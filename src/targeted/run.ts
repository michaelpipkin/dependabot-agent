import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { BaselineFallback } from "../baseline/source.js";
import type { VersionIndex } from "../baseline/versions.js";
import type { ResolvedConfig } from "../config.js";
import { discoverIsolatedManifestDirs, hasOwnLockfile } from "../discover.js";
import { fetchDependabotAlerts, readDependabotAlertsFile } from "../github.js";
import { readDirectDependencies } from "../manifest.js";
import type { DirectDep } from "../manifest.js";
import { readNpmOverrides } from "../override-source.js";
import { detectPackageManager } from "../package-manager/index.js";
import {
  baselineContextFor,
  boundedWarnings,
  fallbackOf,
  highestOverrideFloor,
  judgeOrphanedOverride,
  loadBearingAlertNames,
  readGroupBaseline,
  resolvePmForDir,
} from "../reconcile.js";
import type { RunResult } from "../reconcile.js";
import { fetchDependentRanges, readAdvisories, readPublishedPackage, usableRange } from "../registry.js";
import { compareSemver, parseSemver, satisfiesVulnerableRange } from "../semver.js";
import type { DependabotAlert, DependentRange } from "../types.js";
import { AgentError, exitWithError, log, warn } from "../util.js";
import { applyPlan, npmVersion, snapshotFiles, tryRemoveOverride } from "./apply.js";
import type { NpmRunner, Snapshot } from "./apply.js";
import { copiesOf, edgesOf, edgesTo, hasOldLockfile, readLockfile } from "./lockfile.js";
import type { LockEntry, LockIndex } from "./lockfile.js";
import { isAgentAuthoredOverride, selectorKeyName } from "./override-keys.js";
import { unprocessedAlert } from "./plan.js";
import type { AlertOutcome, Block, ManifestInfo, Plan, PlanInput } from "./plan.js";
import { computeOutcome, renderMarkdown, writeReport } from "./report.js";
import type { RunReport } from "./report.js";
import { ruleOut, solvePlan } from "./requirements.js";
import type { PublishedPackage, ReadAdvisories, ReadPackage, Solved } from "./requirements.js";
import { treeProblems } from "./verify.js";
import type { VerificationFailure } from "./verify.js";

export interface TargetedDeps {
  fetchAlerts: (cfg: ResolvedConfig) => Promise<DependabotAlert[]>;
  /** A package's published versions and what each asks of others, null if the registry has no such package. Any other failure throws. */
  fetchPackage: ReadPackage;
  /** The advisories touching the versions asked about. A failure throws, and the report says the check didn't run. */
  fetchAdvisories: ReadAdvisories;
  /** What a dependent declares for a package at its latest release (its installed range comes from the lockfile). */
  fetchDependents: typeof fetchDependentRanges;
  /** The npm this run uses, or null if it can't be read. */
  npmVersion: (cwd: string) => string | null;
  run?: NpmRunner;
}

const defaultDeps: TargetedDeps = {
  fetchAlerts: async (cfg) =>
    cfg.alertsFile ? readDependabotAlertsFile(cfg.alertsFile) : fetchDependabotAlerts({ owner: cfg.owner, name: cfg.name, token: cfg.token }),
  fetchPackage: readPublishedPackage,
  fetchAdvisories: readAdvisories,
  fetchDependents: fetchDependentRanges,
  npmVersion,
};

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const posix = (p: string): string => p.split(path.sep).join("/");
const sameDir = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Stop before any write if any directory in the run is managed by pnpm. */
export function assertTargetedSupported(dirs: string[], cfg: ResolvedConfig): void {
  const rootPmId = cfg.packageManager ?? detectPackageManager(cfg.workspaceRoot) ?? "npm";
  for (const dir of dirs) {
    const isRoot = sameDir(dir, cfg.workspaceRoot);
    if (resolvePmForDir(dir, isRoot, rootPmId, cfg) !== "pnpm") continue;
    const where = isRoot ? `the workspace root (${dir})` : `the isolated package "${posix(path.relative(cfg.workspaceRoot, dir))}"`;
    exitWithError(
      `The targeted strategy supports npm only, but ${where} uses pnpm. ` +
        `Use the compatible or latest strategy for this repository.`,
    );
  }
}

/**
 * Put each alert in the group of the nearest directory at or above its manifest that has a
 * lockfile of its own. The shared grouping folds anything below an isolated package into
 * the root, which would look for it in the wrong lockfile; this strategy reads each one.
 */
export function groupAlertsByNearestLockfile(
  alerts: DependabotAlert[],
  workspaceRoot: string,
  extraDirs: string[],
): Map<string, DependabotAlert[]> {
  const owners = [workspaceRoot, ...extraDirs];
  const resolved = owners.map((dir) => path.resolve(dir));
  const groups = new Map<string, DependabotAlert[]>();
  for (const alert of alerts) {
    const at = path.resolve(workspaceRoot, path.dirname(alert.dependency.manifest_path));
    let best = 0;
    resolved.forEach((owner, i) => {
      const contains = at === owner || at.startsWith(owner + path.sep);
      if (contains && owner.length >= resolved[best].length) best = i;
    });
    const dir = owners[best];
    groups.set(dir, [...(groups.get(dir) ?? []), alert]);
  }
  for (const dir of owners) {
    if (!groups.has(dir)) groups.set(dir, []);
  }
  return groups;
}

/** The directory at or above `from` that manages its own install: an owner, or one with a lockfile of its own. */
function nearestLockfileDir(root: string, from: string, owners: Set<string>): string {
  let dir = from;
  while (dir !== root && dir !== path.dirname(dir)) {
    if (owners.has(dir) || hasOwnLockfile(dir)) return dir;
    dir = path.dirname(dir);
  }
  return root;
}

/** What an alert's manifest may be called for this run to answer it. pnpm-lock.yaml goes on to the pnpm check, and is refused if that passes. */
const MANIFEST_FILES = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml"]);

const notReadDetail = (manifest: string): string =>
  `${manifest} is a lockfile this run doesn't read: it fixes package-lock.json only, so a change here wouldn't close this alert.`;

/** Whether the lockfile in `dir` holds `at`, a directory below it, as a workspace member or `file:` package. */
function lockfileHolds(dir: string, at: string): boolean {
  // Nothing to look in: the group's own read of this directory stops the run and says why.
  if (!existsSync(path.join(dir, "package-lock.json")) || hasOldLockfile(dir)) return true;
  const relative = posix(path.relative(dir, at));
  return !/(^|\/)node_modules\//.test(relative) && readLockfile(dir).entries.has(relative);
}

/** Once the pnpm checks have passed, a pnpm-lock.yaml alert means the config forced npm, and nothing here reads that file. */
function refusePnpmLockAlerts(placed: PlacedAlerts): void {
  const isPnpmLock = (alert: DependabotAlert): boolean => path.basename(alert.dependency.manifest_path) === "pnpm-lock.yaml";
  for (const alert of placed.processed.filter(isPnpmLock)) {
    placed.unprocessed.push(unprocessedAlert(alert, notReadDetail(alert.dependency.manifest_path)));
  }
  placed.processed = placed.processed.filter((alert) => !isPnpmLock(alert));
}

interface PlacedAlerts {
  /** The alerts some lockfile in this run answers for. */
  processed: DependabotAlert[];
  /** Directories that only an alert brought in: discovery prunes them, but they have a lockfile of their own. */
  addedDirs: string[];
  /** The alerts no lockfile in this run answers for. Reported as blocked, and never folded into the root. */
  unprocessed: AlertOutcome[];
}

/**
 * Decide which alerts this run can answer for. The grouping below folds whatever isn't
 * under an owner into the root, which is right for a workspace member and wrong for
 * anything else: the root's lockfile would say "nothing to change", or fix a copy the
 * alert isn't about, while the real alert stayed open.
 */
function placeAlerts(open: DependabotAlert[], cfg: ResolvedConfig, extraDirs: string[]): PlacedAlerts {
  const root = path.resolve(cfg.workspaceRoot);
  const owners = new Set([root, ...extraDirs.map((dir) => path.resolve(dir))]);
  const placed: PlacedAlerts = { processed: [], addedDirs: [], unprocessed: [] };
  for (const alert of open) {
    const manifest = alert.dependency.manifest_path;
    const refuse = (detail: string): void => void placed.unprocessed.push(unprocessedAlert(alert, detail));
    const at = path.resolve(root, path.dirname(manifest));
    if (isOutside(root, at)) {
      refuse(`${manifest} is outside the repository, so this run can't read it.`);
      continue;
    }
    if (!existsSync(at)) {
      refuse(`The directory holding ${manifest} no longer exists, so no lockfile here answers for this alert. Check that GitHub has rescanned, or dismiss the alert.`);
      continue;
    }
    if (!MANIFEST_FILES.has(path.basename(manifest))) {
      refuse(notReadDetail(manifest));
      continue;
    }
    const dir = nearestLockfileDir(root, at, owners);
    const isOwner = owners.has(dir);
    if (!isOwner && !existsSync(path.join(dir, "package.json"))) {
      refuse(`${manifest} is covered by a lockfile in ${posix(path.relative(root, dir))}, which has no package.json, so this run can't read it.`);
    } else if (!isOwner && !cfg.discoverPackages) {
      refuse(`${manifest} is covered by the lockfile in ${posix(path.relative(root, dir))}, which this run doesn't process because discoverPackages is off. Turn it on, or list that directory under "packages".`);
    } else if (at !== dir && !lockfileHolds(dir, at)) {
      refuse(`${manifest} has no package-lock.json of its own, and the lockfile in ${posix(path.relative(root, dir)) || "the root"} doesn't hold that directory as a package, so nothing this run reads answers for this alert.`);
    } else {
      placed.processed.push(alert);
      if (!isOwner && !placed.addedDirs.includes(dir)) placed.addedDirs.push(dir);
    }
  }
  return placed;
}

// ---------------------------------------------------------------------------
// One lockfile's worth of work
// ---------------------------------------------------------------------------

interface Group {
  dir: string;
  /** "root", or the directory relative to the workspace root, as the other strategies label it. */
  label: string;
  /** The directory relative to the workspace root, with forward slashes; empty for the root. */
  prefix: string;
  manifests: ManifestInfo[];
  /** The lockfile as the run found it. */
  before: LockIndex;
  /** What the plan was made from: a retry makes it again with an alert ruled out. */
  input: PlanInput;
  plan: Plan;
  /** For a package moving only because of another, the packages it comes down to. */
  drivers: Solved["drivers"];
  raised: Solved["raised"];
  /** Every file this group's run may write. */
  files: string[];
}

/** The lockfile paths that a `file:` spec resolves to: packages that npm links in but that aren't workspace members. */
function fileDependencyPaths(lock: LockIndex): Set<string> {
  const paths = new Set<string>();
  for (const edge of edgesOf(lock)) {
    const target = edge.resolved?.path;
    if (edge.spec.trim().startsWith("file:") && target && target !== "" && !target.includes("node_modules/")) paths.add(target);
  }
  return paths;
}

/** Whether a directory is outside the root: nothing there is read, snapshotted or written. */
function isOutside(root: string, target: string): boolean {
  const relative = posix(path.relative(root, target));
  return relative === ".." || relative.startsWith("../") || path.isAbsolute(relative);
}

/** What the lockfile records a package as declaring, for one that isn't read from disk. */
function declaredInLock(entry: LockEntry): DirectDep[] {
  const fields = ["dependencies", "devDependencies", "optionalDependencies"] as const;
  return fields.flatMap((field) => Object.entries(entry[field]).map(([name, spec]) => ({ name, spec, field })));
}

/**
 * The root and every package the lockfile holds at its own path (no node_modules, not a
 * link). Read from the lockfile, so it doesn't depend on how a workspace glob is written:
 * whatever isn't reached by a `file:` spec is a workspace member. A `file:` package counts
 * for pins and declarations but is marked, since npm can't `-w` it. One outside the root is
 * never read from disk (it may not be checked out), and so can't be snapshotted or written:
 * its declarations come from the lockfile.
 */
function manifestsOf(dir: string, lock: LockIndex): ManifestInfo[] {
  const manifests: ManifestInfo[] = [{ dir, lockPath: "", deps: readDirectDependencies(dir) }];
  const filePaths = fileDependencyPaths(lock);
  for (const [lockPath, entry] of lock.entries) {
    if (lockPath === "" || posix(lockPath).includes("node_modules/") || entry.link) continue;
    const memberDir = path.resolve(dir, lockPath);
    const external = isOutside(dir, memberDir);
    const file = external || filePaths.has(lockPath);
    const onDisk = !external && existsSync(path.join(memberDir, "package.json"));
    if (!onDisk && !file) {
      exitWithError(`${lockPath} is a workspace member in ${path.join(dir, "package-lock.json")}, but ${path.join(memberDir, "package.json")} doesn't exist.`);
    }
    manifests.push({
      dir: memberDir,
      lockPath,
      deps: onDisk ? readDirectDependencies(memberDir) : declaredInLock(entry),
      ...(file ? { notWorkspace: true } : {}),
      ...(external ? { external: true } : {}),
    });
  }
  return manifests;
}

const pathLabel = (group: Group, lockPath: string): string => {
  if (!group.prefix) return lockPath || "(root)";
  return lockPath ? `${group.prefix}/${lockPath}` : group.prefix;
};

/**
 * The group's alerts as the report shows them: a plan speaks in its own lockfile's paths,
 * which a report across several lockfiles has to place. The root's already read correctly.
 */
function reportedAlerts(group: Group): AlertOutcome[] {
  if (!group.prefix) return group.plan.alerts;
  return group.plan.alerts.map((alert) => ({
    ...alert,
    copies: alert.copies.map((copy) => ({
      ...copy,
      path: `${group.prefix}/${copy.path}`,
      ...(copy.detail ? { detail: `In ${group.label}: ${copy.detail}` } : {}),
    })),
  }));
}

/** Versions that changed, appeared or went away at the paths the plan didn't name, relocated targets included. */
function otherChangesOf(group: Group, after: LockIndex): RunReport["otherChanges"] {
  const out: RunReport["otherChanges"] = [];
  for (const lockPath of new Set([...group.before.entries.keys(), ...after.entries.keys()])) {
    if (group.plan.targets.has(lockPath)) continue;
    const from = group.before.entries.get(lockPath)?.version;
    const to = after.entries.get(lockPath)?.version;
    if (from === to) continue;
    out.push({ path: pathLabel(group, lockPath), ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orphaned overrides
// ---------------------------------------------------------------------------

const KEPT_MOVES = "Removing it changes the lockfile, so it was kept. Remove it by hand once you have checked what moves.";

interface OrphanContext {
  loadBearing: Set<string>;
  everAlerted: Set<string>;
  deps: TargetedDeps;
}

/** An override the agent wrote that is judged no longer needed. */
interface RemovableOverride {
  key: string;
  floor: string;
}

/**
 * Who depends on `name`, for judging whether an override is still needed. Read from the
 * lockfile, since `npm explain` needs node_modules, and the lockfile is also what knows the
 * range each dependent really declares, private packages and workspace members included.
 * Only the latest release's range comes from the registry, for an installed dependent.
 */
async function dependentsOf(lock: LockIndex, name: string, deps: TargetedDeps): Promise<DependentRange[]> {
  const out: DependentRange[] = [];
  const seen = new Set<string>();
  for (const edge of edgesTo(lock, name)) {
    const from = lock.entries.get(edge.from);
    if (!from || edge.resolved?.name !== name) continue;
    const version = from.version ?? "0.0.0";
    const id = `${from.name}@${version}|${edge.spec}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const installedRange = usableRange(edge.spec);
    // The root and workspace members are the repo's own: their manifests are the latest.
    const installed = edge.from.includes("node_modules/") && from.version !== undefined;
    const latest = installed ? await deps.fetchDependents(from.name, from.version!, name) : null;
    out.push({
      dependent: from.name || "root",
      version,
      installedRange,
      latestRange: latest ? latest.latestRange : installedRange,
      latestKnown: latest ? latest.latestKnown : true,
    });
  }
  return out;
}

function highestVersion(lock: LockIndex, name: string): string | undefined {
  return copiesOf(lock, name)
    .map((copy) => copy.version)
    .filter((v): v is string => v !== undefined && parseSemver(v) !== null)
    .sort((a, b) => compareSemver(parseSemver(a)!, parseSemver(b)!))
    .at(-1);
}

/**
 * The overrides the agent wrote whose alert is fixed and whose dependents no longer need
 * them. Read-only. Only a `remove` verdict counts: on a tree reachable only through
 * workspace members npm doesn't revisit the copy, so "nothing moved" alone proves little.
 */
async function judgeOrphans(group: Group, ctx: OrphanContext): Promise<RemovableOverride[]> {
  const flat = readNpmOverrides(group.dir).flat;
  const byBase = new Map<string, string[]>();
  for (const [key, spec] of Object.entries(flat)) {
    const base = selectorKeyName(key);
    if (!isAgentAuthoredOverride(key, spec) || ctx.loadBearing.has(base) || !ctx.everAlerted.has(base)) continue;
    byBase.set(base, [...(byBase.get(base) ?? []), key]);
  }

  const removable: RemovableOverride[] = [];
  const lock = readLockfile(group.dir);
  for (const [base, keys] of byBase) {
    const floor = highestOverrideFloor(keys.map((k) => flat[k]));
    const verdict = judgeOrphanedOverride(await dependentsOf(lock, base, ctx.deps), floor, highestVersion(lock, base));
    if (verdict.action === "remove") removable.push(...keys.map((key) => ({ key, floor })));
    else log(`   Keeping the override for ${base} (${verdict.action}).`);
  }
  return removable;
}

/** The first lockfile problem a removal introduced, as a reason to keep the override. */
function introducedProblem(dir: string, before: Set<string>): string | null {
  const after = treeProblems(readLockfile(dir), readNpmOverrides(dir).flat);
  const introduced = [...after].filter((problem) => !before.has(problem));
  if (introduced.length === 0) return null;
  const more = introduced.length > 1 ? ` (and ${introduced.length - 1} more)` : "";
  return `Removing it would leave ${introduced[0]} outside what its dependent declares${more}, so it was kept.`;
}

const whyRemovable = (floor: string, applied: boolean): string =>
  `Its alert is fixed and every dependent now asks for ${floor} or later.${applied ? " Removing it moved no locked version." : ""}`;

/**
 * Remove each judged override, keeping a removal only if it moves no version and breaks
 * nothing in the tree.
 */
async function removeOrphans(group: Group, ctx: OrphanContext, run: NpmRunner | undefined): Promise<{ removed: RunReport["removedOverrides"]; kept: RunReport["keptOverrides"] }> {
  const removed: RunReport["removedOverrides"] = [];
  const kept: RunReport["keptOverrides"] = [];
  for (const { key, floor } of await judgeOrphans(group, ctx)) {
    const problemsBefore = treeProblems(readLockfile(group.dir), readNpmOverrides(group.dir).flat);
    const snapshot = snapshotFiles([path.join(group.dir, "package.json"), path.join(group.dir, "package-lock.json")]);
    if (!tryRemoveOverride(group.dir, key, run)) {
      kept.push({ key, reason: KEPT_MOVES });
      continue;
    }
    const problem = introducedProblem(group.dir, problemsBefore);
    if (problem) {
      snapshot.restore();
      kept.push({ key, reason: problem });
      continue;
    }
    log(`   Removed the override ${key}: it is no longer needed and nothing moved.`);
    removed.push({ key, reason: whyRemovable(floor, true) });
  }
  return { removed, kept };
}

// ---------------------------------------------------------------------------
// The baseline the deploy box compares with
// ---------------------------------------------------------------------------

/** Whether the baseline's lockfile has a copy of the alert's package in the alert's vulnerable range, unknown versions included. */
function wasVulnerable(index: VersionIndex, alert: DependabotAlert): boolean {
  const { package: pkg, vulnerable_version_range: range } = alert.security_vulnerability;
  return (index.get(pkg.name) ?? []).some((version) => satisfiesVulnerableRange(version, range) !== false);
}

/**
 * Reads each lockfile with open alerts at the baseline, the way the other strategies do, and
 * names the alerts whose package was vulnerable there. A lockfile that can't be read at the
 * baseline falls back on its own, with a warning; its alerts all count, as in 1.4.0. When no
 * lockfile could be read at the baseline `baselineVulnerable` is left unset. Never throws.
 */
async function readBaseline(groups: Group[], cfg: ResolvedConfig): Promise<Pick<RunReport, "baseline" | "baselineVulnerable" | "warnings">> {
  const bctx = baselineContextFor(cfg);
  const vulnerable: number[] = [];
  const fallbacks: BaselineFallback[] = [];
  const warnings: string[] = [];
  let withAlerts = 0;
  let readable = 0;
  for (const group of groups.filter((g) => g.input.alerts.length > 0)) {
    withAlerts++;
    const read = await readGroupBaseline(bctx, "npm", path.join(group.dir, "package-lock.json"));
    warnings.push(...read.warnings);
    const fallback = fallbackOf(read.baseline, bctx.requested, group.label, read.reason);
    if (fallback) fallbacks.push(fallback);
    if (read.indexes) {
      readable++;
      vulnerable.push(...group.input.alerts.filter((a) => wasVulnerable(read.indexes!.baseline, a)).map((a) => a.number));
    } else {
      vulnerable.push(...group.input.alerts.map((a) => a.number));
    }
  }
  return {
    baseline: { ...bctx.requested, fallbacks },
    ...(withAlerts === 0 || readable > 0 ? { baselineVulnerable: [...new Set(vulnerable)].sort((a, b) => a - b) } : {}),
    ...(warnings.length > 0 ? { warnings: boundedWarnings(warnings) } : {}),
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const readBytes = (file: string): Buffer | null => (existsSync(file) ? readFileSync(file) : null);

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}

const blockedCountOf = (alerts: RunReport["alerts"]): number =>
  alerts.flatMap((alert) => alert.copies).filter((copy) => copy.action === "blocked").length;

/** What the plan changes; a plan that only has copies to move still runs npm, so it counts as one. */
const plannedChangesOf = (plan: Plan): number => {
  const count = plan.bumps.length + Object.keys(plan.addOverrides).length + plan.removeOverrideKeys.length;
  return count === 0 && plan.targets.size > 0 ? 1 : count;
};

/** Facts about the run so far, for a failure report that can't rely on the plan having been made. */
interface RunState {
  npmVersion: string | null;
  alerts: RunReport["alerts"];
  reported: boolean;
  /** Restoring the snapshot has been tried. */
  restored: boolean;
  /** Set if it failed: the files may be left half-changed. */
  restoreError?: string;
}

/** Put every file back. A failure is kept, not thrown, so it can't hide the error that made the restore necessary. */
function restoreAll(snapshot: Snapshot, state: RunState): void {
  state.restored = true;
  try {
    snapshot.restore();
  } catch (e) {
    state.restoreError = messageOf(e);
    warn(state.restoreError);
  }
}

const restoreNote = (state: RunState): string =>
  state.restoreError
    ? `Restoring the files failed, so the working tree may hold partial changes: ${state.restoreError}`
    : "Every file was restored to how it was before the run.";

type ReportBase = Pick<
  RunReport,
  "dryRun" | "blockedCount" | "alerts" | "npmVersion" | "movedWith" | "advised" | "advisoriesUnchecked" | "baseline" | "baselineVulnerable" | "warnings"
>;

/** Write the report if asked to, and print it. A write that fails says so, and names the directory. */
function publish(report: RunReport, cfg: ResolvedConfig, state: RunState): void {
  if (cfg.reportDir) {
    try {
      writeReport(cfg.reportDir, report);
    } catch (e) {
      throw new AgentError(`Could not write the report to ${cfg.reportDir}: ${messageOf(e)}`);
    }
  }
  state.reported = true;
  log(`\n${renderMarkdown(report)}`);
}

/** A failed run's report must never hide why the run failed, so a failure to write it is only a warning. */
function publishFailed(failures: VerificationFailure[], base: ReportBase, cfg: ResolvedConfig, state: RunState): void {
  const report: RunReport = {
    ...base,
    outcome: "failed",
    otherChanges: [],
    keptOverrides: [],
    removedOverrides: [],
    failures,
    ...(state.restoreError ? { restoreError: state.restoreError } : {}),
  };
  // Set first: if the write fails, the cause is still this report's failure, not a new one made of the write error.
  state.reported = true;
  try {
    publish(report, cfg, state);
  } catch (e) {
    warn(messageOf(e));
    log(`\n${renderMarkdown(report)}`);
  }
}

function failureMessage(group: Group, failures: VerificationFailure[], state: RunState): string {
  const [first, ...rest] = failures;
  const where = first.path ? ` on ${first.path}` : "";
  const more = rest.length > 0 ? ` (and ${rest.length} more)` : "";
  const detail = first.detail.split("\n")[0].replace(/\.$/, "");
  return (
    `The targeted run failed${first.check === "run" ? "" : " verification"} in ${group.label}: ${first.check}${where}: ${detail}${more}. ` +
    restoreNote(state)
  );
}

/** Read every group's lockfile and plan it, before any write, so a lockfile that can't be read stops the run clean. */
async function planGroups(
  cfg: ResolvedConfig,
  deps: TargetedDeps,
  open: DependabotAlert[],
  extraDirs: string[],
): Promise<Group[]> {
  const published = new Map<string, string[] | null>();
  const groups: Group[] = [];
  const read = once(deps.fetchPackage);
  for (const [dir, alerts] of groupAlertsByNearestLockfile(open, cfg.workspaceRoot, extraDirs)) {
    const prefix = sameDir(dir, cfg.workspaceRoot) ? "" : posix(path.relative(cfg.workspaceRoot, dir));
    const label = prefix || "root";
    // Nothing is asked of it, so a lockfile this strategy can't read shouldn't stop the others.
    if (prefix && alerts.length === 0 && hasOldLockfile(dir)) {
      warn(`Skipping ${label}: it has no open alerts, and its lockfile is older than the lockfileVersion 2 this strategy reads.`);
      continue;
    }
    log(`\n📂 Planning ${label} (${alerts.length} open alert(s)) [npm]`);

    const lock = readLockfile(dir);
    const manifests = manifestsOf(dir, lock);
    const input: PlanInput = {
      alerts,
      lock,
      manifests,
      overrides: readNpmOverrides(dir),
      limits: cfg.limits,
      published,
      updateWorkspaceMembers: cfg.updateWorkspaceMembers,
      manifestPrefix: prefix,
      moveTogether: cfg.moveTogether,
    };
    const { plan, drivers, raised } = await solvePlan(input, read, deps.fetchAdvisories);
    const manifestFiles = manifests.filter((m) => !m.external).map((m) => path.join(m.dir, "package.json"));
    // npm writes to a shrinkwrap when there is one, so a failed run has to put it back too.
    const shrinkwrap = path.join(dir, "npm-shrinkwrap.json");
    const files = [...new Set([path.join(dir, "package.json"), path.join(dir, "package-lock.json"), ...(existsSync(shrinkwrap) ? [shrinkwrap] : []), ...manifestFiles])];
    groups.push({ dir, label, prefix, manifests, before: lock, input, plan, drivers, raised, files });
  }
  return groups;
}

/** Each package read at most once across a run's lockfiles and its retries. */
function once(read: ReadPackage): ReadPackage {
  const seen = new Map<string, Promise<PublishedPackage | null>>();
  return (name) => {
    const known = seen.get(name);
    if (known) return known;
    const reading = read(name);
    seen.set(name, reading);
    return reading;
  };
}

/** How many times to retry one lockfile without what failed, before giving up on it. */
const MAX_RETRIES = 5;

/** The package a verification failure comes down to, if it names one that's moving. */
function culpritOf(failure: VerificationFailure, group: Group, moving: Set<string>): string | null {
  const named = (name: string | undefined): string | null => (name && moving.has(name) ? name : null);
  switch (failure.check) {
    case "fixed":
    case "limits-held":
      return failure.path ? named(group.before.entries.get(failure.path)?.name) : null;
    case "tree-complete": {
      const [from, to] = failure.detail.split(" -> ");
      return named(group.before.entries.get(from)?.name) ?? named(/^(@?[^@]+)@/.exec(to ?? "")?.[1]);
    }
    case "run": {
      // npm error Could not resolve dependency:
      // npm error peer core@"1.2.25" from forms@1.2.25
      const edge = /Could not resolve dependency:\s*npm error (?:(?:dev|optional|peer|peerOptional)\s+)?(@?[^@\s]+)@\S+(?: from (@?[^@\s]+)@)?/.exec(failure.detail);
      return named(edge?.[1]) ?? named(edge?.[2]);
    }
    default:
      return null;
  }
}

/** The raises past a fix these failures could come down to. A failure naming no package could be any of them. */
function raisesBehindFailures(group: Group, failures: VerificationFailure[], moving: Set<string>): string[] {
  const out = new Set<string>();
  for (const failure of failures) {
    const culprit = culpritOf(failure, group, moving);
    const behind = culprit ? new Set([culprit, ...(group.drivers.get(culprit) ?? [])]) : null;
    for (const name of group.raised) {
      const related = !behind || behind.has(name) || [...(group.drivers.get(name) ?? [])].some((driver) => behind.has(driver));
      if (related) out.add(name);
    }
  }
  return [...out];
}

/** The alerts on the copy a failure names, or on every copy of the package if it names none. */
function alertsOnCopy(group: Group, failure: VerificationFailure, culprit: string): DependabotAlert[] {
  const version = failure.path ? group.before.entries.get(failure.path)?.version : undefined;
  return group.input.alerts.filter((alert) => {
    const { package: pkg, vulnerable_version_range: range } = alert.security_vulnerability;
    return pkg.name === culprit && (version === undefined || satisfiesVulnerableRange(version, range) !== false);
  });
}

/**
 * Rule out every alert the failures come down to, and plan the group again without them.
 * False if nothing could be ruled out: the failure isn't tied to any fix, so it stands.
 */
async function replanWithout(group: Group, failures: VerificationFailure[], read: ReadPackage, readAdvisoriesOf: ReadAdvisories): Promise<boolean> {
  const moving = new Set([...group.plan.targets.keys()].flatMap((path) => group.before.entries.get(path)?.name ?? []));
  const replan = async (): Promise<boolean> => {
    const { plan, drivers, raised } = await solvePlan(group.input, read, readAdvisoriesOf);
    group.plan = plan;
    group.drivers = drivers;
    group.raised = raised;
    return true;
  };
  // Going past the fix was optional, so that goes first: the fix itself may well verify.
  const raises = raisesBehindFailures(group, failures, moving);
  if (raises.length > 0) {
    group.input = { ...group.input, declinedRaises: new Set([...(group.input.declinedRaises ?? []), ...raises]) };
    return replan();
  }
  const excluded = new Map(group.input.excluded);
  const sizeBefore = excluded.size;
  for (const failure of failures) {
    const culprit = culpritOf(failure, group, moving);
    if (!culprit) continue;
    const detail = failure.detail.split("\n").slice(0, 3).join(" ").replace(/\.$/, "");
    const block: Block = {
      reason: "failed-verification",
      detail: `The run couldn't move ${culprit} and pass verification, so this was left alone: ${detail}.`,
    };
    // What pushed it there goes first: on its own, the package may still take a lower fix.
    if (ruleOut(group.input, group.plan, group.drivers.get(culprit) ?? new Set(), block, excluded)) continue;
    for (const alert of alertsOnCopy(group, failure, culprit)) {
      if (!excluded.has(alert)) excluded.set(alert, block);
    }
  }
  if (excluded.size === sizeBefore) return false;
  group.input = { ...group.input, excluded };
  return replan();
}

/** The report's view of every group's plan, as it stands. */
function refreshBase(base: ReportBase, groups: Group[], unprocessed: AlertOutcome[], state: RunState): void {
  base.alerts = [...groups.flatMap(reportedAlerts), ...unprocessed];
  base.blockedCount = blockedCountOf(base.alerts);
  base.movedWith = groups.flatMap((group) =>
    (group.plan.movedWith ?? []).map((moved) => (groups.length > 1 ? { ...moved, because: `In ${group.label}: ${moved.because}` } : moved)),
  );
  base.advised = groups.flatMap((group) =>
    (group.plan.advised ?? []).map((advised) => (groups.length > 1 ? { ...advised, name: `${advised.name} (in ${group.label})` } : advised)),
  );
  const unchecked = groups.find((group) => group.plan.advisoriesUnchecked)?.plan.advisoriesUnchecked;
  if (unchecked) base.advisoriesUnchecked = unchecked;
  else delete base.advisoriesUnchecked;
  state.alerts = base.alerts;
}

/**
 * Apply each group's plan. What ends up in the files has passed every check. A failure tied to
 * a package puts that lockfile's files back and tries again without the alerts it comes down to,
 * which are reported as blocked. Any other failure, or one too many retries, restores every file
 * in every group, writes the report, and exits with an error.
 */
async function applyGroups(
  groups: Group[],
  cfg: ResolvedConfig,
  deps: TargetedDeps,
  base: ReportBase,
  unprocessed: AlertOutcome[],
  snapshot: Snapshot,
  state: RunState,
): Promise<number> {
  const read = once(deps.fetchPackage);
  let applied = 0;
  for (const group of groups) {
    const groupSnapshot = snapshotFiles(group.files);
    for (let attempt = 0; ; attempt++) {
      const planned = plannedChangesOf(group.plan);
      if (planned > 0) log(`\n🔧 Applying ${group.label}`);
      const failures = applyPlan(group.dir, group.plan, { limits: cfg.limits, manifests: group.manifests, run: deps.run });
      if (failures.length === 0) {
        applied += planned;
        break;
      }
      if (attempt < MAX_RETRIES && (await replanWithout(group, failures, read, deps.fetchAdvisories))) {
        groupSnapshot.restore();
        refreshBase(base, groups, unprocessed, state);
        log(`   That didn't verify. Trying ${group.label} again without what failed:\n${failures.map((f) => `     ${f.check}: ${f.detail.split("\n")[0]}`).join("\n")}`);
        continue;
      }
      restoreAll(snapshot, state);
      const named = groups.length > 1 ? failures.map((f) => ({ ...f, detail: `In ${group.label}: ${f.detail}` })) : failures;
      publishFailed(named, base, cfg, state);
      exitWithError(failureMessage(group, failures, state));
    }
  }
  return applied;
}

const inGroup = <T extends { reason: string }>(groups: Group[], group: Group, items: T[]): T[] =>
  groups.length > 1 ? items.map((item) => ({ ...item, reason: `In ${group.label}: ${item.reason}` })) : items;

/** Orphan removal across every group, after all the fixes are in. */
async function removeOrphansIn(groups: Group[], ctx: OrphanContext, run: NpmRunner | undefined) {
  const removed: RunReport["removedOverrides"] = [];
  const kept: RunReport["keptOverrides"] = [];
  for (const group of groups) {
    const result = await removeOrphans(group, ctx, run);
    removed.push(...inGroup(groups, group, result.removed));
    kept.push(...inGroup(groups, group, result.kept));
  }
  return { removed, kept };
}

/** A dry run's version of the above: what it would try, without touching anything. */
async function previewOrphans(groups: Group[], ctx: OrphanContext): Promise<RunReport["removedOverrides"]> {
  const out: RunReport["removedOverrides"] = [];
  for (const group of groups) {
    const items = (await judgeOrphans(group, ctx)).map(({ key, floor }) => ({ key, reason: whyRemovable(floor, false) }));
    out.push(...inGroup(groups, group, items));
  }
  return out;
}

async function execute(cfg: ResolvedConfig, deps: TargetedDeps, state: RunState): Promise<RunResult> {
  // Every directory that has its own lockfile: the root, plus isolated packages found or configured.
  const explicitDirs = cfg.packages.map((p) => path.resolve(cfg.workspaceRoot, p));
  const discoveredDirs = cfg.discoverPackages ? discoverIsolatedManifestDirs(cfg.workspaceRoot) : [];
  const extraDirs = [...new Set([...explicitDirs, ...discoveredDirs])];
  if (extraDirs.length > 0) {
    log(`🧩 Isolated package(s): ${extraDirs.map((d) => path.relative(cfg.workspaceRoot, d)).join(", ")}`);
  }
  assertTargetedSupported([cfg.workspaceRoot, ...extraDirs], cfg);

  // Alerts of every state: open ones are fixed, and the rest decide which overrides may be removed.
  const allAlerts = await deps.fetchAlerts(cfg);
  const open = allAlerts.filter((a) => a.state === "open");
  const ctx: OrphanContext = {
    loadBearing: loadBearingAlertNames(allAlerts),
    everAlerted: new Set(allAlerts.map((a) => a.security_vulnerability.package.name)),
    deps,
  };

  const placed = placeAlerts(open, cfg, extraDirs);
  if (placed.addedDirs.length > 0) {
    log(`🧩 Alerted package(s) that discovery skips: ${placed.addedDirs.map((d) => posix(path.relative(cfg.workspaceRoot, d))).join(", ")}`);
    assertTargetedSupported(placed.addedDirs, cfg);
  }
  refusePnpmLockAlerts(placed);

  const groups = await planGroups(cfg, deps, placed.processed, [...extraDirs, ...placed.addedDirs]);
  const base: ReportBase = { dryRun: cfg.dryRun, blockedCount: 0, alerts: [], npmVersion: state.npmVersion };
  refreshBase(base, groups, placed.unprocessed, state);
  // Before anything is written: a baseline read must never fail the run, and git and GitHub are read-only here.
  Object.assign(base, await readBaseline(groups, cfg));

  if (cfg.dryRun) {
    const removedOverrides = await previewOrphans(groups, ctx);
    const planned = groups.reduce((sum, g) => sum + plannedChangesOf(g.plan), 0) + removedOverrides.length;
    const outcome = computeOutcome({ failed: false, changedFiles: planned, blockedCount: base.blockedCount });
    publish({ ...base, outcome, otherChanges: [], keptOverrides: [], removedOverrides, failures: [] }, cfg, state);
    return { overrideChanges: planned };
  }

  const files = groups.flatMap((g) => g.files);
  const bytesBefore = new Map(files.map((file) => [file, readBytes(file)]));
  const snapshot = snapshotFiles(files);

  try {
    let overrideChanges = await applyGroups(groups, cfg, deps, base, placed.unprocessed, snapshot, state);
    const orphans = await removeOrphansIn(groups, ctx, deps.run);
    overrideChanges += orphans.removed.length;

    // Bytes, not planned changes: a run that rewrote nothing is clean or blocked-only.
    const changedFiles = files.filter((file) => !sameBytes(bytesBefore.get(file) ?? null, readBytes(file))).length;
    const otherChanges = groups.flatMap((group) => otherChangesOf(group, readLockfile(group.dir)));
    const outcome = computeOutcome({ failed: false, changedFiles, blockedCount: base.blockedCount });
    const report: RunReport = { ...base, outcome, otherChanges, keptOverrides: orphans.kept, removedOverrides: orphans.removed, failures: [] };
    try {
      publish(report, cfg, state);
    } catch (e) {
      // The files are changed and nothing will say so: put them back, and say why.
      restoreAll(snapshot, state);
      throw new AgentError(`${messageOf(e)}. ${restoreNote(state)}`);
    }
    return { overrideChanges };
  } catch (e) {
    // A failed verification restored already. Anything else would leave a half-applied tree.
    if (!state.restored) restoreAll(snapshot, state);
    if (state.restoreError && !messageOf(e).includes(state.restoreError)) {
      throw new AgentError(`${messageOf(e)}
${restoreNote(state)}`);
    }
    throw e;
  }
}

export async function runTargeted(cfg: ResolvedConfig, overrides: Partial<TargetedDeps> = {}): Promise<RunResult> {
  const deps: TargetedDeps = { ...defaultDeps, ...overrides };
  const version = deps.npmVersion(cfg.workspaceRoot);
  log(`📦 npm ${version ?? "version unknown"}`);
  const state: RunState = { npmVersion: version, alerts: [], reported: false, restored: false };
  try {
    return await execute(cfg, deps, state);
  } catch (e) {
    // Any exit, not only a failed verification: an expired token is the likeliest way a scheduled run fails.
    if (!state.reported) {
      const detail = e instanceof AgentError ? e.message : `Unexpected error: ${messageOf(e)}`;
      const base: ReportBase = { dryRun: cfg.dryRun, blockedCount: blockedCountOf(state.alerts), alerts: state.alerts, npmVersion: state.npmVersion };
      publishFailed([{ check: "run", detail }], base, cfg, state);
    }
    throw e;
  }
}
