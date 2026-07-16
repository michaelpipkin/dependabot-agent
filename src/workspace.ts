import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { PackageManagerId } from "./types.js";
import { usableRange } from "./registry.js";

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

/**
 * The range a workspace member declares for targetPackage in its own
 * package.json, across every dependency type — or null if it declares none, or
 * only an unusable wildcard. This is what the member would resolve to *without*
 * the override, so it is the member's authoritative current requirement.
 */
export function localDeclaredRange(memberDir: string, targetPackage: string): string | null {
  const pkg = readPackageJson(memberDir);
  if (!pkg) return null;
  const allDeps: Record<string, string> = {
    ...(pkg.dependencies as Record<string, string>),
    ...(pkg.devDependencies as Record<string, string>),
    ...(pkg.peerDependencies as Record<string, string>),
    ...(pkg.optionalDependencies as Record<string, string>),
  };
  return usableRange(allDeps[targetPackage] ?? null);
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
  const out: Array<{ name: string; version: string; range: string }> = [];
  for (const dir of listWorkspaceMemberDirs(root, pmId)) {
    const range = localDeclaredRange(dir, targetPackage);
    if (!range) continue;
    const pkg = readPackageJson(dir);
    if (!pkg?.name || typeof pkg.name !== "string") continue;
    out.push({ name: pkg.name, version: typeof pkg.version === "string" ? pkg.version : "0.0.0", range });
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
