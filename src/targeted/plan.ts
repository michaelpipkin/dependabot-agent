import semver from "semver";
import { DepField, DirectDep, isExactPin, parseSimpleSpec } from "../manifest.js";
import { alertScope } from "../reconcile.js";
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
import { isAgentAuthoredOverride, overrideKeyName } from "./override-keys.js";

export type BlockReason =
  | "no-fix"
  | "target-unavailable"
  | "unreadable-range"
  | "limit"
  | "pin"
  | "unrewritable-spec"
  | "major-crossing"
  | "hand-written-override"
  | "selector-conflict"
  | "manifest-not-processed"
  | "bundled";
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
  /** The manifest GitHub raised the alert on, relative to the repository's root. */
  manifest: string;
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
  /** A package the lockfile holds at its own path that isn't a workspace member (a `file:` dependency): npm can't `-w` it. */
  notWorkspace?: boolean;
  /** Outside the root: its declarations came from the lockfile, and nothing reads, snapshots or writes it. */
  external?: boolean;
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
  copies: LockEntry[];
  /** The edges an override could affect: not a bundled package's, nor one landing on a bundled copy. */
  edges: Edge[];
  /** Every edge to this package, for reporting who a fix lands past. */
  allEdges: Edge[];
  handWritten: string | null;
  /** The agent's own existing keys for this package whose selector is a range. */
  agentKeys: AgentKey[];
}

interface AgentKey {
  key: string;
  /** What npm matches dependents against: the part after the version `@`, or `*` for a flat key. */
  selector: string;
}

function agentKeysOf(flat: Record<string, string>, name: string): AgentKey[] {
  return Object.entries(flat).flatMap(([key, spec]) => {
    if (overrideKeyName(key) !== name || !isAgentAuthoredOverride(key, spec)) return [];
    const at = key.lastIndexOf("@");
    const selector = at > 0 ? key.slice(at + 1) : "*";
    return semver.validRange(selector) === null ? [] : [{ key, selector }];
  });
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

function stillInside(target: string, alert: DependabotAlert): Block {
  return {
    reason: "target-unavailable",
    detail: `${target} is still inside alert #${alert.number}'s range "${rangeOf(alert)}".`,
  };
}

function targetBlock(ctx: PackageContext, alert: DependabotAlert): Block | null {
  const id = alert.security_vulnerability.first_patched_version?.identifier;
  if (!id) return { reason: "no-fix", detail: `Alert #${alert.number} has no patched version.` };

  const target = patchOf(alert);
  if (!target) return { reason: "target-unavailable", detail: `Patched version ${id} isn't a stable release.` };
  if (inRange(target, alert) === true) return stillInside(target, alert);

  const published = ctx.input.published.get(ctx.name);
  if (!published) {
    return { reason: "target-unavailable", detail: `${ctx.name} isn't on the npm registry.` };
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

  // npm keeps only one of the two when it saves, or rewrites one and leaves the
  // other: `dependencies` and `devDependencies` lose the production entry outright.
  for (const { manifest, dep } of declarations) {
    const other = declarations.find((d) => d.manifest === manifest && d.dep.field !== dep.field);
    if (other) {
      return {
        reason: "unrewritable-spec",
        detail: `${dep.name} is declared twice in ${manifestFile(manifest)}, in ${dep.field} and ${other.dep.field}, and npm can't rewrite both.`,
      };
    }
  }

  for (const { manifest, dep } of declarations) {
    if (manifest.notWorkspace) {
      return {
        reason: "unrewritable-spec",
        detail: `"${dep.spec}" in ${manifestFile(manifest)}, which is a file: dependency and not a workspace member, so npm can't rewrite it with -w.`,
      };
    }
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

/** The package whose tarball ships a bundled copy: the nearest one up its path that isn't itself bundled. */
function bundlerOf(lock: LockIndex, copy: LockEntry): LockEntry | undefined {
  let path = copy.path;
  for (;;) {
    const at = path.lastIndexOf("/node_modules/");
    if (at < 0) return undefined;
    path = path.slice(0, at);
    const entry = lock.entries.get(path);
    if (entry && !entry.inBundle) return entry;
  }
}

/** A bundled copy comes out of its parent's tarball, so neither a bump nor an override can reach it. */
function bundleBlock(ctx: PackageContext, copy: LockEntry): Block | null {
  if (!copy.inBundle) return null;
  const bundler = bundlerOf(ctx.input.lock, copy);
  const parent = bundler?.name || "the package that bundles it";
  const shipped = bundler?.name ? `${bundler.name}@${bundler.version}` : "its parent package";
  return {
    reason: "bundled",
    detail: `Bundled inside ${shipped}, which ships this copy in its own tarball, so npm can't move it. Fixing it needs an upgrade of ${parent}.`,
  };
}

/** npm matches an override's name against the name a dependent declares, so a selector can't reach an alias. */
function aliasBlock(ctx: PackageContext, copy: LockEntry): Block | null {
  if (copy.installedAs === ctx.name) return null;
  return {
    reason: "selector-conflict",
    detail: `Installed as ${copy.installedAs}, an alias of ${ctx.name}, which an override for ${ctx.name} can't reach.`,
  };
}

/** The first row that stops `copy` taking `alert`'s patch, or null if nothing does. */
function pairBlock(ctx: PackageContext, copy: LockEntry, alert: DependabotAlert): Block | null {
  const block = targetBlock(ctx, alert) ?? bundleBlock(ctx, copy) ?? aliasBlock(ctx, copy) ?? declarationBlock(ctx, copy);
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
  /** The override to write, when one is needed. */
  key: string | null;
  /** The agent's existing keys that `key` replaces. */
  replaced: string[];
  /** Copies that would have moved but for a selector conflict. */
  conflicts: Map<string, Block>;
}

function emptyLine(): SolvedLine {
  return {
    fixing: [],
    target: null,
    included: new Set(),
    raised: new Set(),
    key: null,
    replaced: [],
    conflicts: new Map(),
  };
}

function dependentName(ctx: PackageContext, edge: Edge): string {
  return ctx.input.lock.entries.get(edge.from)?.name || "root";
}

/** Whether a bump will rewrite this edge: it's a manifest's own declaration of the copy it resolves to. */
function isBumpedEdge(ctx: PackageContext, edge: Edge): boolean {
  if (!edge.resolved) return false;
  return declarationsOf(ctx, edge.resolved).some((d) => d.manifest.lockPath === edge.from && d.dep.spec === edge.spec);
}

/** Edges into `copy` that a bump won't rewrite. */
function edgesStayingPut(ctx: PackageContext, copy: LockEntry): Edge[] {
  return ctx.edges.filter((edge) => edge.resolved?.path === copy.path && !isBumpedEdge(ctx, edge));
}

/** Whether this edge provably rejects `target`. A spec with no declared range can't be judged. */
function rejects(edge: Edge, target: string): boolean {
  const declared = declaredRange(edge.spec);
  return declared !== null && !semver.satisfies(target, declared, LOOSE);
}

/** Edges into `copy` that a bump won't rewrite and that reject `target`. */
function edgesRejecting(ctx: PackageContext, copy: LockEntry, target: string): Edge[] {
  return edgesStayingPut(ctx, copy).filter((edge) => rejects(edge, target));
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
    // An alert that fails its rows, or whose patch is no higher, doesn't raise the
    // target. It's left out, and decide() reports it blocked if the final target
    // is still in its range.
    // One probe copy speaks for the line: the candidates all pass the copy-level
    // rows, and sharing a line means sharing the major-crossing answer.
    const next = ctx.alerts.find(
      (a) =>
        !included.has(a) &&
        inRange(current, a) === true &&
        pairBlock(ctx, probe, a) === null &&
        compare(patchOf(a)!, current) > 0,
    );
    if (!next) return target;
    included.add(next);
    raised.add(next);
    target = patchOf(next)!;
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

const isGitSpec = (spec: string): boolean => GIT_SPECS.some((git) => git.test(spec.trim()));

/**
 * The semver range a spec declares, seeing through what wraps it: an alias's
 * `npm:name@range` (a bare `npm:name` means `*`), or a git spec's `#semver:`
 * range. Null when it declares none: a tag, a path, a URL, a plain git spec.
 */
export function declaredRange(spec: string): string | null {
  let declared = spec.trim();
  if (isGitSpec(declared)) {
    const attrs = declared.split("#")[1]?.split("::") ?? [];
    const gitRange = attrs.find((attr) => attr.startsWith("semver:"))?.slice("semver:".length);
    if (gitRange === undefined) return null;
    declared = gitRange;
  } else if (/^npm:/i.test(declared)) {
    const at = declared.indexOf("@", "npm:".length + 1);
    declared = at > 0 ? declared.slice(at + 1) : "*";
  }
  return semver.validRange(declared, LOOSE) === null ? null : declared;
}

/**
 * Whether npm would apply an override with this range to a dependent declaring
 * `spec`. Follows OverrideSet.getEdgeRule in @npmcli/arborist: it never looks at
 * the version a dependent resolved to, only at what it declares.
 *   - a declared range (see declaredRange): semver.intersects.
 *   - git with no range: never matches.
 *   - anything else (tag, file, directory, remote): always matches.
 * A spec npm can't parse at all (`workspace:*`) lands in that last group: npm
 * would stop on it, and reporting a block is better than failing the whole run.
 * A flat key's `*` matches everything, ahead of all of those.
 */
export function selectorCatches(spec: string, range: string): boolean {
  if (range === "*") return true;
  const declared = declaredRange(spec);
  if (declared !== null) return rangesIntersect(declared, range);
  return !isGitSpec(spec);
}

/** The whole release line `version` sits on, as a range. */
function lineSpan(version: string): string {
  return `>=${lineStart(version)} <${render(compatibleCeiling(parseSemver(version)!))}`;
}

/** The new selector's lower bound: it must still catch what the keys it replaces were catching. */
function carriedLowerBound(alerts: Iterable<DependabotAlert>, replaced: AgentKey[]): string | null {
  const advisory = lowestLowerBound(alerts);
  if (advisory === null) return null;
  return replaced.reduce((lowest, { selector }) => {
    const floor = semver.minVersion(selector)?.version;
    return floor && compare(floor, lowest) < 0 ? floor : lowest;
  }, advisory);
}

/**
 * Whether a key belongs to an alert that's only waiting for GitHub to close it.
 * The first table keeps such a key: the fix it holds is what lets the alert close.
 */
function heldByAwaitingClose(ctx: PackageContext, key: AgentKey, raised: Set<DependabotAlert>): boolean {
  return ctx.alerts.some((alert) => {
    const patch = patchOf(alert);
    return (
      patch !== null &&
      !raised.has(alert) &&
      ctx.copies.every((copy) => inRange(copy.version ?? "", alert) === false) &&
      rangesIntersect(key.selector, lineSpan(patch))
    );
  });
}

/** What the dependents of `copy` will declare once any bump has run. */
function specsAfterFix(ctx: PackageContext, copy: LockEntry, target: string): string[] {
  const bumped = declarationsOf(ctx, copy).map((d) => `${parseSimpleSpec(d.dep.spec)!.operator}${target}`);
  return [...edgesStayingPut(ctx, copy).map((edge) => edge.spec), ...bumped];
}

/** Why the override can't move `copy`, or null if every dependent holding it would get the new key. */
function unreachableReason(
  ctx: PackageContext,
  copy: LockEntry,
  target: string,
  range: string,
  others: AgentKey[],
): string | null {
  // Nothing at the root can lead to it: the temporary-root step gives a package only
  // one range, and testing found no way to reach a copy under the range that lost.
  if (!copy.path.startsWith("node_modules/")) {
    return `${ctx.name}@${copy.version} at ${copy.path} is nested in a workspace member, and npm's override can't reach a copy there.`;
  }
  const edges = edgesStayingPut(ctx, copy);
  if (edges.length === 0 && declarationsOf(ctx, copy).length === 0) {
    return `Nothing declares ${ctx.name}@${copy.version} at ${copy.path}, so an override can't reach it.`;
  }
  for (const edge of edges) {
    if (!selectorCatches(edge.spec, range)) {
      return `${dependentName(ctx, edge)} declares ${ctx.name} "${edge.spec}", which the override "${range}" wouldn't match.`;
    }
  }
  for (const spec of specsAfterFix(ctx, copy, target)) {
    const other = others.find((k) => selectorCatches(spec, k.selector));
    if (other) return `A dependent declaring "${spec}" also matches the existing override "${other.key}"; npm applies only one.`;
  }
  return null;
}

/**
 * A dependent that a key being removed is holding past what it declares, and that
 * the new key won't take over: without the old key it would drop back. A dependent
 * whose own range admits what it resolved to isn't held, so removal moves nothing.
 */
function findDroppedHold(ctx: PackageContext, removing: AgentKey[], range: string, fixing: LockEntry[]): string | null {
  const moving = new Set(fixing.map((c) => c.path));
  for (const edge of ctx.edges) {
    if (!edge.resolved || moving.has(edge.resolved.path) || selectorCatches(edge.spec, range)) continue;
    const held = removing.find((k) => selectorCatches(edge.spec, k.selector));
    if (!held) continue;
    const declared = declaredRange(edge.spec);
    const version = edge.resolved.version;
    if (declared !== null && version && semver.satisfies(version, declared, LOOSE)) continue;
    return (
      `The existing override "${held.key}" has to be replaced for the fix to apply, but it also holds ` +
      `${dependentName(ctx, edge)}'s ${ctx.name} "${edge.spec}" at ${version}, which "${range}" wouldn't cover.`
    );
  }
  return null;
}

/**
 * Step 5: what the selector would catch that isn't being fixed on this line. A
 * safe copy can be caught even though its own version falls outside the selector,
 * because npm matches on the dependent's declared spec (see selectorCatches).
 * And npm refuses outright (EOVERRIDE) an override matching any root edge, moving
 * or not, resolved or not, so only a root edge the bump rewrites first is exempt.
 */
function findConflict(ctx: PackageContext, range: string, fixing: LockEntry[]): string | null {
  const moving = new Set(fixing.map((c) => c.path));
  for (const edge of ctx.edges) {
    if (edge.from === "" && !isBumpedEdge(ctx, edge) && selectorCatches(edge.spec, range)) {
      return `The root declares ${ctx.name} "${edge.spec}", and npm refuses an override "${range}" matching it (EOVERRIDE).`;
    }
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
    if (copy.installedAs !== ctx.name || copy.inBundle) continue; // an alias or a bundled copy is out of the selector's reach
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

  // npm applies the first key matching a dependent's declared spec, so an existing
  // key competes with the new one exactly when it matches a dependent of a moving
  // copy, whatever its version range. Those are replaced, and the new key starts low
  // enough to catch what they caught. Every other key stays: it can't get in the new
  // key's way, and it may be holding an earlier fix. Only an awaiting-close alert's
  // key can stay and still compete, which unreachableReason blocks.
  const specs = fixing.flatMap((copy) => specsAfterFix(ctx, copy, target));
  const replaced = ctx.agentKeys.filter(
    (k) => specs.some((spec) => selectorCatches(spec, k.selector)) && !heldByAwaitingClose(ctx, k, raised),
  );
  const range = selectorRange(carriedLowerBound(included, replaced), target);
  const key = `${ctx.name}@${range}`;
  const removing = replaced.filter((k) => k.key !== key);
  const others = ctx.agentKeys.filter((k) => !replaced.includes(k) && k.key !== key);
  const line: SolvedLine = { ...emptyLine(), fixing, target, included, raised };

  // Step 6: a bump is enough only if no other dependent still rejects the target,
  // and no existing key is left to catch one.
  const needSelector = fixing.filter(
    (copy) =>
      declarationsOf(ctx, copy).length === 0 ||
      replaced.length > 0 ||
      edgesRejecting(ctx, copy, target).length > 0 ||
      specsAfterFix(ctx, copy, target).some((spec) => others.some((k) => selectorCatches(spec, k.selector))),
  );
  if (needSelector.length === 0) return line;

  const staying = new Map<string, string>();
  for (const copy of needSelector) {
    const reason = unreachableReason(ctx, copy, target, range, others);
    if (reason) staying.set(copy.path, reason);
  }
  if (staying.size === 0) {
    const conflict = findConflict(ctx, range, fixing) ?? findDroppedHold(ctx, removing, range, fixing);
    if (!conflict) return { ...line, key, replaced: removing.map((k) => k.key) };
    for (const copy of needSelector) staying.set(copy.path, conflict);
  }

  // Those copies stay put. The rest may still move, and with fewer copies on the
  // line their earliest fix may be lower, so solve them afresh.
  const rest = solveLine(
    ctx,
    fixing.filter((copy) => !staying.has(copy.path)),
  );
  for (const [path, detail] of staying) rest.conflicts.set(path, { reason: "selector-conflict", detail });
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
  // Every edge: a bundled package can't be moved or overridden, but it's still a dependent the fix lands past.
  for (const edge of ctx.allEdges) {
    if (edge.resolved?.path !== copy.path || isBumpedEdge(ctx, edge) || !rejects(edge, target)) continue;
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
    if (targetHit === true) return blocked(copy, pairBlock(ctx, copy, alert) ?? stillInside(line.target, alert));
    if ((copyHit === true && targetHit === false) || line.raised.has(alert)) {
      return fixedDecision(ctx, copy, line.target);
    }
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
    manifest: alert.dependency.manifest_path,
    copies,
  };
}

/** An alert the run can't answer for: no lockfile it reads covers the manifest. */
export function unprocessedAlert(alert: DependabotAlert, detail: string): AlertOutcome {
  const copy: CopyDecision = {
    path: alert.dependency.manifest_path,
    version: "",
    action: "blocked",
    reason: "manifest-not-processed",
    detail,
    pastDeclared: [],
  };
  return outcomeOf(alert, "blocked", [copy]);
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

/** Write each line's key and drop the keys it replaces. */
function recordOverrides(ctx: PackageContext, lines: SolvedLine[], plan: Plan): void {
  const removed = new Set<string>();
  for (const { key, target, replaced } of lines) {
    if (!key) continue;
    if (ctx.input.overrides.flat[key] !== target) plan.addOverrides[key] = target!;
    for (const old of replaced) removed.add(old);
  }
  plan.removeOverrideKeys.push(...removed);
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

  const allEdges = edgesTo(input.lock, name);
  const ctx: PackageContext = {
    input,
    name,
    alerts,
    copies,
    edges: allEdges.filter((edge) => !input.lock.entries.get(edge.from)?.inBundle && !edge.resolved?.inBundle),
    allEdges,
    handWritten: findHandWritten(input.overrides, name),
    agentKeys: agentKeysOf(input.overrides.flat, name),
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
