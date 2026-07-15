import { compareSemver, parseSemver } from "./semver.js";
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
 * Every distinct version of a package installed anywhere in the tree, sorted
 * ascending. Empty when the package isn't installed at all — in which case an
 * override for it would do nothing.
 *
 * There is deliberately no "the installed version" accessor. A tree routinely
 * carries several copies of the same package at different versions, and that is
 * *especially* true in the situation this agent exists to fix: before an
 * override is applied, a vulnerable copy and a safe copy commonly coexist (a
 * stale dependent pins the old one while something else resolves the new one).
 * Picking one copy meant picking the safe one about as often as the vulnerable
 * one, which silently suppressed escape warnings for the alert's actual subject.
 * Callers must decide which copy answers their question:
 *
 *   - bounding a spec    → the HIGHEST copy, so the ceiling can't exclude a
 *                          copy that is already safe and force a downgrade
 *   - detecting escapes  → the LOWEST copy, since escapesCompatibleRange() is
 *                          monotonic in the installed version: if any copy
 *                          escapes, the lowest one does
 */
export function findInstalledVersions(pkgName: string, tree: InstalledTree[]): string[] {
  const versions = new Set<string>();
  for (const workspace of tree) {
    const allDeps = { ...workspace.dependencies, ...workspace.devDependencies };
    for (const hit of findPackageInTree(pkgName, allDeps)) versions.add(hit.version);
  }
  return [...versions].sort((a, b) => {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (!pa || !pb) return a.localeCompare(b);
    return compareSemver(pa, pb);
  });
}
