# Compare the deploy recommendation with what's deployed — design

Status: agreed in conversation on 2026-11-10, pending review of this document.

## Intent

The deploy recommendation (1.4.0) answers one question for the person reading it: **do I need to deploy?** It currently counts only packages "fixed in this run", meaning versions that differ from the installed tree at the start of the run. A copy already patched before the run counts as "already patched, awaiting close": the assumption is that the patch was merged earlier and Dependabot hasn't closed the alert yet.

That assumption holds in CI, where every run starts from a fresh checkout. It fails locally, and most people run the tool locally. On 2026-11-10 the user ran 1.4.0 in `monty-hall` (pnpm, `latest`) after an uncommitted `pnpm update` had already moved zod 4.6.5 → 4.6.6, vite 8.3.0 → 8.3.5, fast-uri 3.1.8 → 3.1.9, source-map-js 1.2.1 → 1.2.2 and others. Every one of the 16 open alerts came out "awaiting close", nothing counted as fixed, and the console printed no recommendation at all. The honest answer was **Deploy**: zod and `@angular/router` are production packages, and their patched versions were neither committed nor deployed.

The question is "is the code here different from what's deployed?", not "what did this run change?". This change makes the tool compare against a baseline that stands for what's deployed, and makes it say something every time.

## Goals

1. The deploy recommendation, summary line and table compare the current state with a **baseline**, not with the tree at the start of the run.
2. By default the baseline is **the last commit**: the lockfile(s) as committed at git `HEAD`.
3. An optional setting, **`compareTo`**, names a branch (or tag, or commit) on GitHub that stands for what's deployed, for example `release`. The tool reads the lockfile(s) at that ref **from GitHub through the API**, so it doesn't depend on local git state. With it set, a local run and a CI run on the same code give the same answer.
4. **Never silent.** When there were open alerts and nothing counts as fixed, the console and the report say so, with the count of alerts already patched in the baseline.
5. The report and the console **name the baseline** they compared against, so the reader knows what "fixed" means.

## Non-goals

- No change to which overrides are written for a given input (the 1.x contract), and no change to exit codes.
- No change to the `targeted` strategy's existing sections or its `outcome`. (See call 6 for what `targeted` does get.)
- No `git fetch` or any other change to the user's git state.
- Not detecting whether the tool runs locally or in CI. One rule for both.
- No change to `pip-cost-sharing` in this work.

## Anti-goals

- **Saying "No deploy needed", or nothing, when a production package differs from the baseline in a way that fixes an alert.** That is the bug this fixes.
- **Silently comparing against something other than what the user asked for.** If `compareTo` is set and can't be read, the fallback is announced in the console and in the report, never quiet.
- **A new way for an ordinary run to fail.** Not being able to read a baseline is a warning, never an error. The run and the overrides go ahead as before.

## Decided in conversation

- **Default baseline: the last commit.** Read the committed lockfile with git (`git show HEAD:<path>`), no install needed.
- **Optional `compareTo`: read from GitHub, not from local git** (the user chose this over fetching a missing local ref). It works whether or not the branch exists locally, is never stale, needs no `fetch-depth` change in CI, and leaves git state alone.
- **Recommended setup:** put `compareTo` in `dependabot-agent.config.json`, so local and CI runs share it. The README presents it as the recommended way to run the tool.
- **If `compareTo` can't be read** (missing permission, unknown ref, no lockfile there, network): warn in the console and the report, for example `⚠️ Couldn't read pnpm-lock.yaml on "release" from GitHub (403); compared with the last commit instead.`, and fall back to the default.
- **If there's no usable last commit** (not a git repository, git not installed, or the lockfile isn't committed yet): fall back to today's rule, the installed tree at the start of the run, and say so the same way.
- **Token:** the same token that reads alerts reads the lockfile. It needs **Contents: Read** in addition (fine-grained); a classic token needs `repo` for a private repository. In Actions the alerts token is already a PAT or App token (`GITHUB_TOKEN` can't read alerts), so it's that token that needs Contents: Read. The README's requirements and token sections say so. Without `compareTo`, no new permission is needed.
- **Large lockfiles:** request the raw file (`Accept: application/vnd.github.raw`), which GitHub serves up to 100 MB. A pnpm lockfile over 1 MB is common.

## How "fixed" is decided

**Rule (decided by the user):** an alert counts as fixed, and so can count toward Deploy, **only when what's deployed (the baseline) has a vulnerable copy** and the current state no longer does, or an override reaches the copy that remains. If production was never exposed, deploying isn't needed for that alert; its fix ships with the next normal release.

Per alert, comparing the baseline lockfile with the current lockfile (call 11):

- **Fixed by a version change:** the baseline has a vulnerable copy, and the current state has no vulnerable copy. That covers the update pass in this run and any update made before it but not yet in the baseline.
- **Fixed by an override:** the baseline has a vulnerable copy, a vulnerable copy remains, and either an override this run writes reaches it (1.4.0's rule 5), or an existing override reaches it that isn't in the baseline (call 3).
- **Already patched in the baseline ("awaiting close"):** the baseline has the package with no vulnerable copy, **and** so does the current state. Only this case is "awaiting close".
- **Not vulnerable in the baseline, vulnerable here:** the baseline has the package patched, or doesn't have it at all (a dependency added or downgraded since), and the current state has a vulnerable copy. Not fixed and not "awaiting close", which would be false: the alert won't close until a fix is merged. It goes on the "Not addressed" line with the reason `not vulnerable in <baseline>; an override covers it` (when this run's override, or one not in the baseline, reaches it) or `not vulnerable in <baseline>; still vulnerable here`.
- **Not in the baseline, not vulnerable here** (a new dependency already on a patched version): "Not addressed" with `not in <baseline>`.
- **No usable baseline** (the start-of-run fallback): 1.4.0's rules apply as they are, including never concluding "already patched" from a package missing from the before tree.
- The rest (no patched version, not installed, still vulnerable with a vulnerable baseline, covered by an override that is in the baseline) stays as in 1.4.0.

The deploy recommendation is built from the fixed alerts exactly as in 1.4.0 (scope from Dependabot, merged across manifests, production wins, the three boxes).

## Where it applies

- **`compatible` and `latest`, npm and pnpm:** the baseline replaces the pre-update tree for classification, the "Change" column's "from" versions and the packages count.
- **`targeted`:** see call 6.
- **Dry runs:** the baseline is used the same way. A dry run now shows the same deploy answer a real run would, apart from the update pass it skips.
- **Isolated packages** (e.g. `functions/` with its own lockfile): each manifest group reads its own lockfile at the baseline.

## Constraints

- The 1.x contract: overrides written and exit codes unchanged; every existing override-decision test passes unchanged.
- Both lockfile formats: `pnpm-lock.yaml` (lockfile v6 and v9 keys, read with the `js-yaml` dependency the project already has) and `package-lock.json` v2/v3 (the `targeted` strategy already parses it, in `src/targeted/lockfile.ts`).
- No new runtime dependency.
- GitHub's body limit and the never-cut header from 1.4.0 still hold.
- The README stays accurate for a security reviewer: say that with `compareTo` the tool reads lockfiles from the repository through the API, with which permission.
- CRLF source files, pnpm for this repo's scripts.

## Calls made in the conversation's absence (mine, for the user to check)

1. **Setting names:** `--compare-to <ref>`, env `COMPARE_TO`, config `compareTo`. The value is any ref the GitHub contents API accepts: a branch, a tag or a commit SHA.
2. **Wording that names the baseline:**
   - The summary line ends with where it compared: `**8** of 16 alerts addressed · **6** overrides added or updated · **0** removed · **23** packages changed since the last commit`. With `compareTo`: `… since \`release\``. In a fallback to the start of the run, it says `… updated by the update pass`, as in 1.4.0.
   - The "Strategy `latest` on pnpm." line gains `Compared with the last commit (\`c2b8101\`).` or `Compared with \`release\` on GitHub.`
   - The console's "Deployment impact analysis" block opens with the same "Compared with …" line.
3. **Overrides already in the working copy but not in the baseline count as fixes.** Typical case: the agent wrote overrides, the user didn't install yet and runs it again. Those overrides change what the next install resolves compared with what's deployed, so an alert they reach counts as fixed by an override. This needs the baseline's override list too: read the same override source file (`package.json` or `pnpm-workspace.yaml`, wherever the run found the overrides) at the baseline the same way as the lockfile. If that file can't be read, every existing override is treated as being in the baseline (1.4.0's behaviour), and no extra warning is shown.
4. **Never silent:**
   - Console: with open alerts in scope and nothing fixed, print the block with `✅ Recommendation: NO DEPLOY NEEDED — no package was fixed for an alert compared with <baseline>.` and, when there are any, `N alert(s) were already patched in <baseline> and are awaiting close.`
   - Report: in that case a `[!TIP]` box with first line `✅ **No deploy needed:** no package was fixed for an alert compared with <baseline>`. This is new copy alongside 1.4.0's fixed first lines; the three existing first lines don't change.
   - With no open alerts and no override change, the console prints `No open alerts to assess.` and the report keeps 1.4.0's behaviour (summary, no box).
5. **Packages count:** compared with the baseline (all version changes since it), not just the update pass. With the start-of-run fallback, it is the update pass, as in 1.4.0.
6. **`targeted`:** gets the same baseline for its summary line and deploy box only. An alert its plan marks `awaiting-close` but whose package was vulnerable in the baseline counts as fixed for the box (scope from Dependabot, as today). Its sections, statuses and `outcome` don't change, so the reusable workflow sees nothing different.
7. **The pre-update tree read** stays only as the fallback baseline. When a baseline from git or GitHub is available, the run doesn't need it, which also removes the pnpm failure mode the 1.4.0 review found. Builder may keep it if dropping it complicates the code.
8. **Lockfile paths:** each group's lockfile path relative to the repository root, taken from `git rev-parse --show-toplevel`; without git (when only `compareTo` could work), relative to the workspace root. If the configured workspace root isn't the repository root, the git-derived path is what's used.
9. **Release:** a **minor** version, **1.5.0**, not 1.4.1, because it adds a setting. (The bump isn't part of this work.)
10. **`report.json`** gains `baseline: { kind: "commit" | "ref" | "run-start", ref?: string, sha?: string, fallbacks: { manifest: string, kind: "commit" | "run-start", reason: string }[] }`. `kind`/`ref`/`sha` describe the baseline the run was asked to use; `fallbacks` lists each manifest group that couldn't use it and what it used instead.
11. **Both sides of the comparison are lockfiles.** The baseline is a lockfile, so "the current state" is the working copy's lockfile after the update pass, not `node_modules`. That's what a deploy installs, and it avoids wrong answers when `node_modules` is out of step locally (after a `git pull` or a branch switch with no install). Vulnerable copies, the "Change" column and the packages count all come from lockfile versus lockfile. The override decisions still come from the installed tree, unchanged (the 1.x contract). Platform-only optional packages in a lockfile count like any other entry; a few extra in the packages count is acceptable.
12. **`outcome` in `report.json` still describes this run, not the baseline:** `changes` when this run added, updated or removed an override, or the working copy's lockfile changed during the run (compare the lockfile read before the update pass with the one after). Otherwise `clean`. Workflows that open a pull request on `changes` must not open empty ones because the branch differs from `release`. The "packages updated by the update pass" figure isn't shown any more when a baseline is in use; the summary shows the count since the baseline (call 5).
13. **When manifest groups end up with different baselines** (say the root reads `release` but `functions/pnpm-lock.yaml` isn't on `release`): each group uses the best baseline it can get. The summary and "Compared with …" lines name the baseline the run was asked for, and a warning line under them names each group that fell back and to what.
14. **`targeted`, precisely:** only the deploy box and the "Compared with …" line use the baseline. The summary line's counts stay as in 1.4.0, computed from the plan, so they never contradict the existing "Alerts: …" line underneath. The box may name a package whose alert the plan calls awaiting close; the "Compared with …" line explains why.
15. **Nothing fixed, in `report.json`:** `deploy.outcome` is `"no-deploy"`, the same instruction as "every fixed package is development-only". Workflows can tell the two apart by `summary.addressed` being 0.
16. **Removed overrides still win:** if nothing was fixed but overrides were removed, 1.4.0's "Check before deciding" box is shown, not the new tip box. An override that's in the baseline but missing from the working copy (removed earlier and not yet committed or deployed) counts like one this run removed, the mirror of call 3.

## Left to the builder

- How to parse each lockfile format into name → installed versions (reuse `src/targeted/lockfile.ts` where possible; a small pnpm-lock reader keyed on `packages`/`snapshots`).
- How to structure the baseline source (git, GitHub, start of run) and its fallback chain.
- Test structure, including a test that reproduces the `monty-hall` case (uncommitted updates; baseline vulnerable; current patched → Deploy).
- Exact console spacing and the warning texts beyond the examples above.

## Acceptance example

`monty-hall` as on 2026-11-10, with no `compareTo`: the baseline is the last commit `c2b8101`, whose lockfile has zod 4.6.5, vite 8.3.0, fast-uri 3.1.8 and source-map-js 1.2.1 (all vulnerable), and `@angular/router` 22.2.5 and `@modelcontextprotocol/server` 2.4.0 (already patched). The run reports the zod, vite, fast-uri and source-map-js alerts as fixed by a version change, shows the **Deploy** box for zod (production) with the dev-only packages listed under it, lists the `@angular/router` and `@modelcontextprotocol/server` alerts as already patched in the last commit, and says `Compared with the last commit (c2b8101).` Run again after committing those changes but with `compareTo: "release"` set (and `release` still on the old versions), it gives the same Deploy answer.
