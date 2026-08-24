import {
  DependentRange,
  DeploymentRecommendation,
  InstalledTree,
  PackageManagerId,
  UpdateStrategy,
} from "../types.js";

/**
 * Run-wide context shared with package managers. Replaces the module-level
 * flag globals the single-file version used.
 */
export interface RunContext {
  dryRun: boolean;
  skipUpdate: boolean;
  updateStrategy: UpdateStrategy;
  /**
   * Whether the update pass may leave a project on a pre-release. Off by
   * default: `update --latest` follows the `latest` dist-tag, and a maintainer
   * who publishes a release candidate without `--tag` points that tag at the
   * pre-release, so following it is not evidence anyone intended to.
   */
  allowPrerelease: boolean;
  /**
   * Whether the update pass may rewrite workspace members' manifests (and, on
   * pnpm, the catalog entries they reference) rather than only the root's.
   */
  updateWorkspaceMembers: boolean;
}

/**
 * Abstraction over a package manager (pnpm or npm). Encapsulates every
 * PM-specific shell command and output shape so the rest of the agent works
 * against normalized types only.
 */
export interface PackageManager {
  readonly id: PackageManagerId;

  /**
   * Run the pre-check dependency update for a directory. Honors dryRun/skipUpdate
   * and the configured update strategy, leaves exactly-pinned direct dependencies
   * alone, and (unless allowPrerelease is set) rolls back any pre-release the
   * update adopted.
   *
   * `alertedPackages` is the set of package names with open alerts in this group.
   * The npm "latest" strategy uses it to target only the relevant direct deps;
   * both package managers use it to warn when a held pin is itself alerted.
   *
   * Async because the pre-release rollback resolves replacement versions from
   * the registry.
   */
  update(cwd: string, alertedPackages: string[]): Promise<void>;

  /** Read the installed dependency tree, normalized to InstalledTree[]. */
  getInstalledTree(cwd: string): InstalledTree[];

  /**
   * Find every installed dependent of `packageName` and resolve the range each
   * declares for it — both at the version installed here and at the dependent's
   * latest published version. Used to decide whether an override with no open
   * alert is still load-bearing (latest), and whether it forces a real dependent
   * past its declared range (installed).
   */
  collectDependentRanges(packageName: string, cwd: string): Promise<DependentRange[]>;

  /** Analyse whether a package is reachable from production code. */
  analyseDeploymentImpact(packageName: string, cwd: string): DeploymentRecommendation;
}
