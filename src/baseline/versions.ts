import * as yaml from "js-yaml";
import { parseSemver } from "../semver.js";
import { parseLock } from "../targeted/lockfile.js";
import { collectInstalledVersions, sortVersions } from "../tree.js";
import { InstalledTree, PackageManagerId } from "../types.js";

/** Package name → every version of it installed, ascending and deduplicated (the order `findInstalledVersions` gives). */
export type VersionIndex = Map<string, string[]>;

export function lockfileName(pm: PackageManagerId): "pnpm-lock.yaml" | "package-lock.json" {
  return pm === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json";
}

function toIndex(found: Map<string, Set<string>>): VersionIndex {
  const index: VersionIndex = new Map();
  for (const [name, versions] of found) index.set(name, sortVersions(versions));
  return index;
}

function add(found: Map<string, Set<string>>, name: string, version: string): void {
  let versions = found.get(name);
  if (!versions) found.set(name, (versions = new Set()));
  versions.add(version);
}

// v5: `/name/1.2.3` or `/@scope/name/1.2.3_peer@x`: the version follows a slash, and a peer suffix follows an underscore.
const V5_KEY = /^((?:@[^/]+\/)?[^/@]+)\/([^/@_]+)(?:_.*)?$/;

/** The name and version a `packages` or `snapshots` key of a pnpm lockfile stands for, or null when it isn't a registry package. */
function parsePnpmKey(rawKey: string): { name: string; version: string } | null {
  let key = rawKey.startsWith("/") ? rawKey.slice(1) : rawKey;
  const peers = key.indexOf("(");
  if (peers >= 0) key = key.slice(0, peers);

  const v5 = V5_KEY.exec(key);
  const split = v5 ? null : key.lastIndexOf("@");
  const name = v5 ? v5[1] : split! > 0 ? key.slice(0, split!) : "";
  const version = v5 ? v5[2] : split! > 0 ? key.slice(split! + 1) : "";
  // A file:, link: or tarball key has no plain version; there's nothing to compare for it.
  return name && parseSemver(version) ? { name, version } : null;
}

/** Name → versions from the `packages` and `snapshots` keys of a pnpm-lock.yaml (v5, v6 and v9 key shapes). */
export function pnpmLockVersions(text: string): VersionIndex {
  const doc = yaml.load(text);
  const found = new Map<string, Set<string>>();
  if (doc && typeof doc === "object") {
    for (const section of ["packages", "snapshots"] as const) {
      const block = (doc as Record<string, unknown>)[section];
      if (!block || typeof block !== "object") continue;
      for (const key of Object.keys(block)) {
        const parsed = parsePnpmKey(key);
        if (parsed) add(found, parsed.name, parsed.version);
      }
    }
  }
  return toIndex(found);
}

/**
 * Name → versions from a package-lock.json (lockfileVersion 2 or 3): every installed copy, by its real name.
 * Throws a plain Error when the text can't be read; a baseline read turns that into a warning, never an exit.
 */
export function npmLockVersions(text: string): VersionIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`could not parse package-lock.json: ${e instanceof Error ? e.message : String(e)}`);
  }
  const lock = raw as { lockfileVersion?: unknown; packages?: unknown } | null;
  if (typeof lock?.lockfileVersion !== "number" || lock.lockfileVersion < 2) {
    throw new Error(`package-lock.json has lockfileVersion ${String(lock?.lockfileVersion)}; lockfileVersion 2 or 3 is needed`);
  }
  // Checked here because parseLock exits the process on a missing block.
  if (!lock.packages || typeof lock.packages !== "object") throw new Error("package-lock.json has no `packages` block");

  const found = new Map<string, Set<string>>();
  for (const entry of parseLock(raw).entries.values()) {
    // Installed copies only: not the root, a workspace link, or a workspace member's own entry.
    if (entry.link || !entry.path.includes("node_modules/") || !entry.version) continue;
    add(found, entry.name, entry.version);
  }
  return toIndex(found);
}

export function lockfileVersions(pm: PackageManagerId, text: string): VersionIndex {
  return pm === "pnpm" ? pnpmLockVersions(text) : npmLockVersions(text);
}

/** The installed tree read as an index, for the start-of-run fallback baseline. */
export function indexInstalledTree(tree: InstalledTree[]): VersionIndex {
  return toIndex(collectInstalledVersions(tree));
}

/** How many package names have a different set of versions in `b` than in `a`, counting names added or removed. */
export function countChangedVersions(a: VersionIndex, b: VersionIndex): number {
  let changed = 0;
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const was = a.get(name);
    const now = b.get(name);
    if (!was || !now || was.length !== now.length || was.some((v, i) => v !== now[i])) changed++;
  }
  return changed;
}
