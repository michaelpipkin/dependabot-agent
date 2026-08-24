import { execSync } from "node:child_process";
import * as path from "node:path";
import { DependentRange, DeploymentRecommendation, InstalledTree, TreeNode } from "../types.js";
import { addUnique, exitWithError, log, shell } from "../util.js";
import { readDirectDependencies } from "../manifest.js";
import { fetchDependentRanges } from "../registry.js";
import { listWorkspaceMemberDirs } from "../workspace.js";
import { PackageManager, RunContext } from "./types.js";
import {
  ManifestScope,
  PinnedSpec,
  PrereleaseScope,
  collectPinnedSpecs,
  exactlyPinnedDeps,
  logHeldPins,
  logPrereleaseRollback,
  rejectAdoptedPrereleasesAcross,
} from "./update-guards.js";

// Raw shape npm emits from `npm ls --all --json`. All deps (prod + dev) appear
// together under `dependencies` at the root; there is no separate dev section.
interface NpmLsNode {
  version?: string;
  resolved?: string;
  overridden?: boolean;
  dependencies?: Record<string, NpmLsNode>;
}

interface NpmLsRoot {
  name: string;
  version?: string;
  dependencies?: Record<string, NpmLsNode>;
}

// Raw shape npm emits from `npm explain <pkg> --json`: an array of explained
// nodes. Each `dependents` edge describes "from depends on (name@spec) as type".
interface NpmExplainEdge {
  type?: string; // "prod" | "dev" | "peer" | "optional"
  name: string; // the dependency this edge points to
  spec?: string; // requested version range
  from?: NpmExplainNode; // the package that requires it
}

interface NpmExplainNode {
  name?: string;
  version?: string;
  location?: string; // "" for the root project
  dependents?: NpmExplainEdge[];
}

function normalizeNodes(deps: Record<string, NpmLsNode> | undefined): Record<string, TreeNode> | undefined {
  if (!deps) return undefined;
  const out: Record<string, TreeNode> = {};
  for (const [name, node] of Object.entries(deps)) {
    if (!node.version) continue; // skip missing/invalid placeholders
    out[name] = { name, version: node.version, dependencies: normalizeNodes(node.dependencies) };
  }
  return out;
}

/**
 * Parse the JSON from `npm ls --all --json` into the agent's InstalledTree[].
 * Pure and separate from the shell call so captured real output can be replayed
 * in tests — a change to npm's output shape surfaces here. npm returns a single
 * root object (all deps under `dependencies`, no dev split); it is wrapped into
 * the one-element array shape the rest of the agent expects.
 */
export function parseNpmLsOutput(raw: string, cwd: string): InstalledTree[] {
  const root: NpmLsRoot = JSON.parse(raw);
  return [
    {
      name: root.name,
      version: root.version ?? "",
      path: cwd,
      dependencies: normalizeNodes(root.dependencies),
      devDependencies: undefined,
    },
  ];
}

/**
 * Run an npm command that prints JSON but may exit non-zero (e.g. `npm ls`
 * exits 1 on extraneous/peer/missing problems while still emitting valid JSON
 * on stdout). Returns stdout regardless of exit code; throws only if there is
 * no usable stdout at all.
 */
function npmJson(cmd: string, cwd: string): string {
  // Pipe stderr instead of letting it inherit the console. `npm ls` prints an
  // ELSPROBLEMS block ("invalid: pkg@x") whenever an override forces a copy out
  // of its declared range — which is the normal steady state for a repo using
  // this tool, not a failure. We read the JSON it still emits on stdout; a real
  // failure surfaces below when there's no usable stdout to fall back on.
  try {
    return shell(cmd, { cwd, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const stdout = (e as { stdout?: Buffer | string }).stdout;
    if (stdout?.toString().trim()) {
      log(`   (npm flags override-forced copies as "invalid" — expected; reading the tree anyway.)`);
      return stdout.toString();
    }
    throw e;
  }
}

export class NpmPackageManager implements PackageManager {
  readonly id = "npm" as const;

  constructor(private readonly ctx: RunContext) {}

  async update(cwd: string, alertedPackages: string[]): Promise<void> {
    if (this.ctx.dryRun) {
      log("⏭️  Skipping npm update (dry run).");
      return;
    }
    if (this.ctx.skipUpdate) {
      log("⏭️  Skipping npm update (skip-update).");
      return;
    }

    const scopes = this.manifestScopes(cwd);
    if (scopes.length > 1) {
      log(`   🗂️  Including ${scopes.length - 1} workspace member(s) in the update pass.`);
    }

    // Snapshot every manifest the command is about to rewrite, before it runs.
    const snapshots: PrereleaseScope[] = scopes.map((s) => ({ ...s, before: readDirectDependencies(s.dir) }));
    const pinned: PinnedSpec[] = collectPinnedSpecs(scopes);
    logHeldPins(pinned, alertedPackages);

    if (!this.runUpdate(cwd, alertedPackages, snapshots)) return;

    if (this.ctx.allowPrerelease) return;
    const rollback = await rejectAdoptedPrereleasesAcross(snapshots);
    logPrereleaseRollback(rollback);
    if (rollback.applied.length > 0) this.resyncLockfile(cwd);
  }

  /**
   * Every manifest this run's update pass will rewrite — the root, plus each
   * workspace member when members are in scope. npm has no catalogs, so unlike
   * pnpm this is the complete list of places a version can be declared.
   */
  private manifestScopes(cwd: string): ManifestScope[] {
    const root: ManifestScope = { dir: cwd, label: "." };
    if (!this.ctx.updateWorkspaceMembers) return [root];

    const members = listWorkspaceMemberDirs(cwd, "npm").map((dir) => ({
      dir,
      label: path.relative(cwd, dir).replace(/\\/g, "/") || ".",
    }));
    return [root, ...members];
  }

  /**
   * Run the update itself. Returns false when there was nothing to do, so the
   * caller can skip the pre-release check rather than re-reading a manifest
   * no command touched.
   *
   * npm has no per-package exclusion for `npm update`, but it doesn't need one:
   * an exact specifier is a range of one, so `npm update --save` cannot move it.
   * That holds in a workspace member exactly as it does at the root, which is
   * why the recursive form needs no extra pin handling. The `latest` path
   * installs named packages outright and *would* overwrite a pin, so pins are
   * filtered out of its target list — per scope, since a package frozen in one
   * member says nothing about what another member wants.
   */
  private runUpdate(cwd: string, alertedPackages: string[], snapshots: PrereleaseScope[]): boolean {
    const recursive = snapshots.length > 1;
    try {
      if (this.ctx.updateStrategy === "latest") {
        // npm has no `update --latest`; install the alerted *direct* deps at
        // @latest so we cross majors only for packages that actually have alerts.
        // One command per manifest: `-w <path>` scopes the install to a single
        // member, and passing --workspaces instead would ADD the package to
        // members that never declared it.
        let ran = false;
        for (const scope of snapshots) {
          const direct = new Set(scope.before.map((d) => d.name));
          const pinnedHere = new Set(exactlyPinnedDeps(scope.before).map((d) => d.name));
          const targets = alertedPackages.filter((name) => direct.has(name) && !pinnedHere.has(name));
          if (targets.length === 0) continue;

          const specs = targets.map((n) => `${n}@latest`).join(" ");
          const where = scope.label === "." ? "" : ` -w ${scope.label}`;
          log(`📦 Running npm install ${specs}${where} in ${cwd}...`);
          execSync(`npm install ${specs}${where}`, { cwd, stdio: "inherit" });
          ran = true;
        }
        if (!ran) {
          log(`📦 No alerted direct dependencies to update at @latest in ${cwd}.`);
          return false;
        }
      } else {
        // --workspaces alone would skip the root, which is a manifest like any
        // other here, so the root is opted back in explicitly.
        const across = recursive ? " --workspaces --include-workspace-root" : "";
        log(`📦 Running npm update --save${across} in ${cwd}...`);
        execSync(`npm update --save${across}`, { cwd, stdio: "inherit" });
      }
      log("   npm update complete.");
      return true;
    } catch (e) {
      exitWithError(`npm update failed: ${(e as Error).message}`);
    }
  }

  /**
   * Re-resolve after a pre-release rollback. The update already wrote the
   * pre-release into package-lock.json; correcting the manifest alone would
   * leave the two disagreeing, and the tree read next would still be the one we
   * rejected.
   */
  private resyncLockfile(cwd: string): void {
    log(`📦 Re-resolving package-lock.json after the pre-release rollback in ${cwd}...`);
    try {
      execSync("npm install", { cwd, stdio: "inherit" });
    } catch (e) {
      exitWithError(`npm install failed after the pre-release rollback: ${(e as Error).message}`);
    }
  }

  getInstalledTree(cwd: string): InstalledTree[] {
    log(`🔍 Reading installed dependency tree (npm) in ${cwd}...`);
    const raw = npmJson("npm ls --all --json", cwd);
    return parseNpmLsOutput(raw, cwd);
  }

  async collectDependentRanges(packageName: string, cwd: string): Promise<DependentRange[]> {
    try {
      const raw = npmJson(`npm explain ${packageName} --json`, cwd);
      const nodes = JSON.parse(raw) as NpmExplainNode[];

      // Collect every package that requires something along each chain (walking
      // `from` up toward the root). Only direct dependents of the target
      // actually declare a range on it; the rest resolve to null and drop out.
      // Keyed by name@version — the same dependent can appear at more than one
      // version, and they may declare different ranges.
      const dependents = new Map<string, { name: string; version: string }>();
      function walk(edges: NpmExplainEdge[] | undefined): void {
        if (!edges) return;
        for (const edge of edges) {
          const from = edge.from;
          if (from?.name && from.version && from.location !== "") {
            dependents.set(`${from.name}@${from.version}`, { name: from.name, version: from.version });
          }
          if (from?.dependents) walk(from.dependents);
        }
      }
      for (const node of nodes) walk(node.dependents);

      const results = await Promise.all(
        [...dependents.values()].map(async ({ name, version }) => {
          const ranges = await fetchDependentRanges(name, version, packageName);
          return { dependent: name, version, ...ranges };
        }),
      );
      return results.filter((r) => r.installedRange !== null || r.latestRange !== null);
    } catch {
      return [];
    }
  }

  analyseDeploymentImpact(packageName: string, cwd: string): DeploymentRecommendation {
    try {
      const raw = npmJson(`npm explain ${packageName} --json`, cwd);
      const nodes = JSON.parse(raw) as NpmExplainNode[];

      const productionPaths: string[] = [];
      const devPaths: string[] = [];

      function isRoot(node: NpmExplainNode | undefined): boolean {
        return !node || !node.dependents || node.dependents.length === 0 || node.location === "";
      }

      // Walk up each chain; the edge whose `from` is the root project tells us
      // whether the root depends on this subtree via a prod or dev dependency,
      // and `edge.name` is the root's direct dependency on that path.
      function walk(edges: NpmExplainEdge[] | undefined): void {
        if (!edges) return;
        for (const edge of edges) {
          if (isRoot(edge.from)) {
            if (edge.type === "dev") addUnique(devPaths, edge.name);
            else if (edge.type === "peer" || edge.type === "optional") {
              /* peers/optionals are not a deploy signal — ignore */
            } else addUnique(productionPaths, edge.name); // prod (or unspecified) → production
          } else {
            walk(edge.from?.dependents);
          }
        }
      }
      for (const node of nodes) walk(node.dependents);

      const devPath = devPaths.length > 0 ? "dev" : "unknown";
      const scope = productionPaths.length > 0 ? "production" : devPath;
      return { packageName, scope, productionPaths, devPaths };
    } catch {
      return { packageName, scope: "unknown", productionPaths: [], devPaths: [] };
    }
  }
}
