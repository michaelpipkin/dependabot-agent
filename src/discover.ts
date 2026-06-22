import * as fs from "node:fs";
import * as path from "node:path";

// Directories never worth descending into when looking for nested packages.
const PRUNE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache",
  ".turbo",
  ".next",
]);

// A directory is a separate manifest root if it manages its own install —
// i.e. it has a package.json AND its own lockfile (so it's not just a member
// of the parent workspace, which shares the root install/overrides).
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json"];

/**
 * Recursively find directories under `workspaceRoot` (excluding the root itself)
 * that have their own package.json + lockfile — i.e. isolated packages such as
 * a Firebase `functions/` folder. Workspace members (no own lockfile) are
 * intentionally excluded; their overrides are governed by the root.
 */
export function discoverIsolatedManifestDirs(workspaceRoot: string): string[] {
  const root = path.resolve(workspaceRoot);
  const found: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const fileNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const isManifestRoot = fileNames.has("package.json") && LOCKFILES.some((l) => fileNames.has(l));
    if (isManifestRoot && path.resolve(dir) !== root) {
      found.push(path.resolve(dir));
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (PRUNE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(path.join(dir, entry.name));
    }
  }

  walk(root);
  return found;
}
