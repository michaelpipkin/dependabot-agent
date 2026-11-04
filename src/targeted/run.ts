import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { ResolvedConfig } from "../config.js";
import { discoverIsolatedManifestDirs } from "../discover.js";
import { fetchDependabotAlerts } from "../github.js";
import { readDirectDependencies } from "../manifest.js";
import { readNpmOverrides } from "../override-source.js";
import { detectPackageManager } from "../package-manager/index.js";
import {
  baseNameOfOverrideKey,
  groupAlertsByManifestDir,
  highestOverrideFloor,
  isAgentAuthoredOverride,
  judgeOrphanedOverride,
  loadBearingAlertNames,
  resolvePmForDir,
} from "../reconcile.js";
import type { RunResult } from "../reconcile.js";
import { fetchDependentRanges, fetchPublishedVersions, usableRange } from "../registry.js";
import { compareSemver, parseSemver } from "../semver.js";
import type { DependabotAlert, DependentRange } from "../types.js";
import { exitWithError, log, warn } from "../util.js";
import { listWorkspaceMemberDirs, workspaceMemberDependents } from "../workspace.js";
import { applyPlan, snapshotFiles, tryRemoveOverride } from "./apply.js";
import type { NpmRunner, Snapshot } from "./apply.js";
import { copiesOf, edgesTo, readLockfile } from "./lockfile.js";
import type { LockIndex } from "./lockfile.js";
import { buildPlan } from "./plan.js";
import type { ManifestInfo, Plan } from "./plan.js";
import { computeOutcome, renderMarkdown, writeReport } from "./report.js";
import type { RunReport } from "./report.js";
import { treeProblems } from "./verify.js";
import type { VerificationFailure } from "./verify.js";

export interface TargetedDeps {
  fetchAlerts: (cfg: ResolvedConfig) => Promise<DependabotAlert[]>;
  fetchPublished: (name: string) => Promise<string[] | null>;
  /** What a dependent declares for a package, at its installed version and its latest. */
  fetchDependents: typeof fetchDependentRanges;
  run?: NpmRunner;
}

const defaultDeps: TargetedDeps = {
  fetchAlerts: (cfg) => fetchDependabotAlerts({ owner: cfg.owner, name: cfg.name, token: cfg.token }),
  fetchPublished: fetchPublishedVersions,
  fetchDependents: fetchDependentRanges,
};

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const posix = (p: string): string => p.split(path.sep).join("/");
const sameDir = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

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
  plan: Plan;
  /** Every file this group's run may write. */
  files: string[];
}

/** The root's manifest and each workspace member that the lockfile knows about. */
function manifestsOf(dir: string, lock: LockIndex): ManifestInfo[] {
  const manifests: ManifestInfo[] = [{ dir, lockPath: "", deps: readDirectDependencies(dir) }];
  for (const memberDir of listWorkspaceMemberDirs(dir, "npm")) {
    const lockPath = posix(path.relative(dir, memberDir));
    if (!lock.entries.has(lockPath)) {
      warn(`Workspace member ${lockPath} is not in ${path.join(dir, "package-lock.json")}; it is left out of this run.`);
      continue;
    }
    manifests.push({ dir: memberDir, lockPath, deps: readDirectDependencies(memberDir) });
  }
  return manifests;
}

const pathLabel = (group: Group, lockPath: string): string =>
  group.prefix ? (lockPath ? `${group.prefix}/${lockPath}` : group.prefix) : lockPath || "(root)";

/** Versions that changed, appeared or went away, other than the copies the plan moved on purpose. */
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

/**
 * Who depends on `name`, for judging whether an override is still needed. Read from the
 * lockfile, since `npm explain` needs node_modules: each installed dependent's declared
 * range comes from the registry, and the root and workspace members, which the registry
 * can't see, from their own manifests.
 */
async function dependentsOf(group: Group, lock: LockIndex, name: string, deps: TargetedDeps): Promise<DependentRange[]> {
  const out: DependentRange[] = [];
  const seen = new Set<string>();
  const edges = edgesTo(lock, name).filter((edge) => edge.resolved?.name === name);

  for (const edge of edges) {
    const from = lock.entries.get(edge.from);
    if (!from?.version || !edge.from.includes("node_modules/")) continue;
    const id = `${from.name}@${from.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ dependent: from.name, version: from.version, ...(await deps.fetchDependents(from.name, from.version, name)) });
  }

  const named = new Set(out.map((d) => d.dependent));
  const local = workspaceMemberDependents(group.dir, "npm", name).map((m) => ({ dependent: m.name, version: m.version, range: m.range }));
  const root = lock.entries.get("");
  for (const edge of edgesTo(lock, name).filter((e) => e.from === "")) {
    const range = usableRange(edge.spec);
    if (range !== null) local.push({ dependent: root?.name || "root", version: root?.version ?? "0.0.0", range });
  }
  for (const { dependent, version, range } of local) {
    if (named.has(dependent)) continue;
    named.add(dependent);
    out.push({ dependent, version, installedRange: range, latestRange: range, latestKnown: true });
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

/** The first lockfile problem a removal introduced, as a reason to keep the override. */
function introducedProblem(dir: string, before: Set<string>): string | null {
  const after = treeProblems(readLockfile(dir), readNpmOverrides(dir).flat);
  const introduced = [...after].filter((problem) => !before.has(problem));
  if (introduced.length === 0) return null;
  const more = introduced.length > 1 ? ` (and ${introduced.length - 1} more)` : "";
  return `Removing it would leave ${introduced[0]} outside what its dependent declares${more}, so it was kept.`;
}

/**
 * Remove each override the agent wrote whose alert is fixed and whose dependents no longer
 * need it, keeping the removal only if it moves no version and breaks nothing in the tree.
 * Only a `remove` verdict is tried: on a tree reachable only through workspace members npm
 * doesn't revisit the copy, so "nothing moved" alone proves little there.
 */
async function removeOrphans(group: Group, ctx: OrphanContext, run: NpmRunner | undefined): Promise<{ removed: number; kept: RunReport["keptOverrides"] }> {
  const byBase = new Map<string, string[]>();
  for (const [key, spec] of Object.entries(readNpmOverrides(group.dir).flat)) {
    const base = baseNameOfOverrideKey(key);
    if (!isAgentAuthoredOverride(key, spec) || ctx.loadBearing.has(base) || !ctx.everAlerted.has(base)) continue;
    byBase.set(base, [...(byBase.get(base) ?? []), key]);
  }

  let removed = 0;
  const kept: RunReport["keptOverrides"] = [];
  for (const [base, keys] of byBase) {
    const lock = readLockfile(group.dir);
    const flat = readNpmOverrides(group.dir).flat;
    const floor = highestOverrideFloor(keys.map((k) => flat[k]));
    const verdict = judgeOrphanedOverride(await dependentsOf(group, lock, base, ctx.deps), floor, highestVersion(lock, base));
    if (verdict.action !== "remove") {
      log(`   Keeping the override for ${base} (${verdict.action}).`);
      continue;
    }

    for (const key of keys) {
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
      removed++;
    }
  }
  return { removed, kept };
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

const plannedChangesOf = (plan: Plan): number =>
  plan.bumps.length + Object.keys(plan.addOverrides).length + plan.removeOverrideKeys.length;

/** Print the report, and write it if asked to. Done before any exit, so a failed run still reports. */
function publish(report: RunReport, cfg: ResolvedConfig): void {
  if (cfg.reportDir) writeReport(cfg.reportDir, report);
  log(`\n${renderMarkdown(report)}`);
}

function failureMessage(group: Group, failures: VerificationFailure[]): string {
  const [first, ...rest] = failures;
  const where = first.path ? ` on ${first.path}` : "";
  const more = rest.length > 0 ? ` (and ${rest.length} more)` : "";
  const detail = first.detail.split("\n")[0];
  return (
    `The targeted run failed verification in ${group.label}: ${first.check}${where}: ${detail}${more}. ` +
    `Every file was restored to how it was before the run.`
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
  for (const [dir, alerts] of groupAlertsByManifestDir(open, cfg.workspaceRoot, extraDirs)) {
    const prefix = sameDir(dir, cfg.workspaceRoot) ? "" : posix(path.relative(cfg.workspaceRoot, dir));
    const label = prefix || "root";
    log(`\n📂 Planning ${label} (${alerts.length} open alert(s)) [npm]`);

    const lock = readLockfile(dir);
    const manifests = manifestsOf(dir, lock);
    for (const { security_vulnerability: v } of alerts) {
      const name = v.package.name;
      if (!published.has(name) && copiesOf(lock, name).length > 0) published.set(name, await deps.fetchPublished(name));
    }
    const plan = buildPlan({
      alerts,
      lock,
      manifests,
      overrides: readNpmOverrides(dir),
      limits: cfg.limits,
      published,
      updateWorkspaceMembers: cfg.updateWorkspaceMembers,
    });
    const manifestFiles = manifests.map((m) => path.join(m.dir, "package.json"));
    const files = [...new Set([path.join(dir, "package.json"), path.join(dir, "package-lock.json"), ...manifestFiles])];
    groups.push({ dir, label, prefix, manifests, before: lock, plan, files });
  }
  return groups;
}

/**
 * Apply each group's plan. All or nothing: on the first failure every file in every
 * group is restored, the report is written, and the run exits with an error.
 */
function applyGroups(groups: Group[], cfg: ResolvedConfig, run: NpmRunner | undefined, base: ReportBase, snapshot: Snapshot): number {
  let applied = 0;
  for (const group of groups) {
    const planned = plannedChangesOf(group.plan);
    if (planned > 0) log(`\n🔧 Applying ${group.label}`);
    const failures = applyPlan(group.dir, group.plan, { limits: cfg.limits, manifests: group.manifests, run });
    if (failures.length > 0) {
      snapshot.restore();
      const named = groups.length > 1 ? failures.map((f) => ({ ...f, detail: `In ${group.label}: ${f.detail}` })) : failures;
      publish({ ...base, outcome: "failed", otherChanges: [], keptOverrides: [], failures: named }, cfg);
      exitWithError(failureMessage(group, failures));
    }
    applied += planned;
  }
  return applied;
}

/** Orphan removal across every group, after all the fixes are in. */
async function removeOrphansIn(groups: Group[], ctx: OrphanContext, run: NpmRunner | undefined) {
  let removed = 0;
  const kept: RunReport["keptOverrides"] = [];
  for (const group of groups) {
    const result = await removeOrphans(group, ctx, run);
    removed += result.removed;
    const named = groups.length > 1 ? result.kept.map((k) => ({ ...k, reason: `In ${group.label}: ${k.reason}` })) : result.kept;
    kept.push(...named);
  }
  return { removed, kept };
}

type ReportBase = Pick<RunReport, "dryRun" | "blockedCount" | "alerts">;

export async function runTargeted(cfg: ResolvedConfig, overrides: Partial<TargetedDeps> = {}): Promise<RunResult> {
  const deps: TargetedDeps = { ...defaultDeps, ...overrides };

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

  const groups = await planGroups(cfg, deps, open, extraDirs);
  const alerts = groups.flatMap((g) => g.plan.alerts);
  const blockedCount = blockedCountOf(alerts);
  const base: ReportBase = { dryRun: cfg.dryRun, blockedCount, alerts };

  if (cfg.dryRun) {
    const planned = groups.reduce((sum, g) => sum + plannedChangesOf(g.plan), 0);
    const outcome = computeOutcome({ failed: false, changedFiles: planned, blockedCount });
    publish({ ...base, outcome, otherChanges: [], keptOverrides: [], failures: [] }, cfg);
    return { overrideChanges: planned };
  }

  const files = groups.flatMap((g) => g.files);
  const bytesBefore = new Map(files.map((file) => [file, readBytes(file)]));
  const snapshot = snapshotFiles(files);

  let overrideChanges: number;
  let keptOverrides: RunReport["keptOverrides"];
  try {
    overrideChanges = applyGroups(groups, cfg, deps.run, base, snapshot);
    const orphans = await removeOrphansIn(groups, ctx, deps.run);
    overrideChanges += orphans.removed;
    keptOverrides = orphans.kept;
  } catch (e) {
    // A failed verification restored already. Anything else would leave a half-applied tree.
    snapshot.restore();
    throw e;
  }

  // Bytes, not planned changes: a run that rewrote nothing is clean or blocked-only.
  const changedFiles = files.filter((file) => !sameBytes(bytesBefore.get(file) ?? null, readBytes(file))).length;
  const otherChanges = groups.flatMap((group) => otherChangesOf(group, readLockfile(group.dir)));
  const outcome = computeOutcome({ failed: false, changedFiles, blockedCount });
  publish({ ...base, outcome, otherChanges, keptOverrides, failures: [] }, cfg);
  return { overrideChanges };
}
