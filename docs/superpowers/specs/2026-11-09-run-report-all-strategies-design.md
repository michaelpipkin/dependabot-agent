# A run report for every strategy, with the deploy recommendation — design

Status: approved in conversation on 2026-11-09, pending review of this document.

## Intent

When the agent runs in CI and opens a pull request, the person reviewing it has one decision to make quickly: **does this need deploying?** If any package fixed for a vulnerability is in production code, they open a pull request to their release branch straight away so a new version ships. If every fix is development-only, merging to the working branch is enough.

The agent already works this out and prints it to the log as "🚀 Deployment impact analysis" with a "Recommendation: DEPLOY / BRANCH PUSH ONLY / REVIEW MANUALLY" line. But under `compatible` and `latest` it only goes to the log, so the reviewer has to dig through the Actions log to find it. That was the user's own experience with `pip-cost-sharing` (pnpm, `latest`, its own workflow with a fixed pull request body).

`--report` already writes a pull request description, but only under `targeted` (npm). This work makes it available for every strategy and package manager, and puts the recommendation at the top of it. The tool is for general use, not one company, so it has to work for anyone's workflow.

## Goals

1. `--report <dir>` works under every strategy (`compatible`, `latest`, `targeted`) and both package managers (npm, pnpm), and writes a description a workflow can use as the pull request body.
2. The description leads with a one-line summary and the deploy recommendation, then a table of the packages fixed for an alert.
3. The recommendation answers the reviewer's actual question: whether any package fixed for an alert **in this run** is in production code. That includes packages the update pass fixed, and excludes open alerts the run didn't change, which today's recommendation counts (see "Recommendation logic").
4. Users can see how to use the report in their own workflow (README).

## Non-goals

- No change to which overrides are written for a given input. That is part of the 1.x contract (README "Versioning & stability"). Only what's reported changes.
- No listing of packages the update pass moved for reasons other than an alert. They are counted, not listed.
- No change to `pip-cost-sharing` in this work. Switching its workflow to use the report is a separate step after the release (see "Follow-up").
- No change to the reusable `targeted-reconcile.yml` workflow's behaviour beyond what the new report content needs.

## Anti-goals

- A recommendation that could be misread at a glance. A reviewer skimming must never read "Deploy" as "don't deploy", or the reverse. No stop-sign-like icons, no red, and the decision is stated in words, not only by colour or icon.
- A recommendation that says "No deploy needed" when a production package changed for an alert in this run, or "Deploy" when no production package changed.
- A description that breaks on GitHub: over the body size limit, or with markdown that renders wrongly.

## What the description looks like (decided by the user)

Top to bottom:

### 1. Summary line

One line with four numbers:

> **12** of 13 alerts addressed · **8** overrides added or updated · **0** removed · **23** packages updated

### 2. Deploy recommendation

A heading, then a GitHub alert box (`> [!IMPORTANT]` and so on). GitHub draws these with a fixed colour, icon and label word, so the type is chosen per outcome, and the box's first line states the decision in words:

| Outcome | Box type (colour, label) | First line |
|---|---|---|
| A package fixed for an alert in this run is in production code | `[!IMPORTANT]` (purple, "Important") | 🚀 **Deploy:** fixed packages are in production code |
| Every package fixed for an alert in this run is development-only | `[!TIP]` (green, "Tip") | ✅ **No deploy needed:** every fixed package is development-only |
| The tool can't tell for at least one fixed package, and none is known to be production | `[!WARNING]` (yellow, "Warning") | ❓ **Check before deciding:** couldn't tell whether these reach production |

`[!CAUTION]` (red) is never used.

Inside the Deploy box, list each production package and what pulls it in (`@grpc/grpc-js` via `@firebase/firestore`, `google-gax`), one line per package. When the same package appears in more than one manifest (root and `functions/`), combine them on one line and name the places. Then a line listing the development-only packages. The other two boxes list their packages the same way.

The approved mockup is in `.superpowers/brainstorm/` (`recommendation-v2.html`, option 1), which is local and not committed.

### 3. Package table

Only packages fixed for an alert in this run, one row per alert, with the columns the targeted report already uses:

| Alert | Severity | Package | Change | How | Scope | Manifest |
|---|---|---|---|---|---|---|

"How" says what fixed it: the update pass, an override, or under `targeted` a range bump or an override as today. "Scope" is production or development.

## Recommendation logic (decided)

- **Counts every package fixed for an alert in this run**, whether the update pass fixed it or an override did, **and nothing else**. Today the recommendation is built from `findVulnerableInstalls`, which returns every installed package with an open alert whether or not its copies are still vulnerable. Update-pass fixes are therefore already counted, because their alerts are still open when the run happens. But so is every open alert the run didn't change, such as one awaiting close after an earlier merge, or one an existing override already covers. A production package in that state makes today's log say DEPLOY when nothing in production changed. *(Corrected 2026-11-09: an earlier draft said update-pass fixes were left out. They weren't; the flaw is the over-count.)*
- **Scope comes from Dependabot first**, as `resolveScope` does today: the alert's `dependency.scope` describes the vulnerable copy, which is version-accurate. Under `compatible` and `latest`, the local tree walk is the fallback when GitHub doesn't say, and still supplies the "via" paths. Under `targeted`, see call 9.
- **Duplicates are merged:** one entry per package, with every manifest it appears in. Today's log lists `minimatch` and `glob` twice for `pip-cost-sharing`.
- **Production wins:** one production package makes the outcome Deploy, whatever else is unknown.
- The console log keeps its "Deployment impact analysis" block, and uses the same corrected logic, so the log and the report never disagree.

## Where it applies

- `compatible` and `latest`, npm and pnpm: new. `--report` stops printing "only applies with --update-strategy targeted".
- `targeted`: keeps every existing section (Fixed, Blocked, Awaiting close and the rest) and its existing outcomes. It gains the summary line and the recommendation box at the top. *(Builder's call within that: the summary numbers that make sense for targeted, such as counting range bumps alongside overrides.)*
- Files written: `report.md` (the pull request body), `report.json`, and `report-full.md` when the body was cut, as `targeted` does today, under the same size limit.

## Constraints

- **The 1.x contract.** Override output for a given input must not change. Existing tests for override decisions must pass unchanged.
- **Both package managers, both lockfiles,** and workspaces and isolated packages (`functions/` in `pip-cost-sharing` is an isolated package with its own lockfile and is processed as its own group).
- **GitHub's body limit** (65,536 characters). Reuse the targeted report's cutting, so the summary and recommendation are never the part that's cut.
- **Exit codes unchanged,** including `--exit-code`.
- Source files are CRLF.
- The README must stay accurate for a security reviewer: say what the report contains, and that the agent's text becomes the pull request body, as it already does for `targeted`.

## Calls made in the conversation's absence (mine, for the user to check)

1. **"Change" for an override** under `compatible` and `latest` shows the installed version and the override's floor, such as `1.15.9 → ≥ 1.16.2`. These strategies write a range and don't resolve the lockfile, so the exact resulting version isn't known when the report is written. For an update-pass fix, it shows the exact before and after versions.
2. **"Alerts addressed"** counts alerts this run fixed, through the update pass or an override. An alert with no patched version, or with no installed copy, isn't addressed. A short line under the table names the alerts not addressed and why (for example `#172 deepmerge: no patched version`). It's a line, not table rows, so the table stays "fixed packages only".
   - **An alert this run didn't need to touch isn't "fixed in this run".** That covers an installed copy that was already patched before the run, because Dependabot can take about twenty minutes to close an alert after a merge. It also covers a vulnerable copy whose existing override already covers it, so no override change is made. These aren't counted as addressed, don't appear in the table, and **never affect the recommendation**, so a production package the run didn't change can't turn the box to Deploy. They go on the not-addressed line with the reason "already patched, awaiting close", matching `targeted`'s "Awaiting close or not found". The summary's denominator stays "open alerts", so these lower the "addressed" count, and the line says why.
3. **"Packages updated"** counts package versions that changed in the lockfiles during the run, which is the update pass. Overrides take effect at the next install, so they aren't in this number, and the wording must not suggest they are.
4. **A run that fixes no alert** but removes overrides gets the yellow "Check before deciding" box, naming the removed overrides, since a removal can change installed versions at the next install. A run that changes nothing writes the summary and no box.
5. **Dry run** writes the same report, titled as a plan. With no update pass, every vulnerable copy gets a planned override, so the recommendation covers those.
6. **`report.json`** for `compatible` and `latest` uses `changes` when files changed and `clean` otherwise, and carries the recommendation (outcome and packages) so a workflow can read it without parsing markdown.
7. **README:** the CI examples for `compatible` and `latest` use `report.md` as the pull request body, and the "Reports deployment impact" line in the overview mentions the report.
8. **Release:** a minor version, 1.4.0, since `--report` gains behaviour under strategies where it was ignored. **The bump isn't part of this work.** A `package.json` version bump publishes on merge, and the user gives that go-ahead separately. So the feature branch keeps 1.3.1, and the README's examples pinned to `dependabot-agent@1.3.1` and `@v1.3.1` move to 1.4.0 in the release change, not here.
9. **"Via" under `targeted`** uses Dependabot's scope only, as `targeted` does today. It never takes on a tree walk or a `node_modules` dependency, because it works from the lockfile and its dry run needs no install. The Deploy box names what pulls each package in when that can be read cheaply from `package-lock.json`, and otherwise just names the package. With no Dependabot scope, the package counts as unknown, which gives the "Check before deciding" box unless another package is production.

## Left to the builder

- How to detect what the update pass fixed. For example, find the vulnerable copies before and after the update, or compare lockfile versions. It must work on npm and pnpm, and in a dry run, where there is no update pass.
- How to share report rendering with `targeted/report.ts` rather than duplicate it.
- Table ordering, exact wording beyond the first lines above, and how the "via" lists are shortened when long.
- Test structure.

## Follow-up (not part of this work)

After 1.4.0 is published, change `pip-cost-sharing`'s `.github/workflows/dependabot-agent.yml` to pass `--report` and use `report.md` as the `create-pull-request` body, in place of its fixed `body:`.
