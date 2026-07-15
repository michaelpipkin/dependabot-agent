# Dependabot Override Agent

An on-demand CLI agent that reconciles dependency **overrides** against open GitHub Dependabot alerts. Works with both **npm** and **pnpm**, in single-package projects and monorepos.

## What it does

1. **Detects** your package manager from the lockfile (`pnpm-lock.yaml` → pnpm, `package-lock.json` → npm), or you can set it explicitly.
2. **Detects** where overrides live:
   - **npm** → top-level `overrides` in `package.json`.
   - **pnpm** → `pnpm-workspace.yaml` (workspace projects) if present, otherwise `pnpm.overrides` in `package.json`.
3. **Fetches** all open npm Dependabot alerts for your repo via the GitHub API.
4. **Updates** dependencies (range-bound by default — see [Update strategy](#update-strategy)).
5. **Walks** the full installed dependency tree and confirms each alerted package is actually present.
6. **Adds or updates** override entries for packages that remain vulnerable, writing a spec bounded at the first breaking version above the patch (`>=0.7.0 <0.8`, `>=4.17.21 <5`) so a fix never drags the tree further than it has to.
7. **Flags** the cases where no in-range fix exists — the earliest patched version sits outside what's installed can accept — separately from routine changes. See [No in-range fix](#no-in-range-fix).
8. **Removes** overrides whose vulnerability has been resolved.
9. **Leaves untouched** any overrides for packages that don't appear in any Dependabot alert (assumed intentional).
10. **Reports** deployment impact — whether vulnerable packages are in your production graph (deploy recommended) or dev/test only (branch push sufficient).

## Requirements

- Node 20+
- npm or pnpm
- A GitHub Personal Access Token (classic or fine-grained) with **`security_events` read** permission, scoped to the repo.
  **In CI, this must be a real PAT stored as a secret** — the automatic `GITHUB_TOKEN` that GitHub
  Actions injects cannot read the Dependabot alerts API under any circumstance. See
  [CI integration](#ci-integration-github-actions) below.

## Install & invoke

There are three ways to run the agent. Pick the one that fits how you use it.

### 1. `npx` — no install

Good for a one-off run or CI. Downloads and runs the published binary on demand:

```bash
npx dependabot-agent --repo owner/repo --token ghp_xxx --dry-run
```

### 2. Project dev dependency — recommended for a repo you maintain

Install it into the project you want to reconcile:

```bash
npm install --save-dev dependabot-agent
# or
pnpm add -D dependabot-agent
```

> **A local install does _not_ put `dependabot-agent` on your shell `PATH`.** Typing `dependabot-agent …` in your terminal will fail with *"command not found"* / *"not recognized"*. A project-installed binary is only available through `npx dependabot-agent …`, or from an **npm/pnpm script** (where `node_modules/.bin` is on `PATH`). The script approach is the nicest — see [Config-driven workflow](#config-driven-workflow-recommended) below.

### 3. Global install

Puts `dependabot-agent` on your `PATH` so you can call it by name from any directory:

```bash
npm install -g dependabot-agent

dependabot-agent --repo owner/repo --token ghp_xxx --dry-run
```

## Usage

The agent takes **only flags** — there are no subcommands. `--dry-run` is a flag, not a command, so `dependabot-agent dry-run` is an error; use `dependabot-agent --dry-run`.

```bash
# Dry run — see planned changes without writing anything
dependabot-agent --repo owner/repo --token ghp_xxx --dry-run

# Real run (writes overrides; then run your package manager's install)
dependabot-agent --repo owner/repo --token ghp_xxx

# Force a package manager instead of auto-detecting
dependabot-agent --repo owner/repo --package-manager npm

# Point at a specific project root
dependabot-agent --repo owner/repo --workspace-root ./packages/app

# Allow crossing major versions in the pre-check update
dependabot-agent --repo owner/repo --update-strategy latest
```

The GitHub token may also come from the `GITHUB_TOKEN` env var (recommended for CI — never commit it).

## Config-driven workflow (recommended)

For day-to-day use you don't want to retype flags. Put your **token in a `.env` file**, your **other options in `dependabot-agent.config.json`**, and wrap the two runs (dry-run and apply) in **package.json scripts**. Then everyday use is just:

```bash
pnpm deps:dry-run   # preview
pnpm deps:fix       # apply
```

### Step 1 — token in `.env` (gitignored)

On startup the agent automatically loads a `.env` file from the workspace root (the directory you run in, or `--workspace-root`):

```bash
# .env  (add to .gitignore — never commit this)
GITHUB_TOKEN=ghp_xxx
```

Real shell/CI environment variables always take precedence over `.env`, so the file never clobbers a value you set explicitly. Any variable the agent understands (`GITHUB_TOKEN`, `GITHUB_REPO`, `PACKAGE_MANAGER`, …) can live here — but the **token belongs in `.env`, never in the committed config file** (a `token` key in the config is ignored with a warning).

### Step 2 — everything else in `dependabot-agent.config.json`

Commit this file at the workspace root. It's auto-discovered — no `--config` flag needed:

```jsonc
{
  "repo": "owner/repo",
  "packageManager": "pnpm",      // omit to auto-detect from the lockfile
  "workspaceRoot": ".",          // resolved relative to this file
  "updateStrategy": "compatible",
  "skipUpdate": false,
  "discoverPackages": true,      // auto-discover isolated sub-packages
  "packages": []                 // extra manifest dirs to always process
}
```

Leave `dryRun` out of the config (or set `false`) so the same config serves both the preview and the apply script — the dry-run script adds `--dry-run` on the command line.

### Step 3 — package.json scripts

```jsonc
{
  "scripts": {
    "deps:dry-run": "dependabot-agent --dry-run",
    "deps:fix": "dependabot-agent"
  }
}
```

Now both invocations pull `repo`, `packageManager`, etc. from the config file and the token from `.env`:

```bash
pnpm deps:dry-run     # or: npm run deps:dry-run
pnpm deps:fix         # then run `pnpm install` to regenerate the lockfile
```

There's no separate "fix" command in the tool — `deps:fix` is just the agent with no `--dry-run`, which writes the override changes. Any config value can still be overridden ad-hoc on the command line because **flags beat the config file**, e.g.:

```bash
pnpm deps:fix --update-strategy latest    # one-off: allow crossing majors
```

## Options

| Flag | Env fallback | Default | Description |
|---|---|---|---|
| `--token <t>` | `GITHUB_TOKEN` | — | GitHub PAT with `security_events` scope. **Required.** Never read from a config file. |
| `--repo <owner/repo>` | `GITHUB_REPO` | — | Target repository. **Required.** |
| `--package-manager <pnpm\|npm>` | `PACKAGE_MANAGER` | auto-detect | Override lockfile-based detection. |
| `--workspace-root <path>` | `WORKSPACE_ROOT` | cwd | Project root. |
| `--update-strategy <compatible\|latest>` | `UPDATE_STRATEGY` | `compatible` | See [Update strategy](#update-strategy). |
| `--dry-run` | `DRY_RUN=true` | `false` | Print planned changes without writing. |
| `--skip-update` | `SKIP_UPDATE=true` | `false` | Skip the pre-check dependency update. |
| `--config <path>` | — | auto-discover | Path to a JSON config file. |

Precedence: **flags > environment variables > config file > defaults.**

## Config file reference

The [Config-driven workflow](#config-driven-workflow-recommended) above shows the common setup. This section is the full reference.

**Discovery order** (first found wins):

1. the path passed to `--config <path>` (parsed as JSON),
2. `dependabot-agent.config.json` in the workspace root,
3. a `"dependabot-agent"` key in the workspace root `package.json`.

The config file must be **JSON** (a `.js`/`.ts` config is not supported). All keys are optional:

```jsonc
{
  "repo": "owner/repo",
  "packageManager": "pnpm",      // omit to auto-detect from the lockfile
  "workspaceRoot": ".",          // resolved relative to the config file
  "updateStrategy": "compatible",
  "dryRun": false,               // prefer leaving this out; pass --dry-run instead
  "skipUpdate": false,
  "discoverPackages": true,      // auto-discover isolated sub-packages (default true)
  "packages": []                 // extra manifest dirs to always process
}
```

> **The GitHub token is never read from a config file** — a `token` key here is ignored with a warning. Keep secrets in `.env` / `GITHUB_TOKEN` / CI secrets so they don't get committed.

## Monorepos & isolated packages

The agent always processes the workspace root, and additionally each **isolated sub-package** — a directory with both its own `package.json` **and** its own lockfile (`pnpm-lock.yaml` / `package-lock.json`), e.g. a Firebase `functions/` folder. These have a separate install and separate overrides, so each is reconciled as its own group (auto-detecting its package manager from its lockfile).

Plain **workspace members** (listed under `pnpm-workspace.yaml`'s `packages:` or a `package.json` `workspaces` field) share the root install and the root override file, so they are intentionally **not** processed separately.

- `discoverPackages` (default `true`) — set to `false` to process only the root.
- `packages` — explicitly list extra manifest directories (relative to the workspace root) to process, e.g. for an isolated package that doesn't have its own lockfile.

## Update strategy

The agent runs a dependency update before reconciling, so legitimately-fixed packages drop off naturally.

- **`compatible`** (default) — stay within existing semver ranges; does not cross majors automatically. pnpm: `pnpm update`; npm: `npm update --save`.
- **`latest`** — allow crossing majors. pnpm: `pnpm update --latest`; npm: `npm install <alerted-pkg>@latest` for the alerted direct dependencies.

Either way, the **overrides themselves are always bounded** at the first breaking version above the patch, so a fixed transitive dependency never travels further than the fix requires. Transitive-only vulnerabilities are handled by overrides regardless of strategy.

Bounded does **not** mean breaking-change-free. When the earliest patched version already sits outside the range the installed version's dependents accept, there is no in-range version that would close the alert, and the override necessarily crosses that boundary. The agent flags these rather than applying them quietly; see [No in-range fix](#no-in-range-fix) below.

Note the boundary follows npm's caret rules, so it is not always the major. `^1.2.3` is `>=1.2.3 <2.0.0`, but `^0.5.0` is `>=0.5.0 <0.6.0` and `^0.0.3` is `>=0.0.3 <0.0.4` — under `0.x`, the minor (or patch) is the breaking position. A `0.5.0 → 0.7.0` bump is every bit as breaking as `1.x → 2.x`, and is treated as such.

### No in-range fix

Sometimes the only non-vulnerable version of a transitive dependency is outside the range its dependents ask for. The agent still writes the override — leaving a known vulnerability in place is not a better default — but reports it separately from routine changes:

```
⚠️  NO IN-RANGE FIX — 1 override(s) escape the installed compatible range:
      cookie: installed 0.5.0 → forced to ">=0.7.0 <0.8"
```

**Treat these as needing review, because nothing else in the pipeline will tell you.** It's tempting to assume a bad override announces itself at install time. It doesn't:

- Overrides are applied at the **resolution layer**, so a dependent's declared range does not veto them. Not a caret range, not a `peerDependencies` range, not even an exact pin. `express@4.18.2` pins `cookie` to exactly `"0.5.0"`; overriding `cookie` to `>=0.7.0 <0.8` installs cleanly and resolves `cookie@0.7.2`. Likewise `react-dom@18.2.0` declares `peerDependencies: { react: "^18.2.0" }`, and overriding `react` to `>=19.0.0 <20` resolves `react@19.2.7` with no `ERESOLVE` and no warning. Both exit 0.
- Dependabot keys off the **resolved version**, so the alert closes.

So the install is green and the alert is closed while a dependent calls an API that changed shape underneath it. The break lands at runtime. Verify the dependents of a flagged package before shipping it, or bump those dependents to versions that request the patched range.

The `cookie` example above is the common shape of this, not a contrived one — `CVE-2024-47764` is a `0.x` transitive alert that a great many projects reach through `express`.

(Two failure modes that *do* announce themselves, for contrast: an override with no matching published version fails with `ETARGET`, and an override on a package you also depend on directly fails with `EOVERRIDE` — see [Direct dependencies vs. overrides](#direct-dependencies-vs-overrides-npms-spec-match-rule).)

### Direct dependencies vs. overrides (npm's spec-match rule)

npm forbids an `overrides` entry for a package you **also depend on directly** unless the override spec matches the direct dependency's declared range (or references it via the `"$name"` syntax); otherwise `npm install` fails with a *"conflicts with direct dependency"* error. The agent sidesteps this by fixing the two cases through different mechanisms:

- **Direct dependencies** are fixed by the update pass above, which rewrites the declared range in `dependencies`/`devDependencies` in place. Once the package resolves to a patched version in-range, its alert closes and **no override is written** for it.
- **Transitive dependencies** — whatever is still vulnerable after the update — are the only things that get overrides. Since they aren't direct deps, npm's spec-match rule doesn't apply.

The agent does not rewrite an override to match a direct dep, and it does not use the `"$name"` self-reference form.

**Edge case:** if a *direct* dependency is still vulnerable after the update — e.g. the only patched version is a major bump and you're on the default `compatible` strategy, so the update can't cross the major — the agent will write an override for a package that is also a direct dep, and `npm install` will then reject it with the conflict error. Fix it by re-running with `--update-strategy latest` (bumps the direct dep across the major and rewrites its declared range, so the alert closes without an override), or bump that dependency by hand.

## After running

If overrides were added or changed, run your package manager's install to regenerate the lockfile:

```bash
pnpm install   # or: npm install
```

## CI integration (GitHub Actions)

> **The built-in `GITHUB_TOKEN` cannot read Dependabot alerts.** GitHub Actions' automatic,
> ephemeral `GITHUB_TOKEN` cannot access the Dependabot alerts REST API **under any `permissions:`
> grant** — including `security-events: read`, which only covers *code scanning* alerts, not
> Dependabot alerts. Passing it to the agent fails with:
> ```
> ❌ Error: GitHub API error 403: {"message":"Resource not accessible by integration", ...}
> ```
> You need a real credential — a classic PAT with `security_events` scope (or a fine-grained PAT /
> GitHub App token with the "Dependabot alerts: read" permission) — stored as a **repository secret**
> and passed to the agent's own steps. Other steps (checkout, opening a PR) can keep using the
> default `GITHUB_TOKEN` — least-privilege still applies everywhere except the one operation that
> structurally requires a PAT.

### Minimal example (manual trigger, commits directly)

```yaml
# .github/workflows/dependabot-overrides.yml
name: Reconcile Dependabot Overrides

on:
  workflow_dispatch: # manual trigger only

jobs:
  reconcile:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      # pnpm projects only:
      - uses: pnpm/action-setup@v4
        with:
          version: latest

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - run: npm install # or: pnpm install

      - name: Run Dependabot Override Agent
        run: npx dependabot-agent --repo ${{ github.repository }}
        env:
          GITHUB_TOKEN: ${{ secrets.DEPENDABOT_AGENT_TOKEN }} # PAT secret — see note above

      - name: Commit changes (if any)
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git diff --quiet && echo "No changes" || (
            git add -A &&
            git commit -m "chore: reconcile dependency overrides with Dependabot alerts" &&
            git push
          )
```

### Recommended: scheduled, pinned dependency, opens a PR

For unattended/org use, install the agent as a pinned `devDependency` (via the
[config-driven workflow](#config-driven-workflow-recommended) above) instead of `npx`-ing an
arbitrary version on every run, and open a PR for review/CI instead of committing straight to the
branch:

```yaml
# .github/workflows/dependabot-agent.yml
name: Reconcile Dependabot Overrides

on:
  workflow_dispatch:
    inputs:
      dry_run:
        description: "Dry run (print planned changes, write nothing, no PR)"
        type: boolean
        default: true
  schedule:
    - cron: "0 6 * * 1" # weekly — GitHub has no native "new Dependabot alert" trigger

permissions:
  contents: write
  pull-requests: write

jobs:
  reconcile:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4 # pnpm projects only
        with:
          version: latest

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - run: pnpm install --frozen-lockfile # or: npm install

      - name: Determine mode
        id: mode
        run: echo "apply=${{ (github.event_name != 'workflow_dispatch') || (!inputs.dry_run) }}" >> "$GITHUB_OUTPUT"

      - name: Preview (dry run)
        if: steps.mode.outputs.apply != 'true'
        env:
          GITHUB_TOKEN: ${{ secrets.DEPENDABOT_AGENT_TOKEN }}
        run: pnpm deps:dry-run

      - name: Apply
        if: steps.mode.outputs.apply == 'true'
        env:
          GITHUB_TOKEN: ${{ secrets.DEPENDABOT_AGENT_TOKEN }}
        run: pnpm deps:fix

      - name: Sync lockfile(s) to new overrides
        if: steps.mode.outputs.apply == 'true'
        run: pnpm install --no-frozen-lockfile # repeat per isolated sub-package, e.g. functions/

      - name: Open pull request
        if: steps.mode.outputs.apply == 'true'
        uses: peter-evans/create-pull-request@v8 # v7 targets a deprecated Node runtime — use v8+
        with:
          token: ${{ secrets.GITHUB_TOKEN }} # default token is fine for opening the PR itself
          branch: dependabot-agent/reconcile-overrides
          commit-message: "chore: reconcile dependency overrides with Dependabot alerts"
          title: "chore: reconcile dependency overrides"
          body: "Automated override reconciliation. **Merge only after CI passes** — the agent does not build or test."
          labels: dependencies
```

### Gotchas

- **`workflow_dispatch` and `schedule` only activate once the workflow file exists on the repo's
  *default* branch.** Pushing it to a feature branch alone won't make it dispatchable or let the
  schedule fire — merge it to your default branch first (once merged, you can still dispatch it
  against any *other* branch by picking that branch in the "Run workflow" dropdown, or via
  `gh workflow run <name> --ref <branch>`).
- **PRs opened with the default `GITHUB_TOKEN` don't trigger other `pull_request`-triggered
  workflows** (GitHub's recursion guard). If your repo requires CI to pass before merge, that CI
  won't auto-run on the agent's PR unless the PR-creation step uses a PAT or GitHub App token
  instead — a human pushing an empty commit, or closing/reopening the PR, also kicks it.
- **If your repo uses GitHub's CodeQL "Default setup" code scanning**, expect its JS/TS analyzer to
  occasionally fail with `Only found JavaScript or TypeScript files that were empty or contained
  syntax errors` on the agent's PRs — every reconciliation PR touches only manifests/lockfiles, never
  real source, which is exactly the shape that trips this. In testing this was **non-deterministic**
  (the identical diff against the identical cached overlay database produced both a pass and a fail
  in back-to-back runs), so it's safe to just re-run the check. If your repo enforces branch
  protection on code scanning, either allowlist this, or switch Code Scanning to "Advanced setup"
  and add a `paths-ignore` for manifest/lockfile-only changes so the job doesn't run on these PRs at
  all.

## Design notes

### Package-manager abstraction

A `PackageManager` interface encapsulates every PM-specific operation (update command, installed-tree retrieval, dependent analysis, deployment-impact analysis) and normalizes their output into a shared internal tree, so the reconciliation logic is identical for npm and pnpm.

### Override safety

- Overrides for packages **not mentioned in any Dependabot alert** are never removed automatically.
- When multiple alerts reference the same package, the **highest** `first_patched_version` wins. Note an advisory can carry one vulnerable range per release line, each with its own patch — so a package vulnerable on two lines at once can be forced onto the newer one even where a lower patch clears both. A single flat override hands one version to every consumer, so some choice has to be made here; see [#2](https://github.com/michaelpipkin/dependabot-agent/issues/2) for why this one isn't yet settled.
- Override specs are bounded at the first breaking version above the patch, per npm's caret rules (`>=4.17.21 <5`, `>=0.7.0 <0.8`, `>=0.0.5 <0.0.6`) — compatible with both npm and pnpm. The bound can never exclude its own floor, so a bounded spec can't produce an `ETARGET` at install.
- Specs that escape the installed version's compatible range are reported as [no in-range fix](#no-in-range-fix) rather than applied silently.
- The agent trusts the **alert state** (open ⇒ keep the override), not the installed version, since the installed tree already reflects applied overrides.
- Overrides are only written for packages that remain vulnerable **after** the update pass — in practice transitive deps. Direct dependencies are fixed by bumping their declared range, so the agent doesn't collide with npm's rule that an override for a direct dep must match its spec. See [Direct dependencies vs. overrides](#direct-dependencies-vs-overrides-npms-spec-match-rule).

### Orphaned overrides

For an override with no matching open alert, the agent finds its installed dependents and asks the npm registry what range each declares for the overridden package. Registry data is used because your installed tree's *resolved* versions reflect whatever the overrides forced; reading the declared range off disk would mean knowing each package manager's `node_modules` layout, so the registry keeps this package-manager independent.

Two different questions get asked here, of two different versions of each dependent:

- **"Can this override be removed?"** reads the range each dependent's **latest published** version declares. It's forward-looking — after an update you resolve to those versions anyway — so the override is only removed if every latest upstream range now requests a safe version. Otherwise it's kept as still load-bearing.
- **"Is this override forcing a dependent past its range?"** reads the range the **installed** version declares, because that's a question about the tree you actually have. A hit is reported as [no in-range fix](#no-in-range-fix), naming the dependent and version.

The distinction matters. An override can look routine against latest and be forcing a major bump on the copy you have: if the newest release of a dependent asks for `^7.5.3` but the version installed asks for `^6.1.11`, an override at `>=7.5.16` is dragging your installed copy across a major, and only the installed range shows it. Where a dependent's installed manifest can't be resolved from the registry, the escape check falls back to its latest range and the report says so.

> **Note on YAML comments:** `js-yaml` doesn't round-trip comments, so hand-written comments in `pnpm-workspace.yaml` are lost on the first write.

## Changelog

See [CHANGELOG.md](CHANGELOG.md), or the [Releases page](https://github.com/michaelpipkin/dependabot-agent/releases) for the same notes per version. Each release is published to GitHub Releases, so if you track this package with Dependabot or Renovate, the notes appear in the update PR itself.

## Development

```bash
npm install
npm run build                                # compile to dist/
npm test                                     # typecheck + run the test suite
npm start -- --repo owner/repo --dry-run     # run the compiled build
npm run dev -- --repo owner/repo --dry-run   # build + run in one step
```

### Tests

Tests run on Node's built-in runner (`node --test`) — no test framework dependency. They compile via `tsconfig.test.json` to a gitignored `dist-test/`, so they're typechecked against `src` but never published in `dist/`. `prepublishOnly` runs them before every release.

Coverage is deliberately concentrated on the decision logic rather than spread for its own sake: `semver.ts` (range parsing, compatibility boundaries, spec bounding) and `computeOverrideChanges` (what gets added, updated, removed, left alone, and flagged). These are the pure functions that decide what lands in your manifest, and they're where a wrong answer is both most likely and least visible — a bad override installs cleanly and closes its alert. The I/O edges (`github.ts`, `registry.ts`, the package-manager shell-outs) are thin wrappers left to integration testing.

## License

[MIT](LICENSE) © Michael Pipkin
