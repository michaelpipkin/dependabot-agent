# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases from 0.1.5 onward are published as [GitHub Releases](https://github.com/michaelpipkin/dependabot-agent/releases), so Dependabot and Renovate surface these notes directly in the update PRs they open for this package. Entries for 0.1.0–0.1.4 were reconstructed from the commit history after the fact.

## [0.1.6]

### Fixed

- **"No in-range fix" now covers overrides with no open alert.** 0.1.5 wired the check into the alert-driven path only. Overrides without an open alert take the orphan path, which asked only whether they were still load-bearing and reported every kept override identically — so a repo with zero open alerts, the steady state most of the time, never saw the check fire. An override kept as load-bearing can still be forcing its dependents past the range they declare; those are now reported as no-in-range-fix.
- **Dependent ranges are resolved at the version installed, not the latest published.** `pnpm why` and `npm explain` both report each dependent's installed version; it was collected into a name-only set and discarded, and the range was then read from the dependent's `latest` manifest — which can declare something entirely different from the copy on disk. This under-reported escapes badly in practice: on a real tree, `tar >=7.5.16` read as routine because the latest dependents declare `^7.5.3`, while the *installed* `@capacitor/cli@5.7.8` declares `^6.1.11` and was being forced across a full major. Two of five escapes on that tree were invisible.

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
