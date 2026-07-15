import { execSync } from "node:child_process";
import { DependentRange, DeploymentRecommendation, InstalledTree, TreeNode } from "../types.js";
import { addUnique, exitWithError, log, shell } from "../util.js";
import { fetchDependentRanges } from "../registry.js";
import { PackageManager, RunContext } from "./types.js";

// Raw shape pnpm emits from `pnpm list --json` (we normalize away from this).
interface PnpmListEntry {
  version: string;
  resolved?: string;
  dependencies?: Record<string, PnpmListEntry>;
}

interface PnpmListOutput {
  name: string;
  version: string;
  path: string;
  dependencies?: Record<string, PnpmListEntry>;
  devDependencies?: Record<string, PnpmListEntry>;
}

interface PnpmWhyDependent {
  name: string;
  version: string;
  deduped?: boolean;
  depField?: string;
  peersSuffixHash?: string;
  dependents?: PnpmWhyDependent[];
}

interface PnpmWhyEntry {
  name: string;
  version: string;
  path: string;
  dependents: PnpmWhyDependent[];
}

function normalizeEntries(deps: Record<string, PnpmListEntry> | undefined): Record<string, TreeNode> | undefined {
  if (!deps) return undefined;
  const out: Record<string, TreeNode> = {};
  for (const [name, entry] of Object.entries(deps)) {
    out[name] = { name, version: entry.version, dependencies: normalizeEntries(entry.dependencies) };
  }
  return out;
}

export class PnpmPackageManager implements PackageManager {
  readonly id = "pnpm" as const;

  constructor(private readonly ctx: RunContext) {}

  update(cwd: string): void {
    if (this.ctx.dryRun) {
      log("⏭️  Skipping pnpm update (dry run).");
      return;
    }
    if (this.ctx.skipUpdate) {
      log("⏭️  Skipping pnpm update (skip-update).");
      return;
    }

    const cmd = this.ctx.updateStrategy === "latest" ? "pnpm update --latest" : "pnpm update";
    log(`📦 Running ${cmd} in ${cwd}...`);
    try {
      // stdio: "inherit" streams pnpm output to the terminal.
      execSync(cmd, { cwd, stdio: "inherit" });
      log("   pnpm update complete.");
    } catch (e) {
      exitWithError(`pnpm update failed: ${(e as Error).message}`);
    }
  }

  getInstalledTree(cwd: string): InstalledTree[] {
    log(`🔍 Reading installed dependency tree (pnpm) in ${cwd}...`);
    const raw = shell(
      "pnpm list --json --depth=Infinity",
      { cwd, maxBuffer: 64 * 1024 * 1024 }, // 64MB — large monorepos can exceed the 1MB default
    );
    const parsed: PnpmListOutput[] = JSON.parse(raw);
    return parsed.map((ws) => ({
      name: ws.name,
      version: ws.version,
      path: ws.path,
      dependencies: normalizeEntries(ws.dependencies),
      devDependencies: normalizeEntries(ws.devDependencies),
    }));
  }

  async collectDependentRanges(packageName: string, cwd: string): Promise<DependentRange[]> {
    try {
      const raw = shell(`pnpm why ${packageName} --json`, { cwd, maxBuffer: 16 * 1024 * 1024 });
      const entries = JSON.parse(raw) as PnpmWhyEntry[];

      // Key by name@version, not name: the same dependent can appear at more
      // than one version in a tree, and they may declare different ranges.
      const dependents = new Map<string, { name: string; version: string }>();
      function collectDependents(deps: PnpmWhyDependent[]): void {
        for (const dep of deps) {
          if (!dep.deduped) dependents.set(`${dep.name}@${dep.version}`, { name: dep.name, version: dep.version });
          if (dep.dependents) collectDependents(dep.dependents);
        }
      }
      for (const entry of entries) collectDependents(entry.dependents);

      const results = await Promise.all(
        [...dependents.values()].map(async ({ name, version }) => {
          const ranges = await fetchDependentRanges(name, version, packageName);
          return { dependent: name, version, ...ranges };
        }),
      );
      // Drop dependents that declare nothing usable at either version.
      return results.filter((r) => r.installedRange !== null || r.latestRange !== null);
    } catch {
      return [];
    }
  }

  analyseDeploymentImpact(packageName: string, cwd: string): DeploymentRecommendation {
    try {
      const raw = shell(`pnpm why ${packageName} --json`, { cwd, maxBuffer: 16 * 1024 * 1024 });
      const entries = JSON.parse(raw) as PnpmWhyEntry[];

      const productionPaths: string[] = [];
      const devPaths: string[] = [];

      function recordRootEntry(dep: PnpmWhyDependent, pathLabel: string): void {
        if (dep.depField === "dependencies") {
          addUnique(productionPaths, pathLabel);
        } else if (dep.depField === "devDependencies") {
          addUnique(devPaths, pathLabel);
        }
      }

      // Walk up each chain from the target toward the root project. The node
      // carrying depField IS the root project — it says how the root reached
      // this chain — so the useful label is the node one level below it: the
      // root's own direct dependency. pathLabel latches the first level walked
      // and carries it down, which is why it must start empty. Seeding it with
      // entry.name (the package being queried) made `pathLabel ||` dead code
      // and labelled every path with the target's own name: "tar — via: tar".
      function walkDependents(deps: PnpmWhyDependent[], pathLabel: string): void {
        for (const dep of deps) {
          if (dep.deduped) continue;
          if (dep.depField) recordRootEntry(dep, pathLabel);
          if (dep.dependents) {
            walkDependents(dep.dependents, pathLabel || `${dep.name}@${dep.version}`);
          }
        }
      }

      for (const entry of entries) walkDependents(entry.dependents, "");

      const devPath = devPaths.length > 0 ? "dev" : "unknown";
      const scope = productionPaths.length > 0 ? "production" : devPath;
      return { packageName, scope, productionPaths, devPaths };
    } catch {
      return { packageName, scope: "unknown", productionPaths: [], devPaths: [] };
    }
  }
}
