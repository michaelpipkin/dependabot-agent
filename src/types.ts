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
