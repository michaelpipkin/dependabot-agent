import { compareSemver, parseSemver } from "./semver.js";
import { AgentError } from "./util.js";

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
 * The same list, for a caller that acts on the answer: the targeted strategy reports an
 * unavailable target as blocked, and a blocked-only run closes an open pull request. So
 * only a 404 reads as "not there" (null). Any other failure says nothing about the
 * package, and throws.
 */
export async function readPublishedVersions(packageName: string): Promise<string[] | null> {
  const versions = await readVersionList(packageName);
  return versions && Object.keys(versions);
}

interface PublishedManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function readVersionList(packageName: string): Promise<Record<string, PublishedManifest> | null> {
  const failed = (why: string): AgentError =>
    new AgentError(`Could not read ${packageName}'s published versions from the npm registry: ${why}.`);

  let response: Response;
  try {
    response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
    });
  } catch (e) {
    throw failed(e instanceof Error ? e.message : String(e));
  }
  if (response.status === 404) return null;
  if (!response.ok) throw failed(`HTTP ${response.status}`);

  let doc: { versions?: Record<string, PublishedManifest> };
  try {
    doc = (await response.json()) as { versions?: Record<string, PublishedManifest> };
  } catch {
    throw failed("the response wasn't JSON");
  }
  if (!doc.versions || typeof doc.versions !== "object") throw failed("the response has no version list");
  return doc.versions;
}

/**
 * The same read, with what each version asks of other packages, for a caller that has to
 * know whether a version can be installed beside what's already there. Fails as above.
 */
export async function readPublishedPackage(
  packageName: string,
): Promise<Map<string, { dependencies: Record<string, string>; peerDependencies: Record<string, string> }> | null> {
  const versions = await readVersionList(packageName);
  if (!versions) return null;
  return new Map(
    Object.entries(versions).map(([version, manifest]) => [
      version,
      {
        dependencies: { ...manifest.dependencies, ...manifest.optionalDependencies },
        peerDependencies: { ...manifest.peerDependencies },
      },
    ]),
  );
}

/**
 * The advisories touching any of the given versions, by package, from the endpoint `npm audit`
 * reads. Package names and versions are all it sends. Any failure throws, so a caller can say
 * the check didn't run instead of reading it as nothing found.
 */
export async function readAdvisories(query: Record<string, string[]>): Promise<Record<string, Array<{ url?: string; vulnerable_versions: string }>>> {
  const failed = (why: string): AgentError => new AgentError(`Could not read advisories from the npm registry: ${why}.`);

  let response: Response;
  try {
    response = await fetch("https://registry.npmjs.org/-/npm/v1/security/advisories/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(query),
    });
  } catch (e) {
    throw failed(e instanceof Error ? e.message : String(e));
  }
  if (!response.ok) throw failed(`HTTP ${response.status}`);

  let doc: Record<string, Array<{ url?: string; vulnerable_versions?: string }>>;
  try {
    doc = (await response.json()) as typeof doc;
  } catch {
    throw failed("the response wasn't JSON");
  }
  return Object.fromEntries(
    Object.entries(doc).map(([name, advisories]) => [
      name,
      advisories.flatMap(({ url, vulnerable_versions }) => (vulnerable_versions ? [{ url, vulnerable_versions }] : [])),
    ]),
  );
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
