import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exitWithError } from "../util.js";

export interface LockEntry {
  path: string; // "node_modules/a/node_modules/b", "packages/a", or "" for root
  name: string; // what the package really is: an alias's entry carries its real name
  installedAs: string; // the name it's installed under, which is what Node and npm's edges resolve by
  version?: string;
  link?: string; // link target path, when this entry is a workspace link
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerOptional: Set<string>;
  devDependencies: Record<string, string>; // root and workspace entries only
}
export interface LockIndex {
  entries: Map<string, LockEntry>;
}
export interface Edge {
  from: string;
  name: string;
  spec: string;
  optional: boolean;
  resolved: LockEntry | null;
}

const NM = "node_modules/";

type RawEntry = {
  name?: string;
  version?: string;
  link?: boolean;
  resolved?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
};

/** The name a package is installed under: its last node_modules segment, else the declared name. */
function installedName(path: string, raw: RawEntry): string {
  const idx = path.lastIndexOf(NM);
  if (idx >= 0 && (idx === 0 || path[idx - 1] === "/")) return path.slice(idx + NM.length);
  return raw.name ?? path.slice(path.lastIndexOf("/") + 1);
}

export function readLockfile(dir: string): LockIndex {
  const file = join(dir, "package-lock.json");
  if (!existsSync(file)) {
    exitWithError(`No package-lock.json found in ${dir}. The targeted strategy reads the npm lockfile; run \`npm install\` first.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    exitWithError(`Could not parse ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const version = (raw as { lockfileVersion?: unknown } | null)?.lockfileVersion;
  if (typeof version !== "number" || version < 2) {
    exitWithError(
      `${file} has lockfileVersion ${String(version)}; the targeted strategy needs lockfileVersion 2 or 3 (npm 7+). Regenerate it with a current npm.`,
    );
  }
  return parseLock(raw);
}

export function parseLock(raw: unknown): LockIndex {
  const packages = (raw as { packages?: Record<string, RawEntry> } | null)?.packages;
  if (!packages || typeof packages !== "object") {
    exitWithError("Lockfile has no `packages` block; the targeted strategy needs lockfileVersion 2 or 3.");
  }
  const entries = new Map<string, LockEntry>();
  for (const [path, e] of Object.entries(packages)) {
    entries.set(path, {
      path,
      // npm writes `name` on a node_modules entry only when it differs from the
      // path: `"node_modules/foo": { "name": "minimatch" }` is minimatch, aliased.
      name: e.name ?? installedName(path, e),
      installedAs: installedName(path, e),
      version: e.version,
      link: e.link && e.resolved ? e.resolved : undefined,
      dependencies: e.dependencies ?? {},
      optionalDependencies: e.optionalDependencies ?? {},
      peerDependencies: e.peerDependencies ?? {},
      peerOptional: new Set(
        Object.entries(e.peerDependenciesMeta ?? {})
          .filter(([, meta]) => meta?.optional)
          .map(([n]) => n),
      ),
      devDependencies: e.devDependencies ?? {},
    });
  }
  return { entries };
}

/** Resolve `name` as required from the package at `fromPath`, the way Node walks node_modules. */
export function resolveDep(lock: LockIndex, fromPath: string, name: string): LockEntry | null {
  let base = fromPath;
  for (;;) {
    const hit = lock.entries.get(base ? `${base}/${NM}${name}` : `${NM}${name}`);
    if (hit) return hit.link ? (lock.entries.get(hit.link) ?? hit) : hit;
    if (base === "") return null;
    const idx = base.lastIndexOf(`/${NM}`);
    base = idx >= 0 ? base.slice(0, idx) : "";
  }
}

/** Every installed copy of the package `name`, aliased or not: node_modules entries only (not links, workspace members or the root). */
export function copiesOf(lock: LockIndex, name: string): LockEntry[] {
  return [...lock.entries.values()].filter((e) => e.name === name && !e.link && e.path.includes(NM));
}

function edgesFrom(lock: LockIndex, entry: LockEntry): Edge[] {
  const out: Edge[] = [];
  const add = (deps: Record<string, string>, optional: (name: string) => boolean) => {
    for (const [name, spec] of Object.entries(deps)) {
      out.push({ from: entry.path, name, spec, optional: optional(name), resolved: resolveDep(lock, entry.path, name) });
    }
  };
  add(entry.dependencies, () => false);
  add(entry.optionalDependencies, () => true);
  add(entry.peerDependencies, (n) => entry.peerOptional.has(n));
  add(entry.devDependencies, () => false);
  return out;
}

/** Every declared dependency of every entry. */
export function edgesOf(lock: LockIndex): Edge[] {
  return [...lock.entries.values()].flatMap((e) => edgesFrom(lock, e));
}

export function edgesTo(lock: LockIndex, name: string): Edge[] {
  return edgesOf(lock).filter((e) => e.name === name);
}

/** Paths reachable from `startPaths` (inclusive), following declared deps and workspace links. */
export function reachableFrom(lock: LockIndex, startPaths: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = startPaths.filter((p) => lock.entries.has(p));
  while (queue.length) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const edge of edgesFrom(lock, lock.entries.get(path)!)) {
      if (edge.resolved && !seen.has(edge.resolved.path)) queue.push(edge.resolved.path);
    }
  }
  return seen;
}

/**
 * For each workspace member, the direct dependencies (name -> declared range) through which a copy
 * of one of `targetNames` is reachable. A target declared directly by a member is not its own owner.
 * An aliased copy doesn't count, since an override can't reach it. When members declare different
 * ranges for the same owner, the first one wins.
 */
export function memberOwnersOf(lock: LockIndex, memberPaths: string[], targetNames: string[]): Record<string, string> {
  const targets = new Set(targetNames);
  const owners: Record<string, string> = {};
  for (const memberPath of memberPaths) {
    const member = lock.entries.get(memberPath);
    if (!member) continue;
    for (const edge of edgesFrom(lock, member)) {
      if (targets.has(edge.name) || !edge.resolved || edge.name in owners) continue;
      const reached = reachableFrom(lock, [edge.resolved.path]);
      const leadsToTarget = [...reached].some((p) => {
        const entry = lock.entries.get(p)!;
        return targets.has(entry.name) && entry.installedAs === entry.name;
      });
      if (leadsToTarget) owners[edge.name] = edge.spec;
    }
  }
  return owners;
}
