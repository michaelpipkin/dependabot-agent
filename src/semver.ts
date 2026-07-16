// ---------------------------------------------------------------------------
// Semver helpers  (no external deps — keeps the agent self-contained)
// ---------------------------------------------------------------------------

/**
 * Parse a semver string into a [major, minor, patch] tuple. A leading range
 * operator (>=, ^, ~, …) is stripped, as are pre-release and build-metadata
 * suffixes: "1.2.3-rc.1" and "1.2.3+build" both parse as [1, 2, 3]. Returns null
 * for anything that isn't a plain dotted version, so callers fall back to their
 * conservative branch.
 *
 * Dropping the pre-release loses its ordering (1.2.3-rc < 1.2.3), a deliberate
 * approximation: the pre-release the agent actually meets is in a range LOWER
 * bound — GitHub writes ">= 21.0.0-next.0" — where ">= X-pre" admits exactly the
 * same stable versions as ">= X". A pre-release as an installed VERSION would be
 * mis-ordered, but Dependabot patch identifiers and installed trees are
 * effectively always stable, so that case doesn't arise. Build metadata, by
 * contrast, is ignored for precedence outright, so stripping it is exact.
 *
 * Segments are validated as digit strings rather than passed through Number():
 * Number("") is 0, not NaN, so a bare "" or a "1..3" would otherwise parse as a
 * real version instead of being rejected.
 */
export function parseSemver(version: string): [number, number, number] | null {
  const clean = version
    .replace(/^[~^>=<\s]+/, "")
    .split(/[-+]/)[0] // drop pre-release and build metadata: 1.2.3-rc.1+build → 1.2.3
    .trim();
  if (clean === "") return null;

  const segments = clean.split(".").map((s) => s.trim());
  if (!segments.every((s) => /^\d+$/.test(s))) return null;

  const parts = segments.map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Returns true if the requested range specifier *could* resolve to a version
 * below patchedVersion — meaning the override is still load-bearing.
 *
 * The key question is whether the range's MINIMUM possible resolution is below
 * the patched version. If the lowest version the range could install is still
 * vulnerable, the override is needed. We use the lower bound (the base version
 * in the specifier) for this check, not the upper bound.
 *
 * Examples with patchedVersion = "7.5.16":
 *   ^7.5.3  → base 7.5.3  < 7.5.16 → still needed (can resolve to 7.5.3-7.5.15)
 *   ~7.5.3  → base 7.5.3  < 7.5.16 → still needed
 *   0.28.1  → exact 0.28.1, must check if < patched (different package, but same logic)
 *   >=7.5.16 → base 7.5.16 = patched → not needed (always resolves to safe version)
 *   >=7.5.3  → base 7.5.3  < patched → still needed (could resolve below patched)
 *   *        → unbounded    → conservatively keep (can't determine)
 */
export function rangeCouldResolveVulnerable(specifier: string, patchedVersion: string): boolean {
  const patched = parseSemver(patchedVersion);
  if (!patched) return true; // can't parse — keep override to be safe

  const trimmed = specifier.trim();

  // Wildcards — can't determine minimum, keep conservatively
  if (trimmed === "*" || trimmed === "") return true;

  // Upper-bound-only ranges (<X, <=X) declare no lower bound, so they can resolve
  // to any version below the ceiling — including below the floor. Always keep.
  if (trimmed.startsWith("<")) return true;

  // Strip the range operator to get the base version (the minimum the range can resolve to)
  const base = parseSemver(trimmed);
  if (!base) return true;

  // The range is still vulnerable if its minimum possible resolution (the base
  // version) is strictly below the patched version. This applies uniformly to
  // all specifier types: ^, ~, >=, exact, etc. — they all have a lower bound
  // equal to their base version.
  //
  // Special case: >= and > with a base AT or ABOVE patched are safe — the range
  // cannot resolve below patched by definition.
  if (trimmed.startsWith(">=")) {
    return compareSemver(base, patched) < 0;
  }
  if (trimmed.startsWith(">")) {
    // > X means minimum is X+patch, conservatively treat base as vulnerable if < patched
    return compareSemver(base, patched) < 0;
  }

  // For ^, ~, exact, and anything else: vulnerable if base < patched
  return compareSemver(base, patched) < 0;
}

/**
 * True when `version` falls inside a GitHub advisory's `vulnerable_version_range`.
 *
 * The format is a comma-separated conjunction of comparators. Across 228 real
 * alerts on two repositories, exactly five shapes occur and nothing else:
 *
 *   ">= V, < V"   (87)     "< V"    (84)     ">= V, <= V"  (31)
 *   "<= V"        (24)     "= V"     (2)
 *
 * `>` has never been observed, but absence from a 228-sample isn't proof and it
 * costs one map entry.
 *
 * Returns **null** rather than false when the version or any bound won't parse.
 * The distinction matters: false reads as "outside the vulnerable range", i.e.
 * safe, which would let an unparseable range manufacture a false all-clear.
 * Callers must treat null as "cannot tell" and fall back to their conservative
 * branch.
 *
 * Pre-release is discarded by parseSemver, which is correct for every shape
 * observed: the only pre-release bounds in real data are lower bounds of the
 * form ">= 21.0.0-next.0" or ">= 7.0.0-alpha.0", and stripping them to
 * ">= 21.0.0" / ">= 7.0.0" admits exactly the same stable versions. Ordering
 * pre-releases properly would buy nothing here.
 */
export function satisfiesVulnerableRange(version: string, range: string): boolean | null {
  const v = parseSemver(version);
  if (!v) return null;

  const parts = range
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (parts.length === 0) return null;

  let inRange = true;
  for (const part of parts) {
    // No \s* between the groups: `.` would also match the space, and the two
    // overlapping quantifiers backtrack. parseSemver trims its own input.
    const m = /^(<=|>=|<|>|=)(.+)$/.exec(part);
    if (!m) return null;
    const bound = parseSemver(m[2]);
    if (!bound) return null;

    const c = compareSemver(v, bound);
    const satisfied: Record<string, boolean> = {
      "<": c < 0,
      "<=": c <= 0,
      ">": c > 0,
      ">=": c >= 0,
      "=": c === 0,
    };
    // Conjunction: one unsatisfied comparator puts the version outside the
    // range, but keep going so an unparseable later part still returns null.
    if (!satisfied[m[1]]) inRange = false;
  }

  return inRange;
}

/**
 * The lowest of `patches` that falls inside NONE of `ranges` — the minimum
 * single version that would clear every one of a package's alerts at once.
 *
 * This is the number issue #2 proposed writing as the override. It is not safe
 * to write (the bounded spec's ceiling anchors on the highest installed copy, so
 * a patch below that copy yields a range still admitting it, and escapes are
 * only detected upward — the CVE would stay live in silence). It is, however,
 * exactly the right number to *compare* against: when it sits below the max, the
 * package is vulnerable on disjoint release lines and the max is forcing someone
 * up further than any advisory requires. The rejected answer makes a sound
 * detector. See findMultiLineAdvisories() in reconcile.ts.
 *
 * Returns null when nothing clears every range, or when any range is
 * unparseable — we only report what we can prove.
 */
export function lowestPatchClearingAll(patches: string[], ranges: string[]): string | null {
  const distinctRanges = [...new Set(ranges)];

  const candidates = [...new Set(patches)]
    .map((p) => ({ raw: p, parsed: parseSemver(p) }))
    .filter((c): c is { raw: string; parsed: [number, number, number] } => c.parsed !== null)
    .sort((a, b) => compareSemver(a.parsed, b.parsed));

  for (const candidate of candidates) {
    let clearsAll = true;
    for (const range of distinctRanges) {
      const hit = satisfiesVulnerableRange(candidate.raw, range);
      if (hit === null) return null; // can't prove anything about this package
      if (hit) {
        clearsAll = false;
        break;
      }
    }
    if (clearsAll) return candidate.raw;
  }

  return null;
}

/**
 * The exclusive upper bound of the caret-compatible range around a version —
 * i.e. the first version that is considered a breaking change from it.
 *
 * Follows npm's caret rules, where the significance of a position depends on
 * the leading zeros:
 *   ^1.2.3 := >=1.2.3 <2.0.0   → breaking at the major
 *   ^0.2.3 := >=0.2.3 <0.3.0   → breaking at the MINOR
 *   ^0.0.3 := >=0.0.3 <0.0.4   → breaking at the PATCH
 *
 * The 0.x rules are the whole reason this is a function rather than `major + 1`.
 * A large share of real transitive alerts sit on 0.x packages, where treating
 * the major as the boundary silently classifies a breaking bump as routine.
 */
export function compatibleCeiling(v: [number, number, number]): [number, number, number] {
  const [major, minor, patch] = v;
  if (major > 0) return [major + 1, 0, 0];
  if (minor > 0) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

/** Render a ceiling tuple as the shortest valid range bound: 8, 0.8, or 0.0.4. */
export function formatCeiling(v: [number, number, number]): string {
  const [major, minor, patch] = v;
  if (major > 0) return `${major}`;
  if (minor > 0) return `0.${minor}`;
  return `0.0.${patch}`;
}

/**
 * True when no in-range fix exists — the earliest patched version falls outside
 * the caret-compatible range of what is currently installed, so clearing the
 * alert necessarily forces the tree across a breaking boundary.
 *
 * This is the bucket that needs flagging rather than silently applying. Such an
 * override installs cleanly: the package manager applies it at the resolution
 * layer, so a dependent's declared range does not veto it — not a caret range,
 * not a peer range, not even an exact pin — and no ERESOLVE is raised. The
 * alert closes because the resolved version is patched. The install is green
 * and the dependent is left calling an API that changed shape underneath it.
 * The failure surfaces at runtime.
 *
 * Note this is about the *breaking* boundary, not the major number: a 0.5.0 →
 * 0.7.0 bump escapes ^0.5.0 and counts, even though the major never moves.
 *
 * Returns false when either version is unparseable — we only flag what we can
 * actually prove escapes the range.
 */
export function escapesCompatibleRange(patchedVersion: string, installedVersion?: string): boolean {
  const patched = parseSemver(patchedVersion);
  const installed = installedVersion ? parseSemver(installedVersion) : null;
  if (!patched || !installed) return false;
  return compareSemver(patched, compatibleCeiling(installed)) >= 0;
}

/**
 * Compute a bounded override spec from a patched version and the currently
 * installed version: a floor at the patch, and a ceiling at the first breaking
 * version above whichever of the two we expect to actually resolve to.
 *
 * Examples:
 *   patchedVersion="7.29.6", installedVersion="7.29.0" → ">=7.29.6 <8"
 *   patchedVersion="5.2.0",  installedVersion="5.1.4"  → ">=5.2.0 <6"
 *   patchedVersion="11.1.1", installedVersion="11.1.1" → ">=11.1.1 <12"
 *   patchedVersion="7.28.0", installedVersion="6.21.0" → ">=7.28.0 <8"
 *   patchedVersion="0.7.0",  installedVersion="0.5.0"  → ">=0.7.0 <0.8"
 *
 * The ceiling anchors on the HIGHER of patched and installed, for two reasons:
 * when the only fix lives above the installed version, the ceiling must clear
 * the patched floor — otherwise we'd emit an impossible empty range like
 * ">=7.28.0 <7". And when the installed version is already above the patch, the
 * ceiling must clear the installed version so the spec doesn't force a
 * pointless downgrade.
 *
 * The ceiling can never exclude the floor, because the floor is itself a
 * published version and always sits inside its own compatible range — so this
 * cannot produce an unsatisfiable spec (an ETARGET at install).
 *
 * If neither version is parseable, falls back to an unbounded ">=", which is
 * still safe.
 */
export function computeBoundedSpec(patchedVersion: string, installedVersion?: string): string {
  const patched = parseSemver(patchedVersion);
  const installed = installedVersion ? parseSemver(installedVersion) : null;
  if (!patched && !installed) return `>=${patchedVersion}`;

  let anchor = patched ?? installed!;
  if (patched && installed && compareSemver(installed, patched) > 0) anchor = installed;

  return `>=${patchedVersion} <${formatCeiling(compatibleCeiling(anchor))}`;
}
