import { compareSemver, parseSemver } from "./semver.js";

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
export function usableRange(range: string | null): string | null {
  if (range === null || range === "*" || range === "") return null;
  return range;
}

/**
 * Every version identifier published for a package.
 *
 * Requests the *abbreviated* packument (`application/vnd.npm.install-v1+json`),
 * which is the document npm's own installer reads: same version list, without
 * the READMEs and per-version metadata that make the full packument tens of
 * megabytes for a package like `typescript`.
 *
 * Returns null when the package can't be read at all, which callers must
 * distinguish from an empty list — "we don't know" is not "nothing published".
 */
export async function fetchPublishedVersions(packageName: string): Promise<string[] | null> {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
    const response: Response = await fetch(url, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
    });
    if (!response.ok) return null;

    const doc = (await response.json()) as { versions?: Record<string, unknown> };
    if (!doc.versions || typeof doc.versions !== "object") return null;
    return Object.keys(doc.versions);
  } catch {
    return null;
  }
}

/**
 * The highest published version that is not a pre-release.
 *
 * This is what the `latest` dist-tag is *supposed* to point at. It doesn't
 * always: a maintainer publishing a release candidate with `npm publish` and no
 * `--tag` moves `latest` onto the pre-release, and every `update --latest` in
 * the ecosystem follows it. Computing the answer from the version list instead
 * is immune to how the tags were set.
 *
 * Ordering is a plain major/minor/patch comparison, which is exact here because
 * pre-releases — the only versions whose ordering parseSemver approximates — are
 * filtered out first. Returns null if the package can't be read or has published
 * nothing but pre-releases.
 */
export async function highestStableVersion(packageName: string): Promise<string | null> {
  const versions = await fetchPublishedVersions(packageName);
  if (!versions) return null;

  const stable = versions
    .filter((v) => !v.includes("-"))
    .map((v) => ({ raw: v, parsed: parseSemver(v) }))
    .filter((v): v is { raw: string; parsed: [number, number, number] } => v.parsed !== null)
    .sort((a, b) => compareSemver(a.parsed, b.parsed));

  return stable.at(-1)?.raw ?? null;
}
