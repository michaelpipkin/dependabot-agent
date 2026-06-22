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

## Install

Run without installing:

```bash
npx dependabot-agent --repo owner/repo --token ghp_xxx --dry-run
```

Or install globally / as a dev dependency:

```bash
npm install -g dependabot-agent
# or
npm install --save-dev dependabot-agent
```

## Usage

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

## Config file

For shared/team setups, commit non-secret settings to a config file. The agent looks for (first found):

1. the path passed to `--config`,
2. `dependabot-agent.config.json` in the workspace root,
3. a `"dependabot-agent"` key in the workspace root `package.json`.

```jsonc
{
  "repo": "owner/repo",
  "packageManager": "pnpm",      // omit to auto-detect
  "workspaceRoot": ".",          // resolved relative to the config file
  "updateStrategy": "compatible",
  "dryRun": false,
  "skipUpdate": false
}
```

> **The GitHub token is never read from a config file** — a `token` key here is ignored with a warning. Keep secrets in `GITHUB_TOKEN` / CI secrets so they don't get committed.

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
