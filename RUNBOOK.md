# Scenario runbook — live end-to-end smoke tests

The agent exists to **add** and **remove** overrides, on **pnpm** and **npm** — four scenarios. Two layers of tests cover them:

1. **Deterministic, offline** — `test/scenarios.test.ts` replays real captured data (`test/fixtures/`) through the actual code paths. Runs in CI on every push; no network, no install, no Dependabot. This is the regression workhorse.
2. **Live smoke tests** — this runbook. Real repos, real package managers, real Dependabot. It catches what captured fixtures can't: a pnpm/npm output-format change, a GitHub payload change, or the npm install-application behavior shifting. Run it before a release or when touching the package-manager or GitHub integration — not on every change.

When a new issue comes in for one of these scenarios, the fix loop is: reproduce it against the relevant fixture (or capture the payload that triggers it into `test/fixtures/`), add a failing test in `test/scenarios.test.ts`, fix, and confirm the live smoke test below still passes.

## Fixture repos

All are public, **deliberately vulnerable, not for use** — leave their alerts open.

| repo | scenario |
| --- | --- |
| [`dependabot-agent-fixture`](https://github.com/michaelpipkin/dependabot-agent-fixture) | add — **pnpm** workspace, multi-line advisory |
| [`dependabot-agent-fixture-npm`](https://github.com/michaelpipkin/dependabot-agent-fixture-npm) | add — **npm** workspace, multi-line advisory |
| [`dependabot-agent-fixture-removal`](https://github.com/michaelpipkin/dependabot-agent-fixture-removal) | remove — orphan override that upstream outgrew |

Reading Dependabot alerts needs a token with `security_events` (or `repo`) scope: `GITHUB_TOKEN=$(gh auth token)`.

## Add — pnpm / npm

Both fixtures pin two majors of `js-yaml`, each vulnerable on its own advisory line. The agent should write one bounded override **per line** so neither consumer crosses a major.

```bash
# pnpm
git clone https://github.com/michaelpipkin/dependabot-agent-fixture && cd dependabot-agent-fixture
pnpm install
GITHUB_TOKEN=$(gh auth token) dependabot-agent --repo michaelpipkin/dependabot-agent-fixture --dry-run
```

```bash
# npm
git clone https://github.com/michaelpipkin/dependabot-agent-fixture-npm && cd dependabot-agent-fixture-npm
npm install
GITHUB_TOKEN=$(gh auth token) dependabot-agent --repo michaelpipkin/dependabot-agent-fixture-npm --dry-run
```

**Expect** — one root group, and:

```
   + ADD    js-yaml@3: ">=3.15.0 <4"
   + ADD    js-yaml@4: ">=4.2.0 <5"
         Split into per-line overrides — each consumer stays on its own line
```

To confirm the full loop closes, drop `--dry-run`, apply the overrides, and push:

- **pnpm**: `pnpm install` re-resolves overrides directly.
- **npm**: a plain `npm install` applies an override to a package the root `package.json` reaches, but not to one reached only through workspace members. If the old versions stay, clear the tree: `rm -rf node_modules package-lock.json && npm install`, which re-resolves everything, so other packages may move too. (The agent prints both.)

Then wait for Dependabot to re-scan; the four **lockfile**-keyed alerts should go `fixed`, each consumer resolving to its own patched line (3.15.0 / 4.3.0). The member `package.json` alerts stay open — they track the *declared* version, which the override doesn't change; that's expected and doesn't occur for a transitive dependency.

*(To re-run from a clean slate: revert the overrides, reinstall, push, and wait for the alerts to reopen.)*

## Remove — deterministic tests, not a live fixture

Removal only touches an override whose package was **alerted at some point** — the agent leaves a hand-added, never-alerted pin untouched (README guarantee; the `everAlertedNames` guard, fetched across all alert states). That makes a synthetic live removal fixture impossible: an override that was never a real Dependabot alert is, by design, left alone. `dependabot-agent-fixture-removal` (`debug@2.6.9` + a never-alerted `ms` override) now demonstrates exactly that **leave-alone** behaviour — the agent reports no changes.

So the removal decision is proven deterministically instead:

- `judgeOrphanedOverride` (`test/reconcile.test.ts`) — remove / keep-load-bearing / escape / keep-no-data, including strategy-independent removal (installed **and** latest ranges checked, so a parent-pinned dependent's override survives regardless of `--update-strategy`) and the highest-floor scoped-key threshold.
- `highestOverrideFloor` (`test/reconcile.test.ts`) — the conservative floor across scoped keys.
- workspace-member local ranges (`test/workspace.test.ts`) — a member declaring a safe range ages the override out; a vulnerable one keeps it.

A genuine live removal needs a package with real alert history whose dependents have since moved on — reproduce from a repo that actually hit such a case rather than a constructed fixture.


## Targeted — npm

Run this when touching `src/targeted/` or `.github/workflows/targeted-reconcile.yml`. `pnpm test` with `DEPENDABOT_AGENT_LIVE_NPM=1` covers real npm resolution in temp projects. This procedure covers what that can't: whether Dependabot closes the alerts, and whether the workflow behaves on GitHub.

No fixture stays in the needed state, because a successful run removes what it tests. The November 2026 proof reshaped `dependabot-agent-fixture-removal` for the test, then restored it. Commit `c60e030` there is a working starting point: an npm workspace resolved with `--before=2020-06-01`, holding a vulnerable direct dependency, transitive packages, a member-only transitive package, a member with a `^` range, an exact pin in a member, and a major crossing.

**1. Do alerts close?** After pushing that shape, wait for Dependabot's alerts, then run a local build from the fixture:

```bash
node <repo>/dist/index.js --repo <fixture> --update-strategy targeted --report <tmp>
```

Push the result. **Expect** every alert reported as fixed to go `fixed`, every blocked alert to stay open, and a second run to change nothing.

**2. Does the workflow behave?** The workflow installs the agent with `npx`, so test an unreleased build by committing the output of `pnpm pack` to the fixture and passing its raw GitHub URL as `agent-version`. `npx` accepts `dependabot-agent@<url>`. Call `targeted-reconcile.yml` from a `workflow_dispatch` workflow, with a token set as `alerts-token` and `pr-token`. The token needs Contents and Pull requests write as well as Dependabot alerts read. **Expect:**

| Situation | Result |
| --- | --- |
| Fixes available | A PR opens with the report as its description, and the fixture's `pull_request` CI runs on it |
| Run again | The same PR is updated, with no duplicate |
| `limits` in `dependabot-agent.config.json` stop every fix | The PR closes, its branch is deleted, and a `dependabot-agent-blocked` issue opens |
| Nothing left blocked | The issue closes with "Nothing is blocked" |
| PR merged, then run again | Outcome `clean`, no PR, no issue, and the merged branch is deleted |

To test a GitHub App, create one with the permissions in the README, install it on the fixture, and pass `app-client-id` and `app-private-key` in place of the tokens. **Expect** the PR's author to be the App, CI to run on it, and three jobs, `alerts`, `plan` and `publish`. With no credentials, expect the first step to fail and say so. With a client ID that doesn't exist, expect `alerts` and `plan` to fail, and the issue to say the alerts weren't available. With a token that can't push, expect `publish` to fail and the issue to say publishing failed.

**If you change which secrets a job refers to,** re-check `plan`. A throwaway workflow can pass a test secret with a meaningless value into a reusable workflow, and have jobs search `Runner.Worker`'s memory for it with `sudo`, logging only a count. On 2026-11-04 a job that only asked whether the secret was passed found 20 matches, and a job in the same workflow that didn't refer to it found none.

**3. Clean up.** Restore the fixture's files, delete its secrets, variables and the label, and remove any write permissions you added to its token. Uninstall or delete a test App. Its fixed alerts stay in its history.

**Results, 2026-11-04, npm 11.16 locally and 11.19 on the runner:** all 46 alerts ended `fixed` once the fixes landed (GitHub later listed 45 in total; the reason for the difference is unknown). Of the first run's 16 fixes, all closed about 15 seconds after a direct push; the 4 fixed through a merged PR closed about 9.5 minutes after the merge. All 30 blocked alerts stayed open until their packages were removed. Every row in the table above behaved as expected. GitHub raised a `package.json`-keyed alert for the exact pin only, not for `^` ranges. The first real run also exposed npm refetching a dependency only the replaced package used, which is why the agent now puts such entries back. A GitHub App was tested the same day on 4 alerts, on the three-job workflow: it read them, opened the PR as the App, and CI ran on it and passed. A dry run skipped `publish`, limits on every fix closed the PR and opened the issue, and removing them opened a PR and closed the issue. A client ID that doesn't exist reported through the issue that the alerts weren't available, and a key with no client ID stopped at the first step. With two tokens, `alerts` read the alerts and `publish` attempted the push, but the token had no write access by then, so the issue reported that publishing failed. A PR with tokens was last completed on the earlier one-job workflow.

### Real applications

The fixture above is small, and it can't show what a real framework's tree does. So these runs used two Angular 21 applications, one single-package and one npm workspace, with server-side rendering, Material, routing, forms, ESLint and Vitest, locked as of February 2026 so that Dependabot raised real alerts. Their CI ran `npm ci`, the build, the tests and linting on every pull request. Their `dependabot-agent.config.json` set `limits` and `moveTogether`.

Those repositories, `dependabot-agent-test-angular` and `dependabot-agent-test-angular-workspace`, and their GitHub App were deleted after 1.3.0 shipped. What follows is a record of the results, and can't be re-checked there. A repeat needs new applications built the same way, and a GitHub App or tokens.

A successful run removes what it tests, so each further repeat needs another new repository, or a replay of the lockfile before the merge. To replay, fetch the alerts, set the fixed ones back to `open`, and pass the file with `--alerts-file` on a clone of the earlier commit. Then run `npm ci`, the build, the tests and linting on the result, since those are what a lockfile check can't see. `npm audit --package-lock-only` shows what's left, and lists more than the open alerts, because GitHub auto-dismisses some development-only ones.

**Results, 2026-11-04 and 2026-11-05, npm 11.16 locally:** both applications ended with 173 of 174 alerts fixed and 1 blocked (`minimatch`, which needs a major upgrade), with `npm ci`, the build, the tests and linting passing locally and in pull request CI on Linux. Dependabot closed all 173 within a minute of each merge, and left the blocked one open. 40 alerts that weren't open at the run, all development-only, closed as well, and 10 stayed auto-dismissed.

What these runs found, which is worth re-checking after any change to planning or applying:

- **npm won't move a family one package at a time.** Before packages could move together, every run failed with `ERESOLVE`, and 0 of 174 alerts were fixed. A batched install fails too while the old entries are in the lockfile. Taking them out first works, and is stable on a second resolve. Editing `package.json` and resolving also works on a workspace, but overshoots: `@angular/ssr` went to 21.2.29, not 21.2.23.
- **A passing lockfile can still fail its build.** `@angular/ssr` moved alone passed every check, and the build failed with `this.manifest.allowedHosts is not iterable`. That's why `moveTogether` exists, and why the results above include builds.
- **A fix can land inside another advisory.** Merging the first pull requests raised two new alerts within a minute: `hono` 4.13.7 and `@hono/node-server` 1.19.15 are inside advisories that didn't touch the old versions. With fix versions now checked, a replay of the same 174 alerts takes `hono` to 4.13.11, `nanoid` to 3.3.18, `tar` to 7.5.21 and `ip-address` to 10.7.4 in one pull request. `@hono/node-server` has no clear version on its line, so it's reported.
- **`legacy-peer-deps` is caught, not hidden.** Without packages moving together, it let a split Angular through npm, and check 5 stopped it. With it, the single-package application ended with 170 fixed, and the build passed.
- **A tighter limit fixes less, and works.** With `@angular/*` at `<21.2`, 138 alerts were fixed and 36 blocked, and the build passed.

The reusable workflow ran on both with a GitHub App: a dry run wrote nothing, a real run opened a pull request authored by the App with CI running on it, and a second run updated that pull request with no duplicate. That pull request moved `hono` to 4.13.11 and removed four overrides no longer needed, with no other version moving.

These workflow runs used the workflow pinned to a commit, with a packed build passed by URL as `agent-version`. The published path, `targeted-reconcile.yml@v1.3.0` with `agent-version: "1.3.0"` from npm, hasn't been run, so try it first on any repeat.

Merging it raised no new alerts. The `hono` alert closed in seconds on the workspace and after about twenty minutes on the single-package application. A further run on each left `minimatch` and `@hono/node-server` blocked, both needing a major upgrade, and opened one issue with no pull request. The single-package run fell inside those twenty minutes, and listed `hono` as awaiting close with nothing to change.

## Regenerating the captured fixtures

`test/fixtures/` holds real output captured once. To refresh after an intentional format change:

- `alerts-*.json` — `gh api "repos/<fixture>/dependabot/alerts"` (trim to the fields the agent reads).
- `pnpm-list-*.json` — `pnpm list -r --json --depth=Infinity` in a vulnerable workspace.
- `npm-ls-*.json` — `npm ls --all --json` in a vulnerable workspace.
- `dependents-*.json` — the `DependentRange[]` shape (`{dependent, version, installedRange, latestRange, latestKnown}`).
