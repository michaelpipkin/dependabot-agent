import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DependentRange, DeploymentRecommendation, InstalledTree, TreeNode } from "../types.js";
import { addUnique, exitWithError, log, shell } from "../util.js";
import { fetchDependentRanges } from "../registry.js";
import { PackageManager, RunContext } from "./types.js";

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

function readDirectDeps(cwd: string): Set<string> {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    return new Set([...Object.keys(deps), ...Object.keys(devDeps)]);
  } catch {
    return new Set();
  }
}

export class NpmPackageManager implements PackageManager {
  readonly id = "npm" as const;

  constructor(private readonly ctx: RunContext) {}

  update(cwd: string, alertedPackages: string[]): void {
    if (this.ctx.dryRun) {
      log("⏭️  Skipping npm update (dry run).");
      return;
    }
    if (this.ctx.skipUpdate) {
      log("⏭️  Skipping npm update (skip-update).");
      return;
    }

    try {
      if (this.ctx.updateStrategy === "latest") {
        // npm has no `update --latest`; install the alerted *direct* deps at
        // @latest so we cross majors only for packages that actually have alerts.
        const direct = readDirectDeps(cwd);
        const targets = alertedPackages.filter((name) => direct.has(name));
        if (targets.length === 0) {
          log(`📦 No alerted direct dependencies to update at @latest in ${cwd}.`);
          return;
        }
        const specs = targets.map((n) => `${n}@latest`).join(" ");
        log(`📦 Running npm install ${specs} in ${cwd}...`);
        execSync(`npm install ${specs}`, { cwd, stdio: "inherit" });
      } else {
        log(`📦 Running npm update --save in ${cwd}...`);
        execSync("npm update --save", { cwd, stdio: "inherit" });
      }
      log("   npm update complete.");
    } catch (e) {
      exitWithError(`npm update failed: ${(e as Error).message}`);
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
