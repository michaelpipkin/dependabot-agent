# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases from 0.1.5 onward are published as [GitHub Releases](https://github.com/michaelpipkin/dependabot-agent/releases), so Dependabot and Renovate surface these notes directly in the update PRs they open for this package. Entries for 0.1.0–0.1.4 were reconstructed from the commit history after the fact.

## [1.0.2]

### Added

- **Documented how to hold a single package back from the update pass.** A new "Excluding a package from the update" section under [Update strategy](README.md#update-strategy) covers pnpm's `updateConfig.ignoreDependencies` — the setting made for this, which lives in `pnpm-workspace.yaml` rather than the `pnpm` field in `package.json` that older examples show, and which is distinct from `overrides` (that force-pins tree-wide; this only tells the update command to leave a direct dependency's declared range alone). npm has no equivalent, so the section gives the range-tightening workaround, notes that npm-check-updates' `reject` list belongs to a tool this agent never invokes, and points out that the npm `latest` path is already narrow — it installs `@latest` only for *alerted* direct dependencies. Also states the limit that applies to every package manager: an exclusion governs only the update pass, so a still-vulnerable transitive copy still gets a bounded override and no alert is suppressed. Documentation only; no code change.

## [1.0.1]

### Fixed

- **Corrected the token-permission docs for fine-grained PATs.** The Requirements and Options sections stated that the GitHub token needs the `security_events` permission — which is right for a **classic** PAT, but a **fine-grained** PAT needs the **Dependabot alerts** repository permission (Read) instead. A fine-grained token set up per the old wording would fail with a 403. Documentation only; no code change.

## [1.0.0]

First stable release. The command-line interface — its flags, environment variables, config-file schema, exit codes, and the overrides the agent writes or removes for a given repository state — is now a stable contract under [Semantic Versioning](https://semver.org/); see [Versioning & stability](README.md#versioning--stability). Functionally a superset of 0.1.16, with the additions and fixes below. Reached after four independent adversarial reviews and live validation on every path (add and remove, pnpm and npm).

### Added

- **`--exit-code` flag (`EXIT_CODE=true`) for CI drift gating.** When set, the agent exits `2` if it finds any override changes — pair it with `--dry-run` to fail a build when a repo's overrides have fallen out of date with its Dependabot alerts. `2` is deliberately distinct from `1` (a real error) so CI can tell drift apart from a broken run; a clean run stays `0`.
- **A "Versioning & stability" policy in the README.** States the contract the version numbers describe from 1.0.0 on — the CLI flags, env vars, config schema, exit codes, and which overrides the agent writes for a given input — and what counts as a major/minor/patch change. Console output and internal modules are explicitly outside the contract.

### Changed

- **The minimum Node version is now 22** (was 20). Node 20 reached end-of-life in April 2026, and the project's own toolchain (pnpm) requires Node 22.13+, so Node 20 can no longer be built or tested against. The CI matrix runs on Node 22 and 24, across Linux and Windows.
- **The package now declares no importable API.** It has always been a CLI-only tool, but `main`/`types` pointed at the CLI entry (which runs on import and exports nothing). Those fields are removed and an `exports` restriction is added, so `import "dependabot-agent"` and deep imports of internal `dist/` modules are no longer resolvable — preventing internal functions from becoming an accidental, frozen public API. The `dependabot-agent` command is unaffected.

### Fixed

- **A hand-written override pin is never auto-removed, on any removal path.** The "only remove a bounded `>=…` the agent could have written" guard was applied when cleaning up a superseded key, but not when aging out an orphaned override — so a hand-written pin (an exact `2.3.1`, a caret, or a scoped `name@major`) for a package whose alert had since been *fixed* could be dropped by the orphan pass, against the documented guarantee. The shape guard now applies to both paths.
- **An empty `--repo=` no longer masks `GITHUB_REPO` or the config file.** Repo resolution used `??`, so an empty inline value won over the environment and config; it now uses `||` (matching `--token`) and falls through.

## [0.1.16]

### Fixed

- **A multi-line advisory whose scoped overrides are already in place no longer reports itself as a flat override.** The multi-line report chose its "split into per-line overrides" vs "forcing a flat version" wording from _this run's changes_ only. On an idempotent re-run — the scoped `js-yaml@3` / `js-yaml@4` keys already on disk, so no change is emitted — it fell through to the flat message, wrongly claiming a single version was being forced on every consumer. It now reads the override shape that will be on disk after the run (current overrides plus this run's changes), so an already-scoped package is reported as scoped. Reporting only; the overrides written are unchanged. Caught by the live add-path smoke test.
- **`npm ls`'s expected "invalid" errors no longer leak to the console.** When an override forces a copy out of its declared range — the normal steady state for any repo using this tool — `npm ls` exits non-zero and prints an `ELSPROBLEMS … invalid: pkg@x` block to stderr. The agent already read the JSON `npm ls` still emits, but the raw npm error text was inheriting the console and reading as a failure. Its stderr is now captured, replaced by a one-line note that override-forced copies are expected. A genuine `npm ls` failure (no usable output) still surfaces.
- **The deployment-impact report no longer prints a dangling "via:".** A package Dependabot classifies as runtime but for which the local tree walk resolved no path printed `— via:` with nothing after it. It now says the classification came from Dependabot with no local path resolved, and omits the empty "via:" for dev-scoped packages.

## [0.1.15]

### Fixed

- **A load-bearing override kept on the strength of an installed range now says so.** When an orphaned override was kept because a dependent's _installed_ range still dips below the floor — while its _latest_ range is already safe — the report printed only the (safe-looking) latest ranges, so the keep read as unexplained. It now names the dependent and the specific below-floor range holding the override, the way the escape report already does. Observability only; the keep decision is unchanged. Surfaced by a live run where `@babel/core` was correctly kept but the message showed only its safe latest versions.

## [0.1.14]

### Fixed

- **Scoped per-line overrides no longer leave a vulnerable copy on an uncovered major.** Before writing per-line `name@major` selectors, the agent bailed to the flat override only when a vulnerable installed copy sat _below the lowest_ selector — it didn't check a copy wedged on a major _between_ non-adjacent lines (say a `4.x` copy when the advisory patches to majors 3, 5, and 6). No `name@major` key matched that copy, so it stayed vulnerable while the run reported the advisory as handled. The guard now bails to flat whenever any vulnerable copy is on a major that no selector covers — below, between, or above — so every copy is either patched or reported as a [no in-range fix](#no-in-range-fix). Found by an independent audit.
- **A user's hand-written scoped pin is no longer discarded when its base package is alerted.** The stale-key cleanup removed any override key whose base was handled this run under a different key, which could drop a deliberate `foo@2: "2.3.1"` compatibility pin when `foo` later got an alert on another line. Every spec the agent writes is a bounded `>=…`, so cleanup now only removes `>=`-shaped keys — a user's exact or caret-ranged pin is left untouched.
- **Nested (object-valued) npm overrides are preserved instead of clobbered.** npm's `overrides` allows nested objects (`"webpack": { "loader-utils": "^2.0.4" }`), which the string-keyed reconciliation couldn't model — an alerted package with such a value would have had it flattened to a version string, and the orphan path could even throw on it. Object-valued overrides are now kept out of reconciliation entirely and merged back verbatim on write, with a note in the log.
- **Override removal is now strategy-independent — `--update-strategy latest` can no longer drop a still-load-bearing override.** The removal decision used to check only each dependent's _latest_ published range under `latest` (checking the installed range only under `compatible`), on the assumption that `latest` moves every dependent to its newest release. But a dependent pinned by a parent — an exact or capped range — can't move there; only the override could, and that's what was being removed. So an override holding back a CVE for such a stuck dependent was deleted with no warning. Removal now reads **both** the installed and latest ranges under every strategy and keeps the override if either could still resolve below the safe floor. A dependent that genuinely can update already shows a safe installed range once the run's update pass has moved it, so overrides still age out — from evidence, not assumption. This completes the round that fixed the same gap for `compatible` in 0.1.13. Found by an independent audit.
- **A dismissed-but-unfixed Dependabot alert keeps its override.** Removal treated any alert that wasn't `open` as resolved, so a `dismissed` / `auto_dismissed` alert — acknowledged but still vulnerable, often dismissed _because_ an override mitigates it — made its override eligible for orphan removal. Only a `fixed` alert now frees an override to age out; every other state keeps it load-bearing.
- **Upper-bound-only dependent ranges no longer read as removable.** `rangeCouldResolveVulnerable` stripped a range to its base version and compared that to the floor — but for a bare `<=4.18.0` or `<4.19.0` the "base" is the ceiling, not a lower bound. Such a range declares no minimum and can resolve to a version below the floor (e.g. `4.17.15`), so it is now always kept. (Compound ranges with a real lower bound were already handled correctly.)
- **A still-open, unpatched alert no longer has its override removed and mislabeled "resolved."** The removal pass keyed off the set of _open_ alert names (via a parameter misleadingly named `resolvedAlertNames`), so any package that had an open alert but was skipped from the vulnerable set — because its advisory has no `first_patched_version` (an unpatched CVE) or because it wasn't found in the installed tree — fell through to removal with the reason "Vulnerability resolved — override no longer needed." A hand-pinned mitigation for an unpatched CVE could be stripped while the alert was still open, reintroducing the exposure and printing a false "resolved." Removal is now driven only by what the run actually did: a key is dropped only if the package was handled this run under a different key (a stale scoped/flat variant to clean up) or the orphan pass judged it removable. A package the run couldn't act on keeps its override — honoring the "open ⇒ keep the override" guarantee. Found by an independent audit.
- **Orphaned scoped overrides no longer emit a false "no in-range fix" warning.** When a per-line override (`js-yaml@3`, `js-yaml@4`) became an orphan with consumers still on both lines, every dependent's escape was judged against the single highest installed copy, so a 3.x consumer was reported as forced past its range to a 4.x version it never resolves to. The override was correctly kept — this was warning noise only — but the check now clears a dependent that any installed copy satisfies, so only genuine escapes (past every copy) are reported.
- **Versions carrying build metadata now parse.** `parseSemver` stripped the pre-release suffix but not build metadata, so `1.2.3+build` failed to parse and callers fell back to their conservative branch. Build metadata is ignored for precedence by the semver spec, so it is now stripped too — `1.2.3+build` compares as `1.2.3`. (Pre-release versions remain flattened, which is exact for the range _lower bounds_ GitHub emits, e.g. `>= 21.0.0-next.0`.)

## [0.1.13]

### Fixed

- **Override removal is safe again across scoped keys, update strategies, and hand-added pins.** An independent audit turned up four ways the removal path could remove an override that was still load-bearing — reintroducing the CVE it was holding back. All are fixed:
  - **Scoped keys were judged against the lowest floor.** When a package was held by per-line overrides (`js-yaml@3` → `>=3.14.2`, `js-yaml@4` → `>=4.1.1`) and became an orphan, the removal check collapsed them to the _lowest_ floor — the least conservative choice, which dropped the whole set while a higher line was still needed (a `^4.0.0` dependent silently back on `4.0.x < 4.1.1`). It now judges against the **highest** floor, keeping the set until every line is clear. **Live since 0.1.10.**
  - **Removal ignored installed dependents.** It decided purely from each dependent's _latest_ published range, on the assumption an update reaches it — which fails under the default `compatible` strategy (no major crossing) or a parent-pinned dependent. Under `compatible` it now also checks the **installed** range and keeps the override if either could still resolve vulnerable; `latest` is unchanged.
  - **It could remove a never-alerted override.** The agent fetched only open alerts, so it couldn't tell a resolved alert from a hand-added pin the agent never authored, and could remove the latter — contradicting the "never removes what was never alerted" guarantee. It now fetches all alert states and only reconciles a package that was alerted at some point. (Consequence: an override for a package with no alert history is now correctly left alone — including the synthetic one in the removal fixture repo.)
  - **Scoped selectors could miss a sub-major copy.** An open-ended-below line (`< 3.14.2`) covers 2.x too, but a `js-yaml@3` selector doesn't — leaving such a copy unpatched and unflagged. When a vulnerable copy sits below the lowest scoped major, the agent now falls back to the flat override (which covers every copy and reports the escape).
- **An empty `--token=` no longer masks a valid `GITHUB_TOKEN`.** It coalesced with `??`, so an empty inline value won over the environment; it now falls through.

## [0.1.12]

### Changed

- **Documentation caught up with behaviour.** The "What it does" overview now mentions that a multi-line advisory is fixed with one scoped override per release line (shipped 0.1.10), and the "Orphaned overrides" section now describes reading a workspace member's local manifest to decide removal (shipped 0.1.11) — it previously said only the npm registry was consulted, which stopped being true. No code change; this release exists to publish the corrected README to npm.

## [0.1.11]

### Added

- **Overrides whose only dependents are workspace-internal can now age out.** Removal of an override with no open alert asks "has upstream moved on?" by reading the dependents' latest ranges from the npm registry — but a workspace member (`packages/*`) has no registry entry, so it was dropped, and an override reachable only through such members was kept indefinitely even after those members raised their own ranges to safe versions. The agent now also reads each workspace member's own `package.json` (its committed range _is_ its authoritative "latest") and folds those in: if every member that declares the package now requests a safe range, the override is removed; if any still declares a vulnerable one, it's kept. Strictly conservative — a member contributes only what it explicitly declares, unfamiliar workspace globs are skipped rather than guessed, and with no registry data and no member declaration the override is still kept. ([#14](https://github.com/michaelpipkin/dependabot-agent/issues/14))

### Fixed

- **A failed alert fetch now exits cleanly instead of crashing.** When the Dependabot alert fetch failed for any reason — bad token (401), alerts disabled (403), network error, any non-2xx — the agent printed the correct error and then aborted with a libuv assertion (`UV_HANDLE_CLOSING`) and a non-standard exit code (127 instead of 1). The cause: `exitWithError` called `process.exit()` synchronously from inside the async fetch path, tearing the process down while undici's handles were still open (Windows/Node 24). It now throws a typed `AgentError` that the top-level handler prints and turns into `process.exitCode = 1`, letting the event loop drain — no assertion, correct exit code, same message. ([#12](https://github.com/michaelpipkin/dependabot-agent/issues/12))

## [0.1.10]

### Added

- **Multi-line advisories are fixed with per-line scoped overrides, not just reported.** When a package is vulnerable on disjoint release lines — `js-yaml` on both 3.x and 4.x, say — the agent now writes one bounded override per line using a version-selector key (`js-yaml@3` → `>=3.15.0 <4`, `js-yaml@4` → `>=4.2.0 <5`) instead of a single flat max that drags the lower line's consumer across a major no advisory demands. Each installed copy stays on its own line. **Both pnpm and npm** honor the `name@major` selector, including for transitive copies, so the same specs work in `pnpm-workspace.yaml` or a package.json `overrides` block — no nested overrides or parent attribution needed (the selector patches a line by the version installed, not by which parent pulled it). Two advisories on the same line collapse to one selector (the higher patch); 0.x packages fall back to the flat max with the existing warning, since `pkg@0` would be too broad. Proven end-to-end on pnpm against a live fixture (each consumer resolved to its own patched line, GitHub closed the alerts, neither crossing a major), with the selector mechanism verified on npm for direct and registry-transitive copies. Detection ([0.1.9](#019)) reported the case; this resolves it. See [#2](https://github.com/michaelpipkin/dependabot-agent/issues/2).

### Fixed

- **Workspace member dependencies are now visible: `pnpm list -r`.** The installed-tree read ran `pnpm list` without `-r`, so in a shared-lockfile pnpm workspace a dependency declared only in a `packages/*` member was invisible at the root — the package was skipped before detection ran and no override was written. The agent did nothing on such a workspace. It now lists every workspace project; a single non-workspace project is unaffected. (Projects with their own lockfile were already walked as isolated dirs, which is why this went unnoticed.)
- **Post-run guidance is now package-manager-specific, and correct for npm.** The agent writes overrides but leaves the install to the user; the old message ("run your package manager's install") is wrong for npm. npm resolves from the existing `node_modules` + `package-lock.json` and does not re-resolve when `overrides` changes — a plain `npm install`, `--force`, or `--package-lock-only` all leave the vulnerable versions in place, so the alert never closes and nothing says why. Confirmed end-to-end on a live npm workspace fixture. The agent now tells npm users to apply a newly written override with a clean install (`rm -rf node_modules package-lock.json && npm install`), and pnpm users their plain `pnpm install`. Documented in the README too.
- **Workspace member alerts no longer spawn member-local override files.** GitHub keys a member's direct-dependency alert to `packages/x/package.json`, and the agent grouped by that path — treating a shared-lockfile member as its own isolated package and writing a `packages/x/pnpm-workspace.yaml` the package manager never reads (overrides resolve from the root). Alerts for members without their own lockfile now fold into the root group, so the fix lands once, in the root override file. A member with its own lockfile, or one named explicitly via `--packages`, still owns its overrides.

## [0.1.9]

### Added

- **Multi-line advisories are reported instead of firing silently.** An advisory carries one vulnerable range per release line, each with its own patch, so a package vulnerable on two lines at once has no single patched version. The agent writes the highest — [deliberately, since it is the only choice that can't leave a vulnerable copy quietly resolvable](https://github.com/michaelpipkin/dependabot-agent/pull/3) — which forces the lower line's consumer across a major no advisory demands. Nothing said so. Replaying a real repository's full alert history turned up **five occurrences across ten months**, every one invisible: `js-yaml` merged to 4.1.1 where 3.14.2 cleared both ranges, `jws` to 4.0.1 over 3.2.3, `ajv` to 8.18.0 over 6.14.0, and `minimatch` twice — once forcing a 3.x consumer to 10.2.3, seven majors, where 3.1.4 cleared all three ranges. They were invisible because the agent fetches `?state=open`, so the case is unreachable from the only window it ever looks through. Now reported as a dedicated block with a summary count, naming each line and the version that would have sufficed. Informational: the override is unchanged, and there is nothing to act on until scoped overrides exist ([#2](https://github.com/michaelpipkin/dependabot-agent/issues/2)) — but the cost stops being paid in silence.
- **A range predicate for GitHub's `vulnerable_version_range`.** Built from the shapes that actually occur rather than the ones a spec implies: across 228 real alerts on two repositories there are exactly five — `>= V, < V`, `< V`, `>= V, <= V`, `<= V`, `= V`. It returns "unknown" rather than "clears" on anything it can't parse, so an unfamiliar range can never manufacture a false all-clear; and it detects nothing rather than guessing. The detector is the fix [#2](https://github.com/michaelpipkin/dependabot-agent/issues/2) proposed and 0.1.8 disproved — computing the lowest patch that clears every range is unsafe to _write_, but it is exactly the right number to _compare_ the max against.

## [0.1.8]

### Changed

- **Keeping the highest `first_patched_version` is now a considered choice, with the reasoning and a fixture behind it.** An advisory carries one vulnerable range per release line, each with its own patch, so "the patched version" isn't a single number — `GHSA-mh29-5h37-fv8m` patches js-yaml's `< 3.14.2` at 3.14.2 and its `>= 4.0.0, < 4.1.1` at 4.1.1, and 3.14.2 clears both. Taking the max therefore drags a 3.x consumer across a major no advisory demands, and [#2](https://github.com/michaelpipkin/dependabot-agent/issues/2) proposed switching to the lowest patch that clears every range. Tracing that through the code disproves it: with 3.13.0 and 4.0.5 both installed, the lower patch emits `>=3.14.2 <5` — the ceiling anchors on the highest installed copy — which still admits the vulnerable 4.0.5, and escapes are only detected upward, so nothing flags it and the CVE stays live in silence. Anchoring the ceiling on the patch instead only trades that for an equally silent major downgrade. The max emits `>=4.1.1 <5` and reports 3.13.0 as a no-in-range fix: the bump is surfaced, not assumed. Behaviour is unchanged; the merge path is now driven from real alert payloads in the tests, and the mechanism the argument rests on is pinned so a future change to it can't quietly invalidate the rationale. Handing each release line its own patch still needs scoped overrides, which #2 now tracks.

## [0.1.7]

### Added

- **Escapes are split by whether an upstream fix exists.** Each escaping dependent is checked against its own latest release: if that release accepts the forced version, or dropped the dependency entirely, a fix exists upstream. The rest — dependents already at their newest release that still can't take the forced version — have nowhere to go. On a real tree this separated 6 escaping dependents into 5 with an upstream fix and 1 genuinely stuck. The report is careful to say a fix _exists_, not that it's reachable: a parent pinning the dependent holds it where it is regardless. Measured on that same tree, `@angular/build@22.0.6` pins `vite` to exactly `7.3.5` and `@capacitor/assets@3.0.5` caps `@capacitor/cli` at `^5.3.0` — both parents already at their own latest, so neither dependent can move and neither escape can be updated away.
- **Dry runs say so.** Escapes are computed from the installed tree, and a dry run skips the update pass, so the list describes the tree you have rather than the one a real run would produce. The report notes this — without implying the list would shrink. In practice it frequently won't: a dependent pinned by its parent survives the update, and so does its escape.
- **Git Bash on Windows: `PNPM_HOME` is repaired before shelling out.** Git Bash can export it as `/c/Users/you/AppData/Local/pnpm`, and converts that to Windows form when _it_ launches a native binary — so a hand-typed `pnpm update` works fine. A pnpm spawned by this agent inherits the raw POSIX value, derives its store as `\c\Users\...\store\v11`, finds `node_modules` recorded against `C:\Users\...\store\v11`, and dies mid-run with `ERR_PNPM_UNEXPECTED_STORE`, naming neither the variable nor the cause. The value is now normalized, with a warning saying what happened and how to silence it. Inert everywhere else: it returns immediately off `win32`, so Linux CI runners (including GitHub Actions) never execute it, and it only rewrites unambiguous MSYS drive paths. It warns rather than exits — a wrong guess must never fail a run.

### Fixed

- **Escapes are judged against the version actually resolved, not the override's floor.** An unbounded spec can sit far above its own floor — a real `uuid` override reading `>=11.1.1` had resolved to `14.0.1`, and a `js-yaml` `>=4.2.0` to `5.0.0`. Judging by the floor didn't just understate severity in the report; it **missed escapes outright**: floor `0.28.1` sits inside a dependent's `^0.28.0`, so a drift to `0.29.5` read as no escape at all. Reports now show `">=11.1.1" → resolved 14.0.1`.
- **Escape detection now considers every installed copy of a package, not one picked by name.** `findInstalledVersion` returned the first match in a tree walk, on the stated assumption that "all instances should be the same version after the package manager resolves with any existing overrides applied." That assumption is inverted: it holds _after_ an override is applied, but the agent runs _before_, which is exactly when a vulnerable copy and a safe copy coexist. On a real tree it landed on the safe copy and suppressed the warning for the alert's actual subject — `tar` 6.2.1 alongside 7.5.20, and `esbuild` 0.27.7 alongside 0.28.1, both silently reported as having no escape. Specs are now bounded against the highest copy (so the ceiling can't exclude one already in range) and escapes tested against every copy, with the offending versions named. The function is gone; `findInstalledVersions` returns all of them.
- **Deployment-impact paths name the actual dependency again (pnpm).** Every path rendered as the queried package's own name — `tar — via: tar` — because the walk seeded its label with `entry.name`, making the `pathLabel ||` fallback dead code. Paths now name the root's direct dependency that pulls the package in: `tar — via: @capacitor/cli@5.7.8, node-gyp@12.4.0`. The npm implementation was already correct.
- **Deployment impact now uses Dependabot's `scope`.** The local `pnpm why` / `npm explain` walk is version-agnostic: with two copies installed it finds the _safe_ copy's production path and calls the package production even when the copy under alert is dev-only. Real example — `tar` reported as PRODUCTION (reached via `@capacitor/cli`, a runtime dependency, at the safe 7.5.20) while every one of its alerts is `development`, because the vulnerable 6.2.1 arrives through `@capacitor/assets`. GitHub reports scope per alert, tied to the vulnerable copy. That's now the source of truth, with the local walk kept as a fallback when the payload omits it.

## [0.1.6]

### Fixed

- **"No in-range fix" now covers overrides with no open alert.** 0.1.5 wired the check into the alert-driven path only. Overrides without an open alert take the orphan path, which asked only whether they were still load-bearing and reported every kept override identically — so a repo with zero open alerts, the steady state most of the time, never saw the check fire. An override kept as load-bearing can still be forcing its dependents past the range they declare; those are now reported as no-in-range-fix.
- **Dependent ranges are resolved at the version installed, not the latest published.** `pnpm why` and `npm explain` both report each dependent's installed version; it was collected into a name-only set and discarded, and the range was then read from the dependent's `latest` manifest — which can declare something entirely different from the copy on disk. This under-reported escapes badly in practice: on a real tree, `tar >=7.5.16` read as routine because the latest dependents declare `^7.5.3`, while the _installed_ `@capacitor/cli@5.7.8` declares `^6.1.11` and was being forced across a full major. Two of five escapes on that tree were invisible.

  Both questions are now asked of the data that answers them: removal still reads the **latest** ranges (it asks "has upstream moved on?"), while the escape check reads the **installed** ranges (it asks "what does the tree I have ask for?"). Where a dependent's installed manifest can't be resolved, the report falls back to its latest range and says which entries it did that for.

### Changed

- Escape reports now name the offending dependents and their versions (`gaxios@6.7.1 declares ^9.0.1`) rather than listing bare ranges.
- `PackageManager.collectDependentRanges` returns `DependentRange[]` instead of `string[]`. Internal interface; no CLI or config surface changes.

## [0.1.5] - 2026-07-15

### Added

- **"No in-range fix" reporting.** When the earliest patched version of a package falls outside the compatible range of what's installed, the override is now flagged separately from routine changes — with an inline marker, a dedicated warning block, and a summary count. This is the bucket that needs a human: such an override installs cleanly and closes its Dependabot alert, so nothing else in the pipeline surfaces it.
- **Test suite** on Node's built-in runner (`node --test`, no framework dependency). Covers the semver logic and override reconciliation. Runs in CI on every push to `main` and gates publishing via `prepublishOnly`.

### Fixed

- **Override bounds now follow npm's caret rules** instead of assuming the major is always the breaking boundary. Under `0.x` the minor is the breaking position (`^0.5.0` is `>=0.5.0 <0.6.0`), and under `0.0.x` it's the patch. A `cookie` `0.5.0 → 0.7.0` bump — the shape of `CVE-2024-47764`, reached through `express` by a great many projects — was previously bounded `>=0.7.0 <1` and reported as a routine change. It is now bounded `>=0.7.0 <0.8` and correctly flagged as escaping the installed range.
- **`parseSemver` rejects malformed input** that previously parsed as a real version. `""` became `0.0.0` and `"1..3"` became `1.0.3`, because `Number("")` is `0` rather than `NaN`. Not reachable through any current caller, which all guard first, but the parser underpins every other decision in the file.

### Changed

- **Override specs for `0.x` packages are tighter** (`<0.8` rather than `<1`). The first run after upgrading may rewrite existing `0.x` overrides as a one-time `UPDATE`. This is expected: the new bound is the correct one, and the old one let a `0.5` override drift as far as `0.9` — every hop a breaking change.

### Documentation

- The README claimed overrides were bounded such that a fix "never forces a breaking major bump" and would "never silently jump a major version." Both were wrong: when no in-range fix exists, the bound is computed from the patched version, and the override crosses the boundary by necessity. Corrected, and documented what actually happens — overrides apply at the resolution layer and are not vetoed by a dependent's caret range, `peerDependencies` range, or even an exact pin. The install exits 0, the alert closes, and the break surfaces at runtime.

## [0.1.4] - 2026-07-12

### Added

- MIT license.
- `repository`, `bugs`, and `homepage` metadata in `package.json`.

### Documentation

- README updates.

## [0.1.3] - 2026-07-09

### Added

- GitHub Actions publish workflow, using npm Trusted Publishing (OIDC) with provenance.

### Changed

- CI installs with pnpm; dropped `package-lock.json`.
- Workflow actions bumped to their Node 24 majors.

### Documentation

- README updates.

## [0.1.2] - 2026-06-24

### Fixed

- Version bounding: when the only patched version lived in a newer major than the installed one, the ceiling was computed from the installed major and produced an impossible empty range like `>=7.28.0 <7`. The ceiling now clears the patched floor.

## [0.1.1] - 2026-06-23

### Documentation

- Documentation updates.

## [0.1.0] - 2026-06-22

Initial release.

- Reconciles npm and pnpm dependency overrides against open GitHub Dependabot alerts.
- Auto-detects the package manager from the lockfile and locates the appropriate override config (`overrides`, `pnpm.overrides`, or `pnpm-workspace.yaml`).
- Discovers and processes isolated sub-packages with their own lockfile, in addition to the workspace root.
- Reports deployment impact — whether vulnerable packages sit in the production graph or dev/test only.
