import * as path from "node:path";
import { ResolvedConfig } from "./config.js";
import { discoverIsolatedManifestDirs } from "./discover.js";
import { fetchDependabotAlerts } from "./github.js";
import { OverrideSource, selectOverrideSource } from "./override-source.js";
import {
  createPackageManager,
  detectPackageManager,
  PackageManager,
  RunContext,
} from "./package-manager/index.js";
import {
  compareSemver,
  computeBoundedSpec,
  escapesCompatibleRange,
  lowestPatchClearingAll,
  parseSemver,
  rangeCouldResolveVulnerable,
} from "./semver.js";
import { findInstalledVersions } from "./tree.js";
import {
  AlertRange,
  DependabotAlert,
  DependentRange,
  DeploymentRecommendation,
  DepScope,
  EscapingDependent,
  InstalledTree,
  MultiLineAdvisory,
  OrphanEscape,
  OverrideChange,
  PackageManagerId,
  VulnerablePackage,
} from "./types.js";
import { exitWithError, log } from "./util.js";

// ---------------------------------------------------------------------------
// Determine which alerts still need overrides
// ---------------------------------------------------------------------------

/** Dependabot's per-alert scope, normalized. Absent/unrecognized → unknown. */
function alertScope(alert: DependabotAlert): DepScope {
  if (alert.dependency.scope === "runtime") return "production";
  if (alert.dependency.scope === "development") return "dev";
  return "unknown";
}

/**
 * Merge a package's scope across its alerts. Production wins: if any alert says
 * the vulnerable copy is reachable at runtime, the package is a deploy concern
 * regardless of what the other alerts say.
 */
function mergeScope(a: DepScope, b: DepScope): DepScope {
  if (a === "production" || b === "production") return "production";
  if (a === "dev" || b === "dev") return "dev";
  return "unknown";
}

// Multiple alerts for the same package — keep the highest patched version.
//
// An advisory carries one vulnerable range per release line, each with its own
// first_patched_version, so "the patched version" isn't a single number.
// GHSA-mh29-5h37-fv8m (js-yaml) patches "< 3.14.2" at 3.14.2 and
// ">= 4.0.0, < 4.1.1" at 4.1.1, and 3.14.2 clears *both* ranges. So with 3.13.0
// and 4.0.5 both installed, taking the max drags the 3.x consumer across a
// major that no advisory demands. That cost is real, and the max is still right:
// an override is flat, one version reaches every consumer, and when consumers
// span two majors someone breaks either way. The only question is which way.
//
// The max is chosen because it is the only side that fails loudly. The spec's
// ceiling anchors on the highest installed copy (see computeBoundedSpec), so any
// patch below that copy yields a range that still admits it: the lower patch
// here emits ">=3.14.2 <5", which keeps the vulnerable 4.0.5 resolvable, and
// escapesCompatibleRange only detects *upward* escapes — so nothing would flag
// it and the CVE would stay live in silence. The max emits ">=4.1.1 <5" and
// flags 3.13.0 as noInRangeFix, so the major bump gets reported rather than
// assumed. Pinned by the findVulnerableInstalls tests in test/reconcile.test.ts;
// the mechanism the argument rests on is pinned in test/semver.test.ts.
//
// This merged max is the flat threshold and the fallback; when copies span two
// majors the agent instead writes one scoped override per line (see
// computeScopedSpecs) so each consumer keeps its own version. See issue #2.
function mergeAlert(
  byName: Map<string, VulnerablePackage>,
  alert: DependabotAlert,
  pkgName: string,
  patchedVersion: string,
  vulnerableRange: string,
  installedVersions: string[],
): void {
  const line: AlertRange = { range: vulnerableRange, patch: patchedVersion };

  const existing = byName.get(pkgName);
  if (!existing) {
    byName.set(pkgName, {
      name: pkgName,
      installedVersions,
      patchedVersion,
      severity: alert.security_advisory.severity,
      scope: alertScope(alert),
      foundInParents: [],
      alertNumber: alert.number,
      alertRanges: [line],
    });
    return;
  }

  // Every range is kept, including this one, whichever patch ends up winning —
  // the set of ranges is what findMultiLineAdvisories needs, not just the max's.
  const alertRanges = [...existing.alertRanges, line];
  const scope = mergeScope(existing.scope, alertScope(alert));
  const patch1 = parseSemver(existing.patchedVersion);
  const patch2 = parseSemver(patchedVersion);
  if (patch1 && patch2 && compareSemver(patch2, patch1) > 0) {
    byName.set(pkgName, { ...existing, patchedVersion, scope, alertNumber: alert.number, alertRanges });
  } else {
    byName.set(pkgName, { ...existing, scope, alertRanges });
  }
}

/**
 * Packages whose alerts span disjoint release lines — where a version lower than
 * the one being written would have cleared every advisory.
 *
 * Detection only. mergeAlert still takes the max, deliberately: an override is
 * flat, so one version reaches every consumer, and the max is the only choice
 * that can't leave a vulnerable copy resolvable with nothing to flag it. What
 * this adds is that the cost stops being invisible. On pip-cost-sharing the
 * condition fired five times across ten months and reported nothing — once
 * forcing a minimatch consumer from 3.x to 10.2.3 where 3.1.4 cleared all three
 * ranges.
 *
 * The comparison is the fix issue #2 proposed and #3 disproved: computing the
 * lowest patch clearing every range is unsafe to *write*, but it is exactly the
 * right number to measure the max against.
 *
 * Silent when it can't prove divergence — an unparseable range yields null from
 * lowestPatchClearingAll rather than a guess.
 */
export function findMultiLineAdvisories(pkgs: VulnerablePackage[]): MultiLineAdvisory[] {
  const found: MultiLineAdvisory[] = [];

  for (const pkg of pkgs) {
    const lowestClearing = lowestPatchClearingAll(
      pkg.alertRanges.map((a) => a.patch),
      pkg.alertRanges.map((a) => a.range),
    );
    if (!lowestClearing) continue;

    const lowest = parseSemver(lowestClearing);
    const chosen = parseSemver(pkg.patchedVersion);
    if (!lowest || !chosen || compareSemver(lowest, chosen) >= 0) continue;

    // Distinct lines, ascending — the same range can arrive on several alerts
    // (one per vulnerable copy), and repeating it in the report says nothing.
    const seen = new Set<string>();
    const lines = pkg.alertRanges
      .filter((a) => !seen.has(a.range) && seen.add(a.range))
      .sort((a, b) => {
        const pa = parseSemver(a.patch);
        const pb = parseSemver(b.patch);
        if (!pa || !pb) return a.patch.localeCompare(b.patch);
        return compareSemver(pa, pb);
      });

    found.push({
      packageName: pkg.name,
      lines,
      chosenPatch: pkg.patchedVersion,
      lowestClearing,
    });
  }

  return found;
}

/** One per-line scoped override for a multi-line package. */
interface ScopedSpec {
  /** pnpm version-selector key, e.g. "js-yaml@3". */
  selector: string;
  /** Bounded spec for that line, e.g. ">=3.15.0 <4". */
  spec: string;
}

/** The major of a range's lower bound (`>=`/`>`), or null if it has none. */
function rangeLowerMajor(range: string): number | null {
  for (const part of range.split(",")) {
    const m = /^\s*(>=|>)(.+)$/.exec(part);
    if (m) {
      const v = parseSemver(m[2]);
      if (v) return v[0];
    }
  }
  return null;
}

/**
 * The base package name behind an override key, stripping a version-selector
 * suffix: "js-yaml@3" → "js-yaml", "@babel/core@7" → "@babel/core", "lodash" →
 * "lodash". The leading `@` of a scoped package name is never treated as a
 * selector (the suffix must start with a digit).
 */
export function baseNameOfOverrideKey(key: string): string {
  const at = key.lastIndexOf("@");
  if (at > 0 && /^\d/.test(key.slice(at + 1))) return key.slice(0, at);
  return key;
}

/**
 * For a package vulnerable on disjoint release lines, the per-line scoped
 * overrides that keep each installed copy on its own major — instead of the flat
 * max, which hands one version to every consumer and drags the lower line across
 * a major no advisory requires.
 *
 * Uses a version-selector key (`name@major`) that both pnpm and npm honor,
 * including for transitive copies. It patches a line by the version installed
 * rather than by which parent pulled it — so no parent attribution is needed.
 * Proven end-to-end against the fixture repo for issue #2.
 *
 * Derived from the advisory ranges, not the installed versions — the agent
 * trusts the alert state, and once an override is applied the installed copies
 * are already patched, so keying off them would make the fix un-write itself on
 * the next run (see findVulnerableInstalls). Each line's selector major and patch
 * come from the alert; the copies matched are whatever pnpm resolves at the
 * selector.
 *
 * Returns null (→ caller writes the flat override) when scoping doesn't apply:
 *   - the advisory isn't multi-line (a single patch clears every range),
 *   - the lines don't span two majors (a same-major bump is safe flat), or
 *   - a line is 0.x (`name@0` is too broad — 0.x lines are minors), or its patch
 *     crosses out of its own major (no in-range fix on that line, so a version
 *     selector can't match the vulnerable copy). Those fall back to the flat max,
 *     with the multi-line report still warning. See issue #2.
 */
function computeScopedSpecs(pkg: VulnerablePackage): ScopedSpec[] | null {
  // Same gate as the report: only when the lines are genuinely disjoint.
  const lowestClearing = lowestPatchClearingAll(
    pkg.alertRanges.map((a) => a.patch),
    pkg.alertRanges.map((a) => a.range),
  );
  if (!lowestClearing) return null;
  const lowest = parseSemver(lowestClearing);
  const chosen = parseSemver(pkg.patchedVersion);
  if (!lowest || !chosen || compareSemver(lowest, chosen) >= 0) return null;

  // Group the advisory's lines by the major of their patch. The patch shares a
  // major with the vulnerable copies it fixes (3.14.2 patches the 3.x line), so
  // that major is the version-selector.
  const patchesByMajor = new Map<number, string[]>();
  for (const ar of pkg.alertRanges) {
    const pv = parseSemver(ar.patch);
    if (!pv) return null; // unparseable patch — can't scope safely
    if (pv[0] === 0) return null; // 0.x: name@0 too broad
    // A patch whose major is above its own vulnerable range is a cross-major fix
    // (no in-range fix on that line); a name@major selector wouldn't match the
    // vulnerable copy, so scoping can't help — fall back to flat.
    const lowerMajor = rangeLowerMajor(ar.range);
    if (lowerMajor !== null && lowerMajor !== pv[0]) return null;
    if (!patchesByMajor.has(pv[0])) patchesByMajor.set(pv[0], []);
    patchesByMajor.get(pv[0])!.push(ar.patch);
  }
  if (patchesByMajor.size < 2) return null; // one major → flat handles it

  const higher = (a: string, b: string): string =>
    compareSemver(parseSemver(a)!, parseSemver(b)!) >= 0 ? a : b;

  const specs: ScopedSpec[] = [];
  for (const [major, patches] of patchesByMajor) {
    // Highest patch on this line (two advisories on one major collapse here).
    // The bound anchors on the patch itself: the selector already scopes to the
    // major, so the ceiling is that major's first breaking version.
    const maxPatch = patches.reduce(higher);
    specs.push({ selector: `${pkg.name}@${major}`, spec: computeBoundedSpec(maxPatch) });
  }
  return specs;
}

/**
 * Builds the list of packages that need overrides from open Dependabot alerts.
 *
 * Approach: trust the alert state rather than the installed versions. The
 * installed tree reflects overrides already applied, so a package that has been
 * overridden will always appear "safe" on disk — checking installed versions
 * produces a false "all clear" and removes overrides that are still necessary.
 * We still confirm the package is present in the tree (no point overriding
 * something absent) and use its version to bound the override spec.
 */
export function findVulnerableInstalls(alerts: DependabotAlert[], tree: InstalledTree[]): VulnerablePackage[] {
  log("🔎 Determining required overrides from open Dependabot alerts...");

  const byName = new Map<string, VulnerablePackage>();

  for (const alert of alerts) {
    const vuln = alert.security_vulnerability;
    const pkgName = vuln.package.name;
    const patchedVersion = vuln.first_patched_version?.identifier;

    if (!patchedVersion) {
      log(`   ⚠️  Alert #${alert.number} (${pkgName}) has no patched version — skipping override.`);
      continue;
    }

    const installedVersions = findInstalledVersions(pkgName, tree);
    if (installedVersions.length === 0) {
      log(`   ℹ️  Alert #${alert.number} (${pkgName}) — package not found in installed tree, skipping.`);
      continue;
    }

    mergeAlert(byName, alert, pkgName, patchedVersion, vuln.vulnerable_version_range, installedVersions);
  }

  const results = [...byName.values()];
  log(`   Found ${results.length} package(s) still needing overrides.`);
  return results;
}

// ---------------------------------------------------------------------------
// Compute and apply override changes
// ---------------------------------------------------------------------------

export function computeOverrideChanges(
  currentOverrides: Record<string, string>,
  stillVulnerable: VulnerablePackage[],
  resolvedAlertNames: Set<string>,
): OverrideChange[] {
  const changes: OverrideChange[] = [];
  // Every override key we write or keep this run — so the removal pass below
  // doesn't touch a scoped selector we just produced.
  const handledKeys = new Set<string>();

  // Add or update overrides for packages that still need them. The spec is
  // bounded at the first breaking version above the patch rather than left as
  // an unbounded >=, so applying a fix can't drag the tree further than it has
  // to. Where even that minimum lands outside what the installed version's
  // dependents can accept, the change is marked noInRangeFix for the report.
  for (const pkg of stillVulnerable) {
    const scoped = computeScopedSpecs(pkg);
    if (scoped) {
      // Vulnerable on disjoint lines — write one bounded override per line so
      // each installed copy stays on its own major, instead of the flat max.
      for (const s of scoped) {
        handledKeys.add(s.selector);
        // A scoped spec keeps its line inside its own major by construction, so
        // it never forces a copy across a breaking boundary — no escape to flag.
        const reason = `Vulnerable on multiple release lines — scoped to ${s.spec} (issue #2)`;
        const existing = currentOverrides[s.selector];
        if (existing === undefined) {
          changes.push({ packageName: s.selector, action: "add", newVersion: s.spec, reason, noInRangeFix: false });
        } else if (existing !== s.spec) {
          changes.push({
            packageName: s.selector,
            action: "update",
            oldVersion: existing,
            newVersion: s.spec,
            reason,
            noInRangeFix: false,
          });
        }
      }
      // A flat override for this package is now superseded by the scoped set.
      handledKeys.add(pkg.name);
      if (currentOverrides[pkg.name] !== undefined) {
        changes.push({
          packageName: pkg.name,
          action: "remove",
          oldVersion: currentOverrides[pkg.name],
          reason: "Replaced by scoped per-line overrides (issue #2)",
        });
      }
      continue;
    }

    // Flat path — one spec per package name.
    handledKeys.add(pkg.name);
    const installedVersions = pkg.installedVersions ?? [];
    const versionSpec = pkg.patchedVersion;

    // Bound against the HIGHEST copy so the ceiling can't exclude one that is
    // already safe; test escapes against EVERY copy, because the vulnerable one
    // is frequently not the one a by-name lookup would land on.
    const boundedSpec = computeBoundedSpec(versionSpec, installedVersions.at(-1));
    const escapingVersions = installedVersions.filter((v) => escapesCompatibleRange(versionSpec, v));
    const noInRangeFix = escapingVersions.length > 0;
    const escapeReason =
      `No in-range fix exists — earliest patch ${versionSpec} is outside the compatible range of ` +
      `installed ${escapingVersions.join(", ")}`;

    const existing = currentOverrides[pkg.name];
    if (existing === undefined) {
      changes.push({
        packageName: pkg.name,
        action: "add",
        newVersion: boundedSpec,
        reason: noInRangeFix ? escapeReason : `Still vulnerable per Dependabot (needs ${boundedSpec})`,
        noInRangeFix,
        installedVersions,
        escapingVersions,
      });
    } else if (existing !== boundedSpec) {
      changes.push({
        packageName: pkg.name,
        action: "update",
        oldVersion: existing,
        newVersion: boundedSpec,
        reason: noInRangeFix ? escapeReason : `Updated version requirement to ${boundedSpec}`,
        noInRangeFix,
        installedVersions,
        escapingVersions,
      });
    }
    // else: already correct — no change needed
  }

  // Remove overrides that are no longer needed. A scoped key (js-yaml@3) carries
  // its base name for the resolved-alert check.
  for (const [key, existingSpec] of Object.entries(currentOverrides)) {
    if (handledKeys.has(key)) continue; // written or kept above

    if (resolvedAlertNames.has(baseNameOfOverrideKey(key))) {
      changes.push({
        packageName: key,
        action: "remove",
        oldVersion: existingSpec,
        reason: "Vulnerability resolved — override no longer needed",
      });
    }
    // Overrides for packages not in any alert are left untouched
  }

  return changes;
}

/** The floor of an override spec: ">=11.1.1" and ">=7.29.6 <8" both yield the lower bound. */
export function overrideFloor(spec: string): string {
  return spec.replace(/^>=/, "").split(" ")[0].trim();
}

/**
 * Would moving this dependent to its own latest release clear the escape?
 *
 * Two ways it can: the latest release widened its range to accept the forced
 * version, or it dropped the dependency altogether — in which case it stops
 * being a dependent at all. Both need the latest manifest to have actually been
 * read; without it we know nothing and claim nothing.
 *
 * Note this says the *upstream fix exists*, not that the update is necessarily
 * reachable — whether the dependent can move depends on what constrains it.
 */
function isFixedByUpdate(dep: DependentRange, forcedVersion: string): boolean {
  if (!dep.latestKnown) return false;
  if (dep.latestRange === null) return true; // upstream dropped the dependency
  return !escapesCompatibleRange(forcedVersion, dep.latestRange);
}

/**
 * Which of this override's dependents does `forcedVersion` push past their
 * declared range?
 *
 * A non-empty result means the override is dragging those dependents beyond
 * what they asked for — the same "no in-range fix" condition that
 * computeOverrideChanges flags, but for an override already in place rather
 * than one being written.
 *
 * Pass the version actually resolved in the tree, not the spec's floor. An
 * unbounded spec can sit well above its own floor (">=4.2.0" resolving to
 * 5.0.0), and judging by the floor doesn't merely understate the severity — it
 * misses escapes outright: floor 0.28.1 sits inside a dependent's ^0.28.0, so
 * a drift to 0.29.5 reads as no escape at all.
 *
 * Each dependent is judged against the range its INSTALLED version declares,
 * which is the question that matters: what does the tree you have ask for?
 * Falls back to the latest published version's range only when the installed
 * one can't be resolved, and records which was used so the report can say so.
 *
 * Ranges it cannot parse (compound "^0.27.0 || ^0.28.0", wildcards) yield false
 * from escapesCompatibleRange and are skipped: only provable escapes are named.
 */
export function findEscapingDependents(forcedVersion: string, dependents: DependentRange[]): EscapingDependent[] {
  const escaping: EscapingDependent[] = [];

  for (const dep of dependents) {
    const range = dep.installedRange ?? dep.latestRange;
    if (!range) continue;
    if (!escapesCompatibleRange(forcedVersion, range)) continue;
    escaping.push({
      name: dep.dependent,
      version: dep.version,
      range,
      source: dep.installedRange ? "installed" : "latest",
      fixedByUpdate: isFixedByUpdate(dep, forcedVersion),
    });
  }

  return escaping;
}

/**
 * Surface the "no in-range fix exists" bucket separately from routine changes.
 *
 * These are the ones that need a human. The override itself will apply without
 * complaint — the package manager forces the version at resolution time, so a
 * dependent's declared range does not block it and the install exits 0.
 * Dependabot then closes the alert because the resolved version is patched.
 * Nothing in that sequence is a signal, which is exactly why it gets its own
 * block here rather than a line in the list above.
 */
function logEscapeList(escaped: OverrideChange[], orphanEscapes: OrphanEscape[]): void {
  if (escaped.length > 0) {
    log("   From open alerts (being written now):");
    for (const c of escaped) {
      const escaping = (c.escapingVersions ?? []).join(", ");
      // Name the other copies too: an escape on one of several is easy to
      // misread as an escape on all of them.
      const safe = (c.installedVersions ?? []).filter((v) => !(c.escapingVersions ?? []).includes(v));
      const alsoInstalled = safe.length > 0 ? `  (also installed, already in range: ${safe.join(", ")})` : "";
      log(`      ${c.packageName}: installed ${escaping} → forced to "${c.newVersion}"${alsoInstalled}`);
    }
  }

  if (orphanEscapes.length === 0) return;
  log("   Already in place (no open alert, kept because still load-bearing):");
  for (const o of orphanEscapes) {
    const resolvedSuffix = o.resolvedVersion ? ` → resolved ${o.resolvedVersion}` : "";
    log(`      ${o.packageName}: "${o.spec}"${resolvedSuffix} forces past what its dependents declare:`);
    for (const d of o.dependents) {
      log(`         ${d.name}@${d.version} declares ${d.range}`);
    }
  }
}

/**
 * Split the escaping dependents into the ones a user can just update away and
 * the ones that need a real judgement call — the distinction that decides what
 * they do next.
 */
function logEscapeGuidance(orphanEscapes: OrphanEscape[]): void {
  const allDeps = orphanEscapes.flatMap((o) => o.dependents);
  const fixable = [...new Set(allDeps.filter((d) => d.fixedByUpdate).map((d) => `${d.name}@${d.version}`))];
  const stuck = allDeps.filter((d) => !d.fixedByUpdate);

  if (fixable.length > 0) {
    const subject = fixable.length === 1 ? "has" : "have";
    log("");
    log(`   ${fixable.length} ${subject} an upstream fix — the dependent's own latest release either`);
    log("   accepts the forced version or dropped the dependency altogether:");
    for (const d of fixable) log(`      ${d}`);
    log("");
    log("   Whether you can reach that fix is a separate question. A parent pinning the");
    log("   dependent — an exact pin or a capped range — holds it where it is, and no");
    log("   amount of updating will move it.");
  }

  if (stuck.length > 0) {
    const subject = stuck.length === 1 ? "has" : "have";
    log("");
    log(`   ${stuck.length} ${subject} no upstream fix available — verify these, or bound the`);
    log("   override lower if the dependent genuinely can't take the forced version:");
    for (const d of stuck) log(`      ${d.name}@${d.version} (wants ${d.range})`);
  }

  // Ranges are read at each dependent's installed version. Where that couldn't
  // be resolved we fell back to the latest published version, which may declare
  // a different range than the copy actually on disk — say so rather than let
  // the entry read as authoritative.
  const fellBack = allDeps.filter((d) => d.source === "latest");
  if (fellBack.length > 0) {
    log("");
    log(`   ${fellBack.length} could not be resolved at the installed version and were judged`);
    log("   against the dependent's latest published range instead:");
    for (const d of fellBack) log(`      ${d.name}@${d.version}`);
  }
}

function logNoInRangeFixWarning(
  escaped: OverrideChange[],
  orphanEscapes: OrphanEscape[],
  treeIsPreUpdate: boolean,
): void {
  const total = escaped.length + orphanEscapes.length;
  if (total === 0) return;

  log(`\n⚠️  NO IN-RANGE FIX — ${total} override(s) escape the compatible range of their dependents:`);
  logEscapeList(escaped, orphanEscapes);

  log("");
  log("   These install cleanly and their alerts read as fixed. That is not the same");
  log("   as being safe: dependents that asked for the old range will still call the");
  log("   old API, and the break shows up at runtime, not at install.");

  logEscapeGuidance(orphanEscapes);

  // Escapes are computed from the installed tree, and without the update pass
  // that tree is whatever was already on disk. Say so — but don't imply a real
  // run would shorten the list. Measured against a live tree it didn't move it
  // at all: every stale dependent was pinned by a parent already at its own
  // latest version, so `update --latest` had nowhere to go.
  if (treeIsPreUpdate && orphanEscapes.length > 0) {
    log("");
    log("   NOTE: the update pass was skipped, so this reflects your current tree.");
    log("   A real run updates first, which clears an escape only when the dependent");
    log("   is free to move. One held by a parent's pin stays put, and so does its");
    log("   escape — expect this list to survive the update more often than not.");
  }
}

/**
 * Report packages vulnerable on more than one release line at once.
 *
 * When per-line scoped overrides were written, this reads as handled: it names
 * the scoped specs that keep each consumer on its own line. When they were not —
 * the 0.x fallback, where a version selector would be too broad — it reads as a
 * warning: the flat max forced the lower line across a major no advisory
 * demanded. See issue #2.
 */
function logMultiLineAdvisories(advisories: MultiLineAdvisory[], changes: OverrideChange[]): void {
  if (advisories.length === 0) return;

  log(`\nℹ️  MULTI-LINE ADVISORY — ${advisories.length} package(s) vulnerable on disjoint release lines:`);
  for (const a of advisories) {
    const [first, ...rest] = a.lines;
    log(`      ${a.packageName}: ${a.lines.length} lines — "${first.range}" → ${first.patch}`);
    // Align continuation lines under the first range, so the set reads as a column.
    const indent = " ".repeat(`      ${a.packageName}: ${a.lines.length} lines — `.length);
    for (const line of rest) log(`${indent}"${line.range}" → ${line.patch}`);

    // Scoped overrides carry a `name@major` key whose base is this package.
    const scoped = changes.filter(
      (c) =>
        c.action !== "remove" &&
        c.packageName !== a.packageName &&
        baseNameOfOverrideKey(c.packageName) === a.packageName,
    );
    if (scoped.length > 0) {
      log(`         Split into per-line overrides — each consumer stays on its own line:`);
      for (const c of scoped) log(`            ${c.packageName} → ${c.newVersion}`);
    } else {
      log(`         Forcing ${a.chosenPatch}. ${a.lowestClearing} clears every range, but a flat`);
      log(`         override hands one version to every consumer. See issue #2.`);
    }
  }
}

export function applyOverrideChanges(
  changes: OverrideChange[],
  currentOverrides: Record<string, string>,
  source: OverrideSource,
  dryRun: boolean,
  pmId: PackageManagerId,
): void {
  if (changes.length === 0) {
    log("\n✅ No override changes needed.");
    return;
  }

  log(`\n📝 Planned override changes (${source.label}):`);
  for (const change of changes) {
    const mark = change.noInRangeFix ? "⚠" : " ";
    if (change.action === "add") {
      log(`  ${mark}+ ADD    ${change.packageName}: "${change.newVersion}"`);
    } else if (change.action === "update") {
      log(`  ${mark}~ UPDATE ${change.packageName}: "${change.oldVersion}" → "${change.newVersion}"`);
    } else {
      log(`  ${mark}- REMOVE ${change.packageName}: "${change.oldVersion}"`);
    }
    log(`            (${change.reason})`);
  }

  if (dryRun) {
    log("\n🚫 Dry run — no changes written.");
    return;
  }

  const newOverrides = { ...currentOverrides };
  for (const change of changes) {
    if (change.action === "add" || change.action === "update") {
      newOverrides[change.packageName] = change.newVersion!;
    } else {
      delete newOverrides[change.packageName];
    }
  }

  source.write(newOverrides);
  log(`\n✅ ${source.label} updated at ${source.filePath}`);
  if (pmId === "npm") {
    // npm resolves from an existing node_modules + package-lock.json and does not
    // re-resolve just because `overrides` changed — a plain `npm install` (even
    // --force or --package-lock-only) leaves the old versions in place. Applying
    // a newly written override needs a clean resolve. Verified on npm 11.
    log("   Then apply them with a clean install — npm won't re-resolve otherwise:");
    log("      rm -rf node_modules package-lock.json && npm install");
  } else {
    log("   Run `pnpm install` to apply the new overrides to your lockfile.");
  }
}

// ---------------------------------------------------------------------------
// Orphaned-override reconciliation
// ---------------------------------------------------------------------------

export type OrphanVerdict =
  | { action: "keep-no-data"; latestRanges: string[] }
  | { action: "remove"; latestRanges: string[] }
  | { action: "keep-load-bearing"; latestRanges: string[] }
  | { action: "escape"; latestRanges: string[]; escaping: EscapingDependent[] };

/**
 * The removal decision for an orphaned override (no open alert), from its
 * dependents' registry ranges and the override floor. Pure — the registry fetch
 * and all logging live in reconcileOrphanedOverride.
 *
 *   - keep-no-data      — no usable latest range; keep conservatively.
 *   - remove            — every latest upstream range now requests a safe
 *                         version, so the override no longer does anything.
 *   - escape            — still load-bearing, but the resolved version forces a
 *                         dependent past its declared range (no in-range fix).
 *   - keep-load-bearing — still needed, routine.
 *
 * Reads the LATEST published ranges, not the installed ones: the question is
 * forward-looking ("has upstream moved on?"), since after an update you resolve
 * to the latest dependents anyway. Proven live against debug@2.0.0 → ms, whose
 * latest requests ms ^2.1.3 above a >=2.0.0 override → remove.
 */
export function judgeOrphanedOverride(
  dependents: DependentRange[],
  floor: string,
  resolvedVersion: string | undefined,
): OrphanVerdict {
  const latestRanges = [...new Set(dependents.map((d) => d.latestRange).filter((r): r is string => r !== null))];
  if (latestRanges.length === 0) return { action: "keep-no-data", latestRanges };
  const stillNeeded = latestRanges.some((range) => rangeCouldResolveVulnerable(range, floor));
  if (!stillNeeded) return { action: "remove", latestRanges };
  const escaping = findEscapingDependents(resolvedVersion ?? floor, dependents);
  if (escaping.length > 0) return { action: "escape", latestRanges, escaping };
  return { action: "keep-load-bearing", latestRanges };
}

/**
 * For an override with no open alert in any group, decide whether it is still
 * load-bearing by checking the upstream ranges dependents declare in the npm
 * registry (registry data is unaffected by local overrides — unlike
 * node_modules, which reflects whatever the PM resolved after overrides
 * applied). If every upstream range now requests a safe version, mark it
 * eligible for removal by adding it to allAlertedNames.
 */
async function reconcileOrphanedOverride(
  name: string,
  source: OverrideSource,
  manifestDir: string,
  pm: PackageManager,
  allAlertedNames: Set<string>,
  tree: InstalledTree[],
): Promise<OrphanEscape | null> {
  // `name` is a base package name; it may be held by a flat key or by one or
  // more scoped selectors (js-yaml@3, js-yaml@4). Describe it by its keys, and
  // judge "still needed" against the LOWEST floor — the most conservative
  // threshold, so any line a dependent might still resolve below keeps the set.
  const keys = Object.keys(source.overrides).filter((k) => baseNameOfOverrideKey(k) === name);
  const overrideSpec = keys.map((k) => source.overrides[k]).join(", ");
  const floors = keys.map((k) => overrideFloor(source.overrides[k]));
  const patchedVersion = floors.reduce((lo, f) => {
    const a = parseSemver(lo);
    const b = parseSemver(f);
    if (!a || !b) return lo;
    return compareSemver(b, a) < 0 ? f : lo;
  }, floors[0]);

  log(`   🔍 Checking npm registry for upstream dependency ranges for ${name}...`);
  const dependents = await pm.collectDependentRanges(name, manifestDir);
  // An override normally collapses the tree to one copy, but not always (a
  // nested override or a peer-suffixed instance can survive). Judge escapes by
  // the HIGHEST copy: escapesCompatibleRange() rises with the forced version, so
  // that's the copy pushing dependents furthest past their range.
  const resolvedVersion = findInstalledVersions(name, tree).at(-1);
  const verdict = judgeOrphanedOverride(dependents, patchedVersion, resolvedVersion);

  switch (verdict.action) {
    case "keep-no-data":
      log(
        `   ℹ️  Override for ${name} (${overrideSpec}) has no open alert. ` +
          `Could not determine upstream ranges from registry. ` +
          `Keeping conservatively — remove manually once upstream packages ` +
          `raise their own minimum requirements.`,
      );
      return null;

    case "remove":
      log(
        `   ✂️  Override for ${name} (${overrideSpec}) is no longer needed — ` +
          `latest upstream versions all request safe ranges: ${verdict.latestRanges.join(", ")}`,
      );
      allAlertedNames.add(name);
      return null;

    case "escape": {
      const resolvedSuffix = resolvedVersion ? ` → resolved ${resolvedVersion}` : "";
      log(
        `   ⚠️  Override for ${name} (${overrideSpec}${resolvedSuffix}) has ` +
          `no open alert and is still load-bearing, but no in-range fix exists for its dependents:`,
      );
      for (const d of verdict.escaping) {
        const via = d.source === "latest" ? " (latest — installed version unresolved)" : "";
        const hint = d.fixedByUpdate ? ` — updating ${d.name} resolves this` : "";
        log(`         ${d.name}@${d.version} declares ${d.range}${via}${hint}`);
      }
      return { packageName: name, spec: overrideSpec, floor: patchedVersion, resolvedVersion, dependents: verdict.escaping };
    }

    case "keep-load-bearing":
      log(
        `   ℹ️  Override for ${name} (${overrideSpec}) has no open alert but is ` +
          `still load-bearing — latest upstream versions request: ${verdict.latestRanges.join(", ")}`,
      );
      return null;
  }
}

// ---------------------------------------------------------------------------
// Deployment-impact reporting
// ---------------------------------------------------------------------------

function logDeploymentRecommendation(recommendations: DeploymentRecommendation[]): void {
  if (recommendations.length === 0) return;

  const needsDeploy = recommendations.filter((r) => r.scope === "production");
  const devOnly = recommendations.filter((r) => r.scope === "dev");
  const unknown = recommendations.filter((r) => r.scope === "unknown");

  log("\n🚀 Deployment impact analysis:");

  if (needsDeploy.length > 0) {
    log("   Packages in PRODUCTION dependency graph (deployment recommended):");
    for (const r of needsDeploy) {
      log(`      ⚠️  ${r.packageName} — via: ${r.productionPaths.join(", ")}`);
    }
  }

  if (devOnly.length > 0) {
    log("   Packages in DEV/TEST dependencies only (branch push is sufficient):");
    for (const r of devOnly) {
      log(`      ✅ ${r.packageName} — via: ${r.devPaths.join(", ")}`);
    }
  }

  if (unknown.length > 0) {
    log("   Packages with undetermined scope (review manually):");
    for (const r of unknown) {
      log(`      ❓ ${r.packageName}`);
    }
  }

  log("");
  if (needsDeploy.length > 0) {
    log("   📦 Recommendation: DEPLOY — vulnerable packages are in production code.");
  } else if (devOnly.length > 0) {
    log("   📋 Recommendation: BRANCH PUSH ONLY — all vulnerable packages are dev/test only.");
  } else {
    log("   ❓ Recommendation: REVIEW MANUALLY — could not determine production impact.");
  }
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Group alerts by the directory containing their manifest. Always include the
 * workspace root (even with no alerts) so stale root overrides get a cleanup
 * pass. Any non-root directory only appears because an alert referenced its
 * manifest — so no directories are synthesized.
 *
 * manifest_path is relative to repo root, e.g. "package.json" or
 * "functions/package.json"; "." means the repo root.
 */
export function groupAlertsByManifestDir(
  alerts: DependabotAlert[],
  workspaceRoot: string,
  extraDirs: string[],
): Map<string, DependabotAlert[]> {
  // Dirs that own their override resolution: the root, plus discovered isolated
  // packages (their own lockfile) and explicitly-configured ones. A Dependabot
  // alert is often keyed to a workspace member's package.json, but a member that
  // shares the root lockfile is not its own override target — pnpm and npm read
  // overrides from the root. Folding such members into the root group keeps the
  // fix in one place instead of writing member-local override files the package
  // manager ignores.
  const ownSources = new Set([workspaceRoot, ...extraDirs].map((d) => path.resolve(d)));

  const alertsByDir = new Map<string, DependabotAlert[]>();
  for (const alert of alerts) {
    const rawDir = path.dirname(alert.dependency.manifest_path);
    const dir = rawDir === "." ? workspaceRoot : path.join(workspaceRoot, rawDir);
    const manifestDir = ownSources.has(path.resolve(dir)) ? dir : workspaceRoot;
    const group = alertsByDir.get(manifestDir) ?? [];
    group.push(alert);
    alertsByDir.set(manifestDir, group);
  }

  // Always include the root, plus any extra manifest dirs (discovered isolated
  // packages and explicitly-configured ones), for a cleanup pass even with no
  // alerts.
  for (const dir of [workspaceRoot, ...extraDirs]) {
    if (!alertsByDir.has(dir)) alertsByDir.set(dir, []);
  }

  return alertsByDir;
}

/**
 * Resolve the package manager for a manifest directory. An explicit
 * --package-manager setting wins everywhere; otherwise each isolated package is
 * detected from its own lockfile, falling back to the root's package manager.
 */
function resolvePmForDir(
  manifestDir: string,
  isRoot: boolean,
  rootPmId: PackageManagerId,
  cfg: ResolvedConfig,
): PackageManagerId {
  if (cfg.packageManager) return cfg.packageManager;
  if (isRoot) return rootPmId;
  return detectPackageManager(manifestDir) ?? rootPmId;
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

/** What one manifest group contributed, for the run-wide summary. */
interface GroupResult {
  alerts: number;
  added: number;
  removed: number;
  noInRangeFix: number;
  multiLine: number;
  recommendations: DeploymentRecommendation[];
}

/**
 * Reconcile a single manifest directory: update, walk its tree, decide what
 * overrides it needs, clean up orphans, and report.
 */
async function processManifestGroup(
  manifestDir: string,
  groupAlerts: DependabotAlert[],
  cfg: ResolvedConfig,
  ctx: RunContext,
  rootPmId: PackageManagerId,
  globalAlertedNames: Set<string>,
): Promise<GroupResult> {
  const isRoot = manifestDir === cfg.workspaceRoot;
  const label = isRoot ? "root" : path.relative(cfg.workspaceRoot, manifestDir);
  const pmId = resolvePmForDir(manifestDir, isRoot, rootPmId, cfg);
  const pm = createPackageManager(pmId, ctx);

  log(`\n${"─".repeat(48)}`);
  log(`📂 Processing manifest: ${label} (${groupAlerts.length} alert(s)) [${pmId}]`);

  log("🗂️  Detecting override config location...");
  const source = selectOverrideSource(pmId, manifestDir, isRoot);

  pm.update(manifestDir, [...new Set(groupAlerts.map((a) => a.security_vulnerability.package.name))]);

  const tree = pm.getInstalledTree(manifestDir);
  const stillVulnerable = findVulnerableInstalls(groupAlerts, tree);

  // Only remove overrides for packages whose alert in this group is resolved.
  const allAlertedNames = new Set(groupAlerts.map((a) => a.security_vulnerability.package.name));

  // For overrides with no active alert in ANY group, check whether any
  // dependent still requests a vulnerable range. Work in base package names: a
  // scoped key like "js-yaml@3" belongs to "js-yaml", which is what the alert
  // set and the registry are keyed by.
  const orphanedBaseNames = [...new Set(Object.keys(source.overrides).map(baseNameOfOverrideKey))].filter(
    (base) => !globalAlertedNames.has(base),
  );
  const orphanEscapes: OrphanEscape[] = [];
  for (const base of orphanedBaseNames) {
    const escape = await reconcileOrphanedOverride(base, source, manifestDir, pm, allAlertedNames, tree);
    if (escape) orphanEscapes.push(escape);
  }

  const changes = computeOverrideChanges(source.overrides, stillVulnerable, allAlertedNames);
  applyOverrideChanges(changes, source.overrides, source, cfg.dryRun, pmId);
  const escapedChanges = changes.filter((c) => c.noInRangeFix);
  // The tree was read without an update pass, so it is whatever was already on
  // disk — escapes computed from it may not survive a real run.
  logNoInRangeFixWarning(escapedChanges, orphanEscapes, ctx.dryRun || ctx.skipUpdate);

  // After the escape block: these lines are usually the reason an escape had no
  // in-range fix to offer, so they read as the explanation rather than a new
  // finding.
  const multiLine = findMultiLineAdvisories(stillVulnerable);
  logMultiLineAdvisories(multiLine, changes);

  return {
    alerts: groupAlerts.length,
    added: changes.filter((c) => c.action !== "remove").length,
    removed: changes.filter((c) => c.action === "remove").length,
    noInRangeFix: escapedChanges.length + orphanEscapes.length,
    multiLine: multiLine.length,
    recommendations: groupAlerts.length > 0 ? stillVulnerable.map((v) => resolveScope(v, pm, manifestDir)) : [],
  };
}

/**
 * Decide whether a vulnerable package is a deploy concern.
 *
 * Prefers Dependabot's scope, which describes the *vulnerable copy* and is
 * therefore version-accurate. Walking the local tree by name is not: with a
 * vulnerable and a safe copy both installed, it finds the safe copy's
 * production path and reports the package as production even when the copy
 * under alert is dev-only. Falls back to the local walk only when GitHub
 * doesn't say (older payloads).
 */
function resolveScope(v: VulnerablePackage, pm: PackageManager, manifestDir: string): DeploymentRecommendation {
  if (v.scope === "unknown") return pm.analyseDeploymentImpact(v.name, manifestDir);

  const local = pm.analyseDeploymentImpact(v.name, manifestDir);
  return { ...local, scope: v.scope };
}

export async function run(cfg: ResolvedConfig): Promise<void> {
  log("🤖 Dependabot Override Agent");
  log("================================");
  if (cfg.dryRun) log("⚠️  DRY RUN MODE — no files will be modified\n");

  // Resolve the root package manager (explicit override or lockfile detection).
  const rootPmId = cfg.packageManager ?? detectPackageManager(cfg.workspaceRoot);
  if (!rootPmId) {
    exitWithError(
      `Could not detect a package manager in ${cfg.workspaceRoot} ` +
        `(no pnpm-lock.yaml or package-lock.json). Pass --package-manager pnpm|npm.`,
    );
  }
  log(`📦 Package manager: ${rootPmId}${cfg.packageManager ? " (explicit)" : " (auto-detected)"}`);
  log(`🔧 Update strategy: ${cfg.updateStrategy}`);

  const ctx: RunContext = {
    dryRun: cfg.dryRun,
    skipUpdate: cfg.skipUpdate,
    updateStrategy: cfg.updateStrategy,
  };

  // Additional manifest roots to reconcile beyond the workspace root: isolated
  // sub-packages with their own lockfile (auto-discovered) plus any explicitly
  // configured directories. Each is processed as its own group.
  const explicitDirs = cfg.packages.map((p) => path.resolve(cfg.workspaceRoot, p));
  const discoveredDirs = cfg.discoverPackages ? discoverIsolatedManifestDirs(cfg.workspaceRoot) : [];
  const extraDirs = [...new Set([...explicitDirs, ...discoveredDirs])];
  if (extraDirs.length > 0) {
    log(`🧩 Isolated package(s): ${extraDirs.map((d) => path.relative(cfg.workspaceRoot, d)).join(", ")}`);
  }

  // 1. Fetch all open npm alerts
  const alerts = await fetchDependabotAlerts({ owner: cfg.owner, name: cfg.name, token: cfg.token });

  // 2. Group alerts by manifest directory (plus root + extra dirs)
  const alertsByDir = groupAlertsByManifestDir(alerts, cfg.workspaceRoot, extraDirs);

  // 3. Process each manifest group independently
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalAlerts = 0;
  let totalNoInRangeFix = 0;
  let totalMultiLine = 0;
  const allRecommendations: DeploymentRecommendation[] = [];

  // Global set of all alerted package names across every group. Prevents a
  // package added as an override in one group from being treated as orphaned
  // and removed in another group's cleanup pass.
  const globalAlertedNames = new Set(alerts.map((a) => a.security_vulnerability.package.name));

  for (const [manifestDir, groupAlerts] of alertsByDir) {
    const result = await processManifestGroup(manifestDir, groupAlerts, cfg, ctx, rootPmId, globalAlertedNames);

    totalAlerts += result.alerts;
    totalAdded += result.added;
    totalRemoved += result.removed;
    totalNoInRangeFix += result.noInRangeFix;
    totalMultiLine += result.multiLine;
    allRecommendations.push(...result.recommendations);
  }

  // Summary
  log(`\n${"═".repeat(48)}`);
  log("📊 Summary:");
  log(`   Manifest groups processed : ${alertsByDir.size}`);
  log(`   Dependabot alerts checked : ${totalAlerts}`);
  log(`   Overrides added/updated   : ${totalAdded}`);
  log(`   Overrides removed         : ${totalRemoved}`);
  if (totalMultiLine > 0) {
    log(`   ℹ️  Multi-line advisory    : ${totalMultiLine}  (forced above the minimum — see issue #2)`);
  }
  if (totalNoInRangeFix > 0) {
    log(`   ⚠️  No in-range fix        : ${totalNoInRangeFix}  (escapes compatible range — verify dependents)`);
  }

  if (allRecommendations.length > 0) {
    log(`\n${"═".repeat(48)}`);
    logDeploymentRecommendation(allRecommendations);
  }
}
