# Deploy Recommendation Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The deploy recommendation, summary line and table compare the working copy's lockfile with a baseline that stands for what's deployed (the last commit by default, or a `compareTo` ref read from GitHub), and the tool always gives an answer.

**Architecture:** A new `src/baseline/` area turns lockfile text into a name → versions index, resolves each manifest group's baseline (GitHub ref → git `HEAD` → start-of-run fallback) and labels it. `classifyAgainstBaseline` in `src/report/alert-fixes.ts` applies the user's rule (an alert counts only when the baseline has a vulnerable copy). The renderers gain the "Compared with …" line, the "since …" summary wording and the nothing-fixed box. `reconcile.ts` and `targeted/run.ts` wire it in. Override decisions keep reading the installed tree, unchanged.

**Tech Stack:** TypeScript (ES modules, `.js` import suffixes), `node:test` + `node:assert/strict`, `js-yaml` (already a dependency) for `pnpm-lock.yaml`, `git` via `child_process.execFileSync`, global `fetch` for the GitHub contents API. pnpm for this repo's scripts.

**Spec:** `docs/superpowers/specs/2026-11-10-deploy-baseline-design.md`

## Global Constraints

- **Override output and exit codes must not change.** Don't change `findVulnerableInstalls`, `computeOverrideChanges`, `applyOverrideChanges`, `judgeOrphanedOverride`, `reconcileOrphanedOverride` or what they call. They keep reading the installed tree. Every existing test in `test/reconcile.test.ts`, `test/scenarios.test.ts`, `test/compatible-override-keys.test.ts` passes unchanged.
- **Never change the user's git state:** no `git fetch`, no writes. Only `git rev-parse` and `git show`.
- **Reading a baseline never fails the run.** Every read failure becomes a warning and a fallback. No `exitWithError` on this path.
- **Setting names:** flag `--compare-to <ref>`, env `COMPARE_TO`, config `compareTo`. The value is any ref the GitHub contents API accepts.
- **GitHub read:** `GET https://api.github.com/repos/{owner}/{name}/contents/{path}?ref={ref}` with `Authorization: Bearer <token>`, `Accept: application/vnd.github.raw`, `X-GitHub-Api-Version: 2022-11-28`. Path segments and ref are URL-encoded. Same token as the alerts.
- **Fixed copy (verbatim):**
  - Compared lines: ``Compared with the last commit (`<sha7>`).`` · ``Compared with `<ref>` on GitHub.`` · `Compared with the packages installed at the start of the run.`
  - Summary ending: `· **N** packages changed since the last commit` or ``· **N** packages changed since `<ref>` `` (singular `package`). In the start-of-run fallback, 1.4.0's `… packages updated by the update pass`.
  - Nothing-fixed box: `> [!TIP]` then ``> ✅ **No deploy needed:** no package was fixed for an alert compared with the last commit`` (or ``compared with `<ref>` ``, or `compared with the packages installed at the start of the run`).
  - Console nothing-fixed: `   ✅ Recommendation: NO DEPLOY NEEDED — no package was fixed for an alert compared with <phrase>.` then, when > 0, `   N alert(s) were already patched in <phrase> and are awaiting close.` With no open alerts and no override change: `   No open alerts to assess.`
  - New "Not addressed" reasons: `not vulnerable in <phrase>; an override covers it` · `not vulnerable in <phrase>; still vulnerable here` · `not in <phrase>`.
  - Fallback warning shape: `⚠️  Couldn't read <file> on "<ref>" from GitHub (<reason>); compared with the last commit instead.` and `⚠️  Couldn't read <file> from the last commit (<reason>); compared with the packages installed at the start of the run instead.`
  - `<phrase>` is `the last commit` · `` `<ref>` `` · `the packages installed at the start of the run`.
- **No version bump.** `package.json` stays `1.4.0`; changelog under `## [Unreleased]`. Release will be 1.5.0, separately.
- **No new runtime dependency.**
- Free text in markdown goes through `inline()`/`cell()`/`code()` as in 1.4.0. The 1.4.0 box caps (`MAX_DEPLOY_ENTRIES`), `MAX_BODY_CHARS` and never-cut header still hold.
- `pnpm test` runs the offline suite; `pnpm run build` builds. Source files CRLF. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch `feat/deploy-baseline`; never push to `main`.

## Review Focus

1. **The `monty-hall` case** (uncommitted updates, baseline vulnerable, working lockfile patched, nothing changed by the run): outcome Deploy, never silent. Test in Task 3; live check in Task 8.
2. **`compareTo` unreadable** (403, 404, a misspelt ref, `--alerts-file` with no token): one warning per file, fallback to the last commit, run and overrides unaffected. Tests in Tasks 2 and 6.
3. **pnpm lockfile key shapes:** v6 `/name@1.2.3`, v9 `name@1.2.3(peer@x)`, scoped `'@scope/name@1.2.3'`, and v5 `/name/1.2.3` all index as name → version. Test in Task 1.
4. **A dependency added or downgraded since the baseline** never counts toward Deploy and is never "awaiting close". Test in Task 3.
5. **Mixed baselines** (root reads `release`, `functions/pnpm-lock.yaml` isn't on `release`): that group alone falls back, a warning names it, `report.json` lists it under `baseline.fallbacks`. Test in Task 6.

---

### Task 1: Lockfile version index

**Files:**
- Create: `src/baseline/versions.ts`
- Test: `test/baseline-versions.test.ts`

**Interfaces:**
- Produces:
  - `export type VersionIndex = Map<string, string[]>;` (versions ascending, deduplicated, same order rule as `findInstalledVersions`)
  - `export function pnpmLockVersions(text: string): VersionIndex`: reads keys of `packages` and `snapshots` (js-yaml `load`). Strip a leading `/`, strip a trailing `(...)` peer suffix (possibly several), then split at the last `@` past index 0; for a v5 key `/name/1.2.3` (no `@` after the name) split at the last `/`. Skip keys that don't yield a name and a parseable-looking version.
  - `export function npmLockVersions(text: string): VersionIndex`: JSON; use `parseLock` from `src/targeted/lockfile.ts` when the lockfile is v2/v3; skip the root entry `""` and link entries. Never calls `exitWithError`: unparseable or unsupported input throws a plain `Error` the caller turns into a warning.
  - `export function lockfileVersions(pm: PackageManagerId, text: string): VersionIndex`
  - `export function indexInstalledTree(tree: InstalledTree[]): VersionIndex` (for the start-of-run fallback)
  - `export function countChangedVersions(a: VersionIndex, b: VersionIndex): number`: names whose version set differs, including added and removed names.
  - `export function lockfileName(pm: PackageManagerId): "pnpm-lock.yaml" | "package-lock.json"`

`parseLock` currently calls `exitWithError` on a missing `packages` block; check it before calling and throw instead, without changing `parseLock`'s behaviour for the targeted strategy.

- [ ] **Step 1: Write the failing tests:**
  - `pnpmLockVersions` on a v9 snippet with `packages:` keys `zod@4.6.5:`, `'@angular/router@22.2.5':`, and `snapshots:` key `'@angular/router@22.2.5(@angular/core@22.2.5)(rxjs@7.8.2)':` → `zod: ["4.6.5"]`, `@angular/router: ["22.2.5"]`.
  - A v6 snippet with `/vite@8.3.0:` and `/vite@8.3.5(esbuild@0.28.2):` → `vite: ["8.3.0", "8.3.5"]`.
  - A v5 key `/js-yaml/3.14.1:` → `js-yaml: ["3.14.1"]`.
  - `npmLockVersions` on a v3 lock with `node_modules/a` 1.0.0, `node_modules/b/node_modules/a` 2.0.0 and a link entry → `a: ["1.0.0", "2.0.0"]`, the link skipped, the root skipped.
  - `npmLockVersions('{"lockfileVersion":1}')` throws `Error` (not process exit).
  - `countChangedVersions`: identical → 0; one version changed plus one name added → 2.
  - `indexInstalledTree` on a two-workspace tree gives the same versions as `findInstalledVersions` per name.
- [ ] **Step 2: Run `pnpm test`.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/baseline/versions.ts`.**
- [ ] **Step 4: Run `pnpm test`.** Expected: all pass.
- [ ] **Step 5: Commit** `feat(baseline): index lockfile versions by package name`.

---

### Task 2: Reading a baseline (GitHub, git, labels)

**Files:**
- Create: `src/baseline/source.ts`
- Modify: `src/github.ts` (add `fetchRepoFile`)
- Modify: `src/override-source.ts` (add `parseOverridesText`)
- Test: `test/baseline-source.test.ts`

**Interfaces:**
- Consumes: `GitHubRepoConfig` from `src/types.ts`.
- Produces:
  - In `src/github.ts`: `export async function fetchRepoFile(repo: GitHubRepoConfig, ref: string, repoPath: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>`. Headers from Global Constraints. `reason` is the HTTP status (`"404"`, `"403"`) or the error message. Never throws, never exits.
  - In `src/baseline/source.ts`:
    - `export type Baseline = { kind: "commit"; sha: string } | { kind: "ref"; ref: string } | { kind: "run-start" };`
    - `export interface BaselineFallback { manifest: string; kind: "commit" | "run-start"; reason: string }` and `export type ReportBaseline = Baseline & { fallbacks: BaselineFallback[] };` (what `report.json` carries, Tasks 4 and 7)
    - `export function baselinePhrase(b: Baseline): string` → `the last commit` · `` `release` `` · `the packages installed at the start of the run`
    - `export function comparedWithLine(b: Baseline): string` → the three Compared lines (sha shortened to 7).
    - `export function gitRepoInfo(dir: string): { toplevel: string; headSha: string } | null` (`git rev-parse --show-toplevel` and `HEAD`; null on any failure, including git missing)
    - `export function gitShowFile(toplevel: string, repoPath: string): string | null` (`git show HEAD:<repoPath>`, posix path; null on failure)
    - `export interface BaselineFiles { baseline: Baseline; texts: Map<string, string>; warnings: string[] }`
    - `export async function readBaselineFiles(input: { repo: GitHubRepoConfig | null; compareTo?: string; git: { toplevel: string; headSha: string } | null; repoPaths: string[] }): Promise<BaselineFiles>`: tries `compareTo` on GitHub for every path; if any required path fails, warns (shape from Global Constraints) and tries git `HEAD` for all paths; if that fails, warns and returns `{ kind: "run-start" }` with empty texts. The **first** path is the lockfile and decides the level; the others (override source files) are optional: a missing optional file at an otherwise-good level just isn't in `texts`, with no warning. `repo` is null when there's no token (alerts file): treat `compareTo` as unreadable with reason `no token`.
  - In `src/override-source.ts`: `export function parseOverridesText(fileBase: string, pm: PackageManagerId, text: string): Record<string, string>`: the flat override map the same file would yield through `selectOverrideSource` (`package.json` `overrides` for npm, `pnpm.overrides` for pnpm; `pnpm-workspace.yaml` top-level `overrides`). Returns `{}` on unparseable text.

- [ ] **Step 1: Write the failing tests:**
  - `fetchRepoFile` with a stubbed global `fetch` (restore in `afterEach`): asserts the URL `https://api.github.com/repos/o/r/contents/functions/pnpm-lock.yaml?ref=release`, the `Accept: application/vnd.github.raw` header, returns the body text; a 404 → `{ ok: false, reason: "404" }`; a rejected fetch → `{ ok: false }` with the message.
  - `readBaselineFiles` with `compareTo: "release"`, GitHub stub returning 403 for the lockfile, and a real temp git repo (init, commit a `pnpm-lock.yaml`) → `baseline.kind === "commit"`, the committed text, one warning containing `Couldn't read pnpm-lock.yaml on "release" from GitHub (403); compared with the last commit instead.`
  - Same but no git repo → `kind: "run-start"`, two warnings.
  - `repo: null` with `compareTo` → falls back with reason `no token`.
  - Lockfile OK on GitHub but `pnpm-workspace.yaml` 404 → `kind: "ref"`, no warning, texts has only the lockfile.
  - `gitShowFile` for an uncommitted file → null.
  - `comparedWithLine` for each kind matches Global Constraints exactly; `baselinePhrase` likewise.
  - `parseOverridesText("pnpm-workspace.yaml", "pnpm", "overrides:\n  zod: '>=4.6.6 <5'\n")` → `{ zod: ">=4.6.6 <5" }`; `package.json` with `overrides` for npm and `pnpm.overrides` for pnpm.
- [ ] **Step 2: Run `pnpm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.** Expected: all pass.
- [ ] **Step 5: Commit** `feat(baseline): read the baseline from GitHub or the last commit, with fallbacks`.

---

### Task 3: Classifying alerts against the baseline

**Files:**
- Modify: `src/report/alert-fixes.ts`
- Test: `test/report-alert-fixes.test.ts`

**Interfaces:**
- Consumes: `VersionIndex` (Task 1).
- Produces:
  - `FixStatus` gains `"introduced-covered" | "introduced" | "not-in-baseline"`. `isFixed` is unchanged (`update` | `override`).
  - `export function classifyAgainstBaseline(input: { alerts: DependabotAlert[]; baseline: VersionIndex; current: VersionIndex; changes: OverrideChange[]; overridesNow: Record<string, string>; baselineOverrides: Record<string, string> }): AlertFix[]`
  - `export function overridesRemovedSinceBaseline(baselineOverrides: Record<string, string>, overridesNow: Record<string, string>): string[]` (keys in the baseline, missing now)
  - `classifyAlerts` (1.4.0, installed trees) stays for the start-of-run fallback.

Rules, first that applies (B = baseline versions of the package, C = current versions; vulnerable as in 1.4.0, an unparseable range counts as vulnerable):
1. No `first_patched_version` → `no-patch`.
2. B and C both empty → `not-installed`.
3. B has no vulnerable copy and C has none → B empty: `not-in-baseline`; else `awaiting-close`.
4. B has no vulnerable copy and C has one → `introduced-covered` if an override reaches C's vulnerable copies (this run's change via 1.4.0's `qualifyingFloor`, or a key in `overridesNow` not in `baselineOverrides` whose floor qualifies the same way), else `introduced`. `from` is C's vulnerable copies.
5. C has no vulnerable copy → `update`; `from` B's vulnerable copies; `to` C's versions joined, or `removed` when C is empty.
6. An override reaches C's vulnerable copies (this run's change, or an `overridesNow` key not in `baselineOverrides`, both through `qualifyingFloor`) → `override`, `to` `≥ <floor>`.
7. A key in `baselineOverrides` with that base name → `covered`.
8. Otherwise `still-vulnerable`.

- [ ] **Step 1: Write the failing tests:**
  - **monty-hall (Review Focus 1):** B `zod: ["4.6.5"]`, C `zod: ["4.6.6"]`, range `< 4.6.6`, no changes → `update`, `from ["4.6.5"]`, `to "4.6.6"`.
  - B `["22.2.5"]`, C `["22.2.5"]`, range `< 22.2.1` → `awaiting-close`.
  - **Introduced (Review Focus 4):** B empty, C `["1.0.0"]` vulnerable, change `add` with floor `1.0.1` → `introduced-covered`; no change → `introduced`; B patched `["2.0.0"]`, C downgraded `["1.0.0"]` vulnerable → `introduced`. None of these is `isFixed`.
  - B empty, C `["2.0.0"]` patched → `not-in-baseline`.
  - Uninstalled override (call 3): B vulnerable, C vulnerable, `overridesNow: { pkg: ">=1.0.1 <2" }`, `baselineOverrides: {}`, no change → `override`.
  - Same override present in both → `covered`.
  - `overridesRemovedSinceBaseline({ a: "1", b: "2" }, { a: "1" })` → `["b"]`.
- [ ] **Step 2: Run `pnpm test`.** Expected: FAIL.
- [ ] **Step 3: Implement** `classifyAgainstBaseline` and `overridesRemovedSinceBaseline`, reusing `qualifyingFloor`.
- [ ] **Step 4: Run `pnpm test`.** Expected: all pass, existing `classifyAlerts` tests unchanged.
- [ ] **Step 5: Commit** `feat(report): classify alerts against the deployed baseline`.

---

### Task 4: Rendering the baseline

**Files:**
- Modify: `src/report/markdown.ts`, `src/report/deploy.ts`, `src/report/strategy-report.ts`
- Test: `test/report-markdown.test.ts`, `test/report-deploy.test.ts`, `test/report-strategy.test.ts`

**Interfaces:**
- Consumes: `Baseline`, `baselinePhrase`, `comparedWithLine` (Task 2); new statuses (Task 3).
- Produces:
  - `SummaryCounts` gains `packagesSince?: string` (a phrase from `baselinePhrase`). When set and not planned, the last part reads `**N** packages changed since <phrase>`; otherwise 1.4.0's wording.
  - `recommendDeploy(inputs, removedOverrides, context?: { openAlerts: number })`: with no inputs, no removed overrides and `openAlerts > 0`, the outcome is `"no-deploy"` with empty lists. `DeployRecommendation` gains `nothingFixed: boolean` (true in exactly that case).
  - `renderDeploySection(rec, baseline?: Baseline)`: for `nothingFixed`, the nothing-fixed box from Global Constraints with `baselinePhrase(baseline ?? { kind: "run-start" })`. Every other outcome renders as in 1.4.0.
  - `logDeployRecommendation(rec, info?: { baseline: Baseline; openAlerts: number; awaitingClose: number })`: prints `comparedWithLine` first under the heading; the nothing-fixed lines; `   No open alerts to assess.` when `openAlerts === 0` and the outcome is `none`. Other outcomes print as in 1.4.0 after the Compared line.
  - `StrategyReport` gains `baseline: ReportBaseline` and `warnings: string[]`. `assembleStrategyReport` takes `baseline`, `warnings`, `openAlerts`, `changedThisRun: boolean`; `outcome` is `changes` exactly when `changedThisRun`. `summary.packagesSince` is set unless `baseline.kind === "run-start"`.
  - `renderStrategyReport`: after the `Strategy …` line, `comparedWithLine(baseline)`, then each warning as an italic line `_<warning>_`. Reasons for the new statuses from Global Constraints, with `<phrase>` from the baseline.

- [ ] **Step 1: Write the failing tests:**
  - Summary: `{ …, packagesUpdated: 23, packagesSince: "the last commit" }` → ends `· **23** packages changed since the last commit`; planned → no packages part; 1 → `package`.
  - `recommendDeploy([], [], { openAlerts: 16 })` → `outcome: "no-deploy"`, `nothingFixed: true`; render with `{ kind: "commit", sha: "c2b8101…" }` contains `> [!TIP]` and ``> ✅ **No deploy needed:** no package was fixed for an alert compared with the last commit``.
  - `recommendDeploy([], ["minimist"], { openAlerts: 3 })` → still the 1.4.0 removed-overrides `check` (call 16).
  - Console: nothing-fixed prints the Compared line, the NO DEPLOY NEEDED line and `   6 alert(s) were already patched in the last commit and are awaiting close.`; `openAlerts: 0` with outcome `none` prints `   No open alerts to assess.`
  - Strategy report: contains ``Compared with `release` on GitHub.``; a warning renders in italics under it; an `introduced-covered` fix shows ``not vulnerable in `release`; an override covers it`` on the Not addressed line; `report.json` has `baseline.kind` and `baseline.fallbacks`; `outcome` is `clean` when `changedThisRun` is false even with `packagesUpdated: 40`.
- [ ] **Step 2: Run `pnpm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.** Expected: all pass.
- [ ] **Step 5: Commit** `feat(report): name the baseline, report changes since it, never stay silent`.

---

### Task 5: The `compareTo` setting

**Files:**
- Modify: `src/config.ts`, `src/cli.ts`, `README.md` (config reference block and flag table row only), `test/readme-config.test.ts`
- Test: `test/config.test.ts` (or the file existing config precedence tests live in), `test/cli.test.ts`

**Interfaces:**
- Produces: `ResolvedConfig.compareTo?: string` (flag > env `COMPARE_TO` > config `compareTo`; empty string → undefined). Allowed in the config file (unlike `reportDir`).

Help text: `--compare-to <ref>                Compare the deploy recommendation with this branch, tag or commit on GitHub (or env COMPARE_TO); default: the last commit`.

- [ ] **Step 1: Write the failing tests:** precedence (flag over env over config); `--compare-to=release` inline form; help contains `--compare-to`; `readme-config` expects `compareTo` in the documented keys.
- [ ] **Step 2: Run `pnpm test`.** Expected: FAIL.
- [ ] **Step 3: Implement**, adding `compareTo` to the README's config block and a flag-table row (`--compare-to <ref>` | `COMPARE_TO` | last commit | description). Full docs come in Task 8.
- [ ] **Step 4: Run `pnpm test`.** Expected: all pass.
- [ ] **Step 5: Commit** `feat(config): compareTo setting`.

---

### Task 6: Wiring for `compatible` and `latest`

**Files:**
- Modify: `src/reconcile.ts` (`GroupResult`, `processManifestGroup`, `run`)
- Test: `test/run-report.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: `GroupResult` gains `baseline: Baseline`, `warnings: string[]`, `awaitingClose: number`, `lockfileChanged: boolean`.

In `run`, once: `const git = gitRepoInfo(cfg.workspaceRoot)`; `repo` is `{ owner, name, token }` or null without a token.

In `processManifestGroup`, before `pm.update`:
- `repoPath` of the group's lockfile: `path.relative(git.toplevel, path.join(manifestDir, lockfileName(pmId)))` in posix form, or relative to `cfg.workspaceRoot` without git. The override source file's repo path likewise (`source.filePath`).
- `const files = await readBaselineFiles({ repo, compareTo: cfg.compareTo, git, repoPaths: [lockPath, overridePath] })`. Warnings are logged and returned.
- Read the working lockfile text from disk (`lockBefore`, or null if absent).
- Only when `files.baseline.kind === "run-start"`: the 1.4.0 pre-update tree read, as it is now.

After `pm.update` and the existing override logic (unchanged):
- `lockAfter` from disk; `lockfileChanged = lockBefore !== lockAfter`.
- Baseline mode: `current = lockfileVersions(pmId, lockAfter)` (if that throws or the file is absent, warn and use `indexInstalledTree(tree)`); `baselineIdx = lockfileVersions(pmId, files.texts.get(lockPath))`; `baselineOverrides = parseOverridesText(...)` when the text is there, else `overridesBefore` (1.4.0 behaviour, no warning); `fixes = classifyAgainstBaseline({ alerts, baseline: baselineIdx, current, changes, overridesNow: overridesBefore, baselineOverrides })`; `packagesUpdated = countChangedVersions(baselineIdx, current)`; removed keys add `overridesRemovedSinceBaseline(baselineOverrides, overridesBefore)`.
- Run-start mode: exactly 1.4.0's path.
- `awaitingClose` counts `awaiting-close` fixes.

In `run`: `baseline` for labels is the requested level: `{ kind: "ref", ref }` when `compareTo` is set, else `{ kind: "commit", sha }` when git is available, else `run-start`. Each group whose `baseline.kind` differs is a fallback `{ manifest: <label>, kind, reason }` (reason from its warning). `recommendDeploy(allDeployInputs, removedKeys, { openAlerts: totalOpenAlerts })`; `logDeployRecommendation(deploy, { baseline, openAlerts, awaitingClose })`; `assembleStrategyReport({ …, baseline, warnings, openAlerts, changedThisRun: totalAdded + totalRemoved > 0 || anyLockfileChanged })`.

- [ ] **Step 1: Write the failing tests** in `test/run-report.test.ts`, on a temp npm project that is a real git repo (commit a `package-lock.json` with a vulnerable version, then change the working lockfile to the patched version without committing), dry run, alerts from a file or a stub, and `fetch` stubbed:
  - Default: report has ``Compared with the last commit (`<sha7>`).``, the alert is in the table as `update`, a deploy box appears.
  - `compareTo: "release"` with the stub returning 404 → the warning line appears in the console and report, the comparison is the last commit, exit code and overrides as without `compareTo`.
  - `compareTo: "release"` with the stub serving the vulnerable lockfile → ``Compared with `release` on GitHub.`` and the same Deploy.
  - **Mixed (Review Focus 5):** an isolated `functions/` with its own lockfile, stub serving only the root lockfile → `report.json` `baseline.fallbacks` has one entry for `functions`, and the report shows its warning.
  - Not a git repo → `Compared with the packages installed at the start of the run.`
- [ ] **Step 2: Run `pnpm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test` and `pnpm run build`.** Expected: all pass, override tests unchanged.
- [ ] **Step 5: Commit** `feat(report): compare compatible and latest runs with the deployed baseline`.

---

### Task 7: `targeted`: the box and the Compared line

**Files:**
- Modify: `src/targeted/run.ts`, `src/targeted/report.ts`
- Test: `test/targeted-report.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `RunReport` gains `baseline?: ReportBaseline` and `baselineVulnerable?: number[]` (alert numbers whose package had a vulnerable copy in the baseline lockfile). `targetedDeploy(report)`: when `baselineVulnerable` is set, inputs are alerts in it with status `fixed`, `partly-fixed` or `awaiting-close`; otherwise 1.4.0's rule. Passes `{ openAlerts: report.alerts.length }` to `recommendDeploy`.

In `run.ts`: read the baseline for the root `package-lock.json` the same way as Task 6 (before planning); compute `baselineVulnerable` with `npmLockVersions` and each alert's range; set both fields. In `headerBlock`, after the summary line, `comparedWithLine` and any warnings, then the box (rendered with the baseline). `targetedSummary` and every section unchanged.

- [ ] **Step 1: Write the failing tests:** an `awaiting-close` production alert in `baselineVulnerable` → `[!IMPORTANT]`; a `fixed` alert not in `baselineVulnerable` (introduced) → no Deploy for it; no `baselineVulnerable` → 1.4.0 behaviour (existing tests pass unchanged); the header contains the Compared line between the summary line and the box; the summary line's numbers are unchanged by the baseline.
- [ ] **Step 2: Run `pnpm test`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.** Expected: all pass, including `targeted-workflow` and `alerts-file`.
- [ ] **Step 5: Commit** `feat(targeted): deploy box compares with the baseline`.

---

### Task 8: Documentation, then a live check

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

Content:
- **README:** "The report" section: what the baseline is, the three Compared lines, the user's rule (counts only when what's deployed has the vulnerable version), the new reasons, the nothing-fixed box. A "Comparing with what's deployed" subsection recommending `"compareTo": "release"` in `dependabot-agent.config.json`, with the token permission (**Contents: Read** fine-grained; classic `repo` for private repositories; in Actions it's the alerts token that needs it). Requirements and token sections mention the extra permission when `compareTo` is set. Security note: with `compareTo` the tool reads the named lockfile and override file from the repository through the API, nothing else. CI examples: add `compareTo` as an option, noting no `fetch-depth` change is needed.
- **CHANGELOG `[Unreleased]`:** Added `compareTo`; Changed: the recommendation compares with the last commit (or `compareTo`) instead of the start of the run, counts an alert only when the baseline is vulnerable, never stays silent, and no longer reads the installed packages before the update when a baseline is available.

- [ ] **Step 1: Make the edits.**
- [ ] **Step 2: Run `pnpm test`** (`readme-config`). Expected: all pass.
- [ ] **Step 3: Live check (read-only).** `pnpm run build`, then:
  - From `C:\Users\mpipk\source\repos\michaelpipkin\monty-hall`: `node ../dependabot-agent/dist/index.js --dry-run --report <scratch>/mh`. Its `.env` holds the token; never print it. Expected (if its working copy is still as on 2026-11-10): ``Compared with the last commit (`c2b8101`).``, a Deploy box naming zod, `@angular/router` listed as awaiting close. Record `git status --porcelain` before and after; they must match. If the user has committed since, report what the comparison shows instead.
  - From the `dependabot-agent-fixture` sibling: the same dry run with `--compare-to main`. Expected: ``Compared with `main` on GitHub.``
  - With `--compare-to no-such-branch`: the 404 warning and a fallback to the last commit, exit 0.
- [ ] **Step 4: Commit** `docs: compare the deploy recommendation with what's deployed`.
