# Dependabot Override Agent

An on-demand CLI agent that reconciles dependency **overrides** against open GitHub Dependabot alerts. Works with both **npm** and **pnpm**, in single-package projects and monorepos.

## What it does

1. **Detects** your package manager from the lockfile (`pnpm-lock.yaml` → pnpm, `package-lock.json` → npm), or you can set it explicitly.
2. **Detects** where overrides live:
   - **npm** → top-level `overrides` in `package.json`.
   - **pnpm** → `pnpm-workspace.yaml` (workspace projects) if present, otherwise `pnpm.overrides` in `package.json`.
3. **Fetches** your repo's npm Dependabot alerts (all states) via the GitHub API; open alerts drive the override decisions, while every package that was *ever* alerted is remembered so a resolved override can be aged out without touching a never-alerted hand-pin.
4. **Updates** dependencies (range-bound by default — see [Update strategy](#update-strategy)), across the root manifest and every workspace member, so a fixable direct dependency is repaired by raising its range rather than by an override.
5. **Walks** the full installed dependency tree and confirms each alerted package is actually present.
6. **Adds or updates** override entries for packages that remain vulnerable, writing a spec bounded at the first breaking version above the patch (`>=0.7.0 <0.8`, `>=4.17.21 <5`) so a fix never drags the tree further than it has to. When one advisory spans **disjoint release lines** — a package vulnerable on, say, both 3.x and 4.x at once — it writes one bounded override *per line* (`js-yaml@3`, `js-yaml@4`) so each consumer stays on its own major instead of being forced up. See [Multi-line advisory](#multi-line-advisory).
7. **Flags** the cases where no in-range fix exists — the earliest patched version sits outside what's installed can accept — separately from routine changes. See [No in-range fix](#no-in-range-fix).
8. **Removes** overrides whose vulnerability has been resolved.
9. **Leaves untouched** any overrides for packages that don't appear in any Dependabot alert (assumed intentional).
10. **Reports** deployment impact — whether vulnerable packages are in your production graph (deploy recommended) or dev/test only (branch push sufficient).

## Requirements

- Node 22+
- npm or pnpm
- A GitHub Personal Access Token that can read the repo's Dependabot alerts. **The required permission differs by token type:**
  - **Classic** — the `security_events` scope (or the broader `repo` scope).
  - **Fine-grained** — the **Dependabot alerts** repository permission, set to **Read**, on the target repo(s).

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
  "allowPrerelease": false,      // let the update pass settle on an rc/beta/alpha
  "skipUpdate": false,
  "exitCode": false,             // exit 2 when override changes are found (CI drift gate)
  "discoverPackages": true,      // auto-discover isolated sub-packages
  "packages": [],                // extra manifest dirs to always process
  "updateWorkspaceMembers": true, // let the update pass bump workspace members too
  "limits": {}
}
```

`repo` is the only value you must supply somewhere — flag, env var, or here. Every other key is optional and can be deleted; see [Config file reference](#config-file-reference) for each one's default and meaning.

`dryRun` is the one key deliberately left out. Omit it (or set `false`) so the same config serves both the preview and the apply script — the dry-run script adds `--dry-run` on the command line.

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
| `--token <t>` | `GITHUB_TOKEN` | — | GitHub PAT that can read Dependabot alerts (classic: `security_events` scope; fine-grained: **Dependabot alerts** read — see [Requirements](#requirements)). **Required.** Never read from a config file. |
| `--repo <owner/repo>` | `GITHUB_REPO` | — | Target repository. **Required.** |
| `--package-manager <pnpm\|npm>` | `PACKAGE_MANAGER` | auto-detect | Override lockfile-based detection. |
| `--workspace-root <path>` | `WORKSPACE_ROOT` | cwd | Project root. |
| `--update-strategy <compatible\|latest\|targeted>` | `UPDATE_STRATEGY` | `compatible` | See [Update strategy](#update-strategy). `targeted` fixes alerts with the smallest change instead of updating everything (npm only). |
| `--allow-prerelease` | `ALLOW_PRERELEASE=true` | `false` | Let the update pass settle on a pre-release version. See [Pre-releases](#pre-releases). |
| `--dry-run` | `DRY_RUN=true` | `false` | Print planned changes without writing. |
| `--skip-update` | `SKIP_UPDATE=true` | `false` | Skip the pre-check dependency update. |
| `--exit-code` | `EXIT_CODE=true` | `false` | Exit `2` if any override changes are found. Pair with `--dry-run` to fail CI on override drift — see [CI integration](#ci-integration-github-actions). |
| `--report <dir>` | `REPORT_DIR` | — | Write a report of the run to this directory. Targeted strategy only: under `compatible` or `latest` it prints a warning and writes nothing. |
| `--config <path>` | — | auto-discover | Path to a JSON config file. |

Precedence: **flags > environment variables > config file > defaults.**

### Exit codes

`0` — ran successfully (whether or not it wrote anything). `1` — the agent failed (bad token, unreadable manifest, an unexpected error). With `--exit-code`, `2` — the run found override changes (in `--dry-run`, that means your overrides have drifted out of date). `2` is deliberately distinct from `1` so CI can tell "drift detected" apart from "the tool broke."

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
  "allowPrerelease": false,      // let the update pass settle on an rc/beta/alpha
  "dryRun": false,               // prefer leaving this out; pass --dry-run instead
  "skipUpdate": false,
  "exitCode": false,             // exit 2 when override changes are found (CI drift gate)
  "discoverPackages": true,      // auto-discover isolated sub-packages (default true)
  "packages": [],                // extra manifest dirs to always process
  "updateWorkspaceMembers": true, // bump workspace members' manifests too (default true)
  "limits": {}                   // targeted mode only: package glob -> semver range, e.g. {"@angular/*": "<22"}
}
```

`discoverPackages`, `packages`, `updateWorkspaceMembers`, and `limits` are config-file only — they have no flag or environment variable. See [Monorepos & isolated packages](#monorepos--isolated-packages) for what the first three govern: they are three different kinds of subdirectory and are easy to mix up. `limits` belongs to [targeted mode](#limits).

> **The GitHub token is never read from a config file** — a `token` key here is ignored with a warning. Keep secrets in `.env` / `GITHUB_TOKEN` / CI secrets so they don't get committed.

## Monorepos & isolated packages

The agent always processes the workspace root, and additionally each **isolated sub-package** — a directory with both its own `package.json` **and** its own lockfile (`pnpm-lock.yaml` / `package-lock.json`), e.g. a Firebase `functions/` folder. These have a separate install and separate overrides, so each is reconciled as its own group (auto-detecting its package manager from its lockfile).

Plain **workspace members** (listed under `pnpm-workspace.yaml`'s `packages:` or a `package.json` `workspaces` field) share the root install and the root override file, so they are intentionally **not** reconciled as separate groups. Their manifests *are* updated, though — see [Workspace members and the update pass](#workspace-members-and-the-update-pass).

- `discoverPackages` (default `true`) — set to `false` to process only the root.
- `packages` — explicitly list extra manifest directories (relative to the workspace root) to process, e.g. for an isolated package that doesn't have its own lockfile.
- `updateWorkspaceMembers` (default `true`) — set to `false` to leave workspace members' manifests untouched by the update pass.

### Workspace members and the update pass

The update pass rewrites **every** manifest in the workspace: the root and each member. This matters more than it sounds, because it decides which of the two repairs a vulnerability gets.

A fixable direct dependency should be fixed by **raising its declared range** — the change lands in the manifest that asked for it, and the alert closes. An **override** is the fallback for transitive copies you don't declare and can't otherwise reach. If members were skipped by the update pass, every fixable alert inside them would fall through to the override path instead: overrides would accumulate for packages that never needed one, and each would silently force a member past the range its own `package.json` states.

So this is on by default. Set `updateWorkspaceMembers` to `false` only if you want members' versions moved by hand:

```jsonc
// dependabot-agent.config.json — just this key; the rest of your config is unaffected
{ "updateWorkspaceMembers": false }
```

**It is not the same switch as `discoverPackages`.** Turning this off does not make the agent ignore your members — their dependency trees are still read, their vulnerabilities are still found, and overrides are still written for them. It only stops the agent from bumping the versions they declare, which means more of their alerts get resolved with an override rather than a version bump.

Every guarantee the update pass makes at the root holds in a member too: [exact pins](#exact-pins-are-never-rewritten) are never rewritten wherever they are declared, and [pre-releases](#pre-releases) are rolled back per manifest. On pnpm this extends to [catalogs](#pnpm-catalogs).

## Update strategy

The agent runs a dependency update before reconciling, so legitimately-fixed packages drop off naturally.

- **`compatible`** (default) — stay within existing semver ranges; does not cross majors automatically. pnpm: `pnpm update`; npm: `npm update --save`.
- **`latest`** — allow crossing majors. pnpm: `pnpm update --latest`; npm: `npm install <alerted-pkg>@latest` for the alerted direct dependencies.
- **`targeted`** (npm only) — no bulk update at all. Each alert gets the smallest change that resolves it, or is reported as blocked. See [Targeted mode (npm)](#targeted-mode-npm).

A config file's `updateStrategy` that isn't one of these stops the run at startup, whatever a flag or environment variable says.

Under `compatible` and `latest`, the update pass leaves two things alone: [exact pins](#exact-pins-are-never-rewritten) and, unless you opt in, [pre-releases](#pre-releases).

Under both, the **overrides themselves are always bounded** at the first breaking version above the patch, so a fixed transitive dependency never travels further than the fix requires. Transitive-only vulnerabilities are handled by overrides regardless of strategy; `targeted` writes an exact version, which goes no further than the fix at all.

Bounded does **not** mean breaking-change-free. When the earliest patched version already sits outside the range the installed version's dependents accept, there is no in-range version that would close the alert, and the override necessarily crosses that boundary. The agent flags these rather than applying them quietly; see [No in-range fix](#no-in-range-fix) below.

Note the boundary follows npm's caret rules, so it is not always the major. `^1.2.3` is `>=1.2.3 <2.0.0`, but `^0.5.0` is `>=0.5.0 <0.6.0` and `^0.0.3` is `>=0.0.3 <0.0.4` — under `0.x`, the minor (or patch) is the breaking position. A `0.5.0 → 0.7.0` bump is every bit as breaking as `1.x → 2.x`, and is treated as such.

### Exact pins are never rewritten

A direct dependency declared at an exact version — `"firebase-functions": "7.3.0"`, or the equivalent `"=7.3.0"` / `"v7.3.0"` — is left exactly as it is. The update pass reads every manifest first, and every pinned name is excluded from the command it runs (`pnpm update --latest "!firebase-functions"`; on npm, dropped from the `@latest` target list).

In a workspace this covers **every** manifest the pass will touch, not just the root: a pin in `packages/app/package.json` is protected exactly as a pin at the root is, and on pnpm so is a pinned [catalog entry](#pnpm-catalogs).

A pin is a decision, and the manifest doesn't record why it was made — a broken release, an unmigrated API, a native build that only links against one version. None of that is visible to a dependency tool, so the only safe reading of an exact version is that someone meant it.

`~1.2.3` is **not** a pin. It's a range, and narrowing a range is a different intent from freezing one — under `latest`, a tilde is meant to move. To hold a *range* back, see [Excluding a package from the update](#excluding-a-package-from-the-update) below.

The run reports what it held:

```
   📌 Holding 2 exact pin(s) — the update pass will not rewrite them: @types/semver, firebase-functions
```

**A held pin can keep an alert open**, and this is the one case worth watching. If a pinned package is itself alerted, the update pass can't fix it and an override won't either — overrides address *transitive* copies, and a direct dependency isn't one. That combination gets called out on its own:

```
   ⚠️  Pinned AND alerted — the update pass cannot fix these; raise the pin by hand:
         firebase-functions pinned at 7.3.0 in functions/package.json (dependencies)
```

### Pre-releases

By default the update pass will not leave a project on a release candidate, beta, or alpha. Pass `--allow-prerelease` (or `"allowPrerelease": true`) if you want the old behavior.

The reason this needs a guard at all is that `update --latest` doesn't resolve to "the newest release" — it resolves through the **`latest` dist-tag**, which is just whatever the last `npm publish` set. A maintainer who ships an rc without `--tag next` moves `latest` onto the pre-release, and every consumer's update follows it. That is exactly how `firebase-functions@7.3.2-rc.0` reached the `latest` tag while `7.3.2-rc.1` sat under `next`:

```
$ npm view firebase-functions dist-tags
{ "next": "7.3.2-rc.1", "latest": "7.3.2-rc.0" }
```

When the agent sees a specifier that has become a pre-release, it looks up the highest **stable** version published and rewrites the specifier to that:

```
   ⏮️  firebase-functions: the update pass chose the pre-release "7.3.2-rc.0" — using the highest stable release "^7.3.0" instead.
```

The operator comes from **what you declared**, not from what the update wrote. Package managers normally carry the operator across an update (`^0.1.0` → `^1.0.0`), but not when the target is a pre-release — pnpm drops the caret and pins exactly, because a caret over a pre-release has semantics nobody wants. That's why the `from` above is a bare `7.3.2-rc.0` while the replacement is `^7.3.0`: reading the operator back off the update's output would silently convert your range into a pin, and [the pin guard](#exact-pins-are-never-rewritten) would then hold it there for good — one bad dist-tag would stop the package updating permanently.

Two limits worth knowing. A project **already** tracking a pre-release line is left alone — if the specifier was a pre-release before the update, staying on one is deliberate. And this never downgrades: if nothing stable has been published at or above what you already declared, the pre-update specifier is restored instead.

Rolling a specifier back leaves the lockfile holding the version that was just rejected, so the agent re-runs `install` to re-resolve before it reads the tree. This is also why exact pins trigger a re-resolve on pnpm: `pnpm update --latest` applies its exclusion patterns to the *manifest rewrite* but not to *resolution* when it has no lockfile to start from, which would otherwise leave `specifier: 1.0.0, version: 3.0.1` recorded — the pin honored on paper and violated in the tree.

### Excluding a package from the update

Sometimes one dependency has to stay put while everything else moves — a major that breaks a framework you're on, a package that went ESM-only before your project did. If an exact pin is acceptable, [the section above](#exact-pins-are-never-rewritten) already covers you and needs no configuration. What follows is for holding back a package you want to keep on a *range*.

This is mostly a `latest` concern; under `compatible` the update already stays inside your declared ranges.

**pnpm** has a setting made for exactly this: `updateConfig.ignoreDependencies` in `pnpm-workspace.yaml`. Listed packages are skipped by `pnpm update --latest` (and hidden from `pnpm outdated`) while everything else updates normally:

```yaml
updateConfig:
  ignoreDependencies:
    - typescript
    - '@babel/*' # patterns work too
```

The agent reads this list and re-supplies it to pnpm as exclusion patterns whenever it also has [an exact pin to protect](#exact-pins-are-never-rewritten). That is not redundant: given any package pattern on the command line, pnpm stops applying `ignoreDependencies` altogether, so the pin guard would otherwise silently un-ignore everything you had held back. The run prints `🔁 Carrying pnpm's updateConfig.ignoreDependencies through as patterns` when this happens. It searches upward for the nearest `pnpm-workspace.yaml`, the same way pnpm does, so a sub-package with no config of its own inherits the root's list — and one with its own config uses that alone, which is also pnpm's rule rather than a merge.

Two more things worth knowing. It lives in **`pnpm-workspace.yaml`**, not the `pnpm` field in `package.json` — a lot of older examples still show the latter, and current pnpm reads it from the workspace file. And it is not `overrides`: `overrides` force-pins a version tree-wide (for transitive deps you don't control), whereas `ignoreDependencies` just tells the update command to leave a **direct** dependency's declared range alone. For holding a direct dep back, `ignoreDependencies` is the right tool and no override is needed.

A pinned **catalog** entry works as a hold-back too — see [pnpm catalogs](#pnpm-catalogs) below.

**npm** has no equivalent. `npm update` offers no per-package exclusion, and `.ncurc.json`'s `reject` list belongs to [npm-check-updates](https://www.npmjs.com/package/npm-check-updates), which this agent does not invoke. On npm, hold a package back by tightening its declared range in `package.json` — an exact pin (`"typescript": "6.0.3"`) or a tilde (`"~6.0.3"`) — which `npm update --save` respects. The agent's `latest` path on npm is already narrow: it runs `npm install <pkg>@latest` only for **alerted** direct dependencies, so a package with no open Dependabot alert is never carried across a major regardless. A pinned package that *does* have an alert is dropped from that target list too, and reported as [pinned AND alerted](#exact-pins-are-never-rewritten).

Either way, an exclusion only governs the **update** pass. If the package is still vulnerable afterward, the reconciler will report it — and, for a transitive copy, still write a bounded override. Excluding a package does not suppress its alert.

### pnpm catalogs

A [catalog](https://pnpm.io/catalogs) lets every manifest in a workspace name one version once, in `pnpm-workspace.yaml`, and reference it from each member:

```yaml
catalog:
  '@angular/core': ^20.1.0
catalogs:
  legacy:
    rxjs: ^6.6.7
```

```jsonc
// packages/app/package.json
{ "dependencies": { "@angular/core": "catalog:", "rxjs": "catalog:legacy" } }
```

The agent understands both forms (`catalog:` / `catalog:default` for the default catalog, `catalog:<name>` for a named one) and resolves a reference to the range the catalog declares before reasoning about it. That matters in two places:

- **Deciding whether an override can be removed.** The [orphan check](#orphaned-overrides) reads what each workspace member requires. A `catalog:` reference is not a semver range, so without resolution it reads as "might still be vulnerable" forever — the override could never age out, and the run would report `app requires catalog:` as its justification, which tells you nothing. Resolved, the member states a real range and the override ages out when the catalog entry becomes safe.
- **Protecting a pinned version.** `pnpm update -r` rewrites catalog entries, so a catalog is a place a version can be frozen. An exact-pinned entry (`rimraf: 3.0.2`) is excluded from the update command exactly as a pinned manifest entry is, and is reported alongside the others:

  ```
     📌 Holding 1 exact pin(s) — the update pass will not rewrite them: rimraf
  ```

A reference that no catalog entry backs is treated as still-vulnerable and the override is kept, with the reason stated plainly rather than left implicit:

```
   ⚠️  app declares rimraf as "catalog:", but no catalog entry backs it — treating it as still-vulnerable and keeping the override.
```

Catalogs solve version *drift*, not vulnerabilities, so the agent reads them but never writes to them: a Dependabot alert is still answered by bumping a declared range or by writing an [override](#override-safety), both of which apply to catalog-managed packages as they do to any other. npm has no catalogs, so none of this applies there.

### No in-range fix

Sometimes the only non-vulnerable version of a transitive dependency is outside the range its dependents ask for. The agent still writes the override — leaving a known vulnerability in place is not a better default — but reports it separately from routine changes:

```
⚠️  NO IN-RANGE FIX — 1 override(s) escape the compatible range of their dependents:
   From open alerts (being written now):
      cookie: installed 0.5.0 → forced to ">=0.7.0 <0.8"
```

**Treat these as needing review, because nothing else in the pipeline will tell you.** It's tempting to assume a bad override announces itself at install time. It doesn't:

- Overrides are applied at the **resolution layer**, so a dependent's declared range does not veto them. Not a caret range, not a `peerDependencies` range, not even an exact pin. `express@4.18.2` pins `cookie` to exactly `"0.5.0"`; overriding `cookie` to `>=0.7.0 <0.8` installs cleanly and resolves `cookie@0.7.2`. Likewise `react-dom@18.2.0` declares `peerDependencies: { react: "^18.2.0" }`, and overriding `react` to `>=19.0.0 <20` resolves `react@19.2.7` with no `ERESOLVE` and no warning. Both exit 0.
- Dependabot keys off the **resolved version**, so the alert closes.

So the install is green and the alert is closed while a dependent calls an API that changed shape underneath it. The break lands at runtime. Verify the dependents of a flagged package before shipping it, or bump those dependents to versions that request the patched range.

The `cookie` example above is the common shape of this, not a contrived one — `CVE-2024-47764` is a `0.x` transitive alert that a great many projects reach through `express`.

(Two failure modes that *do* announce themselves, for contrast: an override with no matching published version fails with `ETARGET`, and an override on a package you also depend on directly fails with `EOVERRIDE` — see [Direct dependencies vs. overrides](#direct-dependencies-vs-overrides-npms-spec-match-rule).)

### Multi-line advisory

An advisory carries one vulnerable range **per release line**, each with its own patch, so a package vulnerable on two lines at once has no single patched version. `GHSA-mh29-5h37-fv8m` patches `js-yaml`'s `< 3.14.2` at `3.14.2` and its `>= 4.0.0, < 4.1.1` at `4.1.1` — and `3.14.2` clears both. A single flat override would drag the 3.x consumer across a major no advisory demands.

**The agent writes one bounded override per line** using a version-selector key, so each installed copy stays on its own release line:

```
ℹ️  MULTI-LINE ADVISORY — 1 package(s) vulnerable on disjoint release lines:
      js-yaml: 2 lines — "< 3.14.2" → 3.14.2
                        ">= 4.0.0, < 4.1.1" → 4.1.1
         Split into per-line overrides — each consumer stays on its own line:
            js-yaml@3 → >=3.14.2 <4
            js-yaml@4 → >=4.1.1 <5
```

Both pnpm and npm honor the `name@major` selector — including for transitive copies — so the same specs work in either `pnpm-workspace.yaml` or a package.json `overrides` block. The selector patches a line by the version installed, not by which parent pulled it, so no parent attribution is needed. Two advisories on one line collapse to a single selector at the higher patch. Proven end-to-end on pnpm against a live repository (each consumer resolved to its own patched line, GitHub closed the alerts), and the selector mechanism verified on npm for both direct and registry-transitive copies.

**The flat max is a fallback** — with the warning form of the report ("Forcing 4.1.1 … See issue #2") — for **0.x packages**, where `pkg@0` is too broad (a 0.x release line is a minor, not a major). Those write the highest patch; see [Override safety](#override-safety) for why the highest is the safe flat choice. The agent also falls back to flat when an installed copy sits on a major that **no** per-line selector would cover (below the lowest line, or wedged between two non-adjacent lines) — a `name@major` key can't reach it, so scoping would leave it vulnerable, whereas the flat override covers every copy and reports the escape. One npm caveat: the selector matches published copies, not a dependency linked via `file:` (npm resolves linked packages' own dependencies independently of the root's overrides).

The condition is rarer than it sounds — most packages accumulate several advisories on a *single* line, where the highest patch is also the lowest that clears them all and nothing special happens.

### Direct dependencies vs. overrides (npm's spec-match rule)

npm forbids an `overrides` entry for a package you **also depend on directly** unless the override spec matches the direct dependency's declared range (or references it via the `"$name"` syntax); otherwise `npm install` fails with a *"conflicts with direct dependency"* error. The agent sidesteps this by fixing the two cases through different mechanisms:

- **Direct dependencies** are fixed by the update pass above, which rewrites the declared range in `dependencies`/`devDependencies` in place — in the root manifest and in [every workspace member](#workspace-members-and-the-update-pass). Once the package resolves to a patched version in-range, its alert closes and **no override is written** for it.
- **Transitive dependencies** — whatever is still vulnerable after the update — are the only things that get overrides. Since they aren't direct deps, npm's spec-match rule doesn't apply.

The agent does not rewrite an override to match a direct dep, and it does not use the `"$name"` self-reference form.

**Edge case:** if a *direct* dependency is still vulnerable after the update — e.g. the only patched version is a major bump and you're on the default `compatible` strategy, so the update can't cross the major — the agent will write an override for a package that is also a direct dep, and `npm install` will then reject it with the conflict error. Fix it by re-running with `--update-strategy latest` (bumps the direct dep across the major and rewrites its declared range, so the alert closes without an override), or bump that dependency by hand. If the package is an [exact pin](#exact-pins-are-never-rewritten), `latest` will not move it either — the run says so explicitly ("Pinned AND alerted"), and raising the pin by hand is the only fix.

## Targeted mode (npm)

Targeted mode is for teams that don't run a general `npm update`: packages move only when they have been vetted, or when a Dependabot alert makes it unavoidable. It answers each open alert with the smallest change that resolves it, or says why it can't. Nothing else in the lockfile moves.

```bash
dependabot-agent --update-strategy targeted --dry-run
```

> **Status: new.** Targeted mode is recent.
>
> - Use **npm 11.3 or newer**. See [Supported npm versions](#supported-npm-versions).
> - On a live repository, Dependabot closed every alert this mode fixed, including those fixed through the [temporary root step](#workspaces), and left open the ones it reported as blocked. Closing took from seconds after a direct push to about ten minutes after a merged pull request, so a run in that gap reports them as awaiting close.
>
> **Run it with `--dry-run` on a real repository first**, read the plan, and review the first pull request closely. CI on that pull request is what proves the result builds and passes your tests. The agent doesn't build or test anything.

It supports npm only. Run against a pnpm project, it stops at startup with an error, before anything is written. `compatible`, `latest` and everything on pnpm behave as before.

### What it changes, and what it doesn't

The unit of decision is each **copy** of a package in `package-lock.json`, not each alert. One alert can cover several copies at different versions, and they can have different outcomes.

**What can move**

- A copy inside an alert's vulnerable range, to the **earliest version that fixes it**: the alert's patched version. Where several alerts hit one release line, the highest patch on that line.
- A **direct dependency** is fixed by raising its declared range in the manifest that declares it, keeping the existing `^` or `~`.
- A **transitive dependency** is fixed with an `overrides` entry in the root `package.json`, keyed to the vulnerable versions and set to exactly the target:

  ```json
  "overrides": {
    "qs@>=6.0.0 <6.7.3": "6.7.3"
  }
  ```

  The key has a lower bound as well as an upper one, so it can't catch a copy on another major line.
- A package a fixed package newly requires, or that has to move with it, and a fixed copy npm relocates to another path. These are listed under "Other changes" in the report.

**What doesn't move**

- A copy outside the vulnerable range, even of an alerted package.
- An exact pin (`"3.0.2"`). A pin means "don't touch", and an alerted pin is reported as blocked.
- A fix that would cross a major version (under `0.x`, a minor). That includes direct dependencies, even with no limit set: a major bump is what needs vetting, so a person chooses to make it.
- Anything beyond a limit you have set (below).
- A parent package. Raising a parent to clear a transitive alert is out of scope.
- A copy bundled inside another package's tarball, which only that package's upgrade can change.
- An override a person wrote.

A fix can still land **past a range a dependent declares**, within the same major: for example `4.0.3` to `4.0.4` where a parent pins `4.0.3`. The change is applied, and the report lists it under "Applied past a declared range — review these" so a person looks at it.

**Partial fixes.** A copy that can be fixed is fixed even if another copy of the same package is blocked. The alert is reported as partly fixed and stays open on GitHub until every copy is resolved.

### Why a copy is blocked

A blocked copy is left exactly as it is, and the report names the copy and the reason. Nothing is skipped silently.

| Reason | What it means |
|---|---|
| `no-fix` | The advisory has no patched version yet. |
| `target-unavailable` | The patched version isn't published on npm, is a pre-release, is still inside the vulnerable range or isn't above the installed version, or the registry has no such package (a 404). Any other registry failure fails the whole run rather than blocking its alerts: an outage says nothing about the package, and a blocked-only result would close an open pull request. |
| `unreadable-range` | The installed version or the advisory's range couldn't be compared. |
| `limit` | The patched version is outside a limit in your config. |
| `pin` | The copy is a direct dependency declared at an exact version. |
| `unrewritable-spec` | The copy is a direct dependency whose spec can't be safely rewritten: a compound range, a tag, or a git spec. Also, a `file:` dependency that isn't a workspace member, a package declared in two dependency fields of one manifest, or a workspace member's declaration while `updateWorkspaceMembers` is `false`. |
| `major-crossing` | The patched version is in a later major (or, under `0.x`, a later minor) than the copy. |
| `hand-written-override` | A person wrote an override that names this package. It is never changed or removed. |
| `bundled` | The copy ships inside another package's tarball (`inBundle` in the lockfile). Neither a bump nor an override reaches it: fixing it needs an upgrade of the package that bundles it. A hoisted copy of the same package is still fixed. |
| `manifest-not-processed` | No lockfile this run reads answers for the alert's manifest: it has a lockfile of its own and `discoverPackages` is off, it has no `package-lock.json` and no parent lockfile holds it as a package, it's a `yarn.lock` or `npm-shrinkwrap.json`, its directory no longer exists, or the path can't be read. The report names the manifest. |
| `selector-conflict` | The override the fix needs can't be written without moving something it shouldn't, or can't reach the copy. For example: it would also catch a copy that must stay put; the root declares a range the override would collide with (npm rejects that with `EOVERRIDE`); the copy is an alias; a dependent declares a range the override wouldn't match; an existing agent-written override still holds a different dependent's fix; or the copy sits inside a workspace member's own `node_modules`, where npm's override can't reach it. |

### Limits

`limits` caps how far named packages may move. Each key is a package name or a `*` glob, and each value is a semver range. It is read from the config file only.

```jsonc
// dependabot-agent.config.json
{
  "updateStrategy": "targeted",
  "limits": {
    "@angular/*": "<22"
  }
}
```

A fix whose target is outside a matching limit is blocked with the reason `limit`, so a fix that needs Angular 22 stays a hard no. If several alerts hit one release line and the highest patch would break a limit, the highest patch that doesn't is used, the alert that needs the higher one is blocked, and the lower one is still fixed. Limits are also checked after the run on every version that changed, including packages that moved as a side effect, so a limit can't be crossed indirectly. A malformed limit stops the run at startup, naming the key: `limits` that isn't an object, an empty package name or glob, or a blank or invalid range. `limits` under another strategy prints a warning and has no effect.

### Overrides already in `package.json`

- **Hand-written** overrides (a plain name, `name@2`, or one nested under a parent) are never changed or removed. If one applies to an alerted package, that copy is blocked and the report names the override.
- **Written by the agent** on an earlier `compatible` or `latest` run (a value beginning `>=`): if the package has an open alert, the old key is replaced with the new shape, but only when it matches what a moving copy's dependents declare, because npm applies only the first key that matches. A key that still holds another dependent's fix, one the new key wouldn't cover, blocks the copy rather than being replaced. With no open alert, such an override is left alone, so adopting this mode moves nothing.
- An override is **removed** only when its alert is fixed, every dependent now asks for a safe version, and removing it moves no locked version. Otherwise it is kept, and the report says so.

### Workspaces

Targeted mode reads the root, the workspace members and any `file:` packages from `package-lock.json`, not from the workspace globs, so any glob form works. Isolated sub-packages with their own lockfile (a `functions/` folder, say) are processed too, and share one report, one pull request and one all-or-nothing result.

Things to know:

- **Each alert is answered by its own lockfile.** An alert's manifest decides which lockfile answers for it: the nearest one at or above the manifest, and a lockfile above the manifest only answers if it holds that directory as a workspace member or `file:` package. Anything else is blocked, naming the manifest, so it stays visible: a folder with a `package.json` but no lockfile, a `yarn.lock`, an `npm-shrinkwrap.json`. Discovery doesn't look in dot-directories or in `dist`, `build`, `out`, `coverage` and the like, so an open alert on a lockfile there (`.github/actions/x/package-lock.json`, say) brings that directory in as its own group, with the same pnpm check. With `discoverPackages` off it is blocked, naming the manifest, unless `packages` lists the directory. An alert whose directory no longer exists is blocked the same way. Neither is ever answered from the root's lockfile.
- **An isolated directory the run can't read.** One with no open alerts and a `lockfileVersion` 1 lockfile is skipped with a warning. With an alert on it, the run stops: that alert can't go unanswered.

- **Overrides on a member-only tree.** npm applies an override only when the package is reachable from the root `package.json`. For a package reachable only through workspace members, targeted mode adds the members' relevant dependencies to the root `devDependencies` temporarily, resolves, then restores `package.json` exactly and resolves again. This relies on npm behaviour that npm doesn't document, which is why the result is verified rather than assumed.
- **A copy nested inside a member.** A copy that needs an override and sits in a workspace member's own `node_modules` is blocked, because npm's override can't reach it. Moving the members to one range of the parent package clears it.
- **A package declared twice.** A package declared in two dependency fields of one manifest (say `dependencies` and `devDependencies`) is blocked: npm can't rewrite both.
- **Alerts stay open until every copy is resolved.** An alert for a package that has a copy still blocked stays open on GitHub. An alert keyed to a `package.json` tracks the version that manifest *declares*, which an override doesn't change. GitHub raises these for exact pins, not ranges, so one on a pin still in the vulnerable range is reported as blocked by the pin, even when the installed copy is safe: it won't close until the pin changes.

### How a run is checked

The agent applies fixes to the lockfile only: every npm command is `--package-lock-only --ignore-scripts`, and no `node_modules` is needed. `npm ci` passing is not treated as evidence, because it has passed on trees with packages missing. Instead, the result is checked against the snapshot taken before the run:

1. Every copy the plan said it would fix is at its target.
2. Nothing else moved: every changed entry is a target copy at its target, or a package a target requires. When npm replaces a package it refetches what only that package used at the newest version in range; before this check runs, the agent puts back any entry that only changed version, and the check fails if npm won't keep it there. Anything else unrequired fails too: a package added, removed or moved to a new path, or a bundled package that changed with its parent's tarball, since an older entry for that would make the lockfile disagree with what `npm ci` installs.
3. Every exact pin in every manifest resolves to the same version as before.
4. Every changed entry satisfies any matching limit.
5. The tree is complete: every non-optional dependency resolves to an entry whose version satisfies the declared range, or the difference is explained by an override.
6. Only the expected `package.json` files changed, and no temporary `devDependencies` remain.
7. A second resolve changes nothing.

If any check fails, **every file is restored, the run exits with code 1, and the report says which check failed and on which package.** It never produces a partial result. If restoring itself fails, the report says so and the pull request step doesn't run.

### The report

`--report <dir>` writes:

- `report.md`: the text for a pull request or issue. Sections are Fixed, Partly fixed, Applied past a declared range, Blocked, Awaiting close or not found, Other changes, and the overrides removed or kept. It is cut to fit GitHub's size limit with a note if it would be too long; in that case `report-full.md` also exists with the complete text.
- `report.json`: the same data, plus an `outcome` that a workflow can act on.

Every alert's line names the manifest GitHub raised it on, and the report says which npm ran.

| `outcome` | Meaning |
|---|---|
| `changes` | At least one file changed. |
| `blocked-only` | Nothing changed, and at least one copy is blocked. |
| `clean` | Nothing changed and nothing is blocked. Alerts awaiting close or not found are in the job summary only, so they don't raise a false issue. |
| `failed` | The run failed. Once targeted mode's run has begun, a failed report is written whatever stopped it, if `--report` is set. A config error or an undetected package manager stops the agent before that, with an error and no report; the workflow treats a missing report as `failed`. |

A dry run produces the same report, labelled as a plan, and writes nothing.

### Running it in GitHub Actions

This repository provides a reusable workflow, `.github/workflows/targeted-reconcile.yml`. Your repository calls it on its own schedule.

```yaml
# .github/workflows/targeted-dependabot-fixes.yml
name: Targeted Dependabot fixes

on:
  workflow_dispatch:
    inputs:
      dry-run:
        description: "Print the plan only: no pull request, no issue"
        type: boolean
        default: true
  schedule:
    - cron: "0 6 * * 1" # weekly: GitHub has no trigger for a new Dependabot alert

jobs:
  targeted:
    permissions: # a called workflow can't hold more than its caller grants
      contents: read
      issues: write
    uses: michaelpipkin/dependabot-agent/.github/workflows/targeted-reconcile.yml@vX.Y.Z # pin a tag or a commit SHA
    with:
      base-branch: main
      agent-version: "X.Y.Z" # the first release that includes targeted mode
      dry-run: ${{ github.event_name == 'workflow_dispatch' && inputs.dry-run }}
    secrets:
      alerts-token: ${{ secrets.DEPENDABOT_ALERTS_TOKEN }}
      pr-token: ${{ secrets.DEPENDABOT_PR_TOKEN }}
```

To use a GitHub App instead of tokens, replace the two tokens with the App's Client ID and private key:

```yaml
    with:
      base-branch: main
      agent-version: "X.Y.Z"
      app-client-id: ${{ vars.DEPENDABOT_APP_CLIENT_ID }}
      dry-run: ${{ github.event_name == 'workflow_dispatch' && inputs.dry-run }}
    secrets:
      app-private-key: ${{ secrets.DEPENDABOT_APP_PRIVATE_KEY }}
```

| Input | Default | |
|---|---|---|
| `base-branch` | required | The branch the run starts from and the pull request targets. |
| `agent-version` | required | The `dependabot-agent` version to run. Required so every caller pins what it trusts. |
| `node-version` | `"24"` | Node version for the run, and so the npm that resolves the lockfile: Node 24 ships npm 11. See [Supported npm versions](#supported-npm-versions). |
| `dry-run` | `false` | Sets `DRY_RUN`. The plan goes to the job summary and nothing is written: no pull request, no issue. This input decides on its own: a `"dryRun"` in your config file doesn't count in this workflow, so it can't stop a real run from opening its pull request. |
| `app-client-id` | none | A GitHub App's Client ID, used with the `app-private-key` secret instead of `alerts-token` and `pr-token`. See [Credentials](#credentials). |

Put `limits` in `dependabot-agent.config.json` in the repository: the workflow checks out `base-branch` and the agent reads that file.

**What each outcome does**

| `outcome` | Pull request | Issue |
|---|---|---|
| `changes` | Created or updated, on the fixed branch `dependabot-agent/targeted`, with `report.md` as its description. | Closed if open and nothing is blocked. If some copies are still blocked, the pull request lists them, so no issue is created, and one already open is updated with the report. |
| `blocked-only` | None. If a pull request from an earlier run is open, it is closed, because the branch no longer differs from the base. | One issue labelled `dependabot-agent-blocked` is created or updated with the report. |
| `clean` | None, and a stale one is closed in the same way. | Closed if open. |
| `failed` | None. | Created or updated with the failure, and the job fails. |
| no report written | None. | Treated as `failed`: the issue and job summary say no report was produced and link to the run. This is what a config error, a crash at startup, or npx failing to fetch the package looks like. |

Every outcome writes the report to the job summary (the full one, when the pull request text was cut). If the report records that restoring the files failed, no pull request is created. The pull request commits only `package.json` and `package-lock.json` files, never anything else in the checkout.
#### Credentials

The built-in `GITHUB_TOKEN` can't do either job this workflow needs a credential for. It can't read Dependabot alerts, under any `permissions:` setting. And a pull request it creates doesn't trigger `pull_request` workflows, so your CI would never run on it, and this mode relies on CI for all build and test verification.

Pass **a GitHub App or two tokens**. If it gets anything else, the workflow's first step fails the job with a message saying what's missing, before anything else runs, so no report or issue is written.

**A GitHub App** suits a team, since it doesn't belong to a person. A pull request's author can't approve it, so a token that belongs to a person also stops that person from reviewing the agent's pull requests.

1. [Create an App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) with webhooks turned off and these repository permissions: **Dependabot alerts: read**, **Contents: write**, **Pull requests: write**.
2. Generate a private key, and install the App on the repository. Creating an App doesn't install it: if the token step fails with `Not Found`, the App isn't installed on this repository.
3. Store the Client ID as a variable and the private key as a secret, then pass them as `app-client-id` and `app-private-key`, as in the example above.

The workflow makes short-lived tokens from these: one that can only read alerts, for the agent step, and, when there's a pull request to open, one that can write, made just before that step. The write token is never in the agent step's environment. That limits what the agent is handed, but isn't a complete barrier: the steps share a job, so a compromised agent package could still interfere with the later steps. As with any token here, pin a version you trust.

If you add a permission to an App after installing it, the installation's owner has to accept it. Until then, creating a token fails, and the run is reported as failed.

**Two tokens:**

- **`alerts-token`** reads the Dependabot alerts. Use a classic personal access token with `security_events`, or a fine-grained token with **Dependabot alerts: read**. It is given to the agent step only.
- **`pr-token`** opens the pull request, and needs **contents: write** and **pull requests: write** on the repository. These come from the token itself, not from the workflow's `permissions:`, which is why the workflow asks `GITHUB_TOKEN` for less. If it belongs to a person, that person can't approve the pull requests, so a service account no reviewer signs in as is better.

The job's own `GITHUB_TOKEN` is used only to check out the repository (`contents: read`) and to manage the blocked-alerts issue (`issues: write`).

**What your organisation may need to approve**

- The third-party action `peter-evans/create-pull-request`, which opens the pull request. The workflow pins it to a full commit SHA (v8.1.1).
- `actions/create-github-app-token`, from GitHub, pinned the same way (v3.3.0). It runs only if you use a GitHub App, and is the only step given the App's private key.
- `actions/checkout` and `actions/setup-node`, from GitHub, which it refers to by tag. If your policy requires commit SHAs for these too, copy the workflow and pin them.
- The `dependabot-agent` package itself, which the workflow fetches with `npx` at the version you pin and runs with `alerts-token` in its environment. The workflow sets `NPM_CONFIG_IGNORE_SCRIPTS` for that step, so npm runs no install scripts from the package or its dependencies while the token is present. Pinning the version still matters: the agent's own code runs with the token.
- The GitHub App or the two tokens above.

The workflow doesn't set up credentials for a private npm registry. If your lockfile depends on one, copy the workflow and add that step.

### Supported npm versions

**Use npm 11.3 or newer.** The live test suite was run on these versions, on Linux, and on 11.16 on Windows:

| npm | Result |
| --- | --- |
| 11.3, 11.6, 11.9, 11.12, 11.14, 11.16, 11.19 | Every fix applies. |
| 11.0, 10.9 | Some fixes fail safely (see below). |

Versions between these weren't tested. The npm that matters is the one the agent runs, which is the one the job's Node ships, and the log and the report both say which it was. The reusable workflow defaults to Node 24, whose current releases ship npm 11. A pinned older Node 24 ships an older npm.

**Older npm can fail safely on some trees.** On npm 10.9.9, which Node 22 ships, and on 11.0, an Angular 19 tree living only in a workspace member, with an alert on `nanoid`, stops with `fixed on node_modules/nanoid: nanoid is at 3.3.8`, whichever npm wrote the lockfile. npm 10.9.2 and 11.0 also leave a hoisted copy unmoved when another copy of the same package is bundled. The post-run checks catch these, every file is restored, and no pull request is opened: the cost is a failed run, not a wrong tree. So setting `node-version` to `"22"`, or running the CLI on npm 10, works until it meets such a tree.

The lockfile must be `lockfileVersion` 2 or 3 (npm 7 or later). If a different npm version changes the behaviour this mode depends on, the post-run checks are meant to catch it and fail the run rather than produce a wrong tree, but that is not a substitute for a dry run on your own repository.

## After running

If overrides were added or changed, run your package manager's install to apply them to the lockfile:

```bash
pnpm install
```

**On npm, what a plain `npm install` does depends on how the package is reached.** npm resolves from the existing `node_modules` and `package-lock.json`. It applies a changed `overrides` entry to a package reachable from the **root** `package.json`. It does not apply one to a package reachable only through **workspace members**: the old version stays in place, and `--force` and `--package-lock-only` don't help. A clean reinstall re-resolves the whole tree and so applies every override:

```bash
rm -rf node_modules package-lock.json && npm install
```

A clean reinstall moves everything the declared ranges now allow, not just the overridden packages (312 of 545 packages in one test Angular project). If you want only the alerted packages to move, use [targeted mode](#targeted-mode-npm) instead.

The agent prints the right command for your package manager after it writes the overrides.

## CI integration (GitHub Actions)

> **The built-in `GITHUB_TOKEN` cannot read Dependabot alerts.** GitHub Actions' automatic,
> ephemeral `GITHUB_TOKEN` cannot access the Dependabot alerts REST API **under any `permissions:`
> grant** — including `security-events: read`, which only covers *code scanning* alerts, not
> Dependabot alerts. Passing it to the agent fails with:
> ```
> ❌ Error: GitHub API error 403: {"message":"Resource not accessible by integration", ...}
> ```
> You need a real credential — a classic PAT with `security_events` scope, or a fine-grained PAT with
> the "Dependabot alerts: read" permission — stored as a **repository secret** and passed to the
> agent's own steps. Other steps (checkout, opening a PR) can keep using the default `GITHUB_TOKEN` —
> least-privilege still applies everywhere except the one operation that structurally requires one.
>
> A GitHub App works too, but its tokens are short-lived, so create one in a step instead of storing
> it. The App needs "Dependabot alerts: read":
> ```yaml
> - uses: actions/create-github-app-token@v3
>   id: app
>   with:
>     client-id: ${{ vars.DEPENDABOT_APP_CLIENT_ID }}
>     private-key: ${{ secrets.DEPENDABOT_APP_PRIVATE_KEY }}
>     permission-vulnerability-alerts: read
> ```
> Then pass `${{ steps.app.outputs.token }}` to the agent as `GITHUB_TOKEN`.

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

### Fail a build on override drift

To gate CI instead of opening PRs — fail the build when a repo's overrides fall out of date with its alerts — run a dry-run with `--exit-code`. It exits `2` when there is override work to do, `0` when everything is in place, `1` on a real error:

```yaml
- name: Check for override drift
  env:
    GITHUB_TOKEN: ${{ secrets.DEPENDABOT_PAT }} # PAT that can read Dependabot alerts (see Requirements)
  run: npx dependabot-agent --repo ${{ github.repository }} --dry-run --exit-code
```

A green run means the overrides are current; a red one (exit `2`) means someone should run the agent for real and commit the result. Because `2` is distinct from `1`, a genuine failure (bad token, network) still reads as a failure rather than as drift.

## Design notes

### Package-manager abstraction

A `PackageManager` interface encapsulates every PM-specific operation (update command, installed-tree retrieval, dependent analysis, deployment-impact analysis) and normalizes their output into a shared internal tree, so the reconciliation logic is identical for npm and pnpm.

### Override safety

- Overrides for packages **not mentioned in any Dependabot alert** are never removed automatically. The agent also only ever removes an override spec it could have written — a bounded `>=…` — so a hand-written pin in another shape (an exact `2.3.1`, a caret `^2.3.0`, including a scoped `name@major` key) is left alone even when that package is alerted.
- **Nested (object-valued) npm overrides** are left untouched. The agent manages only string-valued specs; a nested override like `"webpack": { "loader-utils": "^2.0.4" }` is preserved verbatim and never read or rewritten.
- When multiple alerts reference the same package on **one release line**, the **highest** `first_patched_version` wins — it is the lowest version that clears every range on that line. When they span **disjoint lines** (a [multi-line advisory](#multi-line-advisory)), both pnpm and npm get one bounded override per line so each consumer stays put; only 0.x packages fall back to the flat highest. The flat highest is a safe fallback rather than an arbitrary one: a lower patch would clear the older line but, because the spec's ceiling anchors on the highest installed copy and escapes are only detected upward, would still admit the newer vulnerable copy with nothing to flag it — so the highest is the only flat choice that cannot fail silently. It forces the older consumer up and reports it as [no in-range fix](#no-in-range-fix).
- Override specs are bounded at the first breaking version above the patch, per npm's caret rules (`>=4.17.21 <5`, `>=0.7.0 <0.8`, `>=0.0.5 <0.0.6`) — compatible with both npm and pnpm. The bound can never exclude its own floor, so a bounded spec can't produce an `ETARGET` at install.
- Specs that escape the installed version's compatible range are reported as [no in-range fix](#no-in-range-fix) rather than applied silently.
- The agent trusts the **alert state** (any state except `fixed` ⇒ keep the override), not the installed version, since the installed tree already reflects applied overrides. A `dismissed` or `auto_dismissed` alert is acknowledged but still vulnerable, so it keeps the override too — only a `fixed` alert frees one to be removed.
- Overrides are only written for packages that remain vulnerable **after** the update pass — in practice transitive deps. Direct dependencies are fixed by bumping their declared range, wherever in the workspace it is declared, so the agent doesn't collide with npm's rule that an override for a direct dep must match its spec. (Setting [`updateWorkspaceMembers`](#workspace-members-and-the-update-pass) to `false` gives that up deliberately: a member's direct dependency then gets an override like any other.) See [Direct dependencies vs. overrides](#direct-dependencies-vs-overrides-npms-spec-match-rule).

### Orphaned overrides

For an override whose vulnerability is resolved — no alert still open, dismissed, or otherwise unfixed for it — the agent finds its installed dependents and works out whether it's still load-bearing. (A merely *dismissed* alert doesn't count as resolved: the vulnerability is still there, so the override is kept. Only a `fixed` alert frees an override to age out.)

For a **published** dependent it asks the npm registry what range that dependent declares for the overridden package — reading the registry rather than your installed tree, whose *resolved* versions already reflect whatever the override forced. Two different questions get asked, of two different versions of each dependent:

- **"Can this override be removed?"** reads **both** the range the **installed** version declares and the range the **latest published** version declares, and keeps the override if *either* could still resolve below the safe floor. The override is removed only when every dependent — at the version you have *and* at its latest — requests a safe range. This does not depend on `--update-strategy`: a dependent pinned by a parent can't move to its safe latest no matter the strategy, so trusting latest alone would drop an override that stuck copy still needs. A dependent that *can* update already shows a safe installed range once the run's update pass has moved it, so it still ages out — just from evidence rather than assumption.
- **"Is this override forcing a dependent past its range?"** reads the range the **installed** version declares, because that's a question about the tree you actually have. A hit is reported as [no in-range fix](#no-in-range-fix), naming the dependent and version.

For a **workspace-internal** dependent — a `packages/*` member with no registry entry — there's no published version to look up. Its committed `package.json` *is* its authoritative current requirement, so the agent reads the declared range straight from disk — resolving a [`catalog:`](#pnpm-catalogs) reference to the range the catalog declares — and folds it in as both the installed and latest range. Without this, an override reachable only through workspace members could never age out, even after those members raised their own ranges to safe versions. The read stays strictly conservative: a member contributes only what it explicitly declares, and workspace globs the agent can't confidently parse are skipped rather than guessed — silence never counts as "safe to remove."

The distinction between installed and latest matters. An override can look routine against latest and be forcing a major bump on the copy you have: if the newest release of a dependent asks for `^7.5.3` but the version installed asks for `^6.1.11`, an override at `>=7.5.16` is dragging your installed copy across a major, and only the installed range shows it. Where a published dependent's installed manifest can't be resolved from the registry, the escape check falls back to its latest range and the report says so.

> **Note on YAML comments:** `js-yaml` doesn't round-trip comments, so hand-written comments in `pnpm-workspace.yaml` are lost on the first write.

## Versioning & stability

This package follows [Semantic Versioning](https://semver.org/). From **1.0.0** onward, the contract the version numbers describe is the **command-line interface** — its flags, environment variables, the [config-file schema](#config-file-reference), exit codes, and **which overrides the agent writes or removes for a given repository state**. Two things are deliberately *not* part of the contract: the console output, which is human-facing and may change at any time (parse exit codes, not text); and the internal modules — the package exposes no importable API, and importing anything under `dist/` is unsupported.

- **Major** — removing or renaming a flag, environment variable, or config key; changing a default; changing the config schema; or raising the minimum Node version.
- **Minor** — a new flag, environment variable, or config key with a safe default, **or** a change to *which overrides the agent produces* for inputs it already handled — even a corrective one. Because those alter behaviour for consumers who auto-update, they always get at least a minor bump and a `CHANGELOG` entry, never a silent patch.
- **Patch** — bug fixes for cases the agent previously mishandled or declined to act on, and any change to console output, wording, or diagnostics.

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
