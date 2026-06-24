// ---------------------------------------------------------------------------
// Semver helpers  (no external deps — keeps the agent self-contained)
// ---------------------------------------------------------------------------

/** Parse a semver string into [major, minor, patch] numeric tuple, ignoring pre-release. */
export function parseSemver(version: string): [number, number, number] | null {
  const clean = version.replace(/^[~^>=<\s]+/, "").split("-")[0]; // strip range prefix & pre-release
  const parts = clean.split(".").map(Number);
  if (parts.length < 1 || parts.some(Number.isNaN)) return null;
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
 * Compute a major-bounded override spec from a patched version and the
 * currently installed version.
 *
 * Examples:
 *   patchedVersion="7.29.6", installedVersion="7.29.0" → ">=7.29.6 <8"
 *   patchedVersion="5.2.0",  installedVersion="5.1.4"  → ">=5.2.0 <6"
 *   patchedVersion="11.1.1", installedVersion="11.1.1" → ">=11.1.1 <12"
 *   patchedVersion="7.28.0", installedVersion="6.21.0" → ">=7.28.0 <8"
 *
 * The upper bound uses the higher of the installed and patched majors, plus one.
 * Normally these majors are equal; when the only fix lives in a newer major than
 * what is installed (a cross-major patch), the ceiling must clear the patched
 * floor — otherwise we'd emit an impossible empty range like ">=7.28.0 <7".
 *
 * If we can't determine either major (package not in tree, unparseable patch),
 * falls back to an unbounded ">=", which is still safe.
 */
export function computeBoundedSpec(patchedVersion: string, installedVersion?: string): string {
  const patchedParsed = parseSemver(patchedVersion);
  const installedParsed = installedVersion ? parseSemver(installedVersion) : null;
  const baseMajor = Math.max(patchedParsed?.[0] ?? 0, installedParsed?.[0] ?? 0);
  const nextMajor = patchedParsed || installedParsed ? baseMajor + 1 : null;
  return nextMajor === null ? `>=${patchedVersion}` : `>=${patchedVersion} <${nextMajor}`;
}
