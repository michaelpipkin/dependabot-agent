import { alertScope, baseNameOfOverrideKey, overrideFloor } from "../reconcile.js";
import { compareSemver, parseSemver, satisfiesVulnerableRange } from "../semver.js";
import { findInstalledVersions } from "../tree.js";
import type { DependabotAlert, DepScope, InstalledTree, OverrideChange } from "../types.js";

/**
 * What this run did to one alert.
 *
 *   update           the update pass moved the vulnerable copy to a patched version
 *   override         an override written this run forces a patched version
 *   awaiting-close   the copy was already patched before the run; the alert is open
 *                    only because GitHub hasn't re-scanned yet
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
 * The floor to show for an alert fixed by an override. With scoped keys on several
 * lines (js-yaml@3 and js-yaml@4) each alert must show the floor that clears ITS
 * range: the lowest floor outside the alert's range that isn't below the lowest
 * copy still vulnerable. The second condition is what keeps a 4.x alert from
 * showing the 3.x line's floor — that floor is outside its range too, but it's a
 * downgrade, not a fix. Falls back to the lowest floor outside the range, then to
 * the lowest floor.
 */
function floorFor(floors: string[], range: string, vulnerableAfter: string[]): string {
  const outside = floors.filter((f) => satisfiesVulnerableRange(f, range) === false).sort(byVersion);
  const lowestCopy = vulnerableAfter.length > 0 ? parseSemver(vulnerableAfter[0]) : null;
  const notBelowCopy = lowestCopy
    ? outside.filter((f) => {
        const p = parseSemver(f);
        return p !== null && compareSemver(p, lowestCopy) >= 0;
      })
    : outside;
  return notBelowCopy[0] ?? outside[0] ?? [...floors].sort(byVersion)[0];
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

    const vulnerableBefore = installedBefore.filter(isVulnerable);
    if (vulnerableBefore.length === 0) return { ...fix, status: "awaiting-close" };

    const vulnerableAfter = installedAfter.filter(isVulnerable);
    if (vulnerableAfter.length === 0) {
      return { ...fix, status: "update", from: vulnerableBefore, to: installedAfter.join(", ") };
    }

    const floors = changes
      .filter((c) => c.action !== "remove" && c.newVersion && baseNameOfOverrideKey(c.packageName) === packageName)
      .map((c) => overrideFloor(c.newVersion!));
    if (floors.length > 0) {
      return { ...fix, status: "override", from: vulnerableAfter, to: `≥ ${floorFor(floors, range, vulnerableAfter)}` };
    }

    if (Object.keys(overridesBefore).some((key) => baseNameOfOverrideKey(key) === packageName)) {
      return { ...fix, status: "covered", from: vulnerableAfter };
    }

    return { ...fix, from: vulnerableAfter };
  });
}
