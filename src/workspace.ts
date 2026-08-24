import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { PackageManagerId } from "./types.js";
import { usableRange } from "./registry.js";
import { isExactPin } from "./manifest.js";
import { log } from "./util.js";

// Reading a workspace member's own declared ranges off disk. For a member
// project there is no published "latest" to look up in the registry, so its
// committed package.json is the authoritative statement of what it needs — which
// is exactly what the orphan-override removal decision is missing for
// workspace-internal dependents (see reconcileOrphanedOverride, issue #14).

/**
 * The directories of a workspace's member projects, from the workspace config.
 *
 * Only the common, unambiguous member patterns are resolved: a literal path, or
 * a trailing `/*` (immediate subdirectories that contain a package.json). Any
 * other glob shape (`**`, braces, negation) is skipped rather than guessed — a
 * wrong guess could drop a still-needed override.
 */
export function listWorkspaceMemberDirs(root: string, pmId: PackageManagerId): string[] {
  const patterns = pmId === "pnpm" ? readPnpmPackages(root) : readNpmWorkspaces(root);
  const dirs: string[] = [];
  for (const pattern of patterns) {
    for (const dir of resolvePattern(root, pattern)) {
      if (fs.existsSync(path.join(dir, "package.json"))) dirs.push(dir);
    }
  }
  return [...new Set(dirs)];
}

function readPnpmPackages(root: string): string[] {
  const file = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(file)) return [];
  try {
    const doc = (yaml.load(fs.readFileSync(file, "utf-8")) ?? {}) as Record<string, unknown>;
    return Array.isArray(doc.packages) ? doc.packages.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The `updateConfig.ignoreDependencies` list governing a directory — the
 * packages pnpm's own config says to hold back from `pnpm update`.
 *
 * The agent has to read this because of how `pnpm update` treats patterns:
 * given ANY package pattern on the command line, pnpm stops applying
 * ignoreDependencies entirely. The pin guard passes `!name` patterns, so
 * without re-supplying the ignore list as patterns of its own, adding a single
 * exact pin to a project would silently un-ignore everything the user had
 * deliberately held back. Verified against pnpm 11: `pnpm update --latest`
 * honors the list, `pnpm update --latest "!other"` does not.
 *
 * Searches upward from `dir`, matching how pnpm locates its workspace file — a
 * sub-package with no config of its own inherits the root's. Entries are
 * returned verbatim: they may be globs (`@babel/*`), which are equally valid as
 * `!` patterns.
 */
export function readPnpmIgnoredDependencies(dir: string): string[] {
  const file = findPnpmWorkspaceFile(dir);
  if (!file) return [];
  try {
    const doc = (yaml.load(fs.readFileSync(file, "utf-8")) ?? {}) as Record<string, unknown>;
    const updateConfig = doc.updateConfig as { ignoreDependencies?: unknown } | undefined;
    const list = updateConfig?.ignoreDependencies;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** The nearest pnpm-workspace.yaml at or above `dir`, or null if there is none. */
function findPnpmWorkspaceFile(dir: string): string | null {
  let current = path.resolve(dir);
  // Stop when parent === current, which is the filesystem root.
  for (let parent = path.dirname(current); ; current = parent, parent = path.dirname(current)) {
    const candidate = path.join(current, "pnpm-workspace.yaml");
    if (fs.existsSync(candidate)) return candidate;
    if (parent === current) return null;
  }
}

function readNpmWorkspaces(root: string): string[] {
  const file = path.join(root, "package.json");
  if (!fs.existsSync(file)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    const ws = pkg.workspaces;
    // Accept both `["packages/*"]` and `{ "packages": ["packages/*"] }`.
    const list: unknown = Array.isArray(ws) ? ws : (ws as { packages?: unknown })?.packages;
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Resolve one workspace pattern to member dirs (literal or trailing `/*`). */
function resolvePattern(root: string, pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized === "" || normalized.includes("**") || normalized.includes("{") || normalized.startsWith("!")) {
    return []; // shapes we don't confidently understand — skip
  }
  if (normalized.endsWith("/*")) {
    const parent = path.join(root, normalized.slice(0, -2));
    if (!fs.existsSync(parent)) return [];
    try {
      return fs
        .readdirSync(parent, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(parent, e.name));
    } catch {
      return [];
    }
  }
  if (normalized.includes("*")) return []; // any other wildcard shape — skip
  return [path.join(root, normalized)];
}

// ---------------------------------------------------------------------------
// pnpm catalogs
//
// A catalog lets every manifest in a workspace reference one version by name
// (`"@angular/core": "catalog:"`) so the version is declared in exactly one
// place. Catalogs are root-scoped, the same as overrides: a member never
// defines its own.
//
// They matter here for two independent reasons. A catalog reference is not a
// semver range, so without resolution the orphan-removal check reads `catalog:`
// as unparseable, holds the override forever, and reports a reason that means
// nothing to a reader. And once the update pass walks workspace members, pnpm
// rewrites catalog entries in pnpm-workspace.yaml, so a version frozen in a
// catalog needs the same protection a frozen manifest entry gets.
// ---------------------------------------------------------------------------

/** The catalogs a workspace root defines: the default one, plus any named ones. */
export interface PnpmCatalogs {
  /** Entries reachable as `catalog:` or `catalog:default`. */
  default: Record<string, string>;
  /** Named catalogs, reachable as `catalog:<name>`. */
  named: Record<string, Record<string, string>>;
}

/** A workspace with no catalogs — also what every npm workspace resolves against. */
export const EMPTY_CATALOGS: PnpmCatalogs = { default: {}, named: {} };

const CATALOG_PREFIX = "catalog:";

/** Keep only string-valued entries; a catalog value of any other type isn't a range. */
function toRangeMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(value as Record<string, unknown>)) {
    if (typeof range === "string") out[name] = range;
  }
  return out;
}

/**
 * The catalogs declared in the workspace root's pnpm-workspace.yaml.
 *
 * pnpm accepts the default catalog under either key — a top-level `catalog:` or
 * a `default` entry under `catalogs:` — and both are reachable as `catalog:`.
 * They are merged here, with the top-level key winning where both name the same
 * package, so resolution has exactly one place to look.
 */
export function readPnpmCatalogs(root: string): PnpmCatalogs {
  const file = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(file)) return EMPTY_CATALOGS;
  try {
    const doc = (yaml.load(fs.readFileSync(file, "utf-8")) ?? {}) as Record<string, unknown>;

    const named: Record<string, Record<string, string>> = {};
    if (doc.catalogs && typeof doc.catalogs === "object") {
      for (const [name, entries] of Object.entries(doc.catalogs as Record<string, unknown>)) {
        named[name] = toRangeMap(entries);
      }
    }

    const defaults = { ...(named.default ?? {}), ...toRangeMap(doc.catalog) };
    delete named.default;
    return { default: defaults, named };
  } catch {
    return EMPTY_CATALOGS;
  }
}

/**
 * What a specifier turns out to be once catalogs are taken into account.
 *
 * `unresolved` is kept distinct from `not-catalog` deliberately: one is an
 * ordinary range, the other is a reference into a catalog that has no entry for
 * this package — a broken workspace, and never something to read as "declares
 * nothing".
 */
export type CatalogResolution =
  | { kind: "not-catalog" }
  | { kind: "resolved"; range: string }
  | { kind: "unresolved"; catalog: string };

/** Resolve a `catalog:` / `catalog:<name>` specifier for one package. */
export function resolveCatalogSpec(spec: string, catalogs: PnpmCatalogs, packageName: string): CatalogResolution {
  const trimmed = spec.trim();
  if (!trimmed.startsWith(CATALOG_PREFIX)) return { kind: "not-catalog" };

  // A bare `catalog:` names the default catalog, as does `catalog:default`.
  const catalogName = trimmed.slice(CATALOG_PREFIX.length).trim() || "default";
  const entries = catalogName === "default" ? catalogs.default : catalogs.named[catalogName];

  const range = entries?.[packageName];
  return typeof range === "string" ? { kind: "resolved", range } : { kind: "unresolved", catalog: catalogName };
}

/** True for a range that is still a raw, unresolved catalog reference. */
export function isCatalogReference(range: string): boolean {
  return range.trim().startsWith(CATALOG_PREFIX);
}

/**
 * Catalog entries frozen at an exact version.
 *
 * A version pinned in a catalog is the same statement as a pin in a manifest —
 * held deliberately, for reasons no file records — except that it speaks for
 * every member referencing it. `pnpm update -r` rewrites catalog entries, so
 * these have to reach the update command's exclusion list, or the pin guard
 * would hold everywhere except the one place a monorepo actually declares its
 * versions.
 */
export function catalogPins(root: string): Array<{ name: string; spec: string; origin: string }> {
  const catalogs = readPnpmCatalogs(root);
  const pins: Array<{ name: string; spec: string; origin: string }> = [];

  for (const [name, spec] of Object.entries(catalogs.default)) {
    if (isExactPin(spec)) pins.push({ name, spec, origin: "pnpm-workspace.yaml (catalog)" });
  }
  for (const [catalog, entries] of Object.entries(catalogs.named)) {
    for (const [name, spec] of Object.entries(entries)) {
      if (isExactPin(spec)) pins.push({ name, spec, origin: `pnpm-workspace.yaml (catalogs.${catalog})` });
    }
  }
  return pins;
}

/**
 * The range a workspace member declares for targetPackage in its own
 * package.json, across every dependency type — or null if it declares none, or
 * only an unusable wildcard. This is what the member would resolve to *without*
 * the override, so it is the member's authoritative current requirement.
 *
 * A `catalog:` reference is resolved through the workspace's catalogs first, so
 * a catalog-managed member states a real range here rather than an opaque token.
 */
export function localDeclaredRange(
  memberDir: string,
  targetPackage: string,
  catalogs: PnpmCatalogs = EMPTY_CATALOGS,
): string | null {
  const pkg = readPackageJson(memberDir);
  if (!pkg) return null;
  const allDeps: Record<string, string> = {
    ...(pkg.dependencies as Record<string, string>),
    ...(pkg.devDependencies as Record<string, string>),
    ...(pkg.peerDependencies as Record<string, string>),
    ...(pkg.optionalDependencies as Record<string, string>),
  };

  const declared = allDeps[targetPackage] ?? null;
  if (declared === null) return null;

  const resolution = resolveCatalogSpec(declared, catalogs, targetPackage);
  if (resolution.kind === "resolved") return usableRange(resolution.range);

  // A catalog reference nothing backs keeps its raw text rather than becoming
  // null. It is not a parseable range, so every downstream check reads it as
  // "could still resolve vulnerable" and holds the override — the safe
  // direction. Returning null would drop the member from the dependent set
  // altogether, and silence is the one signal the removal check must never be
  // allowed to read as "safe to remove".
  return usableRange(declared);
}

/**
 * Workspace members that declare `targetPackage`, with the range each declares.
 * The orphan-removal path treats these as authoritative "latest" ranges for
 * dependents the registry can't see. A member that declares nothing for the
 * target contributes nothing — silence never implies "safe to remove".
 */
export function workspaceMemberDependents(
  root: string,
  pmId: PackageManagerId,
  targetPackage: string,
): Array<{ name: string; version: string; range: string }> {
  // Catalogs are root-scoped and read once for the whole sweep. npm has no
  // equivalent, so an npm workspace resolves against an empty set and every
  // specifier stays exactly what its manifest says.
  const catalogs = pmId === "pnpm" ? readPnpmCatalogs(root) : EMPTY_CATALOGS;

  const out: Array<{ name: string; version: string; range: string }> = [];
  for (const dir of listWorkspaceMemberDirs(root, pmId)) {
    const range = localDeclaredRange(dir, targetPackage, catalogs);
    if (!range) continue;
    const pkg = readPackageJson(dir);
    if (!pkg?.name || typeof pkg.name !== "string") continue;
    out.push({ name: pkg.name, version: typeof pkg.version === "string" ? pkg.version : "0.0.0", range });

    // Say so rather than letting an opaque token turn up in the report as the
    // stated reason an override is being held.
    if (isCatalogReference(range)) {
      log(
        `   ⚠️  ${pkg.name} declares ${targetPackage} as "${range}", but no catalog entry backs it — ` +
          `treating it as still-vulnerable and keeping the override.`,
      );
    }
  }
  return out;
}

function readPackageJson(dir: string): Record<string, unknown> | null {
  const file = path.join(dir, "package.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
