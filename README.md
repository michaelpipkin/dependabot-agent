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
6. **Adds or updates** override entries for packages that remain vulnerable, writing a major-bounded spec (`>=patched <nextMajor`) so a fix never forces a breaking major bump.
7. **Removes** overrides whose vulnerability has been resolved.
8. **Leaves untouched** any overrides for packages that don't appear in any Dependabot alert (assumed intentional).
9. **Reports** deployment impact — whether vulnerable packages are in your production graph (deploy recommended) or dev/test only (branch push sufficient).

## Requirements

- Node 20+
- npm or pnpm
- A GitHub Personal Access Token (classic or fine-grained) with **`security_events` read** permission, scoped to the repo.

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

Either way, the **overrides themselves are always major-bounded**, so a fixed transitive dependency never silently jumps a major version. Transitive-only vulnerabilities are handled by overrides regardless of strategy.

## After running

If overrides were added or changed, run your package manager's install to regenerate the lockfile:

```bash
pnpm install   # or: npm install
```

## CI integration (GitHub Actions, manual trigger)

```yaml
# .github/workflows/dependabot-overrides.yml
name: Reconcile Dependabot Overrides

on:
  workflow_dispatch: # manual trigger only

jobs:
  reconcile:
    runs-on: ubuntu-latest
    permissions:
      security-events: read
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
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

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

## Design notes

### Package-manager abstraction

A `PackageManager` interface encapsulates every PM-specific operation (update command, installed-tree retrieval, dependent analysis, deployment-impact analysis) and normalizes their output into a shared internal tree, so the reconciliation logic is identical for npm and pnpm.

### Override safety

- Overrides for packages **not mentioned in any Dependabot alert** are never removed automatically.
- When multiple alerts reference the same package, the **highest** `first_patched_version` wins.
- Override specs are major-bounded (`>=X.Y.Z <nextMajor`) — compatible with both npm and pnpm.
- The agent trusts the **alert state** (open ⇒ keep the override), not the installed version, since the installed tree already reflects applied overrides.

### Orphaned overrides

For an override with no matching open alert, the agent queries the npm registry for the ranges that the latest upstream dependents declare. Only if every upstream range now requests a safe version is the override removed — otherwise it's kept as still load-bearing. Registry data is used because it is unaffected by your local overrides.

> **Note on YAML comments:** `js-yaml` doesn't round-trip comments, so hand-written comments in `pnpm-workspace.yaml` are lost on the first write.

## Development

```bash
npm install
npm run build                                # compile to dist/
npm start -- --repo owner/repo --dry-run     # run the compiled build
npm run dev -- --repo owner/repo --dry-run   # build + run in one step
```
