import { InstalledTree, TreeNode } from "./types.js";

/**
 * Recursively walk the dependency tree and collect all installed instances of
 * a given package name, along with the chain of parents that introduced it.
 */
export function findPackageInTree(
  targetName: string,
  deps: Record<string, TreeNode> | undefined,
  parentChain: string[] = [],
): Array<{ version: string; parents: string[] }> {
  if (!deps) return [];

  const results: Array<{ version: string; parents: string[] }> = [];

  for (const [name, entry] of Object.entries(deps)) {
    const chain = [...parentChain, `${name}@${entry.version}`];
    if (name === targetName) {
      results.push({ version: entry.version, parents: parentChain });
    }
    // Recurse into this package's own transitive dependencies
    results.push(...findPackageInTree(targetName, entry.dependencies, chain));
  }

  return results;
}

/**
 * Check whether a package appears anywhere in the installed tree at any version.
 * Used to confirm a package is actually present before adding an override for it.
 */
export function isPackageInTree(targetName: string, tree: InstalledTree[]): boolean {
  for (const workspace of tree) {
    const allDeps = { ...workspace.dependencies, ...workspace.devDependencies };
    const hits = findPackageInTree(targetName, allDeps);
    if (hits.length > 0) return true;
  }
  return false;
}

/**
 * Only add an override if the package actually exists somewhere in the tree.
 * If it's not installed at all, an override does nothing.
 * We take the first hit — all instances should be the same version after
 * the package manager resolves with any existing overrides applied.
 */
export function findInstalledVersion(pkgName: string, tree: InstalledTree[]): string {
  for (const workspace of tree) {
    const allDeps = { ...workspace.dependencies, ...workspace.devDependencies };
    const hits = findPackageInTree(pkgName, allDeps);
    if (hits.length > 0) return hits[0].version;
  }
  return "";
}
