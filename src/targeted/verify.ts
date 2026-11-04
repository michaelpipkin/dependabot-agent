import semver from "semver";
import { declaredRange, matchesLimit, overrideKeyName, Plan, selectorCatches } from "./plan.js";
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

/**
 * Every planned copy is at its target. A copy missing from its old path is
 * accepted here: hoisting can relocate it, and a package dropped altogether is
 * the tree-complete check's to catch.
 */
function checkFixed({ after, plan }: VerifyInput): VerificationFailure[] {
  const out: VerificationFailure[] = [];
  for (const [path, target] of plan.targets) {
    const entry = after.entries.get(path);
    if (entry && entry.version !== target) {
      out.push({
        check: "fixed",
        path,
        detail: `${entry.name} is at ${entry.version ?? "an unknown version"}, but the plan fixes it at ${target}.`,
      });
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

  // After the run a target may sit elsewhere (hoisting), so start from every
  // copy that is at a target version as well as from the planned paths.
  const afterStarts = [...after.entries.values()]
    .filter((e) => !e.link && e.version !== undefined && targetVersions.get(e.name)?.has(e.version))
    .map((e) => e.path)
    .concat(targetPaths.filter((p) => after.entries.has(p)));
  const closureAfter = reachableFrom(after, afterStarts);
  const closureBefore = reachableFrom(before, targetPaths);

  // Edges whose dependent sits in the closure, grouped by the entry they land on.
  const requiredBy = new Map<string, string[]>();
  for (const edge of edgesOf(after)) {
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
    if (entry.version !== undefined && targetVersions.get(entry.name)?.has(entry.version)) continue;
    if (closureAfter.has(path)) {
      if (!old) continue;
      const oldVersion = old.version;
      const outgrown = oldVersion !== undefined && requiredBy.get(path)?.some((range) => !semver.satisfies(oldVersion, range, NPM_RANGE));
      if (outgrown) continue;
    }
    out.push({
      check: "nothing-else-moved",
      path,
      detail: old
        ? `${entry.name} changed from ${old.version} to ${entry.version}, and nothing the plan fixes requires it.`
        : `${entry.name}@${entry.version} was added, and nothing the plan fixes requires it.`,
    });
  }
  for (const [path, old] of before.entries) {
    if (after.entries.has(path) || plan.targets.has(path) || closureBefore.has(path)) continue;
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
    const was = resolveDep(before, pin.lockPath, pin.name)?.version ?? pin.version;
    const entry = resolveDep(after, pin.lockPath, pin.name);
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

/**
 * Every non-optional edge that is unresolved, or resolved to a version outside
 * what the dependent declares and no override accounts for. Peers count unless
 * the dependent marks them optional. Strings read "<from> -> <name>@<spec>".
 */
export function treeProblems(lock: LockIndex, overrides: Record<string, string>): Set<string> {
  const problems = new Set<string>();
  for (const edge of edgesOf(lock)) {
    if (edge.optional) continue;
    const label = `${edge.from} -> ${edge.name}@${edge.spec}`;
    if (!edge.resolved) {
      problems.add(label);
      continue;
    }
    const version = edge.resolved.version;
    const declared = declaredRange(edge.spec);
    if (version === undefined || declared === null) continue;
    if (semver.satisfies(version, declared, NPM_RANGE)) continue;
    if (!explainedByOverride(edge.name, edge.spec, version, overrides)) problems.add(label);
  }
  return problems;
}

/** npm applies the first override key that matches the edge, and only that one. */
function explainedByOverride(name: string, spec: string, version: string, overrides: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(overrides)) {
    if (overrideKeyName(key) !== name) continue;
    const selector = key.length > name.length ? key.slice(name.length + 1) : "*";
    if (!selectorCatches(spec, selector)) continue;
    return value === version;
  }
  return false;
}

function checkTreeComplete({ before, after, overrides }: VerifyInput): VerificationFailure[] {
  const existing = treeProblems(before, overrides);
  return [...treeProblems(after, overrides)]
    .filter((problem) => !existing.has(problem))
    .map((problem) => ({ check: "tree-complete" as const, path: problem.split(" -> ")[0] || undefined, detail: problem }));
}

// ---------------------------------------------------------------------------
// 6. Manifests
// ---------------------------------------------------------------------------

function checkManifests({ before, after, changedManifests, expectedManifests }: VerifyInput): VerificationFailure[] {
  const out: VerificationFailure[] = [];
  const expected = new Set(expectedManifests);
  for (const file of changedManifests) {
    if (!expected.has(file)) {
      out.push({ check: "manifests", path: file, detail: `${file} changed, and the plan doesn't expect it to.` });
    }
  }
  // The temporary-root step must leave the root devDependencies as they were. A
  // direct bump may change a range, so only the set of names is compared.
  const wasDev = Object.keys(before.entries.get("")?.devDependencies ?? {});
  const nowDev = Object.keys(after.entries.get("")?.devDependencies ?? {});
  for (const name of nowDev.filter((n) => !wasDev.includes(n))) {
    out.push({ check: "manifests", path: "package.json", detail: `Root devDependency "${name}" was left behind by the run.` });
  }
  for (const name of wasDev.filter((n) => !nowDev.includes(n))) {
    out.push({ check: "manifests", path: "package.json", detail: `Root devDependency "${name}" went missing during the run.` });
  }
  return out;
}
