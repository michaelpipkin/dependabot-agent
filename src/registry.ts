/**
 * Fetch a published version of a package from the npm registry and return the
 * version range it declares for targetPackage.
 *
 * `version` may be an exact version ("1.2.3") or a dist-tag ("latest").
 *
 * Registry data is used rather than the installed tree because the tree's
 * *resolved* versions reflect whatever the overrides forced. Note that a
 * dependent's *declared* range is not rewritten by an override — but reading it
 * off disk means knowing each package manager's node_modules layout, so the
 * registry keeps this package-manager independent.
 *
 * Returns null if the version doesn't exist, the request fails, or the package
 * declares no dependency on targetPackage.
 */
export async function fetchRegistrySpecifier(
  dependentName: string,
  targetPackage: string,
  version = "latest",
): Promise<string | null> {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(dependentName)}/${encodeURIComponent(version)}`;
    const response: Response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;

    const pkg = (await response.json()) as Record<string, unknown>;
    const allDeps: Record<string, string> = {
      ...(pkg.dependencies as Record<string, string>),
      ...(pkg.devDependencies as Record<string, string>),
      ...(pkg.peerDependencies as Record<string, string>),
      ...(pkg.optionalDependencies as Record<string, string>),
    };
    return allDeps[targetPackage] ?? null;
  } catch {
    return null;
  }
}

/**
 * Look up a specifier while distinguishing "read the manifest, it declares no
 * such dependency" from "couldn't read the manifest at all".
 *
 * A plain null conflates the two, and they mean opposite things: the first says
 * upstream dropped the dependency (so updating past this version removes the
 * problem), the second says we know nothing.
 */
async function lookupSpecifier(
  dependentName: string,
  targetPackage: string,
  version: string,
): Promise<{ known: boolean; range: string | null }> {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(dependentName)}/${encodeURIComponent(version)}`;
    const response: Response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) return { known: false, range: null };

    const pkg = (await response.json()) as Record<string, unknown>;
    const allDeps: Record<string, string> = {
      ...(pkg.dependencies as Record<string, string>),
      ...(pkg.devDependencies as Record<string, string>),
      ...(pkg.peerDependencies as Record<string, string>),
      ...(pkg.optionalDependencies as Record<string, string>),
    };
    return { known: true, range: usableRange(allDeps[targetPackage] ?? null) };
  } catch {
    return { known: false, range: null };
  }
}

/**
 * Resolve the ranges a single dependent declares for targetPackage, at both its
 * installed version and its latest published version. See DependentRange for
 * why both are kept.
 */
export async function fetchDependentRanges(
  dependentName: string,
  dependentVersion: string,
  targetPackage: string,
): Promise<{ installedRange: string | null; latestRange: string | null; latestKnown: boolean }> {
  const [installed, latest] = await Promise.all([
    lookupSpecifier(dependentName, targetPackage, dependentVersion),
    lookupSpecifier(dependentName, targetPackage, "latest"),
  ]);
  return { installedRange: installed.range, latestRange: latest.range, latestKnown: latest.known };
}

/** A wildcard or empty range tells us nothing about what a dependent needs. */
function usableRange(range: string | null): string | null {
  if (range === null || range === "*" || range === "") return null;
  return range;
}
