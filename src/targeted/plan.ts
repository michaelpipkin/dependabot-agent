import semver from "semver";
import { DepField, DirectDep, isExactPin, parseSimpleSpec } from "../manifest.js";
import { alertScope, isAgentAuthoredOverride } from "../reconcile.js";
import {
  compareSemver,
  compatibleCeiling,
  escapesCompatibleRange,
  formatCeiling,
  parseSemver,
  satisfiesVulnerableRange,
} from "../semver.js";
import { DependabotAlert, DepScope } from "../types.js";
import { copiesOf, Edge, edgesTo, LockEntry, LockIndex, resolveDep } from "./lockfile.js";

export type BlockReason =
  | "no-fix"
  | "target-unavailable"
  | "unreadable-range"
  | "limit"
  | "pin"
  | "unrewritable-spec"
  | "major-crossing"
  | "hand-written-override"
  | "selector-conflict";
export type AlertStatus = "fixed" | "partly-fixed" | "blocked" | "awaiting-close" | "not-found";

export interface CopyDecision {
  path: string;
  version: string;
  action: "bump" | "override" | "blocked";
  target?: string;
  reason?: BlockReason;
  detail?: string;
  /** Dependents whose declared range the target falls outside of (same-major fixes only). */
  pastDeclared: Array<{ dependent: string; range: string }>;
}
export interface AlertOutcome {
  number: number;
  url?: string;
  packageName: string;
  severity: string;
  scope: DepScope;
  status: AlertStatus;
  copies: CopyDecision[];
}
export interface DirectBump {
  manifestDir: string;
  memberPath: string | null;
  name: string;
  field: DepField;
  from: string;
  operator: "^" | "~";
  target: string;
}
export interface ManifestInfo {
  dir: string;
  lockPath: string;
  deps: DirectDep[];
}
export interface PlanInput {
  alerts: DependabotAlert[];
  lock: LockIndex;
  manifests: ManifestInfo[];
  overrides: { flat: Record<string, string>; nested: Record<string, unknown> };
  limits: Record<string, string>;
  published: Map<string, string[] | null>;
  updateWorkspaceMembers: boolean;
}
export interface Plan {
  alerts: AlertOutcome[];
  bumps: DirectBump[];
  addOverrides: Record<string, string>;
  removeOverrideKeys: string[];
  targets: Map<string, string>; // lock path → target version
}

// ---------------------------------------------------------------------------
// Override keys and limit patterns
// ---------------------------------------------------------------------------

type Tuple = [number, number, number];

const render = (v: Tuple): string => v.join(".");
const compare = (a: string, b: string): number => compareSemver(parseSemver(a)!, parseSemver(b)!);

/** The first version of the release line `version` sits on, by the tool's caret rules. */
export function lineStart(version: string): string {
  const [major, minor, patch] = parseSemver(version)!;
  if (major > 0) return `${major}.0.0`;
  if (minor > 0) return `0.${minor}.0`;
  return `0.0.${patch}`;
}

/** The two-sided range an override key selects: never open below, always three-part bounds. */
function selectorRange(lowerBound: string | null, target: string): string {
  const start = lineStart(target);
  const lower = lowerBound && compare(lowerBound, start) > 0 ? lowerBound : start;
  return `>=${render(parseSemver(lower)!)} <${render(parseSemver(target)!)}`;
}

export function selectorKey(name: string, lowerBound: string | null, target: string): string {
  return `${name}@${selectorRange(lowerBound, target)}`;
}

/** Exact name, or `*` as a wildcard across any characters including `/`. */
export function matchesLimit(name: string, pattern: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(name);
}

/** The package an override key names, whatever follows the version `@`. */
function overrideKeyName(key: string): string {
  // Not baseNameOfOverrideKey: it deliberately leaves shapes the agent never
  // writes ("foo@<2.0.0") whole, and those still name foo for a hand-written pin.
  const at = key.lastIndexOf("@");
  return at > 0 ? key.slice(0, at) : key;
}

// ---------------------------------------------------------------------------
// Reading an alert
// ---------------------------------------------------------------------------

const rangeOf = (alert: DependabotAlert): string => alert.security_vulnerability.vulnerable_version_range;

/** The alert's patch as three parts, or null when it's a pre-release or not a version. */
function patchOf(alert: DependabotAlert): string | null {
  const id = alert.security_vulnerability.first_patched_version?.identifier;
  if (!id || id.split("+")[0].includes("-")) return null;
  const parsed = parseSemver(id);
  return parsed ? render(parsed) : null;
}

/** True, false, or null when the version or the range can't be read. */
const inRange = (version: string, alert: DependabotAlert): boolean | null =>
  satisfiesVulnerableRange(version, rangeOf(alert));

/** The range's lower bound as three parts, or null if it's open below. */
function advisoryLowerBound(range: string): string | null {
  let lower: Tuple | null = null;
  for (const part of range.split(",")) {
    const m = /^\s*(>=|>|=)(.+)$/.exec(part);
    const v = m && parseSemver(m[2]);
    if (!m || !v) continue;
    const bound: Tuple = m[1] === ">" ? [v[0], v[1], v[2] + 1] : v;
    if (!lower || compareSemver(bound, lower) > 0) lower = bound;
  }
  return lower && render(lower);
}

/** The lowest lower bound across `alerts`, or null if any is open below. */
function lowestLowerBound(alerts: Iterable<DependabotAlert>): string | null {
  let lowest: string | null = null;
  for (const alert of alerts) {
    const bound = advisoryLowerBound(rangeOf(alert));
    if (bound === null) return null;
    if (lowest === null || compare(bound, lowest) < 0) lowest = bound;
  }
  return lowest;
}

// ---------------------------------------------------------------------------
// One package's context
// ---------------------------------------------------------------------------

interface Block {
  reason: BlockReason;
  detail: string;
}

interface PackageContext {
  input: PlanInput;
  name: string;
  alerts: DependabotAlert[];
  edges: Edge[];
  handWritten: string | null;
}

/** A manifest declaring this package, where that declaration resolves to the copy. */
interface Declaration {
  manifest: ManifestInfo;
  dep: DirectDep;
}

function declarationsOf(ctx: PackageContext, copy: LockEntry): Declaration[] {
  const found: Declaration[] = [];
  for (const manifest of ctx.input.manifests) {
    if (resolveDep(ctx.input.lock, manifest.lockPath, ctx.name)?.path !== copy.path) continue;
    for (const dep of manifest.deps) {
      if (dep.name === ctx.name) found.push({ manifest, dep });
    }
  }
  return found;
}

const manifestFile = (manifest: ManifestInfo): string =>
  manifest.lockPath ? `${manifest.lockPath}/package.json` : "package.json";

/** Any override a person wrote that names this package, flat or nested at any depth. */
function findHandWritten(overrides: PlanInput["overrides"], name: string): string | null {
  for (const [key, spec] of Object.entries(overrides.flat)) {
    if (overrideKeyName(key) === name && !isAgentAuthoredOverride(key, spec)) return `"${key}": "${spec}"`;
  }
  return findNested(overrides.nested, name, []);
}

function findNested(block: Record<string, unknown>, name: string, parents: string[]): string | null {
  for (const [key, value] of Object.entries(block)) {
    const trail = [...parents, key];
    if (overrideKeyName(key) === name) return `nested override ${trail.join(" > ")}`;
    if (value && typeof value === "object") {
      const hit = findNested(value as Record<string, unknown>, name, trail);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 2: the second table's rows, for a copy inside the alert's range
// ---------------------------------------------------------------------------

function targetBlock(ctx: PackageContext, alert: DependabotAlert): Block | null {
  const id = alert.security_vulnerability.first_patched_version?.identifier;
  if (!id) return { reason: "no-fix", detail: `Alert #${alert.number} has no patched version.` };

  const target = patchOf(alert);
  if (!target) return { reason: "target-unavailable", detail: `Patched version ${id} isn't a stable release.` };

  const published = ctx.input.published.get(ctx.name);
  if (!published) {
    return { reason: "target-unavailable", detail: `Could not read ${ctx.name}'s published versions.` };
  }
  if (!published.includes(target)) {
    return { reason: "target-unavailable", detail: `${ctx.name}@${target} isn't published.` };
  }

  for (const [pattern, range] of Object.entries(ctx.input.limits)) {
    if (matchesLimit(ctx.name, pattern) && !semver.satisfies(target, range)) {
      return { reason: "limit", detail: `${ctx.name}@${target} is outside the limit "${pattern}": "${range}".` };
    }
  }
  return null;
}

function declarationBlock(ctx: PackageContext, copy: LockEntry): Block | null {
  const declarations = declarationsOf(ctx, copy);

  const pin = declarations.find((d) => isExactPin(d.dep.spec));
  if (pin) return { reason: "pin", detail: `Pinned at "${pin.dep.spec}" in ${manifestFile(pin.manifest)}.` };

  for (const { manifest, dep } of declarations) {
    const operator = parseSimpleSpec(dep.spec)?.operator;
    if (operator !== "^" && operator !== "~") {
      return {
        reason: "unrewritable-spec",
        detail: `"${dep.spec}" in ${manifestFile(manifest)} can't be safely rewritten.`,
      };
    }
    if (manifest.lockPath !== "" && !ctx.input.updateWorkspaceMembers) {
      return {
        reason: "unrewritable-spec",
        detail: `"${dep.spec}" in ${manifestFile(manifest)} is a workspace member's, and updateWorkspaceMembers is off.`,
      };
    }
  }
  return null;
}

/** The first row that stops `copy` taking `alert`'s patch, or null if nothing does. */
function pairBlock(ctx: PackageContext, copy: LockEntry, alert: DependabotAlert): Block | null {
  const block = targetBlock(ctx, alert) ?? declarationBlock(ctx, copy);
  if (block) return block;

  const target = patchOf(alert)!;
  if (escapesCompatibleRange(target, copy.version)) {
    return { reason: "major-crossing", detail: `${target} crosses a major version from ${copy.version}.` };
  }
  if (ctx.handWritten) return { reason: "hand-written-override", detail: `Hand-written override: ${ctx.handWritten}.` };
  return null;
}

// ---------------------------------------------------------------------------
// Steps 3-6: solving one release line
// ---------------------------------------------------------------------------

interface SolvedLine {
  /** The copies moving to `target`. */
  fixing: LockEntry[];
  target: string | null;
  /** Alerts whose patch the target accounts for. */
  included: Set<DependabotAlert>;
  /** The subset of `included` taken only because the target fell inside its range. */
  raised: Set<DependabotAlert>;
  /** What the line's fix covers; set whenever `fixing` is non-empty. */
  range: string | null;
  /** The override to write, when one is needed. */
  key: string | null;
  /** Copies that would have moved but for a selector conflict. */
  conflicts: Map<string, Block>;
}

function emptyLine(): SolvedLine {
  return {
    fixing: [],
    target: null,
    included: new Set(),
    raised: new Set(),
    range: null,
    key: null,
    conflicts: new Map(),
  };
}

function dependentName(ctx: PackageContext, edge: Edge): string {
  return ctx.input.lock.entries.get(edge.from)?.name || "root";
}

/** Edges into `copy` that won't be rewritten by a bump: a manifest's own declaration will be. */
function edgesStayingPut(ctx: PackageContext, copy: LockEntry): Edge[] {
  const declarations = declarationsOf(ctx, copy);
  return ctx.edges.filter(
    (edge) =>
      edge.resolved?.path === copy.path &&
      !declarations.some((d) => d.manifest.lockPath === edge.from && d.dep.spec === edge.spec),
  );
}

/** Edges into `copy` that provably reject `target`. A spec that isn't a range can't be judged. */
function edgesRejecting(ctx: PackageContext, copy: LockEntry, target: string): Edge[] {
  return edgesStayingPut(ctx, copy).filter(
    (edge) => semver.validRange(edge.spec) !== null && !semver.satisfies(target, edge.spec),
  );
}

/** Step 4: raise the target until it's outside every alert that can still be taken. */
function raiseTarget(
  ctx: PackageContext,
  probe: LockEntry,
  start: string,
  included: Set<DependabotAlert>,
  raised: Set<DependabotAlert>,
): string {
  let target = start;
  for (;;) {
    const current = target;
    // An alert that fails its rows doesn't raise the target. It's left out, and
    // reported as blocked by decide() if the final target is still in its range.
    // One probe copy speaks for the line: the candidates all pass the copy-level
    // rows, and sharing a line means sharing the major-crossing answer.
    const next = ctx.alerts.find(
      (a) => !included.has(a) && inRange(current, a) === true && pairBlock(ctx, probe, a) === null,
    );
    if (!next) return target;
    included.add(next);
    raised.add(next);
    const patch = patchOf(next)!;
    if (compare(patch, target) > 0) target = patch;
  }
}

const LOOSE = { loose: true };

// The specs npm-package-arg classifies as git: protocols and hosts' shorthands,
// `owner/repo`, scp-style `git@host:path`, and a hosted repo's own https URL (a
// deeper path on the same host, like a tarball, is a plain remote).
const GIT_SPECS = [
  /^(?:git(?:\+[a-z]+)?|ssh|github|gitlab|bitbucket|gist):/i,
  /^[^/@:.~\s][^/@:\s]*\/[^/@:\s#]+(?:#|$)/,
  /^[^@/\s]+@[^:/\s]+:/,
  /^https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org)\/[^/]+\/[^/#]+(?:#|$)/i,
];

function rangesIntersect(spec: string, range: string): boolean {
  return semver.validRange(spec, LOOSE) !== null && semver.intersects(spec, range, LOOSE);
}

/**
 * Whether npm would apply an override with this range to a dependent declaring
 * `spec`. Follows OverrideSet.getEdgeRule in @npmcli/arborist: it never looks at
 * the version a dependent resolved to, only at what it declares.
 *   - range or version: semver.intersects.
 *   - alias: the same, on what's after `npm:name@` (a bare `npm:name` means `*`).
 *   - git: intersects on its `#semver:` range; with no such range, never matches.
 *   - anything else (tag, file, directory, remote): always matches.
 * A spec npm can't parse at all (`workspace:*`) lands in that last group: npm
 * would stop on it, and reporting a block is better than failing the whole run.
 */
function selectorCatches(spec: string, range: string): boolean {
  const declared = spec.trim();
  if (GIT_SPECS.some((git) => git.test(declared))) {
    const attrs = declared.split("#")[1]?.split("::") ?? [];
    const gitRange = attrs.find((attr) => attr.startsWith("semver:"))?.slice("semver:".length);
    return gitRange !== undefined && rangesIntersect(gitRange, range);
  }
  let inner = declared;
  if (/^npm:/i.test(declared)) {
    const at = declared.indexOf("@", "npm:".length + 1);
    inner = at > 0 ? declared.slice(at + 1) : "*";
  }
  return semver.validRange(inner, LOOSE) === null || rangesIntersect(inner, range);
}

/**
 * Step 5: what the selector would catch that isn't being fixed on this line. A
 * safe copy can be caught even though its own version falls outside the selector,
 * because npm matches on the dependent's declared spec (see selectorCatches).
 */
function findConflict(ctx: PackageContext, range: string, fixing: LockEntry[]): string | null {
  const moving = new Set(fixing.map((c) => c.path));
  for (const edge of ctx.edges) {
    if (!edge.resolved || moving.has(edge.resolved.path)) continue;
    if (selectorCatches(edge.spec, range)) {
      return (
        `${dependentName(ctx, edge)} declares ${ctx.name} "${edge.spec}", resolved to ${edge.resolved.version}, ` +
        `which the override "${range}" would also catch.`
      );
    }
  }
  // Also the spec's rule as written: the selector must exclude every copy staying
  // put, including one npm wouldn't match by its spec (a git dependency, say).
  for (const copy of copiesOf(ctx.input.lock, ctx.name)) {
    if (!moving.has(copy.path) && copy.version && semver.satisfies(copy.version, range)) {
      return `${ctx.name}@${copy.version} at ${copy.path} stays put, but the override "${range}" would also catch it.`;
    }
  }
  return null;
}

function solveLine(ctx: PackageContext, copies: LockEntry[]): SolvedLine {
  const included = new Set<DependabotAlert>();
  const candidates = copies.filter((copy) => {
    const passing = ctx.alerts.filter((a) => inRange(copy.version!, a) === true && !pairBlock(ctx, copy, a));
    passing.forEach((a) => included.add(a));
    return passing.length > 0;
  });
  if (candidates.length === 0) return emptyLine();

  const patches = [...included].map((a) => patchOf(a)!);
  const highest = patches.reduce((hi, p) => (compare(p, hi) > 0 ? p : hi), patches[0]);
  const raised = new Set<DependabotAlert>();
  const target = raiseTarget(ctx, candidates[0], highest, included, raised);

  // A copy at or above the target can't take it: that would be a downgrade.
  const fixing = candidates.filter((copy) => compare(copy.version!, target) < 0);
  if (fixing.length === 0) return emptyLine();

  const range = selectorRange(lowestLowerBound(included), target);
  const line: SolvedLine = { ...emptyLine(), fixing, target, included, raised, range };

  // Step 6: a bump is enough only if no other dependent still rejects the target.
  const needSelector = fixing.filter(
    (copy) => declarationsOf(ctx, copy).length === 0 || edgesRejecting(ctx, copy, target).length > 0,
  );
  if (needSelector.length === 0) return line;

  const conflict = findConflict(ctx, range, fixing);
  if (!conflict) return { ...line, key: `${ctx.name}@${range}` };

  // Those copies stay put. The rest are bumps that need no override, and with
  // fewer copies on the line their earliest fix may be lower, so solve them afresh.
  const rest = solveLine(
    ctx,
    fixing.filter((copy) => !needSelector.includes(copy)),
  );
  for (const copy of needSelector) rest.conflicts.set(copy.path, { reason: "selector-conflict", detail: conflict });
  return rest;
}

function solveLines(ctx: PackageContext, copies: LockEntry[]): SolvedLine[] {
  const byLine = new Map<string, LockEntry[]>();
  for (const copy of copies) {
    const parsed = parseSemver(copy.version ?? "");
    if (!parsed) continue;
    const id = formatCeiling(compatibleCeiling(parsed));
    byLine.set(id, [...(byLine.get(id) ?? []), copy]);
  }
  return [...byLine.values()].map((line) => solveLine(ctx, line));
}

// ---------------------------------------------------------------------------
// Steps 7-8: what each alert reports
// ---------------------------------------------------------------------------

function blocked(copy: LockEntry, block: Block): CopyDecision {
  return { path: copy.path, version: copy.version ?? "", action: "blocked", ...block, pastDeclared: [] };
}

function fixedDecision(ctx: PackageContext, copy: LockEntry, target: string): CopyDecision {
  const past = new Map<string, { dependent: string; range: string }>();
  for (const edge of edgesRejecting(ctx, copy, target)) {
    const dependent = dependentName(ctx, edge);
    past.set(`${dependent}\0${edge.spec}`, { dependent, range: edge.spec });
  }
  return {
    path: copy.path,
    version: copy.version!,
    action: declarationsOf(ctx, copy).length > 0 ? "bump" : "override",
    target,
    pastDeclared: [...past.values()],
  };
}

/** The decision this alert reports for this copy, or null if the alert doesn't concern it. */
function decide(ctx: PackageContext, copy: LockEntry, alert: DependabotAlert, line: SolvedLine): CopyDecision | null {
  const version = copy.version ?? "";
  const copyHit = inRange(version, alert);

  if (line.target && line.fixing.includes(copy)) {
    const targetHit = inRange(line.target, alert);
    const coveredHere = copyHit === true && (line.included.has(alert) || targetHit === false);
    if (coveredHere || line.raised.has(alert)) return fixedDecision(ctx, copy, line.target);
    if (targetHit === true) return blocked(copy, pairBlock(ctx, copy, alert)!);
  }

  if (copyHit === false) return null;
  if (copyHit === null) {
    const detail = `Can't compare ${version || "an unknown version"} with "${rangeOf(alert)}".`;
    return blocked(copy, { reason: "unreadable-range", detail });
  }
  const atOrAbove: Block = {
    reason: "target-unavailable",
    detail: `Patched version ${patchOf(alert)} isn't above the installed ${version}.`,
  };
  return blocked(copy, pairBlock(ctx, copy, alert) ?? line.conflicts.get(copy.path) ?? atOrAbove);
}

function statusOf(copies: CopyDecision[]): AlertStatus {
  if (copies.length === 0) return "awaiting-close";
  const fixed = copies.filter((c) => c.action !== "blocked").length;
  if (fixed === copies.length) return "fixed";
  return fixed > 0 ? "partly-fixed" : "blocked";
}

function outcomeOf(alert: DependabotAlert, status: AlertStatus, copies: CopyDecision[]): AlertOutcome {
  return {
    number: alert.number,
    url: alert.html_url,
    packageName: alert.security_vulnerability.package.name,
    severity: alert.security_advisory.severity,
    scope: alertScope(alert),
    status,
    copies,
  };
}

// ---------------------------------------------------------------------------
// Steps 6 and 9: what the plan writes
// ---------------------------------------------------------------------------

function recordBumps(ctx: PackageContext, line: SolvedLine, plan: Plan): void {
  for (const copy of line.fixing) {
    plan.targets.set(copy.path, line.target!);
    for (const { manifest, dep } of declarationsOf(ctx, copy)) {
      plan.bumps.push({
        manifestDir: manifest.dir,
        memberPath: manifest.lockPath === "" ? null : manifest.lockPath,
        name: dep.name,
        field: dep.field,
        from: dep.spec,
        operator: parseSimpleSpec(dep.spec)!.operator as "^" | "~",
        target: line.target!,
      });
    }
  }
}

/** Whether an existing key could apply to versions in `range`. A flat key applies to every version. */
function keyOverlaps(key: string, range: string): boolean {
  const at = key.lastIndexOf("@");
  const selector = at > 0 ? key.slice(at + 1) : "*";
  return semver.validRange(selector) !== null && semver.intersects(selector, range);
}

/**
 * Replace the agent's own keys that this run's fixes supersede. Limited to keys
 * overlapping a line being fixed: two overlapping keys would leave npm to apply
 * whichever comes first, but a key on another line is still holding that line's
 * earlier fix, and only a `fixed` alert may free an override.
 */
function recordOverrides(ctx: PackageContext, lines: SolvedLine[], plan: Plan): void {
  const flat = ctx.input.overrides.flat;
  const fixedLines = lines.filter((line) => line.fixing.length > 0);
  const written = new Set<string>();
  for (const { key, target } of fixedLines) {
    if (!key) continue;
    written.add(key);
    if (flat[key] !== target) plan.addOverrides[key] = target!;
  }
  for (const [key, spec] of Object.entries(flat)) {
    if (overrideKeyName(key) !== ctx.name || written.has(key) || !isAgentAuthoredOverride(key, spec)) continue;
    if (fixedLines.some((line) => keyOverlaps(key, line.range!))) plan.removeOverrideKeys.push(key);
  }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

function planPackage(
  input: PlanInput,
  name: string,
  alerts: DependabotAlert[],
  plan: Plan,
): Map<DependabotAlert, AlertOutcome> {
  const outcomes = new Map<DependabotAlert, AlertOutcome>();
  const copies = copiesOf(input.lock, name);
  if (copies.length === 0) {
    for (const alert of alerts) outcomes.set(alert, outcomeOf(alert, "not-found", []));
    return outcomes;
  }

  const ctx: PackageContext = {
    input,
    name,
    alerts,
    edges: edgesTo(input.lock, name),
    handWritten: findHandWritten(input.overrides, name),
  };
  const lines = solveLines(ctx, copies);
  const lineOf = (copy: LockEntry): SolvedLine =>
    lines.find((l) => l.fixing.includes(copy) || l.conflicts.has(copy.path)) ?? emptyLine();

  for (const alert of alerts) {
    const decisions = copies.flatMap((copy) => decide(ctx, copy, alert, lineOf(copy)) ?? []);
    outcomes.set(alert, outcomeOf(alert, statusOf(decisions), decisions));
  }
  for (const line of lines) recordBumps(ctx, line, plan);
  recordOverrides(ctx, lines, plan);
  return outcomes;
}

export function buildPlan(input: PlanInput): Plan {
  const plan: Plan = { alerts: [], bumps: [], addOverrides: {}, removeOverrideKeys: [], targets: new Map() };
  const open = input.alerts.filter((a) => a.state === "open");

  const byPackage = new Map<string, DependabotAlert[]>();
  for (const alert of open) {
    const name = alert.security_vulnerability.package.name;
    byPackage.set(name, [...(byPackage.get(name) ?? []), alert]);
  }

  const outcomes = new Map<DependabotAlert, AlertOutcome>();
  for (const [name, alerts] of byPackage) {
    for (const [alert, outcome] of planPackage(input, name, alerts, plan)) outcomes.set(alert, outcome);
  }
  plan.alerts = open.map((alert) => outcomes.get(alert)!);
  return plan;
}
