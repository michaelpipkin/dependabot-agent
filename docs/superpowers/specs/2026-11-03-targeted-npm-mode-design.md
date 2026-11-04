# Targeted npm mode: design

**Status:** awaiting approval. **Date:** 2026-11-03. **Base version:** 1.2.0.

## Why

Architects at the owner's workplace want to use dependabot-agent to clear a backlog of Dependabot alerts and, in practice, to set how the company handles them. Their repos use npm only, some with workspaces, and on GitHub. They don't run a general `npm update`: packages move only when vetted and tested or absolutely necessary. Vetting a framework upgrade takes a long time, and they have only just reached Angular 21.

The agent cannot do this today, even with `--skip-update`:

- An alerted direct dependency still gets an override, and npm then fails with `EOVERRIDE`.
- The documented way to apply overrides on npm (`rm -rf node_modules package-lock.json && npm install`) moved 312 of 545 packages in a test Angular project.
- Bounded overrides like `>=7.5.2 <8` install the newest version in range (7.8.6 in testing), not the earliest fix.
- The "Pinned AND alerted" warning only runs during the update pass, so it disappears.

## Goals

1. Address every open Dependabot alert in the most minimal way: each alert is either fixed or explicitly reported as blocked.
2. Change nothing else. A package moves only if it must to fix an alert, or because a fixed package requires it.
3. Move each package to the earliest version that resolves its alert.
4. Let each project set limits on how far specific packages may move, so a fix needing Angular 22 is a hard no.
5. Run on a schedule in GitHub Actions and put the result in front of reviewers as a PR whose description is the report.

## Non-goals

- pnpm support for this mode. Existing behaviour on pnpm and the `compatible` and `latest` strategies must not change.
- Moving exact pins. This may become a setting later if the architects allow it, but is out of scope now.
- Updating a parent package to clear a transitive alert.
- Building or testing. That remains the job of the repo's CI on the PR.
- Sending email directly or integrating with Azure DevOps. Reviewers get GitHub's normal PR notifications.
- Fixing `--skip-update` on the existing strategies (see "Follow-ups").

## Anti-goals

This has failed, even if it technically works, if:

- A package moves that no alert required.
- A limit is crossed, or an exact pin is rewritten.
- An alert is skipped without being reported.
- A PR contains a broken dependency tree that merely passes `npm ci`.

## Decisions made by the owner

- **Scope of a run:** only packages that must move, preferably to the earliest version that resolves the alert.
- **Limits:** configurable per project, stored in the project's settings. Crossing one is an absolute no-go.
- **Exact pins in `package.json`:** mean "don't touch". An alerted pin is left alone and reported as blocked, with no override written.
- **Fixes past a parent's declared range:**
  - Staying in the same major (`4.0.3` → `4.0.4` past a parent's exact pin): apply, and flag clearly in the PR.
  - Crossing a major: leave the alert open and report it.
- **Direct dependencies whose earliest fix is in the next major:** leave the alert open and report it, even with no limit set.
- **Delivery:** a scheduled GitHub Action. The report is the PR description. If every alert is blocked, open an issue instead.
- **Package manager:** npm only.

## Behaviour

### Turning it on

`"updateStrategy": "targeted"` in `dependabot-agent.config.json`, or `--update-strategy targeted`. *(Builder's call made here: extending the existing strategy setting rather than adding a new flag.)*

```jsonc
{
  "repo": "owner/name",
  "updateStrategy": "targeted",
  "limits": {
    "@angular/*": "<22"
  }
}
```

Running `targeted` against a pnpm project stops at startup with a clear error.

### Sorting each open alert

The unit of decision is each **copy** of the package in the lockfile, not the alert: one alert can cover several copies, and they can have different outcomes. For each open alert, check these in order:

| Condition | Outcome |
|---|---|
| Package isn't in the lockfile | Not found: nothing to do, listed in the report |
| Package is in the lockfile, but no copy is in the alert's vulnerable range | Awaiting close: nothing to do, any override is kept, listed in the report |

Then, for each copy inside the vulnerable range, in this order:

| Condition | Outcome |
|---|---|
| No `first_patched_version` | Blocked: no fix published |
| Target version not published on npm, or is a pre-release | Blocked: target unavailable |
| Target outside a matching limit | Blocked: names the limit |
| Copy is a direct dependency with an exact pin | Blocked: names the pin and manifest |
| Copy is a direct dependency with a spec that can't be safely rewritten (compound range, tag, git) | Blocked: names the spec |
| Target crosses a major from this copy | Blocked: major version crossing |
| A hand-written override already applies to this package | Blocked: names the override |
| Otherwise, direct dependency | Raise the declared range |
| Otherwise, transitive | Write a selector override |

Details:

- **A registry failure isn't a blocked alert:** only a 404 reads as target unavailable. Any other failure reading the published versions fails the run, since a `blocked-only` result would close an open PR over an outage.
- **Partial fixes:** fixable copies are fixed even if another copy of the same package is blocked. The report shows that alert as partly fixed, and it stays open until every copy is resolved. *(Builder's call.)*
- **Overrides must not catch copies that stay put:** a selector's range must exclude every copy that's blocked or safe. If it can't, for example because a pinned copy and a transitive copy share one version, the transitive copy is blocked too, naming the reason. No override is ever written that could move a pinned copy. *(Builder's call.)*
- **Limits on a shared release line:** if several alerts hit one line and the highest target breaks a limit, use the highest target that doesn't. The alert needing the higher one is reported as blocked, and the lower one is still fixed. *(Builder's call.)*
- **Major crossing follows the tool's existing caret rules.** Under `0.x`, the minor is the breaking position, as `escapesCompatibleRange` already treats it. So `0.5.0` → `0.7.0` counts as crossing.
- **The major-crossing rule also applies to direct dependencies,** even with no limit set. A major bump is exactly what needs vetting, so a person chooses to make it. The owner accepts that more of the backlog stays blocked until then.
- **Safe copies are ignored.** Only copies inside an alert's vulnerable range count, so a safe copy of the same package never moves or causes a block.
- **Target version:** the alert's `first_patched_version`. Where several alerts hit one release line, take the highest patch on that line. `mergeAlert` and `computeScopedSpecs` already do this reasoning.
- **`dismissed` alerts:** ignored for fixing, as today, and still count as load-bearing for removal.

### Limits

- `limits` maps a package name or `*` glob to a semver range. Config file only.
- A limit applies to every version the run would write or cause: direct bumps, overrides, and packages moved as a side effect.
- A malformed limit stops the run at startup, naming the key: `limits` that isn't a plain object, an empty pattern, or a blank or invalid range.
- `limits` set on another strategy prints a warning that it has no effect.

### Applying fixes

Fixes operate on the lockfile and need no `node_modules`. All install commands use `--package-lock-only --ignore-scripts`.

Members and `file:` packages are read from the lockfile, not from a workspace glob, so any glob form works. A package outside the root is never read from disk.

Snapshot `package-lock.json` and every manifest first. Then:

1. **Raise direct dependencies.** For each manifest declaring a vulnerable copy:
   `npm install <name>@<target> [-w <member>] --save-prefix=<existing operator> --package-lock-only --ignore-scripts`.
   The prefix must be passed through because npm otherwise turns `~` into `^`. Beware `.npmrc` settings like `save-exact`, which must not change the written operator.
2. **Write overrides** to the root `package.json`, keyed to the vulnerable versions with an exact value:

   ```json
   "overrides": {
     "qs@>=6.0.0 <6.7.3": "6.7.3",
     "minimatch@>=3.0.0 <3.1.3": "3.1.3",
     "minimatch@>=5.0.0 <5.1.7": "5.1.7"
   }
   ```

   Build one key per release line. The upper bound is the target. The lower bound is the higher of the advisory's lower bound and the start of the target's release line, and is **never omitted**: an open-ended `qs@<6.7.3` would also catch a 5.x copy and drag it across a major. Under `0.x`, the line starts at the minor (`>=0.5.0`). Convert GitHub's `>= 4.0.0, < 4.1.1` form to `>=4.0.0 <4.1.1`.
3. **Resolve:** `npm install --package-lock-only --ignore-scripts`. This is enough for anything reachable from the root `package.json`.
4. **For copies that didn't move,** which means they're reachable only through workspace members, npm needs the temporary-root step:
   - Using the lockfile, find each member's direct dependencies that lead to the target. Exclude the alerted package itself.
   - Add them, with their declared ranges, to the root `devDependencies`. Root entries that already exist win.
   - Resolve.
   - Restore the root `devDependencies` exactly, and resolve again.
5. **Verify** (see below). On any failure, restore every snapshot.

Override key order follows the existing `sortObjectKeys`, and nested overrides are preserved as `override-source.ts` already does.

Replaced override keys are removed before the bumps run, and new keys are added after them. A plan with no changes runs no npm at all.

### Verification

Apply these checks to the result. `npm ci` alone is not evidence: it passed on trees missing packages entirely. `npm ls` is not usable as the gate either: it reports valid overrides as `invalid` in member-only trees. So the tool needs its own lockfile check.

1. **Fixed:** every copy the plan said it would fix is at its target. Copies reported as blocked are expected to remain.
2. **Nothing else moved:** comparing before and after, every changed entry must be either a target copy now at its target, or a package newly added or moved because a target's declared dependency requires it. Anything else fails, including a safe copy that moved.
3. **Pins held:** every exact pin in every manifest resolves to the same version as before.
4. **Limits held:** every changed entry satisfies any matching limit.
5. **Tree complete:** walking every lockfile entry using Node's resolution rules, every non-optional dependency resolves to an entry. Each version satisfies the declared range, or the difference is explained by an override.
6. **Manifests:** only the expected `package.json` changes exist. No temporary `devDependencies` remain.
7. **Stable:** another `npm install --package-lock-only --ignore-scripts` changes nothing.

Verification failure is all-or-nothing for a first version: restore the snapshots, exit 1, and report which check failed and on which package. It never produces a partial PR.

### Existing overrides

*(Builder's calls, following the rule that the agent never discards a pin it didn't write.)*

- **Hand-written** (a plain name, `name@2`, or a nested override under a parent): never changed or removed. If one applies to an alerted package, that package is blocked and the report names the override. Nested overrides under a parent that the alert's copy sits beneath count too.
- **Written by the agent on an earlier `compatible` or `latest` run** (a value starting with `>=`): if the package has an open alert, replace it with the new key shape, but only when its selector matches what a moving copy's dependents will declare. npm applies the first key that matches a dependent, so only such a key competes with the new one. A key that doesn't match stays, because it may still be holding an earlier fix. A key that still holds another dependent's fix, one the new key wouldn't cover, blocks the copy instead of being replaced. Verification still applies, so if this moves anything unexpected the run fails rather than passing it through. With no open alert, leave it alone so that adopting the mode moves nothing.

### Removing overrides

Keep the existing rules: only `fixed` alerts free an override, upstream ranges must have moved on, and hand-written overrides are never removed. In targeted mode, a removal additionally happens only if it moves no lockfile version. Otherwise keep the override and say so in the report. Replacing a key with the new shape follows the rule under "Existing overrides": it happens only when the key matches what a moving copy's dependents will declare, and a key that still holds another dependent's fix blocks the copy instead.

The range-selector rules live in targeted-only helpers (`src/targeted/override-keys.ts`), and `baseNameOfOverrideKey` and the removal check in `computeOverrideChanges` stay as they are, so `compatible` and `latest` behave exactly as before:

- A selector key names its package whatever the selector's shape, so `qs@>=6.0.0 <6.7.3` resolves to `qs`.
- An override is agent-authored when its value starts with `>=`, or when its key is exactly `name@>=X.Y.Z <A.B.C` with the value `A.B.C`. Any other exact value, on a plain name, a `name@2` key or a range key whose value isn't its upper bound, stays hand-written.

### More than one lockfile

Isolated sub-packages with their own lockfile, such as a `functions/` folder, are in scope, because skipping their alerts silently is an anti-goal. The existing grouping in `run()` still applies: alerts on workspace members fold into the root, and each isolated directory is its own group with its own root `package.json` and lockfile. *(Builder's calls:)*

- All groups share one report, one PR, and one `outcome`.
- All-or-nothing covers the whole run: a failure in any group restores every snapshot.
- If any group resolves to pnpm, the run stops at startup with a clear error.

### The report

With `--report <dir>`, the tool writes:

- **`report.md`:** the PR or issue body. Sections are "Fixed", "Partly fixed", "Applied past a declared range — review these", "Blocked", "Awaiting close or not found", and "Other changes". Fixed entries give the alert number and link, severity, package, version from and to, and whether it was a range bump or an override, along with the existing production or dev classification. "Other changes" lists packages moved only because a fixed package needs them.
- **`report.json`:** the same data plus `outcome`, which the workflow reads to decide what to do:
  - `failed`: the run failed.
  - `changes`: at least one file changed.
  - `blocked-only`: nothing changed, and at least one copy is blocked.
  - `clean`: nothing changed and nothing is blocked. Alerts awaiting close or not found appear in the job summary only, so they don't open a false issue.

A dry run produces the same report, labelled as a plan, with no writes.

### The workflow

Provide a reusable workflow (`workflow_call`) in this repo. Consumers call it on their own `schedule` and `workflow_dispatch`, passing the base branch and the PAT.

| `outcome` | Action |
|---|---|
| `changes` | Create or update a PR from a fixed branch, using `peter-evans/create-pull-request` with `body-path: report.md`. Close the blocked issue if nothing is blocked |
| `blocked-only` | Create or update one labelled issue with `report.md`. No PR |
| `clean` | Job summary only. Close the issue if open |
| `failed` | Fail the job and update the issue with the failure. A missing `report.json` counts as `failed`: the job summary and issue say that no report was produced and link to the run |

Every outcome also writes the report to `$GITHUB_STEP_SUMMARY`: `report-full.md` when the tool wrote one (it does only when `report.md` was cut to fit GitHub's size limit, and the cut note points to the job summary), otherwise `report.md`. A report with a `restoreError` means the checkout is in an unknown state, so no PR is created. Nothing is written to GitHub on a dry run.

`pip-cost-sharing/.github/workflows/dependabot-agent.yml` is the model for this workflow. It already shows that a personal access token is needed for the alerts API because `GITHUB_TOKEN` can't read it, and that a fixed branch name makes reruns update one PR.

**Don't copy its PR token.** That workflow creates the PR with `GITHUB_TOKEN`, and PRs created that way don't trigger `pull_request` workflows, so a repo's GitHub Actions CI would never run on them. This design relies on CI for all testing. The reusable workflow takes a separate required PR-creating token, and the docs explain the choice: a GitHub App or a service account, because a PR's author can't approve their own PR. *(Builder's call: the tool stays neutral on which credential a company picks.)* Document the token, its required permissions and the third-party action, since companies may need to approve all three.

## Evidence from testing

Throwaway projects, npm 11.16 unless noted, with lockfiles made using `--before=<date>` so that newer versions were available.

| Case | Result |
|---|---|
| Single package: exact or selector override + `npm install` or `--package-lock-only` | Only targets moved; `npm ci` ok |
| Single package: bounded range override | Moved to newest in range, not the earliest fix |
| Selector with a safe direct copy beside it | Only vulnerable copies moved |
| Selector overlapping the declared range of a root direct dependency | `EOVERRIDE`; raising the direct dependency first works |
| Two-sided selectors on two majors | Each line moved within itself; a flat override dragged the 5.x consumer to 3.x |
| Workspace, reachable from root | Plain resolve applies the override (4 of 545 on Angular 21) |
| Workspace, members only: plain, `--force`, `--package-lock-only`, `-w` | Override ignored; nothing moved |
| Workspace, members only: `npm update <name>` | Skipped past the exact target to newest in range |
| Workspace, members only: deleting lock entries, then installing | **Package disappeared from the lockfile; `npm ci` still passed** |
| Workspace, members only: rewriting lock entries by hand | Works only if the new version needs no new dependencies; otherwise a broken tree that passes `npm ci` |
| Workspace, members only: re-requesting the parent with `--no-save` | Nothing moved |
| **Workspace, members only: temporary root dependencies** | **Worked: 4 of 545 on Angular 21, manifests restored, second run stable, including members with different ranges, when the members share one hoisted copy. A copy nested inside a member's own `node_modules` is blocked: the override can't reach it, and moving the members to one range of the parent clears it** |
| Same technique, target above a safe copy | Safe copy moved too, which is why verification check 2 exists |
| Direct bump with `-w`; `~` with `--save-prefix=~`; devDependency stays in `devDependencies` | All correct |
| Clean reinstall, for comparison | 312 of 545 moved |

The Angular build packages pin some dependencies exactly: `@angular/build` declares `picomatch` 4.0.3, and `@angular-devkit/core` declares `ajv` 8.17.1. `npm ls` flags overrides of these as `invalid` in member-only trees, which is expected under the "apply and flag" decision.

## Must be proven during the build

The temporary-root technique relies on behaviour npm doesn't document. These must be tested, and a release should not go out until the first is confirmed:

1. **Real alerts close.** On a live fixture repo, Dependabot closes alerts after a selector override, including one applied by the temporary-root step. The agent's earlier fixtures confirmed this for `name@major` keys only.
2. **It holds on npm 10.** Only plain overrides and direct bumps have been tested there. Find the supported minimum and state it.
3. **A later `npm install` with `node_modules` present keeps the versions.** Only lockfile-only reruns have been tested.
4. **A member's exact pin overlapping a selector.** Not tested. The sorting rules should prevent this from being written, and verification check 3 is the backstop. A test should confirm the run stops rather than moving it.
5. **Replacing an agent-written floating override with the new key shape.** Not tested, and neither is a selector beside an existing override for the same package.
6. **Windows and Linux both work.** Testing was on Windows; the workflow runs on Linux.
7. **A real work repo, dry run first.** Peer dependency conflicts or `legacy-peer-deps` settings in real repos may behave differently from the test projects.

If a later npm version changes the behaviour, verification should catch it and report the alert as failed.

## Left to the builder

- Module layout. A sensible split: alert sorting, override key building, lockfile reading and verification, and report writing as separate, pure, testable units, with the npm commands behind `PackageManager`.
- Whether to read the lockfile directly for the tree (likely, since `npm ls` needs `node_modules`).
- Semver range matching for limits. `semver.ts` is hand-written, so either extend it or add a dependency.
- Exact report wording, and labels and titles for the PR and issue.
- Existing tests to extend: `readme-config.test.ts` checks that config keys are documented, and `reconcile.test.ts`, `scenarios.test.ts` and `update-guards.test.ts` cover nearby behaviour. Follow the repo's practice of replaying captured real package-manager output.

## Release

- Minor bump (the versioning policy covers new config keys with safe defaults), with a CHANGELOG entry. A `package.json` version bump triggers publishing, so it goes in only when ready to release.
- Document the mode, limits, blocked outcomes and the workflow in the README, and add the npm details to RUNBOOK.md.
- **Correct existing documentation.** `README.md`, `RUNBOOK.md`, the CHANGELOG-derived guidance and the comment and output in `reconcile.ts` say npm never applies overrides without a clean install. Testing shows that's only true for packages reachable solely through workspace members.

## Follow-ups (not part of this work)

- `--skip-update` on existing strategies still writes an override for an alerted direct dependency, which fails with `EOVERRIDE` on npm, and it loses the "Pinned AND alerted" warning.
- A setting allowing the tool to move exact pins, if the architects decide they want it.
- Per-alert isolation, so one failing fix doesn't stop the rest of a run.
