# Dependabot Override Agent

An on-demand CLI agent that reconciles `pnpm.overrides` in your `package.json` against open GitHub Dependabot alerts.

## What it does

1. **Detects** where overrides live — `pnpm-workspace.yaml` (pnpm v9+ workspace projects) if present, otherwise `package.json`.
2. **Fetches** all open npm Dependabot alerts for your repo via the GitHub API.
3. **Updates** all packages to their latest versions (`pnpm update --latest`).
4. **Walks** the full installed dependency tree (`pnpm list --json --depth=Infinity`) and checks whether any installed version (top-level or transitive) still falls in a vulnerable range.
5. **Adds or updates** `pnpm.overrides` entries for packages that remain vulnerable after the update.
6. **Removes** overrides for packages whose vulnerability has been resolved (either the package was updated past the vulnerable range, or it's no longer in the tree at all).
7. **Leaves untouched** any overrides for packages that don't appear in any Dependabot alert (assumed to be there for unrelated reasons).

## Requirements

- Node 18+
- pnpm
- GitHub Personal Access Token (or a fine-grained token) with:
  - `security_events` read permission (for Dependabot alerts)
  - Works with both classic PATs and fine-grained tokens scoped to specific repos

## Setup

Place this agent anywhere in your monorepo or as a standalone tool.

```bash
pnpm install
```

## Usage

```bash
# Basic usage
GITHUB_TOKEN=ghp_xxx GITHUB_REPO=your-org/your-repo npx ts-node dependabot-agent.ts

# Dry run (see planned changes without writing anything)
DRY_RUN=true GITHUB_TOKEN=ghp_xxx GITHUB_REPO=your-org/your-repo npx ts-node dependabot-agent.ts

# Skip the pnpm update step (just reconcile overrides against current install)
SKIP_UPDATE=true GITHUB_TOKEN=ghp_xxx GITHUB_REPO=your-org/your-repo npx ts-node dependabot-agent.ts

# Point at a specific workspace root (defaults to cwd)
WORKSPACE_ROOT=/path/to/my/app GITHUB_TOKEN=ghp_xxx GITHUB_REPO=owner/repo npx ts-node dependabot-agent.ts
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GITHUB_TOKEN` | ✅ | — | GitHub PAT with `security_events` scope |
| `GITHUB_REPO` | ✅ | — | `owner/repo` format |
| `DRY_RUN` | — | `false` | Print planned changes without writing `package.json` |
| `SKIP_UPDATE` | — | `false` | Skip `pnpm update --latest` |
| `WORKSPACE_ROOT` | — | `process.cwd()` | Path to root `package.json` |

## After running

If overrides were added or changed, run:

```bash
pnpm install
```

This regenerates the lockfile with the new override constraints applied.

## Integration options

### As a pnpm script in your project

Add to your root `package.json`:

```json
{
  "scripts": {
    "security:fix": "ts-node path/to/dependabot-agent.ts"
  }
}
```

### As a GitHub Actions workflow (manual trigger)

```yaml
# .github/workflows/dependabot-overrides.yml
name: Reconcile Dependabot Overrides

on:
  workflow_dispatch:  # manual trigger only

jobs:
  reconcile:
    runs-on: ubuntu-latest
    permissions:
      security-events: read
      contents: write
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: latest

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install

      - name: Run Dependabot Override Agent
        run: npx ts-node path/to/dependabot-agent.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPO: ${{ github.repository }}

      - name: Commit changes (if any)
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git diff --quiet && echo "No changes" || (
            git add package.json pnpm-lock.yaml &&
            git commit -m "chore: reconcile pnpm overrides with Dependabot alerts" &&
            git push
          )
```

## Design notes

### Override file detection

The agent checks for `pnpm-workspace.yaml` in `WORKSPACE_ROOT` at startup:

- **Found** → overrides are read from and written to `pnpm.overrides` in that file (pnpm v9+ workspace behaviour).
- **Not found** → falls back to `pnpm.overrides` in `package.json` (standalone project behaviour).

Both paths share the same `OverrideSource` interface, so the rest of the agent doesn't care which file it's dealing with.

> **Note on YAML comment preservation:** `js-yaml` doesn't round-trip comments, so if you have hand-written comments in `pnpm-workspace.yaml`, they'll be lost on the first write. If that's a concern, consider keeping comments in a separate section the agent won't touch (e.g. above the `pnpm:` key).

### Semver range parsing

The agent implements its own minimal semver comparator (no external deps) that handles the range formats Dependabot actually emits (`>= X, < Y`, `>= X`, `= X`). It does not attempt to handle full semver range syntax (^ ~ || etc.) since GitHub's API uses a simple subset.

### Override safety

- Overrides for packages **not mentioned in any Dependabot alert** are never removed — they're assumed to be intentional for unrelated reasons.
- When multiple alerts reference the same package with different `first_patched_version` values, the agent uses the **highest** patched version to be conservative.
- The agent writes `>=X.Y.Z` as the override value, which lets pnpm resolve the latest compatible version rather than pinning to an exact patch.

### Monorepo support

`pnpm list --json --depth=Infinity` run from the workspace root will traverse all workspace packages. The agent already iterates over the array of workspace entries that pnpm outputs in a monorepo context.
