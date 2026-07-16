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
- **npm**: a plain `npm install` does **not** re-resolve a changed `overrides` block — you must clear the tree: `rm -rf node_modules package-lock.json && npm install`. (The agent prints this.)

Then wait for Dependabot to re-scan; the four **lockfile**-keyed alerts should go `fixed`, each consumer resolving to its own patched line (3.15.0 / 4.3.0). The member `package.json` alerts stay open — they track the *declared* version, which the override doesn't change; that's expected and doesn't occur for a transitive dependency.

*(To re-run from a clean slate: revert the overrides, reinstall, push, and wait for the alerts to reopen.)*

## Remove — either manager

`dependabot-agent-fixture-removal` installs `debug@2.6.9` (which declares `ms 2.0.0`) with an override forcing `ms >=2.1.0 <3`. `debug@latest` declares `ms ^2.1.3` — above the floor — so the override is dead weight.

```bash
git clone https://github.com/michaelpipkin/dependabot-agent-fixture-removal && cd dependabot-agent-fixture-removal
npm install
GITHUB_TOKEN=$(gh auth token) dependabot-agent --repo michaelpipkin/dependabot-agent-fixture-removal --dry-run
```

**Expect**:

```
🔍 Checking npm registry for upstream dependency ranges for ms...
✂️  Override for ms (>=2.1.0 <3) is no longer needed — latest upstream versions all request safe ranges: ^2.1.3
   - REMOVE ms: ">=2.1.0 <3"
```

This scenario is **registry-driven, not alert-driven** — the repo has no vulnerabilities, so the agent fetches zero alerts and the `ms` override is a pure orphan. (The repo still needs Dependabot alerts *enabled* so the fetch returns `[]` rather than a 403 — this fixture has them on.) The removal decision reads `debug@latest`'s range (`^2.1.3`), not the installed `debug@2.6.9`'s (`2.0.0`); that forward-looking check is the whole point. The decision logic itself is pinned deterministically by `judgeOrphanedOverride` in `test/reconcile.test.ts`.

## Regenerating the captured fixtures

`test/fixtures/` holds real output captured once. To refresh after an intentional format change:

- `alerts-*.json` — `gh api "repos/<fixture>/dependabot/alerts"` (trim to the fields the agent reads).
- `pnpm-list-*.json` — `pnpm list -r --json --depth=Infinity` in a vulnerable workspace.
- `npm-ls-*.json` — `npm ls --all --json` in a vulnerable workspace.
- `dependents-*.json` — the `DependentRange[]` shape (`{dependent, version, installedRange, latestRange, latestKnown}`).
