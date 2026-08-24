import { DirectDep, SpecEdit, isExactPin, parseSimpleSpec, readDirectDependencies, rewriteSpecs } from "../manifest.js";
import { highestStableVersion } from "../registry.js";
import { compareSemver, parseSemver } from "../semver.js";
import { log } from "../util.js";

// ---------------------------------------------------------------------------
// Two guards the update pass applies, on either package manager.
//
// The pass exists so legitimately-fixed packages drop off before the reconciler
// looks at them — it is a means, not the product. That makes both of these
// corrections rather than features: an update that rewrites a deliberate pin, or
// that walks a project onto a release candidate, has changed something the run
// was never asked to change.
// ---------------------------------------------------------------------------

/**
 * Direct dependencies frozen at an exact version, which the update pass must
 * leave exactly as it found them. See isExactPin for what counts.
 */
export function exactlyPinnedDeps(deps: DirectDep[]): DirectDep[] {
  return deps.filter((d) => isExactPin(d.spec));
}

/**
 * One manifest the update pass will rewrite, and therefore one the guards have
 * to read first.
 *
 * A single-project run has exactly one of these. A workspace run has the root
 * plus every member, because `pnpm update -r` rewrites all of them — and a
 * guard that reads only the root would enforce its guarantee on the one
 * manifest in a monorepo least likely to declare anything.
 */
export interface ManifestScope {
  /** Directory containing the package.json. */
  dir: string;
  /** How the directory is named in reports — "." for the run's root. */
  label: string;
}

/** A specifier held back from the update pass, and where it was declared. */
export interface PinnedSpec {
  name: string;
  spec: string;
  /** Human-readable source, e.g. `packages/app/package.json (devDependencies)`. */
  origin: string;
}

/** The manifest path as it should read in a report. */
function manifestLabel(scope: ManifestScope): string {
  return scope.label === "." ? "package.json" : `${scope.label}/package.json`;
}

/** The manifest-declared exact pins across every scope the update pass will touch. */
export function collectPinnedSpecs(scopes: ManifestScope[]): PinnedSpec[] {
  const pins: PinnedSpec[] = [];
  for (const scope of scopes) {
    const manifest = manifestLabel(scope);
    for (const dep of exactlyPinnedDeps(readDirectDependencies(scope.dir))) {
      pins.push({ name: dep.name, spec: dep.spec, origin: `${manifest} (${dep.field})` });
    }
  }
  return pins;
}

/**
 * Report the pins being held, and call out any that have an open alert.
 *
 * The second half matters more than the first. Holding a pin means the update
 * pass will not fix a vulnerable *direct* dependency for you, and nothing else
 * in the run says so — the reconciler writes overrides for transitive copies,
 * and a direct dependency is not one. Without this line the alert would simply
 * stay open every week with no explanation.
 */
export function logHeldPins(pinned: PinnedSpec[], alertedPackages: string[]): void {
  if (pinned.length === 0) return;

  const names = [...new Set(pinned.map((p) => p.name))].sort((a, b) => a.localeCompare(b));
  log(`   📌 Holding ${names.length} exact pin(s) — the update pass will not rewrite them: ${names.join(", ")}`);

  const alerted = new Set(alertedPackages);
  const pinnedAndAlerted = pinned.filter((p) => alerted.has(p.name));
  if (pinnedAndAlerted.length === 0) return;

  log("   ⚠️  Pinned AND alerted — the update pass cannot fix these; raise the pin by hand:");
  for (const p of pinnedAndAlerted) {
    log(`         ${p.name} pinned at ${p.spec} in ${p.origin}`);
  }
}

/** One pre-release specifier replaced, and where the replacement came from. */
export interface PrereleaseFix extends SpecEdit {
  /**
   * `highest-stable` — the highest non-pre-release version the registry lists.
   * `restored` — the pre-update specifier, used when the registry is unreachable
   * or lists nothing stable above what the project already declared.
   */
  source: "highest-stable" | "restored";
  /**
   * Which manifest this was corrected in, when the run covers more than one.
   * Absent for a single-scope run, where naming the file would add nothing.
   */
  origin?: string;
}

export interface PrereleaseRollback {
  /** Fixes written back to the manifest. */
  applied: PrereleaseFix[];
  /** Fixes whose specifier could not be located in the manifest text; still pre-release on disk. */
  skipped: PrereleaseFix[];
}

/**
 * Undo any pre-release the update pass just adopted, replacing it with the
 * highest stable version published.
 *
 * `update --latest` resolves through the `latest` dist-tag, and that tag is only
 * as correct as the last `npm publish`. A maintainer who ships a release
 * candidate without `--tag next` moves `latest` onto it, and every consumer's
 * update walks onto a pre-release with no signal that anything unusual happened.
 * The highest stable version is what the tag was meant to say, so that is what
 * gets written.
 *
 * Only specifiers that were stable BEFORE the update are corrected. A project
 * already tracking a pre-release line said so deliberately, and holding it there
 * is the same courtesy the pin guard extends to an exact pin.
 *
 * `before` must be the manifest's state prior to the update pass.
 */
export async function rejectAdoptedPrereleases(cwd: string, before: DirectDep[]): Promise<PrereleaseRollback> {
  const priorSpecs = new Map(before.map((d) => [`${d.field} ${d.name}`, d.spec]));
  const fixes: PrereleaseFix[] = [];

  for (const dep of readDirectDependencies(cwd)) {
    const parsed = parseSimpleSpec(dep.spec);
    if (parsed?.prerelease == null) continue; // stable, or a shape this module doesn't rewrite

    const prior = priorSpecs.get(`${dep.field} ${dep.name}`);
    if (prior === undefined) continue; // added during the update — not ours to judge
    const priorParsed = parseSimpleSpec(prior);
    if (priorParsed?.prerelease != null) continue; // already on a pre-release line, deliberately

    // Take the operator from what the author declared, NOT from what the update
    // just wrote. A package manager normally preserves the operator across an
    // update (`^0.1.0` → `^1.0.0`), but not when the target is a pre-release:
    // pnpm drops the caret and pins exactly, because a caret over a pre-release
    // has semantics nobody wants. Reading the operator back off that would turn
    // a declared range into an exact pin — and the pin guard above would then
    // freeze it there for good, so a one-off bad dist-tag would permanently
    // stop the package from updating. Fall back to the written operator only
    // when the prior specifier is a shape this module can't read.
    const operator = priorParsed?.operator ?? parsed.operator;
    const replacement = await stableReplacement(dep.name, operator, prior);
    if (replacement.spec === dep.spec) continue;

    fixes.push({ field: dep.field, name: dep.name, from: dep.spec, to: replacement.spec, source: replacement.source });
  }

  const applied = new Set(rewriteSpecs(cwd, fixes));
  return {
    applied: fixes.filter((f) => applied.has(f)),
    skipped: fixes.filter((f) => !applied.has(f)),
  };
}

/** A manifest scope paired with its pre-update state, for the rollback sweep. */
export interface PrereleaseScope extends ManifestScope {
  before: DirectDep[];
}

/**
 * Run the pre-release rollback over every manifest the update pass rewrote.
 *
 * The correction is per-manifest and completely independent between them, so
 * this is a plain sweep — but it has to cover all of them. `pnpm update -r`
 * follows the `latest` dist-tag in a member exactly as readily as in the root,
 * and a rollback that only ever looked at the root would leave a member sitting
 * on the release candidate it was never meant to adopt.
 */
export async function rejectAdoptedPrereleasesAcross(scopes: PrereleaseScope[]): Promise<PrereleaseRollback> {
  const applied: PrereleaseFix[] = [];
  const skipped: PrereleaseFix[] = [];

  for (const scope of scopes) {
    const rollback = await rejectAdoptedPrereleases(scope.dir, scope.before);
    // Only name the file when there is more than one it could have been.
    const origin = scopes.length > 1 ? manifestLabel(scope) : undefined;
    applied.push(...rollback.applied.map((f) => ({ ...f, origin })));
    skipped.push(...rollback.skipped.map((f) => ({ ...f, origin })));
  }

  return { applied, skipped };
}

/**
 * The specifier to write in place of an adopted pre-release: the same operator
 * over the highest stable version.
 *
 * Falls back to the pre-update specifier when the registry is unreachable or has
 * nothing stable at or above what was already declared. Never returns something
 * lower than the project already had — a guard against pre-releases must not
 * turn into a downgrade.
 */
async function stableReplacement(
  name: string,
  operator: string,
  prior: string,
): Promise<{ spec: string; source: PrereleaseFix["source"] }> {
  const stable = await highestStableVersion(name);
  if (stable === null) return { spec: prior, source: "restored" };

  const priorParsed = parseSemver(prior);
  const stableParsed = parseSemver(stable);
  if (!stableParsed) return { spec: prior, source: "restored" };
  if (priorParsed && compareSemver(stableParsed, priorParsed) < 0) return { spec: prior, source: "restored" };

  return { spec: `${operator}${stable}`, source: "highest-stable" };
}

/** Print what the rollback changed, so a reviewer can see why a bump stopped short. */
export function logPrereleaseRollback(rollback: PrereleaseRollback): void {
  // Naming the manifest matters once a run spans several: "firebase-functions
  // was rolled back" is ambiguous in a monorepo that declares it three times.
  const where = (fix: PrereleaseFix): string => (fix.origin ? ` in ${fix.origin}` : "");

  for (const fix of rollback.applied) {
    const tail =
      fix.source === "highest-stable"
        ? `using the highest stable release "${fix.to}" instead.`
        : `no newer stable release found — restored "${fix.to}".`;
    log(`   ⏮️  ${fix.name}${where(fix)}: the update pass chose the pre-release "${fix.from}" — ${tail}`);
  }
  for (const fix of rollback.skipped) {
    log(
      `   ⚠️  ${fix.name}${where(fix)} is at the pre-release "${fix.from}" and its entry could not be edited — left as-is.`,
    );
  }
}
