import semver from "semver";
import { declaredRange, lineStart, matchesLimit, overrideKeyName, Plan, selectorCatches } from "./plan.js";
import { edgesOf, LockEntry, LockIndex, reachableFrom, resolveDep } from "./lockfile.js";

export type CheckName =
  | "fixed"
  | "nothing-else-moved"
  | "pins-held"
  | "limits-held"
  | "tree-complete"
  | "manifests"
  | "stable";
export interface VerificationFailure {
  check: CheckName;
  path?: string;
  detail: string;
}
export interface VerifyInput {
  before: LockIndex;
  after: LockIndex;
  plan: Plan;
  limits: Record<string, string>;
  overrides: Record<string, string>; // flat overrides after the run
  pins: Array<{ lockPath: string; name: string; version: string }>;
  changedManifests: string[];
  expectedManifests: string[];
  stable: boolean;
}

// npm's own edge validity test: loose parsing, pre-releases allowed.
const NPM_RANGE = { loose: true, includePrerelease: true };

const sameEntry = (a: LockEntry, b: LockEntry): boolean =>
  a.version === b.version && a.name === b.name && a.link === b.link;

/**
 * Run every check against the result of an install. Pure: it reads only the two
 * lockfiles and what the caller says about the run, so it can be the last line
 * of defence even when `npm ci` would pass on a tree that is missing packages.
 */
export function verify(input: VerifyInput): VerificationFailure[] {
  return [
    ...checkFixed(input),
    ...checkNothingElseMoved(input),
    ...checkPins(input),
    ...checkLimits(input),
    ...checkTreeComplete(input),
    ...checkManifests(input),
    ...(input.stable
      ? []
      : [{ check: "stable" as const, detail: "A second `npm install --package-lock-only` changed the lockfile again." }]),
  ];
}

// ---------------------------------------------------------------------------
// 1. Fixed
// ---------------------------------------------------------------------------

/** Whether deduping onto this copy is as good as the target: same release line, at or above it. */
function safeAtOrAbove(version: string | undefined, target: string): boolean {
  if (!version || !semver.valid(version) || !semver.valid(target)) return false;
  try {
    return semver.gte(version, target) && lineStart(version) === lineStart(target);
  } catch {
    return false;
  }
}

/**
 * Every planned copy is fixed. A copy still at its path must be at the target.
 * A copy gone from its path (hoisting can relocate or merge it) is judged by the
 * dependents it had that still exist: each must now resolve to the target, or to
 * an untouched copy already at or above it on the same line. A planned copy with
 * no surviving dependents has nothing left to fix, and a dependent that no longer
 * resolves at all is for tree-complete to report.
 */
function checkFixed({ before, after, plan }: VerifyInput): VerificationFailure[] {
  const out: VerificationFailure[] = [];
  const beforeEdges = edgesOf(before);
  for (const [path, target] of plan.targets) {
    const entry = after.entries.get(path);
    if (entry) {
      if (entry.version !== target) {
        out.push({
          check: "fixed",
          path,
          detail: `${entry.name} is at ${entry.version ?? "an unknown version"}, but the plan fixes it at ${target}.`,
        });
      }
      continue;
    }
    for (const edge of beforeEdges) {
      if (edge.resolved?.path !== path || !after.entries.has(edge.from)) continue;
      const now = resolveDep(after, edge.from, edge.name);
      if (!now || now.version === target) continue;
      const was = before.entries.get(now.path);
      if (was && sameEntry(was, now) && safeAtOrAbove(now.version, target)) continue;
      const dependent = edge.from || "(root)";
      out.push({
        check: "fixed",
        path,
        detail:
          `${edge.name} for ${dependent} was planned to move to ${target}, but its copy is gone and ` +
          `${dependent} now resolves to ${now.path} at ${now.version ?? "an unknown version"}.`,
      });
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Nothing else moved
// ---------------------------------------------------------------------------

function checkNothingElseMoved({ before, after, plan }: VerifyInput): VerificationFailure[] {
  const targetPaths = [...plan.targets.keys()];
  // name -> every version a target of that name is meant to end at
  const targetVersions = new Map<string, Set<string>>();
  for (const [path, version] of plan.targets) {
    const name = before.entries.get(path)?.name ?? after.entries.get(path)?.name;
    if (!name) continue;
    (targetVersions.get(name) ?? targetVersions.set(name, new Set()).get(name)!).add(version);
  }
  const afterEdges = edgesOf(after);
  const beforeEdges = edgesOf(before);

  // A target relocated by hoisting shows up as a new path at a target version.
  // It counts only if everything that depends on it used to resolve to a planned
  // copy, so a safe copy is never mistaken for a target by sharing its version.
  const isRelocatedTarget = (path: string, entry: LockEntry): boolean => {
    if (before.entries.has(path) || entry.link || entry.version === undefined) return false;
    if (!targetVersions.get(entry.name)?.has(entry.version)) return false;
    const dependents = afterEdges.filter((e) => e.resolved?.path === path);
    if (dependents.length === 0) return false;
    return dependents.every((e) => {
      const prev = before.entries.has(e.from) ? resolveDep(before, e.from, e.name) : null;
      return prev === null || plan.targets.has(prev.path);
    });
  };
  const relocated = new Set<string>();
  for (const [path, entry] of after.entries) if (isRelocatedTarget(path, entry)) relocated.add(path);

  const closureAfter = reachableFrom(after, targetPaths.filter((p) => after.entries.has(p)).concat([...relocated]));
  const closureBefore = reachableFrom(before, targetPaths);

  // Declared ranges of the closure's own dependents, grouped by the entry each lands on.
  const requiredBy = new Map<string, string[]>();
  for (const edge of afterEdges) {
    if (!closureAfter.has(edge.from) || !edge.resolved) continue;
    const declared = declaredRange(edge.spec);
    if (declared === null) continue;
    (requiredBy.get(edge.resolved.path) ?? requiredBy.set(edge.resolved.path, []).get(edge.resolved.path)!).push(declared);
  }

  const out: VerificationFailure[] = [];
  for (const [path, entry] of after.entries) {
    const old = before.entries.get(path);
    if (old && sameEntry(old, entry)) continue;
    if (plan.targets.get(path) === entry.version) continue;
    if (relocated.has(path)) continue;
    if (closureAfter.has(path)) {
      if (!old) continue;
      // A move is excused only by a range the old version broke and the new one meets.
      const oldVersion = old.version;
      const newVersion = entry.version;
      const excused =
        oldVersion !== undefined &&
        newVersion !== undefined &&
        requiredBy
          .get(path)
          ?.some((range) => !semver.satisfies(oldVersion, range, NPM_RANGE) && semver.satisfies(newVersion, range, NPM_RANGE));
      if (excused) continue;
    }
    out.push({
      check: "nothing-else-moved",
      path,
      detail: old
        ? `${entry.name} changed from ${old.version} to ${entry.version}, and nothing the plan fixes requires it.`
        : `${entry.name}@${entry.version} was added, and nothing the plan fixes requires it.`,
    });
  }

  // npm prunes a copy that has become redundant: every dependent still there now
  // gets the very same version from somewhere else.
  const mergedAway = (path: string, old: LockEntry): boolean => {
    const survivors = beforeEdges.filter((e) => e.resolved?.path === path && after.entries.has(e.from));
    return (
      survivors.length > 0 &&
      survivors.every((e) => {
        const now = resolveDep(after, e.from, e.name);
        return now !== null && now.name === old.name && now.version === old.version;
      })
    );
  };
  for (const [path, old] of before.entries) {
    if (after.entries.has(path) || plan.targets.has(path) || closureBefore.has(path) || mergedAway(path, old)) continue;
    out.push({
      check: "nothing-else-moved",
      path,
      detail: `${old.name}@${old.version} was removed, and nothing the plan fixes accounts for it.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Pins held, 4. Limits held
// ---------------------------------------------------------------------------

function checkPins({ before, after, pins }: VerifyInput): VerificationFailure[] {
  const out: VerificationFailure[] = [];
  for (const pin of pins) {
    const wasEntry = resolveDep(before, pin.lockPath, pin.name);
    const entry = resolveDep(after, pin.lockPath, pin.name);
    if (!wasEntry && !entry) continue; // unresolved before and after: not this run's doing
    const was = wasEntry?.version ?? pin.version;
    if (entry?.version === was) continue;
    out.push({
      check: "pins-held",
      path: entry?.path,
      detail: `${pin.name} is pinned at ${was} but now resolves to ${entry?.version ?? "nothing"}.`,
    });
  }
  return out;
}

function checkLimits({ before, after, limits }: VerifyInput): VerificationFailure[] {
  const out: VerificationFailure[] = [];
  for (const [path, entry] of after.entries) {
    const old = before.entries.get(path);
    if ((old && sameEntry(old, entry)) || entry.version === undefined) continue;
    for (const [pattern, range] of Object.entries(limits)) {
      if (!matchesLimit(entry.name, pattern) || semver.satisfies(entry.version, range)) continue;
      out.push({
        check: "limits-held",
        path,
        detail: `${entry.name}@${entry.version} is outside the limit "${pattern}": "${range}".`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Tree complete
// ---------------------------------------------------------------------------

type Problem = "unresolved" | "range";

/** Every non-optional edge in trouble, keyed "<from> -> <name>@<spec>", with how. */
function problemsOf(lock: LockIndex, overrides: Record<string, string>): Map<string, Problem> {
  const problems = new Map<string, Problem>();
  const root = lock.entries.get("");
  for (const edge of edgesOf(lock)) {
    if (edge.optional) continue;
    const label = `${edge.from} -> ${edge.name}@${edge.spec}`;
    if (!edge.resolved) {
      problems.set(label, "unresolved");
      continue;
    }
    const version = edge.resolved.version;
    const declared = declaredRange(edge.spec);
    if (version === undefined || declared === null) continue;
    if (semver.satisfies(version, declared, NPM_RANGE)) continue;
    if (!explainedByOverride(edge.name, edge.spec, version, overrides, root)) problems.set(label, "range");
  }
  return problems;
}

/**
 * Every non-optional edge that is unresolved, or resolved to a version outside
 * what the dependent declares and no override accounts for. Peers count unless
 * the dependent marks them optional. Strings read "<from> -> <name>@<spec>".
 */
export function treeProblems(lock: LockIndex, overrides: Record<string, string>): Set<string> {
  return new Set(problemsOf(lock, overrides).keys());
}

/** An override's value as a version or range: `$name` takes what the root declares for it. */
function overrideValue(value: string, root: LockEntry | undefined): string | null {
  if (!value.startsWith("$")) return value;
  if (!root) return null;
  const ref = value.slice(1);
  const declared =
    root.dependencies[ref] ?? root.devDependencies[ref] ?? root.optionalDependencies[ref] ?? root.peerDependencies[ref];
  return declared !== undefined && !declared.startsWith("$") ? declared : null;
}

/** selectorCatches throws on a selector semver can't read (`q@latest`); that key then explains nothing. */
function catches(spec: string, selector: string): boolean {
  try {
    return selectorCatches(spec, selector);
  } catch {
    return false;
  }
}

/**
 * npm applies the first override key that matches the edge, and only that one,
 * rewriting the edge to the key's value: an exact version, or a range that a
 * floating override like ">=1.2.5" leaves open.
 */
function explainedByOverride(
  name: string,
  spec: string,
  version: string,
  overrides: Record<string, string>,
  root: LockEntry | undefined,
): boolean {
  for (const [key, raw] of Object.entries(overrides)) {
    if (overrideKeyName(key) !== name) continue;
    const selector = key.length > name.length ? key.slice(name.length + 1) : "*";
    if (!catches(spec, selector)) continue;
    const value = overrideValue(raw, root);
    if (value === null) return false;
    return semver.valid(value, NPM_RANGE) ? value === version : semver.satisfies(version, value, NPM_RANGE);
  }
  return false;
}

/**
 * New problems only: real repos already have peer problems. An edge that no
 * longer resolves is new even if it was already out of range before, since a
 * package going missing is not the same as a version mismatch.
 */
function checkTreeComplete({ before, after, overrides }: VerifyInput): VerificationFailure[] {
  const existing = problemsOf(before, overrides);
  const out: VerificationFailure[] = [];
  for (const [label, kind] of problemsOf(after, overrides)) {
    const was = existing.get(label);
    if (was !== undefined && !(kind === "unresolved" && was !== "unresolved")) continue;
    out.push({ check: "tree-complete", path: label.split(" -> ")[0] || undefined, detail: label });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 6. Manifests
// ---------------------------------------------------------------------------

const SPEC_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/**
 * The root and every workspace member declare the same specs as before, except
 * where a planned bump explains the change, operator and target included. That
 * catches an exact pin rewritten to a range, a temporary entry left behind, and
 * a bump written with the wrong operator.
 */
function checkManifests({ before, after, plan, changedManifests, expectedManifests }: VerifyInput): VerificationFailure[] {
  const out: VerificationFailure[] = [];
  const expected = new Set(expectedManifests);
  for (const file of changedManifests) {
    if (!expected.has(file)) {
      out.push({ check: "manifests", path: file, detail: `${file} changed, and the plan doesn't expect it to.` });
    }
  }
  for (const [path, was] of before.entries) {
    const now = after.entries.get(path);
    if (!now || was.link || path.includes("node_modules/")) continue;
    const file = path ? `${path}/package.json` : "package.json";
    for (const field of SPEC_FIELDS) {
      for (const name of new Set([...Object.keys(was[field]), ...Object.keys(now[field])])) {
        const from = was[field][name];
        const to = now[field][name];
        if (from === to) continue;
        if (from === undefined) {
          out.push({ check: "manifests", path: file, detail: `${field} "${name}": "${to}" was added by the run and left behind.` });
        } else if (to === undefined) {
          out.push({ check: "manifests", path: file, detail: `${field} "${name}": "${from}" went missing during the run.` });
        } else {
          const bumped = plan.bumps.some(
            (b) => b.field === field && (b.memberPath ?? "") === path && b.name === name && to === `${b.operator}${b.target}`,
          );
          if (!bumped) {
            out.push({
              check: "manifests",
              path: file,
              detail: `${field} "${name}" changed from "${from}" to "${to}", and no planned bump explains it.`,
            });
          }
        }
      }
    }
  }
  return out;
}
