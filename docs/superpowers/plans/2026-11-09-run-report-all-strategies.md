# Run Report for Every Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--report <dir>` writes a pull request description under every strategy and package manager, led by a summary line and a deploy recommendation that counts only packages fixed for an alert in this run.

**Architecture:** Pure modules under `src/report/` do the work: classifying each alert against the tree before and after the update pass, building and rendering the deploy recommendation, and assembling and rendering the `compatible`/`latest` report. `reconcile.ts` gathers inputs per manifest group and calls them. `targeted/report.ts` adds the same summary line and recommendation to its existing report, computed from its `RunReport`. Override decisions are not touched.

**Tech Stack:** TypeScript (ES modules, `.js` import suffixes), Node's `node:test` and `node:assert/strict`, pnpm for this repo's own scripts.

**Spec:** `docs/superpowers/specs/2026-11-09-run-report-all-strategies-design.md`

## Global Constraints

- **Override output must not change.** Do not change the behaviour of `findVulnerableInstalls`, `computeOverrideChanges`, `applyOverrideChanges`, `judgeOrphanedOverride` or anything they call. Every existing test in `test/reconcile.test.ts`, `test/scenarios.test.ts` and `test/compatible-override-keys.test.ts` passes unchanged.
- **No version bump.** `package.json` stays at `1.3.1`. The README's `1.3.1` pins stay. Changelog entries go under `## [Unreleased]`.
- **Exit codes unchanged,** including `--exit-code` (`RunResult.overrideChanges` keeps its meaning).
- **Box types and first lines are fixed copy:** `[!IMPORTANT]` 🚀 `**Deploy:** fixed packages are in production code`; `[!TIP]` ✅ `**No deploy needed:** every fixed package is development-only`; `[!WARNING]` ❓ `**Check before deciding:** couldn't tell whether these reach production`. `[!CAUTION]` is never written.
- **Body limit:** reuse `MAX_BODY_CHARS` (60000). The header, summary line and deploy section are never cut.
- **Free text in markdown goes through `inline()` or `cell()`** (escapes `@mentions`, pipes and line breaks).
- **Commands:** `pnpm test` runs the offline suite (`tsc -p tsconfig.test.json && cd dist-test && node --test`); `pnpm run build` builds. Never `npm` for this repo's own scripts.
- **Line endings:** source files are CRLF in the working copy; git normalises. Don't rewrite whole files to LF.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on branch `feat/report-all-strategies`; never push to `main`.

## Review Focus

1. **The same package fixed in two manifests** (root and an isolated `functions/`): one deploy line naming both places, not two lines. Test in Task 2.
2. **An open alert whose copy was already patched before the run, in production:** it must never produce Deploy, and must appear as "already patched, awaiting close". Test in Task 4 (`assembleStrategyReport`).
3. **Dry run and `skipUpdate`:** no tree read before the update, every fix is "override", and "packages updated" isn't shown. Tests in Tasks 3 and 4.
4. **Scoped multi-line overrides** (`js-yaml@3` and `js-yaml@4`): each alert maps to its base name, and "Change" shows the floor that clears that alert's own range. Test in Task 3, using `test/fixtures/alerts-js-yaml-multiline.json`.
5. **A body over 60000 characters:** the summary and deploy section stay, table rows are cut, and the cut note appears. Test in Task 4.

---

### Task 1: Shared markdown helpers and the summary line

**Files:**
- Create: `src/report/markdown.ts`
- Modify: `src/targeted/report.ts` (move `inline`, `cell`, `SCOPE_LABEL`, `MAX_BODY_CHARS` out; import them back; keep `inline` and `MAX_BODY_CHARS` re-exported so existing imports work)
- Test: `test/report-markdown.test.ts`

**Interfaces:**
- Produces:
  - `export const MAX_BODY_CHARS = 60000;`
  - `export function inline(text: string): string` and `export function cell(text: string): string`, moved unchanged
  - `export const SCOPE_LABEL: Record<DepScope, string>`, moved unchanged
  - `export interface SummaryCounts { addressed: number; open: number; overridesAddedOrUpdated: number; overridesRemoved: number; packagesUpdated: number; rangeBumps?: number; updatePassOnly: boolean }`
  - `export function renderSummaryLine(c: SummaryCounts, planned: boolean): string`

- [ ] **Step 1: Write the failing tests** in `test/report-markdown.test.ts`:

```ts
const base = { addressed: 12, open: 13, overridesAddedOrUpdated: 8, overridesRemoved: 0, packagesUpdated: 23, updatePassOnly: true };
it("renders the approved summary line", () => {
  assert.equal(renderSummaryLine(base, false),
    "**12** of 13 alerts addressed · **8** overrides added or updated · **0** removed · **23** packages updated by the update pass");
});
it("says 'packages updated' without the update-pass qualifier when the count includes everything", () => {
  assert.match(renderSummaryLine({ ...base, updatePassOnly: false }, false), /· \*\*23\*\* packages updated$/);
});
it("puts range bumps after overrides when given", () => {
  assert.match(renderSummaryLine({ ...base, rangeBumps: 2, updatePassOnly: false }, false), /overrides added or updated · \*\*2\*\* range bumps · \*\*0\*\* removed/);
});
it("uses singular forms", () => {
  assert.equal(renderSummaryLine({ addressed: 1, open: 1, overridesAddedOrUpdated: 1, overridesRemoved: 1, packagesUpdated: 1, rangeBumps: 1, updatePassOnly: false }, false),
    "**1** of 1 alert addressed · **1** override added or updated · **1** range bump · **1** removed · **1** package updated");
});
it("in a plan, prefixes 'Planned:' and leaves out packages updated", () => {
  assert.equal(renderSummaryLine(base, true), "Planned: **12** of 13 alerts addressed · **8** overrides added or updated · **0** removed");
});
it("inline and cell still escape mentions and pipes after the move", () => {
  assert.equal(inline("by @someone"), "by `@someone`");
  assert.equal(cell("a|b"), "a\\|b");
});
```

- [ ] **Step 2: Run `pnpm test`.** Expected: FAIL, `src/report/markdown.js` not found.
- [ ] **Step 3: Create `src/report/markdown.ts`,** move the four helpers verbatim, add `SummaryCounts` and `renderSummaryLine`. In `src/targeted/report.ts`, import them and add `export { inline, MAX_BODY_CHARS } from "../report/markdown.js";`.
- [ ] **Step 4: Run `pnpm test`.** Expected: all pass, including every existing `targeted-report` test.
- [ ] **Step 5: Commit** `feat(report): shared markdown helpers and the summary line`.

---

### Task 2: The deploy recommendation

**Files:**
- Create: `src/report/deploy.ts`
- Test: `test/report-deploy.test.ts`

**Interfaces:**
- Consumes: `inline` from Task 1; `DepScope`, `DeploymentRecommendation` from `src/types.ts`; `log` from `src/util.ts`.
- Produces:
  - `export interface DeployInput { packageName: string; scope: DepScope; manifest: string; via: string[] }`: `manifest` is the alert's `manifest_path` (repo-relative, posix); `via` may hold `name@version` strings.
  - `export interface DeployEntry { packageName: string; places: string[]; via: string[] }`
  - `export type DeployOutcome = "deploy" | "no-deploy" | "check" | "none";`
  - `export interface DeployRecommendation { outcome: DeployOutcome; production: DeployEntry[]; development: DeployEntry[]; unknown: DeployEntry[]; removedOverrides: string[] }`
  - `export function manifestLabel(manifestPath: string): string`: `"package-lock.json"` → `"root"`; `"functions/pnpm-lock.yaml"` → `"functions/"`; `"packages/a/package.json"` → `"packages/a/"`.
  - `export function recommendDeploy(inputs: DeployInput[], removedOverrides: string[]): DeployRecommendation`
  - `export function renderDeploySection(rec: DeployRecommendation): string`: empty string for `"none"`.
  - `export function logDeployRecommendation(rec: DeployRecommendation): void`

Rules for `recommendDeploy`:
- One entry per `packageName`. Its scope merges production over dev over unknown, matching `mergeScope` in `reconcile.ts`. `places` are the union of `manifestLabel(manifest)`, with `root` first and the rest sorted. `via` is the union, with each `name@version` stripped to `name` (keep a leading `@scope/`), deduplicated, in first-seen order.
- Outcome: any production entry → `deploy`; otherwise any unknown → `check`; otherwise any dev → `no-deploy`; otherwise `removedOverrides.length > 0` → `check`; otherwise `none`.

Rendering, with the box lines prefixed `> ` as GitHub alerts need:
- Heading `## Deploy recommendation`, a blank line, then the box.
- The box type and first line come from Global Constraints. When the outcome is `check` only because of removed overrides, the first line is `❓ **Check before deciding:** overrides were removed, which can change installed versions at the next install`, followed by `Overrides removed: ` and the keys as code spans.
- Deploy box: a bullet per production entry, then `Development only: ` and the development names, if any. Check box: a bullet per unknown entry, then the development line, if any. No-deploy box: the development names on one line.
- Bullet: `` `name` ``, plus ` via ` and up to five via names as code spans joined by `, ` (with `, and N more` past five). When `places` has more than one place, add ` (` + places + `)`: `root` stays plain, others go in code spans, two are joined with ` and `, and three or more read `a, b and c`.

`logDeployRecommendation` keeps the console heading `🚀 Deployment impact analysis:` and prints the same entries as plain text. It ends with one of `   🚀 Recommendation: DEPLOY — fixed packages are in production code.`, `   ✅ Recommendation: NO DEPLOY NEEDED — every fixed package is development-only.` or `   ❓ Recommendation: CHECK BEFORE DECIDING — …`. It prints nothing for `none`.

- [ ] **Step 1: Write the failing tests** in `test/report-deploy.test.ts`. Use this input, based on the `pip-cost-sharing` run of 2026-11-09:

```ts
const inputs: DeployInput[] = [
  { packageName: "@grpc/grpc-js", scope: "production", manifest: "pnpm-lock.yaml", via: ["@firebase/firestore@4.19.1", "google-gax@5.0.8"] },
  { packageName: "glob", scope: "production", manifest: "pnpm-lock.yaml", via: ["rimraf@5.0.10", "replace-in-file@9.0.0", "rimraf@6.1.3"] },
  { packageName: "glob", scope: "production", manifest: "functions/pnpm-lock.yaml", via: ["rimraf@5.0.10"] },
  { packageName: "follow-redirects", scope: "dev", manifest: "pnpm-lock.yaml", via: ["axios@1.20.0"] },
];
```

Tests to include:
- `manifestLabel` gives the three results listed above.
- `recommendDeploy(inputs, [])` has outcome `deploy`; production is `[@grpc/grpc-js, glob]`; glob has `places` `["root", "functions/"]` and `via` `["rimraf", "replace-in-file"]`.
- `renderDeploySection` for that result contains these lines exactly: `> [!IMPORTANT]`, `> 🚀 **Deploy:** fixed packages are in production code`, ``> - `glob` via `rimraf`, `replace-in-file` (root and `functions/`)``, ``> - `@grpc/grpc-js` via `@firebase/firestore`, `google-gax` ``, ``> Development only: `follow-redirects` ``. It does not contain `CAUTION`.
- Dev-only input → outcome `no-deploy`, with lines `> [!TIP]` and `> ✅ **No deploy needed:** every fixed package is development-only`.
- One unknown input plus one dev input → `check`, with `> [!WARNING]` and the check first line.
- Unknown plus production → `deploy` (production wins).
- No inputs and `["minimist"]` removed → `check`, with the overrides-removed first line and ``Overrides removed: `minimist` ``.
- No inputs, nothing removed → `none`, and `renderDeploySection` returns `""`.
- Seven via names → five shown, then `, and 2 more`.
- A via name of `@evil` in free text is a code span, never a bare mention.

- [ ] **Step 2: Run `pnpm test`.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/report/deploy.ts`** to the interfaces and rules above.
- [ ] **Step 4: Run `pnpm test`.** Expected: all pass.
- [ ] **Step 5: Commit** `feat(report): deploy recommendation, merged across manifests`.

---

### Task 3: What this run fixed, alert by alert

**Files:**
- Create: `src/report/alert-fixes.ts`
- Modify: `src/tree.ts` (add `countChangedPackages`)
- Test: `test/report-alert-fixes.test.ts`

**Interfaces:**
- Consumes: `findInstalledVersions` from `src/tree.ts`; `satisfiesVulnerableRange` from `src/semver.ts`; `baseNameOfOverrideKey`, `overrideFloor` and `alertScope` from `src/reconcile.ts`; `DependabotAlert`, `InstalledTree`, `OverrideChange` and `DepScope` from `src/types.ts`.
- Produces:
  - `export type FixStatus = "update" | "override" | "awaiting-close" | "covered" | "no-patch" | "not-installed" | "still-vulnerable";`
  - `export interface AlertFix { number: number; url?: string; severity: string; packageName: string; manifest: string; scope: DepScope; status: FixStatus; from: string[]; to?: string }`
  - `export const isFixed = (f: AlertFix): boolean => f.status === "update" || f.status === "override";`
  - `export function classifyAlerts(input: { alerts: DependabotAlert[]; before: InstalledTree[]; after: InstalledTree[]; changes: OverrideChange[]; overridesBefore: Record<string, string> }): AlertFix[]`
  - In `src/tree.ts`: `export function countChangedPackages(before: InstalledTree[], after: InstalledTree[]): number`. This counts package names whose set of installed versions differs anywhere in the trees, including names added or removed.

`classifyAlerts` gives one `AlertFix` per alert. A copy is vulnerable when `satisfiesVulnerableRange(version, alert.security_vulnerability.vulnerable_version_range) !== false`, so an unparseable range counts as vulnerable. Take the first rule that applies:
1. No `first_patched_version` → `no-patch`.
2. No installed copy before or after → `not-installed`.
3. No vulnerable copy before → `awaiting-close` (`from` is empty).
4. No vulnerable copy after → `update`; `from` is the vulnerable copies before, and `to` is the installed versions after, joined with `, `.
5. An `add` or `update` change whose `baseNameOfOverrideKey(packageName)` equals the alert's package → `override`. `from` is the vulnerable copies after. `to` is `≥ ` plus the floor of that change's `newVersion`; when several such changes exist, use the lowest floor not inside the alert's range.
6. A key in `overridesBefore` with that base name → `covered`.
7. Otherwise → `still-vulnerable`.

`scope` is `alertScope(alert)`, `manifest` is `alert.dependency.manifest_path`, and `url` is `alert.html_url`.

- [ ] **Step 1: Write the failing tests** in `test/report-alert-fixes.test.ts`. Build alerts and trees with small helpers in the test file. Include:
  - Fixed by the update pass: before has `axios@1.19.2` and after has `1.20.0`, with range `< 1.19.3` → `update`, `from ["1.19.2"]`, `to "1.20.0"`.
  - Fixed by an override: `follow-redirects@1.15.9` in both trees, with change `{ packageName: "follow-redirects", action: "add", newVersion: ">=1.16.2 <2" }` → `override`, `to "≥ 1.16.2"`.
  - Already patched before the run: `1.16.2` in both trees, range `< 1.16.2` → `awaiting-close`.
  - Existing override, no change, still vulnerable → `covered`.
  - No patched version → `no-patch`; absent from both trees → `not-installed`.
  - Unparseable range with the copy present in both trees and no change → `still-vulnerable` (never `awaiting-close`).
  - Dry run (`before === after`) with a change → `override`.
  - Scoped lines: load `test/fixtures/alerts-js-yaml-multiline.json` and a tree with `js-yaml` 3.14.1 and 4.1.0 in both, with changes `js-yaml@3 → ">=3.15.0 <4"` and `js-yaml@4 → ">=4.2.0 <5"`. Every alert is `override`. A 3.x-line alert has `to` `≥ 3.15.0`, and a 4.x-line alert has `≥ 4.2.0`.
  - `countChangedPackages`: identical trees → 0. One nested version change plus one added package → 2.
- [ ] **Step 2: Run `pnpm test`.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `classifyAlerts` and `countChangedPackages`.
- [ ] **Step 4: Run `pnpm test`.** Expected: all pass.
- [ ] **Step 5: Commit** `feat(report): classify each alert by what this run did to it`.

---

### Task 4: The report for `compatible` and `latest`

**Files:**
- Create: `src/report/strategy-report.ts`
- Test: `test/report-strategy.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `DeploymentRecommendation` and `PackageManagerId` from `src/types.ts`.
- Produces:
  - `export interface StrategyReport { strategy: "compatible" | "latest"; packageManager: PackageManagerId; dryRun: boolean; outcome: "changes" | "clean"; summary: SummaryCounts; deploy: DeployRecommendation; fixes: AlertFix[]; notAddressed: AlertFix[] }`
  - `export function deployInputsOf(fixes: AlertFix[], impactOf: (packageName: string) => DeploymentRecommendation): DeployInput[]`: one input per fixed alert. `scope` is the fix's scope, or `impactOf(name).scope` when that is `unknown`. `via` is `productionPaths` for production, `devPaths` for dev, and both for unknown.
  - `export function assembleStrategyReport(input: { strategy: "compatible" | "latest"; packageManager: PackageManagerId; dryRun: boolean; fixes: AlertFix[]; deployInputs: DeployInput[]; overridesAddedOrUpdated: number; overridesRemoved: number; removedOverrideKeys: string[]; packagesUpdated: number }): StrategyReport`. `open` is `fixes.length`, `addressed` counts `isFixed`, and `updatePassOnly` is `true`. `outcome` is `changes` when there are override changes or packages updated, and `clean` otherwise. `deploy` is `recommendDeploy(deployInputs, removedOverrideKeys)`. `notAddressed` holds the rest of `fixes`.
  - `export function renderStrategyReport(report: StrategyReport, options?: { full?: boolean }): string`
  - `export function writeStrategyReport(dir: string, report: StrategyReport): void`: writes `report.md`, `report.json` (the whole `StrategyReport`) and `report-full.md` when the body was cut, like `targeted`'s `writeReport`.

Rendered body, in order:
- `# Dependency overrides reconciled`, or `… — plan` in a dry run, followed in a dry run by `> **Dry run.** This is the plan of what the tool would do. Nothing was changed.`
- The summary line, then `` Strategy `latest` on pnpm. ``
- The deploy section from Task 2, when it isn't empty.
- `## Packages`, a table with `| Alert | Severity | Package | Change | How | Scope | Manifest |`, and one row per fixed alert. Rows for production come first, then dev, then unknown, then by package name. Alert is `[#n](url)`; Change is `from.join(", ") → to`; How is `update` or `override`; Scope is `SCOPE_LABEL[scope]`; Manifest is the `manifest` path as a code span. With no fixed alerts, there's no table and the line `No alerts were fixed in this run.`
- When `notAddressed` isn't empty: `**Not addressed:** ` and up to 20 entries of `` [#n](url) `name`: reason `` joined with `; `, then `; and N more` past 20. Reasons: `awaiting-close` → `already patched, awaiting close`; `covered` → `an existing override covers it from the next install`; `no-patch` → `no patched version`; `not-installed` → `not installed`; `still-vulnerable` → `still vulnerable after this run`.
- When the whole body exceeds `MAX_BODY_CHARS` and `full` isn't set, keep everything above the table, cut table rows from the end, and end with the same italic note `targeted` uses: `_This report was cut to fit GitHub's size limit. Not shown in full: Packages. The complete report is in the workflow run's job summary._`

- [ ] **Step 1: Write the failing tests** in `test/report-strategy.test.ts`. Include:
  - **The awaiting-close case (Review Focus 2):** fixes are a production `awaiting-close` and a dev `override`. Deploy inputs come from `deployInputsOf` with an `impactOf` stub. The rendered body has `[!TIP]` and not `[!IMPORTANT]`, and its Not addressed line contains `already patched, awaiting close`.
  - The production `update` fix renders `[!IMPORTANT]` and a row with `| update | production |`.
  - The summary line from Task 1 appears after the title; `Strategy `latest` on pnpm.` appears.
  - A dry run has `— plan`, the dry-run note and `Planned: `, with no `packages updated`.
  - No fixes and no changes → outcome `clean`, `No alerts were fixed in this run.` and no deploy heading.
  - `deployInputsOf` uses `impactOf` only for scope when the fix's scope is `unknown`.
  - **Truncation (Review Focus 5):** 2,000 fixed alerts make a body of at most `MAX_BODY_CHARS`, still containing the summary line and `[!IMPORTANT]`, and ending with the cut note. `writeStrategyReport` writes `report-full.md` holding every row.
  - `report.json` parses back to the same `outcome`, `summary` and `deploy.outcome`.
- [ ] **Step 2: Run `pnpm test`.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `src/report/strategy-report.ts`.
- [ ] **Step 4: Run `pnpm test`.** Expected: all pass.
- [ ] **Step 5: Commit** `feat(report): the report for compatible and latest`.

---

### Task 5: Wire it into the run

**Files:**
- Modify: `src/reconcile.ts` (`GroupResult`, `processManifestGroup`, `run`; remove `logDeploymentRecommendation`; keep `resolveScope` only if still used)
- Modify: `src/config.ts:181-183` (remove the `--report` warning)
- Modify: `src/cli.ts:39-40` (help text)
- Test: `test/config-targeted.test.ts:150-160`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `classifyAlerts`, `isFixed` (Task 3); `countChangedPackages` (Task 3); `deployInputsOf`, `assembleStrategyReport`, `writeStrategyReport` (Task 4); `recommendDeploy`, `logDeployRecommendation` (Task 2).
- Produces: `GroupResult` drops `recommendations` and gains `fixes: AlertFix[]`, `deployInputs: DeployInput[]`, `packagesUpdated: number` and `removedOverrideKeys: string[]`.

In `processManifestGroup`:
- Before `pm.update`, when `!ctx.dryRun && !ctx.skipUpdate`, read `before = pm.getInstalledTree(manifestDir)`; otherwise `before` is the tree read after the update.
- Take `overridesBefore = { ...source.overrides }` before `applyOverrideChanges`, which mutates it.
- After the changes are computed, set `fixes = classifyAlerts({ alerts: groupAlerts, before, after: tree, changes, overridesBefore })`.
- `deployInputs = deployInputsOf(fixes, (name) => pm.analyseDeploymentImpact(name, manifestDir))`. Call `analyseDeploymentImpact` only for packages with a fixed alert, once per name per group.
- `packagesUpdated = countChangedPackages(before, tree)`, which is 0 when no update ran.
- `removedOverrideKeys` are the keys of changes with action `remove`.

In `run`:
- Replace the old deploy block with `const deploy = recommendDeploy(allDeployInputs, removedKeys); logDeployRecommendation(deploy);`.
- When `cfg.reportDir` is set, call `writeStrategyReport(cfg.reportDir, assembleStrategyReport({...}))`. Wrap a failed write as `AgentError` with `Could not write the report to <dir>: <message>`, as `targeted/run.ts` does.

Help text for `--report`: `Write a report of the run to this directory (or env REPORT_DIR): a pull request description with the deploy recommendation.`

- [ ] **Step 1: Update the tests.** In `test/config-targeted.test.ts`, replace the two assertions that `--report` warns under `compatible` and `latest` with one asserting it doesn't, and that `cfg.reportDir` is `"out"` under `latest`. In `test/cli.test.ts`, assert the help text contains `deploy recommendation`.
- [ ] **Step 2: Run `pnpm test`.** Expected: the updated assertions FAIL.
- [ ] **Step 3: Implement** the wiring, the config change and the help text.
- [ ] **Step 4: Run `pnpm test` and `pnpm run build`.** Expected: all pass, with existing override tests unchanged; the build succeeds.
- [ ] **Step 5: Commit** `feat(report): --report under compatible and latest, with the deploy recommendation`.

---

### Task 6: The summary and recommendation in the targeted report

**Files:**
- Modify: `src/targeted/report.ts` (`headerBlock`, `writeReport`)
- Test: `test/targeted-report.test.ts`

**Interfaces:**
- Consumes: `renderSummaryLine`, `SummaryCounts` (Task 1); `recommendDeploy`, `renderDeploySection`, `DeployInput` (Task 2).
- Produces:
  - `export function targetedSummary(report: RunReport): SummaryCounts`. `open` is `alerts.length`; `addressed` counts `fixed` and `partly-fixed`. `overridesAddedOrUpdated` and `rangeBumps` count distinct `packageName@target` among non-blocked copies with action `override` and `bump`. `overridesRemoved` is `removedOverrides.length`. `packagesUpdated` counts distinct `path`s across non-blocked copies of those alerts plus `otherChanges`. `updatePassOnly` is `false`.
  - `export function targetedDeploy(report: RunReport): DeployRecommendation`, built from `recommendDeploy`. There is one input per `fixed` or `partly-fixed` alert with `scope: alert.scope`, `manifest: alert.manifest` and `via: []`; no tree walk and no lockfile read. Removed overrides come from `removedOverrides` keys.

Changes:
- In `headerBlock`, after the dry-run and failure notes, insert the summary line (`planned` as today) and, when the outcome isn't `failed`, the deploy section. The existing `Alerts: …` line stays below them. Both stay in the header, so truncation never drops them.
- `writeReport` writes `report.json` as `{ ...report, summary: targetedSummary(report), deploy: targetedDeploy(report) }`. Existing fields are unchanged.

- [ ] **Step 1: Write the failing tests** in `test/targeted-report.test.ts`, building a `RunReport` the way the file's existing tests do:
  - A production `fixed` alert with one override copy and one bump copy → the body contains `[!IMPORTANT]` and the summary line containing `**1** override added or updated · **1** range bump`.
  - A dev-only fix → `[!TIP]`.
  - A `failed` outcome → no `Deploy recommendation` heading.
  - A dry run → `Planned: ` in the summary line.
  - A truncated body still contains the deploy section.
  - `report.json` has `summary.addressed` and `deploy.outcome`.
  Update existing assertions that pin the header's exact text only where the new lines come between, and say so in the commit message.
- [ ] **Step 2: Run `pnpm test`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `pnpm test`.** Expected: all pass, including `targeted-workflow` and `alerts-file`.
- [ ] **Step 5: Commit** `feat(targeted): summary line and deploy recommendation in the report`.

---

### Task 7: Documentation, then a live check

**Files:**
- Modify: `README.md` (overview item 10, line 22; the `--report` row, line 176; "The report" section near line 625; the CI examples under "CI integration (GitHub Actions)"; the "What it changes" wording if it mentions the old deploy text)
- Modify: `CHANGELOG.md` (add `## [Unreleased]` above `## [1.3.1]`)

Content:
- **README overview item 10:** the run reports deployment impact for the packages fixed in this run, in the log and, with `--report`, at the top of the pull request description.
- **`--report` row:** any strategy. It writes `report.md` (the pull request body: summary line, deploy recommendation, table of fixed alerts), `report.json` and `report-full.md` when cut. Drop "Targeted strategy only".
- **CI examples for `compatible`/`latest`:** pass `--report "$RUNNER_TEMP/agent-report"` and give `peter-evans/create-pull-request` `body-path: ${{ runner.temp }}/agent-report/report.md` in place of a fixed body. Note that the agent's text becomes the pull request body, as with `targeted`.
- **"The report" section:** describe the three boxes and their first lines, that only packages fixed in this run count, and how alerts not addressed are listed.
- **CHANGELOG `[Unreleased]`:**
  - Under **Added:** `--report` under every strategy; the summary line; the deploy recommendation in the report.
  - Under **Changed:** the recommendation now counts only packages fixed for an alert in this run. Before, every open alert's installed package counted, so one awaiting close could make it say DEPLOY. Duplicate packages across manifests are merged. The console wording is now "NO DEPLOY NEEDED" and "CHECK BEFORE DECIDING".

- [ ] **Step 1: Make the edits,** keeping the README's existing tone and CRLF endings.
- [ ] **Step 2: Run `pnpm test`** (`readme-config` guards the README's config blocks). Expected: all pass.
- [ ] **Step 3: Live check (read-only).** Run `pnpm run build`, then run each of these from its sibling fixture directory. Each fixture's `.env` holds the token:
  - `node ../dependabot-agent/dist/index.js --repo michaelpipkin/dependabot-agent-fixture --dry-run --report <scratch>/pnpm`
  - `node ../dependabot-agent/dist/index.js --repo michaelpipkin/dependabot-agent-fixture-npm --dry-run --report <scratch>/npm`

  Expected: each writes `report.md` with the title `… — plan`, a `Planned:` summary line, a deploy box whose type matches the alerts' scope, and a table row per planned fix. Each fixture's `git status` is the same afterwards as before; `dependabot-agent-fixture-npm` already has an uncommitted `.gitignore` edit of the user's, so leave it alone. If a fixture has no `node_modules`, run its package manager's install first.
- [ ] **Step 4: Commit** `docs: the report under every strategy, and the deploy recommendation`.
