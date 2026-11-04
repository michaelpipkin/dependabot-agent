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
import { AgentError, exitWithError, log, warn } from "../util.js";
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
  /** What a dependent declares for a package at its latest release (its installed range comes from the lockfile). */
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

/** The root's `workspaces` patterns: included, and excluded (`!pattern`). */
function workspacePatterns(dir: string): { include: string[]; exclude: string[] } {
  let declared: unknown;
  try {
    declared = (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")) as { workspaces?: unknown }).workspaces;
  } catch {
    return { include: [], exclude: [] };
  }
  const list = Array.isArray(declared) ? declared : (declared as { packages?: unknown } | undefined)?.packages;
  const patterns = Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  return {
    include: patterns.filter((p) => !p.startsWith("!")),
    exclude: patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1)),
  };
}

/** A workspace pattern as npm reads it: `*` within a path segment, `**` across any number of them. */
function globToRegExp(pattern: string): RegExp {
  const segments = pattern.replace(/^\.\//, "").replace(/\/+$/, "").split("/");
  const source = segments
    .map((segment, i) => {
      const last = i === segments.length - 1;
      if (segment === "**") return last ? ".*" : "(?:[^/]+/)*";
      const body = segment
        .replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
        .replaceAll("*", "[^/]*")
        .replaceAll("?", "[^/]");
      return last ? body : `${body}/`;
    })
    .join("");
  return new RegExp(`^${source}$`);
}

/** Whether a lockfile path is a workspace member under the root's declared patterns. */
export function isWorkspaceMember(lockPath: string, patterns: { include: string[]; exclude: string[] }): boolean {
  const matches = (list: string[]): boolean => list.some((pattern) => globToRegExp(pattern).test(lockPath));
  return matches(patterns.include) && !matches(patterns.exclude);
}

/**
 * The root and every package the lockfile holds at its own path (no node_modules, not a
 * link): workspace members, and `file:` dependencies, which share that shape. Read from
 * the lockfile, so it doesn't depend on how a workspace glob is written. A `file:` package
 * counts for pins and declarations but is marked, since npm can't `-w` it.
 */
function manifestsOf(dir: string, lock: LockIndex): ManifestInfo[] {
  const manifests: ManifestInfo[] = [{ dir, lockPath: "", deps: readDirectDependencies(dir) }];
  const patterns = workspacePatterns(dir);
  for (const [lockPath, entry] of lock.entries) {
    if (lockPath === "" || lockPath.includes("node_modules/") || entry.link) continue;
    const memberDir = path.resolve(dir, lockPath);
    const member = isWorkspaceMember(lockPath, patterns);
    if (!existsSync(path.join(memberDir, "package.json"))) {
      if (member) {
        exitWithError(`${lockPath} is a workspace member in ${path.join(dir, "package-lock.json")}, but ${path.join(memberDir, "package.json")} doesn't exist.`);
      }
      continue;
    }
    manifests.push({ dir: memberDir, lockPath, deps: readDirectDependencies(memberDir), ...(member ? {} : { notWorkspace: true }) });
  }
  return manifests;
}

const pathLabel = (group: Group, lockPath: string): string => {
  if (!group.prefix) return lockPath || "(root)";
  return lockPath ? `${group.prefix}/${lockPath}` : group.prefix;
};

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
    const base = baseNameOfOverrideKey(key);
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
  alerts: RunReport["alerts"];
  reported: boolean;
}

type ReportBase = Pick<RunReport, "dryRun" | "blockedCount" | "alerts">;

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
  const report: RunReport = { ...base, outcome: "failed", otherChanges: [], keptOverrides: [], removedOverrides: [], failures };
  try {
    publish(report, cfg, state);
  } catch (e) {
    warn(messageOf(e));
    log(`\n${renderMarkdown(report)}`);
  }
}

function failureMessage(group: Group, failures: VerificationFailure[]): string {
  const [first, ...rest] = failures;
  const where = first.path ? ` on ${first.path}` : "";
  const more = rest.length > 0 ? ` (and ${rest.length} more)` : "";
  const detail = first.detail.split("\n")[0].replace(/\.$/, "");
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
  for (const [dir, alerts] of groupAlertsByNearestLockfile(open, cfg.workspaceRoot, extraDirs)) {
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
function applyGroups(
  groups: Group[],
  cfg: ResolvedConfig,
  run: NpmRunner | undefined,
  base: ReportBase,
  snapshot: Snapshot,
  state: RunState,
): number {
  let applied = 0;
  for (const group of groups) {
    const planned = plannedChangesOf(group.plan);
    if (planned > 0) log(`\n🔧 Applying ${group.label}`);
    const failures = applyPlan(group.dir, group.plan, { limits: cfg.limits, manifests: group.manifests, run });
    if (failures.length > 0) {
      snapshot.restore();
      const named = groups.length > 1 ? failures.map((f) => ({ ...f, detail: `In ${group.label}: ${f.detail}` })) : failures;
      publishFailed(named, base, cfg, state);
      exitWithError(failureMessage(group, failures));
    }
    applied += planned;
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

  const groups = await planGroups(cfg, deps, open, extraDirs);
  const alerts = groups.flatMap((g) => g.plan.alerts);
  state.alerts = alerts;
  const blockedCount = blockedCountOf(alerts);
  const base: ReportBase = { dryRun: cfg.dryRun, blockedCount, alerts };

  if (cfg.dryRun) {
    const removedOverrides = await previewOrphans(groups, ctx);
    const planned = groups.reduce((sum, g) => sum + plannedChangesOf(g.plan), 0) + removedOverrides.length;
    const outcome = computeOutcome({ failed: false, changedFiles: planned, blockedCount });
    publish({ ...base, outcome, otherChanges: [], keptOverrides: [], removedOverrides, failures: [] }, cfg, state);
    return { overrideChanges: planned };
  }

  const files = groups.flatMap((g) => g.files);
  const bytesBefore = new Map(files.map((file) => [file, readBytes(file)]));
  const snapshot = snapshotFiles(files);

  try {
    let overrideChanges = applyGroups(groups, cfg, deps.run, base, snapshot, state);
    const orphans = await removeOrphansIn(groups, ctx, deps.run);
    overrideChanges += orphans.removed.length;

    // Bytes, not planned changes: a run that rewrote nothing is clean or blocked-only.
    const changedFiles = files.filter((file) => !sameBytes(bytesBefore.get(file) ?? null, readBytes(file))).length;
    const otherChanges = groups.flatMap((group) => otherChangesOf(group, readLockfile(group.dir)));
    const outcome = computeOutcome({ failed: false, changedFiles, blockedCount });
    const report: RunReport = { ...base, outcome, otherChanges, keptOverrides: orphans.kept, removedOverrides: orphans.removed, failures: [] };
    try {
      publish(report, cfg, state);
    } catch (e) {
      // The files are changed and nothing will say so: put them back, and say why.
      snapshot.restore();
      throw new AgentError(`${messageOf(e)}. Every file was restored to how it was before the run.`);
    }
    return { overrideChanges };
  } catch (e) {
    // A failed verification restored already. Anything else would leave a half-applied tree.
    snapshot.restore();
    throw e;
  }
}

export async function runTargeted(cfg: ResolvedConfig, overrides: Partial<TargetedDeps> = {}): Promise<RunResult> {
  const deps: TargetedDeps = { ...defaultDeps, ...overrides };
  const state: RunState = { alerts: [], reported: false };
  try {
    return await execute(cfg, deps, state);
  } catch (e) {
    // Any exit, not only a failed verification: an expired token is the likeliest way a scheduled run fails.
    if (!state.reported) {
      const detail = e instanceof AgentError ? e.message : `Unexpected error: ${messageOf(e)}`;
      const base: ReportBase = { dryRun: cfg.dryRun, blockedCount: blockedCountOf(state.alerts), alerts: state.alerts };
      publishFailed([{ check: "run", detail }], base, cfg, state);
    }
    throw e;
  }
}
