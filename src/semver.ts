// ---------------------------------------------------------------------------
// Semver helpers  (no external deps — keeps the agent self-contained)
// ---------------------------------------------------------------------------

/**
 * Parse a semver string into a [major, minor, patch] tuple, ignoring
 * pre-release. Returns null for anything that isn't a plain dotted version, so
 * callers can fall back to their conservative branch.
 *
 * Segments are validated as digit strings rather than passed through Number():
 * Number("") is 0, not NaN, so a bare "" or a "1..3" would otherwise parse as a
 * real version instead of being rejected.
 */
export function parseSemver(version: string): [number, number, number] | null {
  const clean = version
    .replace(/^[~^>=<\s]+/, "")
    .split("-")[0] // strip range prefix & pre-release
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
