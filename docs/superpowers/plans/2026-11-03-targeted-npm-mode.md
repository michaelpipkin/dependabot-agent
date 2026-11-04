# Targeted npm Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `updateStrategy: "targeted"`, which fixes open Dependabot alerts on npm repos by moving only the packages that must move, to the earliest fixing version, within project-set limits, and reports the result as a PR description or issue.

**Architecture:** A new `src/targeted/` module, entered from the top of `run()` in `src/reconcile.ts`. Pure units (lockfile index, plan, verification, report) are tested offline against small built lockfiles. `apply.ts` is the only unit that runs npm, and is covered by network tests gated behind an env var. The existing strategies don't change.

**Tech Stack:** TypeScript (nodenext, ES2022), `node:test`, npm CLI, the `semver` package (new runtime dependency), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-03-targeted-npm-mode-design.md`. Read it first: the "Sorting each open alert" tables and the "Verification" list are the requirements for Tasks 3 and 4.

## Global Constraints

- Node `>=22`. Package manager for this repo is pnpm. Run tests with `pnpm test`.
- Work on branch `targeted-npm-mode`, never `main`.
- Stage files by name, never `git add -A`.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `README.md`, `RUNBOOK.md`, `CHANGELOG.md` and `src/reconcile.ts` are CRLF. Keep their line endings.
- All npm commands run by this mode use `--package-lock-only --ignore-scripts --no-audit --no-fund`.
- `compatible` and `latest` behaviour, and everything on pnpm, must not change. Existing tests must pass unmodified, apart from the config key list in `test/readme-config.test.ts`.
- Do not bump `version` in `package.json` until Task 9: a version bump triggers publishing.
- Default test runs stay offline. Anything using the network or real npm is gated on `DEPENDABOT_AGENT_LIVE_NPM=1`.

## Review Focus

1. **A repo that already has dependency-tree problems** (`legacy-peer-deps`, an unmet peer): verification fails only on problems the run introduced, not ones already there. Test in Task 4.
2. **`--save-prefix=^` on Windows:** `cmd.exe` treats `^` as an escape character and would silently drop it, widening or narrowing a range. Test in Task 5.
3. **A selector catching a safe copy:** npm matches override keys against each dependent's declared *range*, not the resolved version, so `^6.5.0` resolved to safe 6.9.4 is still caught by `qs@>=6.0.0 <6.7.3`. The plan must block this rather than downgrade the safe copy. Test in Task 3.
4. **A target that is itself vulnerable to another open alert:** moving to 3.5.0 when another advisory covers `>=3.2.0 <3.6.0` must not count as fixed. Test in Task 3.
5. **A report longer than GitHub's 65,536-character body limit:** the PR or issue must still be created, with the report truncated and saying so. Test in Task 6.

---

### Task 1: Foundation: strategy, limits, report flag and override key shape

**Files:**
- Modify: `src/types.ts`, `src/cli.ts`, `src/config.ts`, `src/reconcile.ts:206-210,476`, `package.json`, `README.md:164,189-203` and the walkthrough block, `test/readme-config.test.ts:44-56`
- Test: `test/cli.test.ts`, `test/reconcile.test.ts`, new `test/config-targeted.test.ts`

**Interfaces:**
- Produces: `UpdateStrategy = "compatible" | "latest" | "targeted"`.
- Produces: `DependabotAlert.html_url?: string`.
- Produces: `ResolvedConfig.limits: Record<string, string>` and `ResolvedConfig.reportDir?: string`, plus `CliArgs.reportDir?: string`.
- Produces in `reconcile.ts`: `export function isAgentAuthoredOverride(key: string, spec: string): boolean` and `export function alertScope(alert): DepScope` (add `export`).

- [ ] **Step 1: Create the branch and commit what's already waiting**

Run `git switch -c targeted-npm-mode`. Then make two commits:
- The owner's uncommitted pnpm update, which they've asked to include: `git add package.json pnpm-lock.yaml`, message `chore: update pnpm to 12.16.1`.
- The spec and this plan: `git add docs/superpowers/specs/2026-11-03-targeted-npm-mode-design.md docs/superpowers/plans/2026-11-03-targeted-npm-mode.md`, message `docs: add targeted npm mode design and plan`.

- [ ] **Step 2: Write the failing tests**

```ts
// test/cli.test.ts
it("accepts the targeted strategy and --report", () => {
  const args = parseArgs(["--update-strategy", "targeted", "--report", "out"], "0.0.0");
  assert.equal(args.updateStrategy, "targeted");
  assert.equal(args.reportDir, "out");
});

// test/reconcile.test.ts
it("baseNameOfOverrideKey understands range selectors", () => {
  assert.equal(baseNameOfOverrideKey("qs@>=6.0.0 <6.7.3"), "qs");
  assert.equal(baseNameOfOverrideKey("@babel/core@>=7.0.0 <7.1.0"), "@babel/core");
  assert.equal(baseNameOfOverrideKey("js-yaml@3"), "js-yaml");
  assert.equal(baseNameOfOverrideKey("@babel/core"), "@babel/core");
});
it("isAgentAuthoredOverride separates agent keys from hand-written pins", () => {
  assert.equal(isAgentAuthoredOverride("qs@>=6.0.0 <6.7.3", "6.7.3"), true);
  assert.equal(isAgentAuthoredOverride("js-yaml@3", ">=3.15.0 <4"), true);
  assert.equal(isAgentAuthoredOverride("foo@2", "2.3.1"), false);
  assert.equal(isAgentAuthoredOverride("foo", "2.3.1"), false);
});

// test/config-targeted.test.ts: resolveConfig with a temp dir config file
// "limits": {"@angular/*": "<22"} → cfg.limits deep-equals that object
// no limits key → cfg.limits deep-equals {}
// "limits": {"@angular/*": "not a range"} → throws AgentError naming the key
// REPORT_DIR env and --report both set → flag wins
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`. Expected: FAIL on the new tests, plus TypeScript errors for the new names.

- [ ] **Step 4: Update `readme-config.test.ts` expected keys and the README**

Add `"limits"` after `"updateWorkspaceMembers"` in the expected list. Add `"limits": {}` to both jsonc config blocks in the README, with a comment in the reference block. Add `targeted` to the `--update-strategy` row and a `--report <dir>` row (`REPORT_DIR`, no default). `limits` is config-file only; `reportDir` is flag and env only.

- [ ] **Step 5: Add the dependency and implement**

Run `pnpm add semver` and `pnpm add -D @types/semver`. Import with `import semver from "semver"`. `src/semver.ts` stays as it is.

- `parseUpdateStrategy` and `parseStrategyEnv` accept `targeted`; update `USAGE`.
- `resolveConfig` validates each limit with `semver.validRange`, calling `exitWithError` with the key name on failure.
- `resolveConfig` warns when `limits` is non-empty and the strategy isn't `targeted`, and when `skipUpdate` or `allowPrerelease` is set under `targeted` (they have no effect).
- `baseNameOfOverrideKey`: change the suffix test to `/^[\d<>=~^]/`.
- `isAgentAuthoredOverride`: true when the spec starts with `>=` or the key's selector suffix starts with `<`, `>` or `=`.
- Replace the check at `reconcile.ts:476` with `if (!isAgentAuthoredOverride(key, existingSpec)) continue;`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test`. Expected: all pass.

- [ ] **Step 7: Commit**

`git add src/types.ts src/cli.ts src/config.ts src/reconcile.ts README.md package.json pnpm-lock.yaml test/cli.test.ts test/reconcile.test.ts test/readme-config.test.ts test/config-targeted.test.ts`. Message: `feat: add targeted strategy, limits and report settings`.

---

### Task 2: Lockfile index

**Files:**
- Create: `src/targeted/lockfile.ts`, `test/helpers/lock.ts`
- Test: `test/targeted-lockfile.test.ts`

**Interfaces:**
```ts
export interface LockEntry {
  path: string;            // "node_modules/a/node_modules/b", "packages/a", or "" for root
  name: string;
  version?: string;
  link?: string;           // link target path, when this entry is a workspace link
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerOptional: Set<string>;
  devDependencies: Record<string, string>; // root and workspace entries only
}
export interface LockIndex { entries: Map<string, LockEntry>; }
export interface Edge { from: string; name: string; spec: string; optional: boolean; resolved: LockEntry | null; }

export function readLockfile(dir: string): LockIndex;      // AgentError if absent or lockfileVersion < 2
export function parseLock(raw: unknown): LockIndex;
export function resolveDep(lock: LockIndex, fromPath: string, name: string): LockEntry | null;
export function copiesOf(lock: LockIndex, name: string): LockEntry[];
export function edgesOf(lock: LockIndex): Edge[];          // every declared dependency of every entry
export function edgesTo(lock: LockIndex, name: string): Edge[];
export function reachableFrom(lock: LockIndex, startPaths: string[]): Set<string>;
export function memberOwnersOf(lock: LockIndex, memberPaths: string[], targetNames: string[]): Record<string, string>;
```
Test helper: `makeLock(packages: Record<string, object>): LockIndex`, a thin wrapper over `parseLock` taking the same shape as a lockfile's `packages` block.

- [ ] **Step 1: Write the failing tests**

```ts
it("resolves through node_modules the way Node does", () => {
  const lock = makeLock({
    "": { dependencies: { a: "^1.0.0" } },
    "node_modules/a": { version: "1.0.0", dependencies: { b: "^2.0.0" } },
    "node_modules/a/node_modules/b": { version: "2.0.0" },
    "node_modules/b": { version: "1.0.0" },
  });
  assert.equal(resolveDep(lock, "node_modules/a", "b")?.version, "2.0.0");
  assert.equal(resolveDep(lock, "", "b")?.version, "1.0.0");
  assert.equal(resolveDep(lock, "node_modules/a", "zzz"), null);
});
it("resolves a workspace member's dep from its own node_modules, then the root", ...);
it("follows workspace links when walking reachability", ...);
it("names an entry from its last node_modules segment, including scopes", () => {
  // "node_modules/@s/a/node_modules/@t/b" → name "@t/b"
});
it("memberOwnersOf finds a member's direct deps that lead to the target", () => {
  // member a → glob → minimatch; member b → express; targets ["minimatch"]
  assert.deepEqual(memberOwnersOf(lock, ["packages/a", "packages/b"], ["minimatch"]), { glob: "^7.1.6" });
});
it("memberOwnersOf excludes the target itself", () => {
  // member b declares qs directly and via express; targets ["qs"] → { express: "^4.17.1" }
});
it("readLockfile rejects a lockfileVersion 1 file with a clear message", ...);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/targeted/lockfile.ts`**

`resolveDep` checks `<from>/node_modules/<name>`, then strips the last `/node_modules/<segment>` and repeats, finishing at the root. A workspace path like `packages/a` falls back directly to root. If the result is a link entry, return the entry at `link`. Declared ranges disagreeing between members in `memberOwnersOf`: first one wins (tested safe in the spike).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`. Expected: all pass.

- [ ] **Step 5: Commit**

`git add src/targeted/lockfile.ts test/helpers/lock.ts test/targeted-lockfile.test.ts`. Message: `feat(targeted): read and walk package-lock.json`.

---

### Task 3: The plan: sorting alerts and building overrides

**Files:**
- Create: `src/targeted/plan.ts`
- Modify: `src/override-source.ts` (add `readNpmOverrides`)
- Test: `test/targeted-plan.test.ts`

**Interfaces:**
- Consumes: `LockIndex`, `edgesTo`, `copiesOf`, `resolveDep` from Task 2. `isAgentAuthoredOverride`, `baseNameOfOverrideKey`, `alertScope` from Task 1. `compatibleCeiling`, `escapesCompatibleRange`, `satisfiesVulnerableRange`, `parseSemver` from `semver.ts`. `readDirectDependencies`, `isExactPin`, `parseSimpleSpec` from `manifest.ts`.
- Produces in `override-source.ts`: `export function readNpmOverrides(dir: string): { flat: Record<string, string>; nested: Record<string, unknown> }`.
- Produces:
```ts
export type BlockReason = "no-fix" | "target-unavailable" | "unreadable-range" | "limit" | "pin"
  | "unrewritable-spec" | "major-crossing" | "hand-written-override" | "selector-conflict";
export type AlertStatus = "fixed" | "partly-fixed" | "blocked" | "awaiting-close" | "not-found";

export interface CopyDecision {
  path: string; version: string;
  action: "bump" | "override" | "blocked";
  target?: string;
  reason?: BlockReason; detail?: string;
  /** Dependents whose declared range the target falls outside of (same-major fixes only). */
  pastDeclared: Array<{ dependent: string; range: string }>;
}
export interface AlertOutcome {
  number: number; url?: string; packageName: string; severity: string; scope: DepScope;
  status: AlertStatus; copies: CopyDecision[];
}
export interface DirectBump {
  manifestDir: string; memberPath: string | null; name: string;
  field: DepField; from: string; operator: "^" | "~"; target: string;
}
export interface ManifestInfo { dir: string; lockPath: string; deps: DirectDep[]; }
export interface PlanInput {
  alerts: DependabotAlert[]; lock: LockIndex; manifests: ManifestInfo[];
  overrides: { flat: Record<string, string>; nested: Record<string, unknown> };
  limits: Record<string, string>;
  published: Map<string, string[] | null>;
  updateWorkspaceMembers: boolean;
}
export interface Plan {
  alerts: AlertOutcome[]; bumps: DirectBump[];
  addOverrides: Record<string, string>; removeOverrideKeys: string[];
  targets: Map<string, string>; // lock path → target version
}
export function buildPlan(input: PlanInput): Plan;
export function selectorKey(name: string, lowerBound: string | null, target: string): string;
export function lineStart(version: string): string;
export function matchesLimit(name: string, pattern: string): boolean;
```

- [ ] **Step 1: Write the failing tests**

One test per row of the spec's two tables, in `describe("sorting")`, each asserting `status`, `action` and `reason`. Use `makeLock` and a local `alert(number, name, range, patch)` builder. The tests that decide behaviour:

```ts
it("not in lockfile → not-found", ...);
it("in lockfile, no copy in range → awaiting-close, and any override is kept", ...);
it("unparseable vulnerable range → blocked unreadable-range, never treated as safe", ...);
it("limit wins: @angular/core 21.1.0, patch 22.0.1, limit <22 → blocked limit, detail names the limit", ...);
it("exact pin → blocked pin, no bump, no override written", ...);
it("`>=1.0.0` or `^1 || ^2` declared directly → blocked unrewritable-spec", ...);
it("direct 2.4.0, patch 3.0.0, no limit → blocked major-crossing", ...);
it("transitive 0.5.0, patch 0.7.0 → blocked major-crossing", ...);
it("hand-written flat override → blocked; so does one nested under any parent", ...);
it("direct ^ range → DirectBump with operator ^ and target = patch", ...);
it("direct ~ range keeps operator ~", ...);
it("updateWorkspaceMembers false → member's direct copy blocked unrewritable-spec", ...);

describe("override keys", () => {
  it("is never open below", () => {
    assert.equal(selectorKey("qs", null, "6.7.3"), "qs@>=6.0.0 <6.7.3");
    assert.equal(selectorKey("a", "0.5.1", "0.5.3"), "a@>=0.5.1 <0.5.3");
    assert.equal(selectorKey("a", null, "0.5.3"), "a@>=0.5.0 <0.5.3");
    assert.equal(selectorKey("js-yaml", "4.0.0", "4.1.1"), "js-yaml@>=4.0.0 <4.1.1");
  });
  it("does not catch a 5.x copy when fixing 6.x", ...);   // 5.x copy → blocked major-crossing, 6.x fixed
  it("writes one key per release line for two majors", ...);
});

describe("partial and mixed outcomes", () => {
  it("fixes the fixable copy and blocks the other → partly-fixed", ...);
  it("direct bump also writes a selector when a parent pins the old version exactly", () => {
    // direct qs ^6.5.0 @ 6.7.0, express declares qs "6.7.0"; patch 6.7.3
    // → bump qs to 6.7.3 AND addOverrides["qs@>=6.0.0 <6.7.3"] === "6.7.3"
  });
  it("uses the highest target within a limit; the higher alert is blocked, the lower fixed", ...);
});

// Review Focus 3
it("blocks with selector-conflict when a safe copy's declared range overlaps the selector", () => {
  // member declares qs "^6.5.0" resolved to safe 6.9.4; express → qs 6.7.0; patch 6.7.3
  // express's copy: blocked selector-conflict; no override written; hoisted 6.9.4 absent from targets
});
it("blocks with selector-conflict when a pinned direct copy shares the version", ...);

// Review Focus 4
it("raises the target when it falls inside another open alert's range", () => {
  // copy 3.0.0; alerts: <3.1.0 → 3.1.0 and >=3.1.0 <3.6.0 → 3.6.0
  // → target 3.6.0, both alerts fixed
});
it("reports the second alert blocked if raising the target would break a limit", ...);

describe("existing overrides", () => {
  it("replaces an agent floating key on an alerted package", () => {
    // flat { "qs": ">=6.7.3 <7" } → removeOverrideKeys ["qs"], addOverrides has the selector
  });
  it("leaves an agent floating key alone with no open alert", ...);
  it("is idempotent: the exact key already present produces no add or remove", ...);
});

describe("past a declared range", () => {
  it("flags a same-major fix past a parent's exact pin", () => {
    // @angular/build declares picomatch "4.0.3"; patch 4.0.4
    // → action override, pastDeclared [{ dependent: "@angular/build", range: "4.0.3" }]
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `buildPlan` in `src/targeted/plan.ts`**

The target-selection and conflict rules aren't determined by the signature, so follow this order:

1. Group open alerts by package. For a package with no copies → `not-found`. Mark each alert with no copy in its range `awaiting-close`.
2. For each vulnerable copy and each alert containing it, take the first matching row of the spec's second table (excluding "selector-conflict", which comes in step 5). Unparseable range is checked first.
3. Group copies by release line, using `formatCeiling(compatibleCeiling(parseSemver(version)))` as the line id. The line's target is the highest patch among its unblocked (copy, alert) pairs.
4. Fixpoint: while the target is inside any of the package's alerts' ranges, include that alert's patch if it passes the same rows and raise the target. If it doesn't pass, mark that alert blocked for these copies and stop raising. A copy at or above the target is blocked with its alert's reason.
5. Build each line's selector with `selectorKey` (lower bound: the lowest advisory lower bound on the line, or `null` if any is open below). Run `edgesTo(lock, name)`: an edge whose spec `semver.intersects` the selector range, and whose resolved copy isn't being fixed on this line, is a conflict. Every override copy on that line becomes blocked `selector-conflict`, naming the edge. An edge whose spec isn't a valid semver range doesn't intersect.
6. A direct copy gets a `DirectBump` for each manifest resolving to it. If any other edge resolving to that copy has a spec the target doesn't satisfy, also write the selector.
7. `pastDeclared` comes from `edgesTo`: edges resolving to a fixed copy with a spec `semver.satisfies(target, spec)` rejects.
8. Alert status: all copies fixed → `fixed`; some → `partly-fixed`; none → `blocked`.
9. Existing keys for a package with any fixed copy: agent-authored keys not in the new set go in `removeOverrideKeys`.

`matchesLimit`: exact name, or `*` as a wildcard across any characters including `/`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`. Expected: all pass.

- [ ] **Step 5: Commit**

`git add src/targeted/plan.ts src/override-source.ts test/targeted-plan.test.ts`. Message: `feat(targeted): sort alerts per copy and build the plan`.

---

### Task 4: Verification

**Files:**
- Create: `src/targeted/verify.ts`
- Test: `test/targeted-verify.test.ts`

**Interfaces:**
- Consumes: `Plan` (Task 3), `LockIndex`, `edgesOf`, `reachableFrom` (Task 2).
- Produces:
```ts
export type CheckName = "fixed" | "nothing-else-moved" | "pins-held" | "limits-held" | "tree-complete" | "manifests" | "stable";
export interface VerificationFailure { check: CheckName; path?: string; detail: string; }
export interface VerifyInput {
  before: LockIndex; after: LockIndex; plan: Plan;
  limits: Record<string, string>;
  overrides: Record<string, string>;         // flat overrides after the run
  pins: Array<{ lockPath: string; name: string; version: string }>;
  changedManifests: string[]; expectedManifests: string[];
  stable: boolean;
}
export function verify(input: VerifyInput): VerificationFailure[];
export function treeProblems(lock: LockIndex, overrides: Record<string, string>): Set<string>;
```

- [ ] **Step 1: Write the failing tests**

One test per check in the spec's Verification list, each building a `before`/`after` pair and asserting the failing `check`. The tests that decide behaviour:

```ts
it("passes when only the target moved", ...);
it("allows a dependency the target now requires: @isaacs/brace-expansion 5.0.0 → 5.0.1", () => {
  // after: minimatch 10.1.2 declares ^5.0.1 → no failure
});
it("rejects a move inside the closure that nothing required", ...);
it("rejects a safe copy that moved: qs 6.9.4 → 6.11.0", () => {
  assert.equal(failures[0].check, "nothing-else-moved");
});
it("allows an entry removed because only the old target needed it", ...);
it("rejects a package missing from the lockfile even though nothing else changed", () => {
  // the spike's `glob` → missing minimatch; check "tree-complete"
});
it("does not count an edge explained by an override as a problem", () => {
  // @angular/build declares picomatch "4.0.3", resolved 4.0.4, override "picomatch@>=4.0.0 <4.0.4": "4.0.4"
});
it("rejects a moved pin", ...);
it("rejects a change past a limit, including a side-effect move", ...);
it("rejects temporary devDependencies left in the root manifest", ...);
it("copies reported as blocked may remain vulnerable", ...);

// Review Focus 1
it("ignores tree problems that already existed before the run", () => {
  // before and after both have the same unmet peer → no failure; a new one → failure
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `verify`**

Rules for `nothing-else-moved`, comparing entries by path:
- Changed or added entry: allowed if `plan.targets` has it at that version, or if its name is a target's and it's at that target (hoisting may relocate a copy), or if it's in `reachableFrom(after, targetPaths)` and is either new or its old version fails a declared range from a dependent inside that closure.
- Removed entry: allowed if it was a planned target copy or is in `reachableFrom(before, targetPaths)`.

`treeProblems` returns strings like `"<from> -> <name>@<spec>"` for each non-optional edge (peer included unless `peerOptional`) that is unresolved, or whose resolved version fails the spec and isn't explained by an override. An edge is explained when an override key's base name matches and its selector intersects the spec (or it has no selector) and its value equals the resolved version. Skip specs `semver.validRange` rejects. `tree-complete` fails on `treeProblems(after) − treeProblems(before)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`. Expected: all pass.

- [ ] **Step 5: Commit**

`git add src/targeted/verify.ts test/targeted-verify.test.ts`. Message: `feat(targeted): verify results against the plan`.

---

### Task 5: Applying fixes with npm

**Files:**
- Create: `src/targeted/apply.ts`
- Test: `test/targeted-apply.test.ts` (offline), `test/targeted-npm.live.test.ts` (gated)

**Interfaces:**
- Consumes: `Plan`, `DirectBump`, `ManifestInfo` (Task 3); `memberOwnersOf`, `readLockfile`, `copiesOf` (Task 2); `verify` (Task 4); `selectOverrideSource` from `override-source.ts`.
- Produces:
```ts
export type NpmRunner = (command: string, cwd: string) => void;
export interface Snapshot { restore(): void; }
export function snapshotFiles(paths: string[]): Snapshot;      // preserves exact bytes
export function bumpCommand(bump: DirectBump): string;
export function resolveCommand(): string;
export function applyPlan(dir: string, plan: Plan, opts: { limits: Record<string, string>; manifests: ManifestInfo[]; run?: NpmRunner }): VerificationFailure[];
export function tryRemoveOverride(dir: string, key: string, run?: NpmRunner): boolean;
```
`applyPlan` returns an empty array on success. On failures, it leaves restoring to the caller's run-wide snapshot.

- [ ] **Step 1: Write the failing offline tests**

```ts
// Review Focus 2
it("quotes the prefix so cmd.exe keeps ^", () => {
  const cmd = bumpCommand({ name: "debug", target: "4.3.1", operator: "^", memberPath: null, ... });
  assert.match(cmd, /"--save-prefix=\^"/);
  assert.match(cmd, /--save-exact=false/);
  assert.match(cmd, /--package-lock-only/);
  assert.match(cmd, /--ignore-scripts/);
});
it("targets a member with -w", ...);   // memberPath "packages/a" → `-w packages/a`
it("keeps ~", ...);
it("snapshot restore returns the exact bytes", ...);

// With a fake NpmRunner recording commands and editing the lockfile fixture:
it("runs bumps, then writes overrides, then resolves", ...);
it("uses the temporary-root step only for copies that did not move", () => {
  // fake runner leaves minimatch at the old version on the first resolve
  // → adds glob to root devDependencies, resolves, restores, resolves
});
it("skips the temporary-root step when the first resolve moved everything", ...);
it("restores root devDependencies byte-for-byte after the temporary-root step", ...);
it("returns a failure rather than throwing when npm exits non-zero", ...);
```

- [ ] **Step 2: Write the gated live test**

Skip the whole file unless `process.env.DEPENDABOT_AGENT_LIVE_NPM === "1"`. It builds throwaway projects in `os.tmpdir()` using `npm install --before=<date>`, runs `applyPlan`, asserts the moved set, then runs `npm ci --ignore-scripts`. Cover these shapes from the spec's evidence table, using the same dates and packages:

- Single package, `glob ^7.1.6` (`--before=2020-06-01`): `minimatch` 3.0.4 → 3.0.5, one package moved.
- Workspace, member only: same result through the temporary-root step, and both manifests unchanged apart from the override.
- Workspace, reachable from root: no temporary-root step needed.
- Two majors (`glob ^7.1.6`, `filelist ^1.0.4`, `--before=2023-06-01`): `minimatch` 3.1.2 → 3.1.3 and 5.1.6 → 5.1.7.
- Direct bump with `~` in a member: `chalk ~4.0.0` → `~4.1.2`.
- Safe copy moved by a too-high target: `applyPlan` returns a `nothing-else-moved` failure.
- Spec "Must be proven" item 3: after applying, a real `npm install` with `node_modules` present keeps the versions.
- Item 4: a member's exact pin overlapping a selector leaves the pin unmoved.
- Item 5: replacing a floating override, and a selector beside an existing override.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test`. Expected: offline tests FAIL, module not found; the live file reports skipped.

- [ ] **Step 4: Implement `src/targeted/apply.ts`**

Order within `applyPlan`, per the spec's "Applying fixes" list:
1. Read `before`, and record each manifest's pin versions.
2. Run bump commands.
3. Write overrides through `selectOverrideSource("npm", dir, true).write(...)`, with `removeOverrideKeys` removed.
4. Run `resolveCommand()`. Read the lockfile. For each target copy not at its target: compute `memberOwnersOf`, save the root `package.json` text, merge owners under root `devDependencies` (existing root entries win), resolve, write the saved text back, resolve again.
5. Run `resolveCommand()` again to get `stable`, then call `verify` and return its failures.

Default `NpmRunner` is `execSync(command, { cwd, stdio: "inherit" })`. A non-zero exit becomes a `VerificationFailure` with check `"stable"` and the npm message as `detail`. `tryRemoveOverride` deletes the key, resolves, and returns `false` with the key restored if any lockfile version moved.

- [ ] **Step 5: Run tests to verify they pass**

Run `pnpm test`, expected all pass. Then run `DEPENDABOT_AGENT_LIVE_NPM=1 pnpm test`, expected all pass including the live file. If a "Must be proven" case fails, stop and report it to the owner rather than working around it.

- [ ] **Step 6: Commit**

`git add src/targeted/apply.ts test/targeted-apply.test.ts test/targeted-npm.live.test.ts`. Message: `feat(targeted): apply plans without deleting the lockfile`.

---

### Task 6: The report

**Files:**
- Create: `src/targeted/report.ts`
- Test: `test/targeted-report.test.ts`

**Interfaces:**
- Consumes: `AlertOutcome` (Task 3), `VerificationFailure` (Task 4).
- Produces:
```ts
export type Outcome = "changes" | "blocked-only" | "clean" | "failed";
export interface RunReport {
  outcome: Outcome; dryRun: boolean; blockedCount: number;
  alerts: AlertOutcome[];
  otherChanges: Array<{ path: string; from?: string; to?: string }>;
  keptOverrides: Array<{ key: string; reason: string }>;
  failures: VerificationFailure[];
}
export function computeOutcome(input: { failed: boolean; changedFiles: number; blockedCount: number }): Outcome;
export function renderMarkdown(report: RunReport): string;
export function writeReport(dir: string, report: RunReport): void;  // report.md and report.json
export const MAX_BODY_CHARS = 60000;
```

- [ ] **Step 1: Write the failing tests**

```ts
it("computeOutcome follows the spec's order", () => {
  assert.equal(computeOutcome({ failed: true, changedFiles: 3, blockedCount: 0 }), "failed");
  assert.equal(computeOutcome({ failed: false, changedFiles: 1, blockedCount: 2 }), "changes");
  assert.equal(computeOutcome({ failed: false, changedFiles: 0, blockedCount: 2 }), "blocked-only");
  assert.equal(computeOutcome({ failed: false, changedFiles: 0, blockedCount: 0 }), "clean");
});
it("awaiting-close alone is clean, not blocked-only", ...);
it("uses the spec's section headings, omitting empty ones", () => {
  // "Fixed", "Partly fixed", "Applied past a declared range — review these",
  // "Blocked", "Awaiting close or not found", "Other changes"
});
it("a fixed entry shows alert link, severity, package, from → to, mechanism and scope", ...);
it("a blocked entry names the limit, pin or override", ...);
it("labels a dry run as a plan", ...);
it("a failed report names the check and package", ...);
it("report.json round-trips outcome and blockedCount", ...);

// Review Focus 5
it("truncates to MAX_BODY_CHARS, keeping Blocked, and says so", () => {
  // 5000 fixed alerts → length <= MAX_BODY_CHARS, ends with a note pointing at the job summary,
  // and the Blocked section is still present
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/targeted/report.ts`**

Render Blocked and "Applied past a declared range" first when truncating, since those need a person's attention. Use the existing `DepScope` wording for production and dev. Escape `|` in table cells.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`. Expected: all pass.

- [ ] **Step 5: Commit**

`git add src/targeted/report.ts test/targeted-report.test.ts`. Message: `feat(targeted): write the PR and issue report`.

---

### Task 7: Wiring it into a run

**Files:**
- Create: `src/targeted/run.ts`
- Modify: `src/reconcile.ts:1222-1236` (branch into targeted; export `groupAlertsByManifestDir`, `resolvePmForDir`, `loadBearingAlertNames` as needed)
- Test: `test/targeted-run.test.ts`

**Interfaces:**
- Consumes: everything above; `fetchDependabotAlerts`, `fetchPublishedVersions`, `fetchDependentRanges`, `judgeOrphanedOverride`, `discoverIsolatedManifestDirs`, `listWorkspaceMemberDirs`.
- Produces:
```ts
export interface TargetedDeps {
  fetchAlerts: (cfg: ResolvedConfig) => Promise<DependabotAlert[]>;
  fetchPublished: (name: string) => Promise<string[] | null>;
  run?: NpmRunner;
}
export function assertTargetedSupported(dirs: string[], cfg: ResolvedConfig): void;
export async function runTargeted(cfg: ResolvedConfig, deps?: Partial<TargetedDeps>): Promise<RunResult>;
```

- [ ] **Step 1: Write the failing tests**

Using temp directories, `deps` fakes, and a fake `NpmRunner`:

```ts
it("stops at startup when the root is pnpm", ...);
it("stops at startup when an isolated sub-package is pnpm, naming it", ...);
it("stops with a clear error when there is no package-lock.json", ...);
it("dry run writes the report and leaves every file byte-identical", ...);
it("all alerts blocked → outcome blocked-only, nothing changed", ...);
it("a verification failure restores every file in every group and sets outcome failed", () => {
  // two groups: root succeeds, functions/ fails → root's files are restored too
});
it("writes the report before exiting 1 on failure", ...);
it("merges two groups into one report", ...);
it("does not call the update pass", ...);       // no `npm update` in recorded commands
it("removes an orphaned override only when nothing moves; otherwise lists it as kept", ...);
it("never removes an override for a dismissed alert", ...);
it("result.overrideChanges counts bumps and override changes, so --exit-code works", ...);
```
And in `test/reconcile.test.ts`: `run()` with `compatible` still reaches the existing path.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `runTargeted`**

1. In `run()`, immediately after detecting the root package manager: `if (cfg.updateStrategy === "targeted") return runTargeted(cfg);`.
2. Fetch alerts across all states. Split into open, load-bearing (`loadBearingAlertNames`) and ever-alerted names, as `run()` does.
3. Group with `groupAlertsByManifestDir`, reusing the discovery logic for isolated directories. Call `assertTargetedSupported` before any write.
4. For each group, read the lockfile, manifests (root + `listWorkspaceMemberDirs`) and `readNpmOverrides`. Fetch published versions once per alerted name. `buildPlan`.
5. Dry run: `writeReport`, return.
6. Snapshot `package.json`, `package-lock.json` and member manifests for every group, then `applyPlan` per group. On the first failure, restore all snapshots, set `failed`, write the report and `exitWithError` naming the check.
7. Orphan removal: for agent-authored override keys whose base isn't load-bearing and was ever alerted, build dependents from the lockfile (`edgesTo` plus `fetchDependentRanges`, not `npm explain`, which isn't reliable without `node_modules`), call `judgeOrphanedOverride`, and on `remove` call `tryRemoveOverride`. A `false` return adds to `keptOverrides`.
8. `computeOutcome`, `writeReport` when `cfg.reportDir` is set, print `renderMarkdown` to the log, and return `{ overrideChanges }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test`. Expected: all pass.

- [ ] **Step 5: Commit**

`git add src/targeted/run.ts src/reconcile.ts test/targeted-run.test.ts test/reconcile.test.ts`. Message: `feat(targeted): run the targeted strategy end to end`.

---

### Task 8: The reusable workflow and documentation

**Files:**
- Create: `.github/workflows/targeted-reconcile.yml`
- Modify: `README.md`, `RUNBOOK.md:50-53`, `src/reconcile.ts:803-809` (comment and printed guidance), `CHANGELOG.md`
- Test: new `test/targeted-workflow.test.ts`, `test/readme-config.test.ts` (unchanged keys)

**Interfaces:**
- Consumes: `report.json` fields `outcome` and `blockedCount`; `report.md` from Task 6; `--report` and `--update-strategy targeted` from Task 1.
- Produces workflow inputs: `base-branch` (required), `agent-version` (required, so consumers pin), `node-version` (default `"22"`), `dry-run` (default `false`). Secrets: `alerts-token` (required), `pr-token` (required).

- [ ] **Step 1: Write the failing test**

```ts
// Parse the YAML with js-yaml.
it("is a reusable workflow with required tokens", () => {
  assert.ok(wf.on.workflow_call);
  assert.equal(wf.on.workflow_call.secrets["pr-token"].required, true);
  assert.equal(wf.on.workflow_call.secrets["alerts-token"].required, true);
});
it("never creates the PR with GITHUB_TOKEN", () => {
  const step = findStep("peter-evans/create-pull-request");
  assert.equal(step.with.token, "${{ secrets.pr-token }}");
  assert.equal(step.with["body-path"].endsWith("report.md"), true);
});
it("keeps the report outside the checkout so it can't be committed", () => {
  assert.match(reportDirExpression, /runner\.temp/);
});
it("skips the PR step on failure", ...);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`. Expected: FAIL, workflow file not found.

- [ ] **Step 3: Write the workflow**

Follow `pip-cost-sharing/.github/workflows/dependabot-agent.yml` for checkout and setup. Steps:

1. Run `npx -y dependabot-agent@${{ inputs.agent-version }} --update-strategy targeted --report "$RUNNER_TEMP/agent-report"` with `GITHUB_TOKEN: ${{ secrets.alerts-token }}` and `continue-on-error: true`. Add `--dry-run` when the input is set.
2. Append `report.md` to `$GITHUB_STEP_SUMMARY`, and read `outcome` and `blockedCount` into step outputs with `jq`.
3. `peter-evans/create-pull-request` on a fixed branch `dependabot-agent/targeted`, when `outcome != 'failed'` and not a dry run. It runs on `clean` and `blocked-only` too, because with no diff it should close a stale PR; Task 9 confirms this.
4. With `gh`, using a label `dependabot-agent-blocked` and one issue per repo:
   - `blocked-only` or `failed`: create or update the issue with `report.md`.
   - `clean`, or `changes` with `blockedCount` of 0: close it if open.
5. Fail the job if `outcome == 'failed'`.

Permissions: `contents: write`, `pull-requests: write`, `issues: write`.

- [ ] **Step 4: Write the documentation**

- README: a new "Targeted mode (npm)" section covering what moves and what doesn't, the blocked reasons, `limits`, the report, a calling-workflow example, the token choice (GitHub App or service account, why not `GITHUB_TOKEN`), the third-party action, and supported npm versions.
- Correct the npm claims in `README.md:417` onward, `RUNBOOK.md:51`, and the comment and output at `reconcile.ts:803-809`: a plain install applies an override for packages reachable from the root `package.json`, and doesn't for packages reachable only through workspace members. A clean reinstall re-resolves the whole tree. Keep printing a working command for the other strategies.
- CHANGELOG: an `[Unreleased]` entry.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`. Expected: all pass.

- [ ] **Step 6: Commit**

`git add .github/workflows/targeted-reconcile.yml README.md RUNBOOK.md CHANGELOG.md src/reconcile.ts test/targeted-workflow.test.ts`. Message: `feat(targeted): add the reusable workflow and docs`.

---

### Task 9: Live proof and release gate

This task needs the owner: it pushes to fixture repos and ends in a publish. Confirm each outward-facing step with them first.

**Files:**
- Modify: `RUNBOOK.md` (add the targeted procedure and results), `package.json` (`version`), `CHANGELOG.md`
- Test: manual, on `dependabot-agent-fixture-npm`, plus the Task 5 live suite

- [ ] **Step 1: Prove real alerts close**

Run the local build against `dependabot-agent-fixture-npm`: `node <repo>/dist/index.js --repo michaelpipkin/dependabot-agent-fixture-npm --update-strategy targeted --report <tmp>`. Push the result. Wait for Dependabot to re-scan. Expected: lockfile-keyed alerts go `fixed`, including one applied through the temporary-root step. Per `RUNBOOK.md:53`, `package.json`-keyed alerts on members may stay open: confirm whether they show as "awaiting close" in the next run's report.

- [ ] **Step 2: Run the live suite on the other npm and OS combinations**

Run `DEPENDABOT_AGENT_LIVE_NPM=1 pnpm test` on npm 11 and npm 10 (`npx -y npm@10.9.2`, or a temporary `PATH` entry), on Windows and on Linux (a throwaway `workflow_dispatch` run in `ci.yml`'s environment is fine). Expected: all pass. Record the lowest npm version that passes, and state it in the README.

- [ ] **Step 3: Exercise the workflow on the fixture**

Call `targeted-reconcile.yml` from the fixture repo. Expected:
- A PR opens with the report as its description, and the fixture's `pull_request` CI runs on it.
- A second run updates the same PR.
- With everything blocked (add a limit to force it), an issue opens and no PR remains.
- Once clear, the issue closes. If the stale PR doesn't close on its own, fix step 3 of the workflow.

- [ ] **Step 4: Dry run on a real work repo (owner runs it)**

`--dry-run --update-strategy targeted --report <tmp>` with `@angular/*` limited to `<22`. The owner reviews the report for anything unexpected, especially peer dependency or `legacy-peer-deps` behaviour. Fix anything found, with a test, before continuing.

- [ ] **Step 5: Release, on the owner's go-ahead**

Move the CHANGELOG entry from `[Unreleased]` to `[1.3.0]`, and set `version` to `1.3.0` in `package.json`. Open a PR with `gh pr create`, ending the description with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Merging triggers publishing, so that's the owner's call.
