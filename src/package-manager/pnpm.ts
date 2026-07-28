import { execSync } from "node:child_process";
import { DirectDep, readDirectDependencies } from "../manifest.js";
import { fetchDependentRanges } from "../registry.js";
import { DependentRange, DeploymentRecommendation, InstalledTree, TreeNode, UpdateStrategy } from "../types.js";
import { addUnique, exitWithError, log, shell } from "../util.js";
import { readPnpmIgnoredDependencies } from "../workspace.js";
import { PackageManager, RunContext } from "./types.js";
import { exactlyPinnedDeps, logHeldPins, logPrereleaseRollback, rejectAdoptedPrereleases } from "./update-guards.js";

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

/**
 * Parse the JSON from `pnpm list -r --json` into the agent's InstalledTree[].
 * Pure and separate from the shell call so captured real output can be replayed
 * in tests — a change to pnpm's output shape surfaces here. Each array element is
 * one workspace project; findInstalledVersions() walks them all.
 */
export function parsePnpmListOutput(raw: string): InstalledTree[] {
  const parsed: PnpmListOutput[] = JSON.parse(raw);
  return parsed.map((ws) => ({
    name: ws.name,
    version: ws.version,
    path: ws.path,
    dependencies: normalizeEntries(ws.dependencies),
    devDependencies: normalizeEntries(ws.devDependencies),
  }));
}

/**
 * The pnpm update command for a strategy, excluding both the exactly-pinned
 * dependencies and everything pnpm's own `updateConfig.ignoreDependencies`
 * holds back.
 *
 * `pnpm update` takes package patterns, and a `!name` pattern means "update
 * everything EXCEPT this". A pattern list made only of negations therefore still
 * updates the rest of the manifest — which is what makes this usable as a pin
 * guard, rather than an allow-list that would have to be kept exhaustive to
 * avoid quietly freezing the whole project.
 *
 * `ignored` has to be folded in because passing ANY pattern makes pnpm stop
 * applying ignoreDependencies. Re-supplying that list as patterns restores it;
 * omitting it would mean a project that adds one exact pin silently loses every
 * hold-back it had configured. Both lists are just patterns to pnpm, so globs
 * (`@babel/*`) carry over unchanged.
 *
 * With nothing to exclude the command stays bare — which matters, since that is
 * the only form under which pnpm applies ignoreDependencies itself.
 *
 * Patterns are quoted so every shell hands the `!` through untouched.
 */
export function pnpmUpdateCommand(strategy: UpdateStrategy, pinned: DirectDep[], ignored: string[] = []): string {
  const base = strategy === "latest" ? "pnpm update --latest" : "pnpm update";
  if (pinned.length === 0) return base;

  const patterns = [...new Set([...pinned.map((p) => p.name), ...ignored])];
  const quoted = patterns.map((p) => '"!' + p + '"').join(" ");
  return `${base} ${quoted}`;
}

export class PnpmPackageManager implements PackageManager {
  readonly id = "pnpm" as const;

  constructor(private readonly ctx: RunContext) {}

  async update(cwd: string, alertedPackages: string[]): Promise<void> {
    if (this.ctx.dryRun) {
      log("⏭️  Skipping pnpm update (dry run).");
      return;
    }
    if (this.ctx.skipUpdate) {
      log("⏭️  Skipping pnpm update (skip-update).");
      return;
    }

    const before = readDirectDependencies(cwd);
    const pinned = exactlyPinnedDeps(before);
    logHeldPins(pinned, alertedPackages);

    const ignored = pinned.length > 0 ? readPnpmIgnoredDependencies(cwd) : [];
    if (ignored.length > 0) {
      log(`   🔁 Carrying pnpm's updateConfig.ignoreDependencies through as patterns: ${ignored.join(", ")}`);
    }
    const cmd = pnpmUpdateCommand(this.ctx.updateStrategy, pinned, ignored);
    log(`📦 Running ${cmd} in ${cwd}...`);
    try {
      // stdio: "inherit" streams pnpm output to the terminal.
      execSync(cmd, { cwd, stdio: "inherit" });
      log("   pnpm update complete.");
    } catch (e) {
      exitWithError(`pnpm update failed: ${(e as Error).message}`);
    }

    const rollback = this.ctx.allowPrerelease ? null : await rejectAdoptedPrereleases(cwd, before);
    if (rollback) logPrereleaseRollback(rollback);

    // A rollback is the stronger reason but the same repair, so it wins the
    // message and only one install runs either way.
    if (rollback && rollback.applied.length > 0) this.resyncLockfile(cwd, "the pre-release rollback");
    else if (pinned.length > 0) this.resyncLockfile(cwd, "the held pins");
  }

  /**
   * Re-resolve so the lockfile agrees with the manifest the run is leaving
   * behind. Needed on two paths, both of which end with a manifest the previous
   * command's resolution no longer matches:
   *
   *   - a pre-release rollback, where the update wrote the pre-release into the
   *     lockfile and only the manifest has been corrected since;
   *   - held exact pins, because `pnpm update --latest` applies its exclusion
   *     patterns to the manifest rewrite but not to resolution when it has no
   *     lockfile to start from. A directory reached with no lockfile of its own —
   *     an explicitly-configured `packages` entry inheriting the root's package
   *     manager — otherwise ends up recording `specifier: 1.0.0, version: 3.0.1`,
   *     with the pin honored on paper and violated in the tree.
   *
   * A plain install is the repair in both cases: it resolves from the manifest,
   * which is the copy that is now correct. Cheap when nothing is wrong.
   */
  private resyncLockfile(cwd: string, reason: string): void {
    log(`📦 Re-resolving the lockfile against ${reason} in ${cwd}...`);
    try {
      execSync("pnpm install --no-frozen-lockfile", { cwd, stdio: "inherit" });
    } catch (e) {
      exitWithError(`pnpm install failed while re-resolving against ${reason}: ${(e as Error).message}`);
    }
  }

  getInstalledTree(cwd: string): InstalledTree[] {
    log(`🔍 Reading installed dependency tree (pnpm) in ${cwd}...`);
    // -r lists every project in the workspace, not just the one in cwd. Without
    // it, a dependency declared only in a `packages/*` member of a shared-lockfile
    // workspace is invisible at the root, so its vulnerable copies are never found
    // and no override is written. The return is already an array of workspace
    // projects, and findInstalledVersions() already walks all of them, so -r just
    // fills in the members. For a single, non-workspace project it returns the
    // same one-element array as before.
    const raw = shell(
      "pnpm list -r --json --depth=Infinity",
      { cwd, maxBuffer: 64 * 1024 * 1024 }, // 64MB — large monorepos can exceed the 1MB default
    );
    return parsePnpmListOutput(raw);
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
          // Skipping `deduped` nodes is a safe optimization, not a correctness gate.
          // pnpm prints a subtree in full at its FIRST occurrence and marks every
          // later one `deduped`, so a deduped node's name@version always has a
          // non-deduped occurrence elsewhere in the same output — and this Map is
          // keyed by name@version, so including deduped nodes would add nothing.
          // Deduped nodes also carry no `dependents`, so there is no subtree lost by
          // not recursing. Verified against real `pnpm why --json` (pnpm 10): deduped
          // nodes carry both name and version and no children, and every one had a
          // canonical full occurrence. So a dependent appearing ONLY deduped can't
          // arise, and the orphan check can't be starved of a range this way.
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
