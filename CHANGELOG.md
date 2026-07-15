# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases from 0.1.5 onward are published as [GitHub Releases](https://github.com/michaelpipkin/dependabot-agent/releases), so Dependabot and Renovate surface these notes directly in the update PRs they open for this package. Entries for 0.1.0–0.1.4 were reconstructed from the commit history after the fact.

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
