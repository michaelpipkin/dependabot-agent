import { alertScope, baseNameOfOverrideKey, overrideFloor } from "../reconcile.js";
import { compareSemver, parseSemver, satisfiesVulnerableRange } from "../semver.js";
import { findInstalledVersions } from "../tree.js";
import type { DependabotAlert, DepScope, InstalledTree, OverrideChange } from "../types.js";

/**
 * What this run did to one alert.
 *
 *   update           the update pass moved the vulnerable copy to a patched version
 *                    (or, with no copy in the before tree, installed a patched one)
 *   override         an override written this run forces a patched version
 *   awaiting-close   a copy was installed before the run and every copy was already
 *                    patched; the alert is open only because GitHub hasn't re-scanned yet
 *   covered          an override from an earlier run already holds this package
 *   no-patch         the advisory has no patched version to move to
 *   not-installed    the package isn't in the tree, before or after
 *   still-vulnerable nothing this run did fixed it, and nothing explains why
 */
export type FixStatus =
  | "update"
  | "override"
  | "awaiting-close"
  | "covered"
  | "no-patch"
  | "not-installed"
  | "still-vulnerable";

export interface AlertFix {
  number: number;
  url?: string;
  severity: string;
  packageName: string;
  manifest: string;
  scope: DepScope;
  status: FixStatus;
  /** The vulnerable versions this run dealt with. Empty when it dealt with none. */
  from: string[];
  /** What the alert is fixed to: the installed versions after an update, or "≥ floor" for an override. */
  to?: string;
}

/** Only these two mean the run itself changed something that clears the alert. */
export const isFixed = (f: AlertFix): boolean => f.status === "update" || f.status === "override";

const byVersion = (a: string, b: string): number => {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) return compareSemver(pa, pb);
  if (pa) return -1; // unparseable sorts last
  if (pb) return 1;
  return a.localeCompare(b);
};

/**
 * The floor to show for an alert fixed by an override, or null when no change
 * this run fixes THIS alert. A package can be held by scoped keys on several
 * release lines (js-yaml@3 and js-yaml@4), and a change on another line says
 * nothing about this alert, so a change qualifies only when
 *
 *   - its key reaches a copy that is still vulnerable: an unscoped key reaches
 *     every copy, a scoped one (name@3) only copies on that major — otherwise a
 *     js-yaml@4 change would "fix" an alert whose copy is on 3.x, since 4.2.0 is
 *     neither below that copy nor inside its range;
 *   - its floor isn't below the lowest of those copies (a lower floor is a
 *     downgrade, not a fix); and
 *   - its floor isn't known to sit inside the alert's range (an unparseable range
 *     or floor counts as clearing, matching how an unparseable range counts as
 *     vulnerable everywhere else).
 *
 * The lowest qualifying floor wins.
 */
function qualifyingFloor(
  changes: OverrideChange[],
  packageName: string,
  range: string,
  vulnerableAfter: string[],
): string | null {
  const floors: string[] = [];
  for (const change of changes) {
    if (change.action === "remove" || !change.newVersion) continue;
    if (baseNameOfOverrideKey(change.packageName) !== packageName) continue;

    const selector = change.packageName.slice(packageName.length + 1);
    const line = /^\d+/.exec(selector)?.[0];
    const reached =
      line === undefined ? vulnerableAfter : vulnerableAfter.filter((v) => parseSemver(v)?.[0] === Number(line));
    if (reached.length === 0) continue;

    const floor = overrideFloor(change.newVersion);
    const p = parseSemver(floor);
    const lowest = parseSemver(reached[0]);
    if (p && lowest && compareSemver(p, lowest) < 0) continue;
    if (satisfiesVulnerableRange(floor, range) === true) continue;
    floors.push(floor);
  }
  floors.sort(byVersion);
  return floors[0] ?? null;
}

/**
 * One AlertFix per alert: did this run fix it, and if not, why not. Drives both
 * the report table and the deploy recommendation, so a wrong "fixed" tells
 * someone to deploy for nothing and a wrong "not fixed" can tell them to skip a
 * deploy they needed.
 *
 * A copy counts as vulnerable unless the alert's range provably excludes it, so an
 * unparseable range is vulnerable rather than a false all-clear.
 */
export function classifyAlerts(input: {
  alerts: DependabotAlert[];
  before: InstalledTree[];
  after: InstalledTree[];
  changes: OverrideChange[];
  overridesBefore: Record<string, string>;
}): AlertFix[] {
  const { alerts, before, after, changes, overridesBefore } = input;

  return alerts.map((alert) => {
    const vuln = alert.security_vulnerability;
    const packageName = alert.dependency.package.name;
    const range = vuln.vulnerable_version_range;
    const fix: AlertFix = {
      number: alert.number,
      url: alert.html_url,
      severity: alert.security_advisory.severity,
      packageName,
      manifest: alert.dependency.manifest_path,
      scope: alertScope(alert),
      status: "still-vulnerable",
      from: [],
    };
    const isVulnerable = (version: string): boolean => satisfiesVulnerableRange(version, range) !== false;

    if (!vuln.first_patched_version) return { ...fix, status: "no-patch" };

    const installedBefore = findInstalledVersions(packageName, before);
    const installedAfter = findInstalledVersions(packageName, after);
    if (installedBefore.length === 0 && installedAfter.length === 0) return { ...fix, status: "not-installed" };

    // Awaiting close needs a copy before the run to have been patched. With none
    // (nothing installed yet, or a tree that couldn't be read), the before tree
    // says nothing, so the after tree decides: a patched copy is the update's doing,
    // and a vulnerable one goes through the override rules below.
    const vulnerableBefore = installedBefore.filter(isVulnerable);
    if (installedBefore.length > 0 && vulnerableBefore.length === 0) return { ...fix, status: "awaiting-close" };

    const vulnerableAfter = installedAfter.filter(isVulnerable);
    if (vulnerableAfter.length === 0) {
      return { ...fix, status: "update", from: vulnerableBefore, to: installedAfter.length > 0 ? installedAfter.join(", ") : "removed" };
    }

    const floor = qualifyingFloor(changes, packageName, range, vulnerableAfter);
    if (floor !== null) return { ...fix, status: "override", from: vulnerableAfter, to: `≥ ${floor}` };

    if (Object.keys(overridesBefore).some((key) => baseNameOfOverrideKey(key) === packageName)) {
      return { ...fix, status: "covered", from: vulnerableAfter };
    }

    return { ...fix, from: vulnerableAfter };
  });
}
