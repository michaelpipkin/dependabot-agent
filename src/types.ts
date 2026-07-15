// ---------------------------------------------------------------------------
// Shared types — package-manager independent
// ---------------------------------------------------------------------------

export interface DependabotAlert {
  number: number;
  state: "open" | "dismissed" | "fixed" | "auto_dismissed";
  dependency: {
    package: { ecosystem: string; name: string };
    manifest_path: string;
  };
  security_advisory: {
    summary: string;
    severity: "low" | "medium" | "high" | "critical";
    vulnerabilities: Array<{
      package: { ecosystem: string; name: string };
      vulnerable_version_range: string; // e.g. ">= 1.0.0, < 1.2.3"
      first_patched_version: { identifier: string } | null;
    }>;
  };
  security_vulnerability: {
    package: { ecosystem: string; name: string };
    vulnerable_version_range: string;
    first_patched_version: { identifier: string } | null;
  };
}

// ---------------------------------------------------------------------------
// Normalized installed-tree shape — produced by every PackageManager so the
// rest of the agent never sees pnpm- or npm-specific JSON. Consumers only read
// `version` and the nested children, so the node is intentionally minimal.
// ---------------------------------------------------------------------------

export interface TreeNode {
  name: string;
  version: string;
  dependencies?: Record<string, TreeNode>; // transitive children
}

export interface InstalledTree {
  name: string;
  version: string;
  path: string;
  dependencies?: Record<string, TreeNode>;
  devDependencies?: Record<string, TreeNode>;
}

// ---------------------------------------------------------------------------
// Reconciliation types
// ---------------------------------------------------------------------------

export interface VulnerablePackage {
  name: string;
  installedVersion: string;
  patchedVersion: string; // minimum safe version
  severity: string;
  foundInParents: string[]; // dependency chain that brought this in
  alertNumber: number;
}

export interface OverrideChange {
  packageName: string;
  action: "add" | "update" | "remove";
  oldVersion?: string;
  newVersion?: string;
  reason: string;
  /**
   * Set when no in-range fix exists — the patched version falls outside the
   * caret-compatible range of what is installed, so this override forces the
   * tree across a breaking boundary. The install will still succeed; the risk
   * is a runtime break in the dependents that requested the old range. See
   * escapesCompatibleRange() in semver.ts.
   */
  noInRangeFix?: boolean;
  /** Installed version at the time the change was computed — context for the warning. */
  installedVersion?: string;
}

/**
 * One dependent of an overridden package, with the ranges it declares for that
 * package at two points: the version installed in this tree, and the latest
 * published version.
 *
 * The two answer different questions and are deliberately both kept:
 *   - latestRange    — "has upstream moved on?" Decides whether an override
 *                      with no open alert can be dropped, since after an update
 *                      you resolve to the latest dependents anyway.
 *   - installedRange — "what does the tree I actually have ask for?" Decides
 *                      whether an override is forcing a real dependent past its
 *                      declared range.
 *
 * Either may be null when the registry has no manifest for that version or the
 * dependent declares no range on the target.
 */
export interface DependentRange {
  dependent: string;
  version: string; // the dependent's INSTALLED version
  installedRange: string | null;
  latestRange: string | null;
}

/** A dependent an override forces past the range it declares. */
export interface EscapingDependent {
  name: string;
  version: string;
  range: string;
  /** Which range this was judged against — "latest" means installedRange was unavailable. */
  source: "installed" | "latest";
}

/**
 * An override already in place, with no open alert, that forces its dependents
 * past the range they declare. Same "no in-range fix" condition as the
 * noInRangeFix flag on OverrideChange, reached the other way: there is no alert
 * driving it, so it produces no OverrideChange and would otherwise be reported
 * as a routine still-load-bearing override.
 */
export interface OrphanEscape {
  packageName: string;
  spec: string; // the full override spec, e.g. ">=11.1.1"
  floor: string; // the spec's floor, e.g. "11.1.1"
  dependents: EscapingDependent[];
}

// ---------------------------------------------------------------------------
// Deployment-impact analysis
// ---------------------------------------------------------------------------

export type DepScope = "production" | "dev" | "unknown";

export interface DeploymentRecommendation {
  packageName: string;
  scope: DepScope;
  productionPaths: string[]; // root dep names that are production
  devPaths: string[]; // root dep names that are dev-only
}

// ---------------------------------------------------------------------------
// Run-wide configuration
// ---------------------------------------------------------------------------

export type PackageManagerId = "pnpm" | "npm";
export type UpdateStrategy = "compatible" | "latest";
