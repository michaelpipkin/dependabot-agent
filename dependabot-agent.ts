import * as yaml from "js-yaml";
import { execSync, ExecSyncOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
/**
 * dependabot-agent.ts
 *
 * On-demand agent that:
 *  1. Fetches open Dependabot alerts from GitHub for this repo.
 *  2. Groups alerts by manifest path (e.g. package.json vs functions/package.json).
 *  3. For each group: runs `pnpm update --latest`, walks the installed tree,
 *     and adds/removes pnpm.overrides as needed.
 *  4. Writes overrides to the correct file per group:
 *       - Root manifest   → pnpm-workspace.yaml (or root package.json)
 *       - Isolated folder → that folder's package.json under pnpm.overrides
 *
 * Override location is detected automatically per manifest group:
 *   - Root group + pnpm-workspace.yaml present → overrides in pnpm-workspace.yaml
 *   - Root group, no workspace file            → overrides in package.json
 *   - Non-root group                           → overrides in that folder's package.json
 *
 * Usage:
 *   GITHUB_TOKEN=<token> GITHUB_REPO=owner/repo npx ts-node dependabot-agent.ts
 *
 * Optional env vars:
 *   DRY_RUN=true          — print planned changes without writing any file
 *   SKIP_UPDATE=true      — skip `pnpm update --latest` (useful for testing)
 *   WORKSPACE_ROOT=<path> — path to the workspace root (default: cwd)
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? ""; // "owner/repo"
const DRY_RUN = process.env.DRY_RUN === "true";
const SKIP_UPDATE = process.env.SKIP_UPDATE === "true";
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? process.cwd();

if (!GITHUB_TOKEN) exitWithError("GITHUB_TOKEN env var is required.");
if (!GITHUB_REPO?.includes("/")) exitWithError('GITHUB_REPO env var is required (format: "owner/repo").');

const [REPO_OWNER, REPO_NAME] = GITHUB_REPO.split("/");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DependabotAlert {
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

interface NpmPackageEntry {
  from: string; // the version range the parent requested, e.g. "^9.0.0"
  version: string;
  resolved?: string;
  dependencies?: Record<string, NpmPackageEntry>;
}

interface PnpmListOutput {
  name: string;
  version: string;
  path: string;
  dependencies?: Record<string, NpmPackageEntry>;
  devDependencies?: Record<string, NpmPackageEntry>;
}

interface VulnerablePackage {
  name: string;
  installedVersion: string;
  patchedVersion: string; // minimum safe version
  severity: string;
  foundInParents: string[]; // dependency chain that brought this in
  alertNumber: number;
}

interface OverrideChange {
  packageName: string;
  action: "add" | "update" | "remove";
  oldVersion?: string;
  newVersion?: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Step 1 — Fetch Dependabot alerts
// ---------------------------------------------------------------------------

async function fetchDependabotAlerts(): Promise<DependabotAlert[]> {
  log("📡 Fetching Dependabot alerts from GitHub...");

  const alerts: DependabotAlert[] = [];
  // Cursor-based pagination: GitHub returns a Link header with the next URL
  let nextUrl: string | null =
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/dependabot/alerts?state=open&ecosystem=npm&per_page=100`;

  while (nextUrl) {
    const response: Response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      exitWithError(
        `GitHub API error ${response.status}: ${body}\n\nMake sure your token has the 'security_events' scope and Dependabot alerts are enabled for the repo.`,
      );
    }

    const page_alerts: DependabotAlert[] = await response.json();

    // Only keep npm ecosystem alerts
    alerts.push(...page_alerts.filter((a) => a.dependency.package.ecosystem === "npm"));

    // Parse the Link header for the next cursor URL, e.g.:
    // <https://api.github.com/...&after=cursor123>; rel="next"
    const linkHeader: string = response.headers.get("link") ?? "";
    const nextMatch: RegExpMatchArray | null = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
    nextUrl = nextMatch ? nextMatch[1] : null;
  }

  log(`   Found ${alerts.length} open npm Dependabot alert(s).`);
  return alerts;
}

// ---------------------------------------------------------------------------
// Step 2 — Run pnpm update --latest
// ---------------------------------------------------------------------------

function runPnpmUpdate(cwd: string): void {
  if (DRY_RUN) {
    log("⏭️  Skipping pnpm update (DRY_RUN=true).");
    return;
  }

  if (SKIP_UPDATE) {
    log("⏭️  Skipping pnpm update (SKIP_UPDATE=true).");
    return;
  }

  log(`📦 Running pnpm update --latest in ${cwd}...`);
  try {
    // Use stdio: "inherit" to stream pnpm output to the terminal, but call
    // execSync directly rather than through shell() since inherit mode returns
    // null instead of a string.
    execSync("pnpm update --latest", { cwd, stdio: "inherit" });
    log("   pnpm update complete.");
  } catch (e) {
    exitWithError(`pnpm update failed: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Step 3 — Walk the installed dependency tree
// ---------------------------------------------------------------------------

function getInstalledTree(cwd: string): PnpmListOutput[] {
  log(`🔍 Reading installed dependency tree in ${cwd}...`);
  const raw = shell(
    "pnpm list --json --depth=Infinity",
    { cwd, maxBuffer: 64 * 1024 * 1024 }, // 64MB — large monorepos can exceed the 1MB default
  );
  const parsed: PnpmListOutput[] = JSON.parse(raw);
  return parsed;
}

/**
 * Recursively walk the dependency tree and collect all installed instances of
 * a given package name, along with the chain of parents that introduced it.
 */
function findPackageInTree(
  targetName: string,
  deps: Record<string, NpmPackageEntry> | undefined,
  parentChain: string[] = [],
): Array<{ version: string; parents: string[] }> {
  if (!deps) return [];

  const results: Array<{ version: string; parents: string[] }> = [];

  for (const [name, entry] of Object.entries(deps)) {
    const chain = [...parentChain, `${name}@${entry.version}`];
    if (name === targetName) {
      results.push({ version: entry.version, parents: parentChain });
    }
    // Recurse into this package's own transitive dependencies
    results.push(...findPackageInTree(targetName, entry.dependencies, chain));
  }

  return results;
}

/**
 * Check whether a package appears anywhere in the installed tree at any version.
 * Used to confirm a package is actually present before adding an override for it.
 */
function isPackageInTree(targetName: string, tree: PnpmListOutput[]): boolean {
  for (const workspace of tree) {
    const allDeps = { ...workspace.dependencies, ...workspace.devDependencies };
    const hits = findPackageInTree(targetName, allDeps);
    if (hits.length > 0) return true;
  }
  return false;
}

/**
 * Walk the installed tree and collect every "from" specifier (requested version
 * range) for the target package. These are the ranges that dependents declared
 * in their own package.json — what they *want*, before overrides are applied.
 */
function collectRequestedRanges(targetName: string, deps: Record<string, NpmPackageEntry> | undefined): string[] {
  if (!deps) return [];

  const ranges: string[] = [];
  for (const [name, entry] of Object.entries(deps)) {
    if (name === targetName) {
      ranges.push(entry.from);
    }
    ranges.push(...collectRequestedRanges(targetName, entry.dependencies));
  }
  return ranges;
}

function collectRequestedRangesFromTree(targetName: string, tree: PnpmListOutput[]): string[] {
  const ranges: string[] = [];
  for (const workspace of tree) {
    const allDeps = { ...workspace.dependencies, ...workspace.devDependencies };
    ranges.push(...collectRequestedRanges(targetName, allDeps));
  }
  // Deduplicate
  return [...new Set(ranges)];
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

/**
 * Fetch the latest published version of a package from the npm registry and
 * return the version range it declares for targetPackage.
 *
 * Uses the public npm registry API: https://registry.npmjs.org/<name>/latest
 * This gives us the upstream author's declared dependency — completely
 * unaffected by local pnpm overrides.
 */
async function fetchRegistrySpecifier(dependentName: string, targetPackage: string): Promise<string | null> {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(dependentName)}/latest`;
    const response: Response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;

    const pkg = (await response.json()) as Record<string, unknown>;
    const allDeps: Record<string, string> = {
      ...(pkg.dependencies as Record<string, string>),
      ...(pkg.devDependencies as Record<string, string>),
      ...(pkg.peerDependencies as Record<string, string>),
      ...(pkg.optionalDependencies as Record<string, string>),
    };
    return allDeps[targetPackage] ?? null;
  } catch {
    return null;
  }
}

/**
 * Run `pnpm why <package> --json` to find all packages that depend on it,
 * then fetch each dependent's latest version from the npm registry to get
 * the version range it declares for the target package.
 *
 * Using the registry rather than local node_modules ensures we see the
 * upstream author's declared specifier, not a version that may have been
 * influenced by our own pnpm overrides.
 */
async function collectRangesFromRegistry(packageName: string, cwd: string): Promise<string[]> {
  try {
    const raw = shell(`pnpm why ${packageName} --json`, { cwd, maxBuffer: 16 * 1024 * 1024 });
    const entries = JSON.parse(raw) as PnpmWhyEntry[];

    // Collect all unique dependent package names from the tree
    const dependentNames = new Set<string>();

    function collectDependents(deps: PnpmWhyDependent[]): void {
      for (const dep of deps) {
        if (!dep.deduped) dependentNames.add(dep.name);
        if (dep.dependents) collectDependents(dep.dependents);
      }
    }

    for (const entry of entries) {
      collectDependents(entry.dependents);
    }

    // Fetch each dependent's latest package.json from the npm registry
    const rangeResults = await Promise.all(
      [...dependentNames].map((name) => fetchRegistrySpecifier(name, packageName)),
    );

    return [...new Set(rangeResults.filter((r): r is string => r !== null && r !== "*" && r !== ""))];
  } catch {
    return [];
  }
}

/**
 * Analyse whether a vulnerable package is reachable from production code.
 *
 * Walks the pnpm why --json dependents tree to find every root workspace entry
 * (nodes with a depField). If any root entry has depField "dependencies", the
 * package is in the production dependency graph and a deployment is needed to
 * ship the fix to users. If all root entries are "devDependencies", a branch
 * push alone resolves the Dependabot alert without requiring a new deployment.
 *
 * Returns:
 *   "production" — at least one path leads through a production dep
 *   "dev"        — all paths lead through devDependencies only
 *   "unknown"    — couldn't determine (pnpm why failed or no depField found)
 */
type DepScope = "production" | "dev" | "unknown";

interface DeploymentRecommendation {
  packageName: string;
  scope: DepScope;
  productionPaths: string[]; // root dep names that are production
  devPaths: string[]; // root dep names that are dev-only
}

function analyseDeploymentImpact(packageName: string, cwd: string): DeploymentRecommendation {
  try {
    const raw = shell(`pnpm why ${packageName} --json`, { cwd, maxBuffer: 16 * 1024 * 1024 });
    const entries = JSON.parse(raw) as PnpmWhyEntry[];

    const productionPaths: string[] = [];
    const devPaths: string[] = [];

    // Walk the dependents tree, collecting root workspace entries (those with depField)
    function recordRootEntry(dep: PnpmWhyDependent, pathLabel: string): void {
      if (dep.depField === "dependencies") {
        addUnique(productionPaths, pathLabel);
      } else if (dep.depField === "devDependencies") {
        addUnique(devPaths, pathLabel);
      }
    }

    function walkDependents(deps: PnpmWhyDependent[], pathLabel: string): void {
      for (const dep of deps) {
        if (dep.deduped) continue;
        if (dep.depField) recordRootEntry(dep, pathLabel);
        if (dep.dependents) {
          walkDependents(dep.dependents, pathLabel || `${dep.name}@${dep.version}`);
        }
      }
    }

    for (const entry of entries) {
      walkDependents(entry.dependents, entry.name);
    }

    const devPath = devPaths.length > 0 ? "dev" : "unknown";
    const scope: DepScope = productionPaths.length > 0 ? "production" : devPath;

    return { packageName, scope, productionPaths, devPaths };
  } catch {
    return { packageName, scope: "unknown", productionPaths: [], devPaths: [] };
  }
}

function logDeploymentRecommendation(recommendations: DeploymentRecommendation[]): void {
  if (recommendations.length === 0) return;

  const needsDeploy = recommendations.filter((r) => r.scope === "production");
  const devOnly = recommendations.filter((r) => r.scope === "dev");
  const unknown = recommendations.filter((r) => r.scope === "unknown");

  log("\n🚀 Deployment impact analysis:");

  if (needsDeploy.length > 0) {
    log("   Packages in PRODUCTION dependency graph (deployment recommended):");
    for (const r of needsDeploy) {
      log(`      ⚠️  ${r.packageName} — via: ${r.productionPaths.join(", ")}`);
    }
  }

  if (devOnly.length > 0) {
    log("   Packages in DEV/TEST dependencies only (branch push is sufficient):");
    for (const r of devOnly) {
      log(`      ✅ ${r.packageName} — via: ${r.devPaths.join(", ")}`);
    }
  }

  if (unknown.length > 0) {
    log("   Packages with undetermined scope (review manually):");
    for (const r of unknown) {
      log(`      ❓ ${r.packageName}`);
    }
  }

  log("");
  if (needsDeploy.length > 0) {
    log("   📦 Recommendation: DEPLOY — vulnerable packages are in production code.");
  } else if (devOnly.length > 0) {
    log("   📋 Recommendation: BRANCH PUSH ONLY — all vulnerable packages are dev/test only.");
  } else {
    log("   ❓ Recommendation: REVIEW MANUALLY — could not determine production impact.");
  }
}

// ---------------------------------------------------------------------------
// Semver helpers  (no external deps — keeps the agent self-contained)
// ---------------------------------------------------------------------------

/** Parse a semver string into [major, minor, patch] numeric tuple, ignoring pre-release. */
function parseSemver(version: string): [number, number, number] | null {
  const clean = version.replace(/^[~^>=<\s]+/, "").split("-")[0]; // strip range prefix & pre-release
  const parts = clean.split(".").map(Number);
  if (parts.length < 1 || parts.some(Number.isNaN)) return null;
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
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
function rangeCouldResolveVulnerable(specifier: string, patchedVersion: string): boolean {
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

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Compute a major-bounded override spec from a patched version and the
 * currently installed version.
 *
 * Examples:
 *   patchedVersion="7.29.6", installedVersion="7.29.0" → ">=7.29.6 <8"
 *   patchedVersion="5.2.0",  installedVersion="5.1.4"  → ">=5.2.0 <6"
 *   patchedVersion="11.1.1", installedVersion="11.1.1" → ">=11.1.1 <12"
 *
 * If we can't determine the installed major (package not in tree), falls back
 * to the patched version's own major, which is still safe.
 */
function computeBoundedSpec(patchedVersion: string, installedVersion?: string): string {
  const base = installedVersion ?? patchedVersion;
  const parsed = parseSemver(base);
  const nextMajor = parsed ? parsed[0] + 1 : null;
  return nextMajor === null ? `>=${patchedVersion}` : `>=${patchedVersion} <${nextMajor}`;
}

// ---------------------------------------------------------------------------
// Step 3 continued — Determine which alerts still need overrides
// ---------------------------------------------------------------------------

/**
 * Builds the list of packages that need overrides from open Dependabot alerts.
 *
 * Approach: trust the alert state rather than the installed versions.
 * The installed tree reflects overrides already being applied, so a package
 * that has been overridden will always appear "safe" on disk — checking installed
 * versions produces a false "all clear" and causes the agent to remove overrides
 * that are still necessary.
 *
 * Instead: an open alert means the vulnerability is unresolved as far as GitHub
 * is concerned. We keep the override until GitHub closes the alert. We still
 * check the installed tree to confirm the package is actually present (no point
 * overriding something that isn't in the tree at all), and we use the tree to
 * verify the override is actually doing something useful.
 */
// Only add an override if the package actually exists somewhere in the tree.
// If it's not installed at all, an override does nothing.
// We take the first hit — all instances should be the same version after
// pnpm resolves with any existing overrides applied.
function findInstalledVersion(pkgName: string, tree: PnpmListOutput[]): string {
  for (const workspace of tree) {
    const allDeps = { ...workspace.dependencies, ...workspace.devDependencies };
    const hits = findPackageInTree(pkgName, allDeps);
    if (hits.length > 0) return hits[0].version;
  }
  return "";
}

// Multiple alerts for the same package — keep the highest patched version.
function mergeAlert(
  byName: Map<string, VulnerablePackage>,
  alert: DependabotAlert,
  pkgName: string,
  patchedVersion: string,
  installedVersion: string,
): void {
  const existing = byName.get(pkgName);
  if (!existing) {
    byName.set(pkgName, {
      name: pkgName,
      installedVersion,
      patchedVersion,
      severity: alert.security_advisory.severity,
      foundInParents: [],
      alertNumber: alert.number,
    });
    return;
  }
  const patch1 = parseSemver(existing.patchedVersion);
  const patch2 = parseSemver(patchedVersion);
  if (patch1 && patch2 && compareSemver(patch2, patch1) > 0) {
    byName.set(pkgName, { ...existing, patchedVersion, alertNumber: alert.number });
  }
}

function findVulnerableInstalls(alerts: DependabotAlert[], tree: PnpmListOutput[]): VulnerablePackage[] {
  log("🔎 Determining required overrides from open Dependabot alerts...");

  const byName = new Map<string, VulnerablePackage>();

  for (const alert of alerts) {
    const vuln = alert.security_vulnerability;
    const pkgName = vuln.package.name;
    const patchedVersion = vuln.first_patched_version?.identifier;

    if (!patchedVersion) {
      log(`   ⚠️  Alert #${alert.number} (${pkgName}) has no patched version — skipping override.`);
      continue;
    }

    const installedVersion = findInstalledVersion(pkgName, tree);
    if (!installedVersion) {
      log(`   ℹ️  Alert #${alert.number} (${pkgName}) — package not found in installed tree, skipping.`);
      continue;
    }

    mergeAlert(byName, alert, pkgName, patchedVersion, installedVersion);
  }

  const results = [...byName.values()];
  log(`   Found ${results.length} package(s) still needing overrides.`);
  return results;
}

// ---------------------------------------------------------------------------
// Step 4 — Config source abstraction (package.json vs pnpm-workspace.yaml)
// ---------------------------------------------------------------------------

/**
 * Abstraction over the two possible override locations so the rest of the
 * agent doesn't need to know which file it's dealing with.
 */
interface OverrideSource {
  /** Human-readable label shown in log output */
  label: string;
  /** Absolute path to the file being managed */
  filePath: string;
  /** Current pnpm.overrides contents */
  overrides: Record<string, string>;
  /** Write the supplied overrides back to the source file */
  write(newOverrides: Record<string, string>): void;
}

function detectOverrideSource(): OverrideSource {
  const workspaceYamlPath = path.join(WORKSPACE_ROOT, "pnpm-workspace.yaml");

  if (fs.existsSync(workspaceYamlPath)) {
    log(`   Detected pnpm-workspace.yaml — overrides will be managed there.`);
    return buildWorkspaceYamlSource(workspaceYamlPath);
  }

  const pkgJsonPath = path.join(WORKSPACE_ROOT, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    exitWithError(`Neither pnpm-workspace.yaml nor package.json found in ${WORKSPACE_ROOT}`);
  }

  log(`   No pnpm-workspace.yaml found — overrides will be managed in package.json.`);
  return buildPackageJsonSource(pkgJsonPath);
}

/**
 * Override source for an isolated package folder (e.g. functions/) that is not
 * part of the pnpm workspace. Overrides go in a pnpm-workspace.yaml in that
 * folder — pnpm v9+ no longer reads pnpm.overrides from package.json.
 * If no pnpm-workspace.yaml exists yet, one will be created on first write.
 */
function buildIsolatedPackageJsonSource(folderPath: string): OverrideSource {
  const pkgJsonPath = path.join(folderPath, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    exitWithError(`No package.json found in isolated package folder: ${folderPath}`);
  }
  const workspaceYamlPath = path.join(folderPath, "pnpm-workspace.yaml");
  log(`   Isolated package — overrides will be managed in ${workspaceYamlPath}.`);
  return buildWorkspaceYamlSource(workspaceYamlPath);
}

function buildWorkspaceYamlSource(filePath: string): OverrideSource {
  // File may not exist yet (e.g. first run for an isolated package folder)
  const rawText = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  // js-yaml returns unknown; cast carefully
  const doc = (yaml.load(rawText) ?? {}) as Record<string, unknown>;

  // Determine which overrides location this file is already using:
  //   1. Top-level `overrides:` key  (preferred pnpm-workspace.yaml convention)
  //   2. Nested `pnpm.overrides:`    (also valid, used in older configs)
  // If neither exists yet, default to top-level.
  const hasTopLevel = "overrides" in doc;
  const hasPnpmNested =
    typeof doc.pnpm === "object" && doc.pnpm !== null && "overrides" in (doc.pnpm as Record<string, unknown>);

  const useTopLevel = hasTopLevel || !hasPnpmNested;

  const overrides: Record<string, string> = useTopLevel
    ? ((doc.overrides ?? {}) as Record<string, string>)
    : (((doc.pnpm as Record<string, unknown>).overrides ?? {}) as Record<string, string>);

  log(`   Using ${useTopLevel ? "top-level" : "pnpm.overrides"} section in pnpm-workspace.yaml.`);

  return {
    label: "pnpm-workspace.yaml",
    filePath,
    overrides,
    write(newOverrides: Record<string, string>): void {
      if (useTopLevel) {
        if (Object.keys(newOverrides).length === 0) {
          delete doc.overrides;
        } else {
          doc.overrides = sortObjectKeys(newOverrides);
        }
      } else {
        const pnpm = doc.pnpm as Record<string, unknown>;
        if (Object.keys(newOverrides).length === 0) {
          delete pnpm.overrides;
          if (Object.keys(pnpm).length === 0) delete doc.pnpm;
        } else {
          pnpm.overrides = sortObjectKeys(newOverrides);
        }
      }

      fs.writeFileSync(filePath, yaml.dump(doc, { lineWidth: -1, noRefs: true }), "utf-8");
    },
  };
}

function buildPackageJsonSource(filePath: string): OverrideSource {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  const pnpm = (raw.pnpm ?? {}) as Record<string, unknown>;
  const overrides = (pnpm.overrides ?? {}) as Record<string, string>;

  return {
    label: "package.json",
    filePath,
    overrides,
    write(newOverrides: Record<string, string>): void {
      const pnpmBlock = (raw.pnpm ?? {}) as Record<string, unknown>;

      if (Object.keys(newOverrides).length === 0) {
        delete pnpmBlock.overrides;
      } else {
        pnpmBlock.overrides = sortObjectKeys(newOverrides);
      }

      if (Object.keys(pnpmBlock).length === 0) {
        delete raw.pnpm;
      } else {
        raw.pnpm = pnpmBlock;
      }

      fs.writeFileSync(filePath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    },
  };
}

function computeOverrideChanges(
  currentOverrides: Record<string, string>,
  stillVulnerable: VulnerablePackage[],
  resolvedAlertNames: Set<string>,
): OverrideChange[] {
  const changes: OverrideChange[] = [];
  const neededOverrides = new Map(stillVulnerable.map((v) => [v.name, `>=${v.patchedVersion}`]));

  // Add or update overrides for packages that still need them.
  // We write a major-bounded spec (>=patchedVersion <currentMajor+1) rather
  // than an unbounded >= to prevent the override from jumping to a new major
  // version that may have breaking changes (e.g. @babel/core 7.x -> 8.x).
  for (const [name, versionSpec] of neededOverrides) {
    const pkg = stillVulnerable.find((v) => v.name === name);
    const boundedSpec = computeBoundedSpec(versionSpec, pkg?.installedVersion);
    const existing = currentOverrides[name];
    if (!existing) {
      changes.push({
        packageName: name,
        action: "add",
        newVersion: boundedSpec,
        reason: `Still vulnerable per Dependabot (needs ${boundedSpec})`,
      });
    } else if (existing !== boundedSpec) {
      changes.push({
        packageName: name,
        action: "update",
        oldVersion: existing,
        newVersion: boundedSpec,
        reason: `Updated version requirement to ${boundedSpec}`,
      });
    }
    // else: already correct — no change needed
  }

  // Remove overrides that are no longer needed
  for (const [name, existingSpec] of Object.entries(currentOverrides)) {
    if (neededOverrides.has(name)) continue; // handled above

    if (resolvedAlertNames.has(name)) {
      changes.push({
        packageName: name,
        action: "remove",
        oldVersion: existingSpec,
        reason: "Vulnerability resolved — override no longer needed",
      });
    }
    // Overrides for packages not in any alert are left untouched
  }

  return changes;
}

function applyOverrideChanges(
  changes: OverrideChange[],
  currentOverrides: Record<string, string>,
  source: OverrideSource,
): void {
  if (changes.length === 0) {
    log("\n✅ No override changes needed.");
    return;
  }

  log(`\n📝 Planned override changes (${source.label}):`);
  for (const change of changes) {
    if (change.action === "add") {
      log(`   + ADD    ${change.packageName}: "${change.newVersion}"`);
    } else if (change.action === "update") {
      log(`   ~ UPDATE ${change.packageName}: "${change.oldVersion}" → "${change.newVersion}"`);
    } else {
      log(`   - REMOVE ${change.packageName}: "${change.oldVersion}"`);
    }
    log(`            (${change.reason})`);
  }

  if (DRY_RUN) {
    log("\n🚫 DRY_RUN=true — no changes written.");
    return;
  }

  // Apply changes to the overrides map
  const newOverrides = { ...currentOverrides };
  for (const change of changes) {
    if (change.action === "add" || change.action === "update") {
      newOverrides[change.packageName] = change.newVersion!;
    } else {
      delete newOverrides[change.packageName];
    }
  }

  source.write(newOverrides);
  log(`\n✅ ${source.label} updated at ${source.filePath}`);
  log("   Run `pnpm install` to apply the new overrides to your lockfile.");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function shell(cmd: string, opts: ExecSyncOptions = {}): string {
  return (execSync(cmd, { encoding: "utf-8", ...opts }) as unknown as string).toString();
}

function addUnique<T>(arr: T[], value: T): void {
  if (!arr.includes(value)) arr.push(value);
}

function sortObjectKeys(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

function log(msg: string): void {
  console.log(msg);
}

function exitWithError(msg: string): never {
  console.error(`\n❌ Error: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Group alerts by the directory containing their manifest, and ensure every
 * known override location is represented (even with no alerts) so stale
 * overrides get a cleanup pass.
 *
 * manifest_path is relative to repo root, e.g. "package.json" or
 * "functions/package.json"; "." means the repo root. Empty groups are cleanup
 * passes only.
 */
function groupAlertsByManifestDir(alerts: DependabotAlert[]): Map<string, DependabotAlert[]> {
  const alertsByDir = new Map<string, DependabotAlert[]>();
  for (const alert of alerts) {
    const rawDir = path.dirname(alert.dependency.manifest_path);
    const manifestDir = rawDir === "." ? WORKSPACE_ROOT : path.join(WORKSPACE_ROOT, rawDir);
    const group = alertsByDir.get(manifestDir) ?? [];
    group.push(alert);
    alertsByDir.set(manifestDir, group);
  }

  // Always include the root. Add functions/ if it exists and isn't already present.
  if (!alertsByDir.has(WORKSPACE_ROOT)) {
    alertsByDir.set(WORKSPACE_ROOT, []);
  }
  const functionsDir = path.join(WORKSPACE_ROOT, "functions");
  if (fs.existsSync(path.join(functionsDir, "package.json")) && !alertsByDir.has(functionsDir)) {
    alertsByDir.set(functionsDir, []);
  }

  return alertsByDir;
}

/**
 * For an override with no open alert in any group, decide whether it is still
 * load-bearing by checking the upstream ranges dependents declare in the npm
 * registry (registry data is unaffected by local overrides — unlike
 * node_modules, which reflects whatever pnpm resolved after overrides applied).
 * If every upstream range now requests a safe version, mark it eligible for
 * removal by adding it to allAlertedNames.
 */
async function reconcileOrphanedOverride(
  name: string,
  source: OverrideSource,
  manifestDir: string,
  allAlertedNames: Set<string>,
): Promise<void> {
  // Extract the patched version from the override spec, e.g. ">=11.1.1 <12" -> "11.1.1"
  const overrideSpec = source.overrides[name];
  const patchedVersion = overrideSpec.replace(/^>=/, "").split(" ")[0].trim();

  log(`   🔍 Checking npm registry for upstream dependency ranges for ${name}...`);
  const registryRanges = await collectRangesFromRegistry(name, manifestDir);

  if (registryRanges.length === 0) {
    log(
      `   ℹ️  Override for ${name} (${overrideSpec}) has no open alert. ` +
        `Could not determine upstream ranges from registry. ` +
        `Keeping conservatively — remove manually once upstream packages ` +
        `raise their own minimum requirements.`,
    );
    return;
  }

  const stillNeeded = registryRanges.some((range) => rangeCouldResolveVulnerable(range, patchedVersion));
  if (stillNeeded) {
    log(
      `   ℹ️  Override for ${name} (${overrideSpec}) has no open alert but is ` +
        `still load-bearing — latest upstream versions request: ${registryRanges.join(", ")}`,
    );
  } else {
    log(
      `   ✂️  Override for ${name} (${overrideSpec}) is no longer needed — ` +
        `latest upstream versions all request safe ranges: ${registryRanges.join(", ")}`,
    );
    allAlertedNames.add(name);
  }
}

async function main(): Promise<void> {
  log("🤖 Dependabot Override Agent");
  log("================================");
  if (DRY_RUN) log("⚠️  DRY RUN MODE — no files will be modified\n");

  // 1. Fetch all open npm alerts
  const alerts = await fetchDependabotAlerts();

  // 2. Group alerts by manifest directory, ensuring every override location is
  //    represented so stale overrides get a cleanup pass.
  const alertsByDir = groupAlertsByManifestDir(alerts);

  // 3. Process each manifest group independently
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalAlerts = 0;
  const allRecommendations: DeploymentRecommendation[] = [];

  // Build a global set of all alerted package names across every group.
  // This prevents a package added as an override in one group from being
  // incorrectly treated as orphaned and removed in another group's cleanup pass.
  const globalAlertedNames = new Set(alerts.map((a) => a.security_vulnerability.package.name));

  for (const [manifestDir, groupAlerts] of alertsByDir) {
    const isRoot = manifestDir === WORKSPACE_ROOT;
    const label = isRoot ? "root" : path.relative(WORKSPACE_ROOT, manifestDir);

    log(`\n${"─".repeat(48)}`);
    log(`📂 Processing manifest: ${label} (${groupAlerts.length} alert(s))`);

    // Detect the right override source for this group
    log("🗂️  Detecting override config location...");
    const source = isRoot ? detectOverrideSource() : buildIsolatedPackageJsonSource(manifestDir);

    // Update packages in this directory
    runPnpmUpdate(manifestDir);

    // Walk its installed tree
    const tree = getInstalledTree(manifestDir);

    // Determine which packages still need overrides
    const stillVulnerable = findVulnerableInstalls(groupAlerts, tree);

    // Build the set of package names eligible for removal.
    // Only remove overrides for packages that have an open alert in this group
    // that is now resolved. We do NOT automatically remove overrides just because
    // there are no active alerts — a closed alert often means the override is
    // working, not that it is no longer needed. If the underlying dependency that
    // pulls in the vulnerable package is updated to require a safe version natively,
    // the user should remove the override manually after verifying with pnpm why.
    const allAlertedNames = new Set(groupAlerts.map((a) => a.security_vulnerability.package.name));

    // For overrides with no active alert in ANY group, check whether any
    // dependent still requests a vulnerable version range. We use the global
    // alerted names set to avoid treating a package as orphaned just because
    // its alert belongs to a different manifest group processed in the same run.
    const orphanedOverrides = Object.keys(source.overrides).filter((name) => !globalAlertedNames.has(name));

    for (const name of orphanedOverrides) {
      await reconcileOrphanedOverride(name, source, manifestDir, allAlertedNames);
    }

    const changes = computeOverrideChanges(source.overrides, stillVulnerable, allAlertedNames);

    applyOverrideChanges(changes, source.overrides, source);

    // Analyse deployment impact for packages with active alerts in this group
    if (groupAlerts.length > 0) {
      const groupRecs = stillVulnerable.map((v) => analyseDeploymentImpact(v.name, manifestDir));
      allRecommendations.push(...groupRecs);
    }

    totalAlerts += groupAlerts.length;
    totalAdded += changes.filter((c) => c.action !== "remove").length;
    totalRemoved += changes.filter((c) => c.action === "remove").length;
  }

  // Summary
  log(`\n${"═".repeat(48)}`);
  log("📊 Summary:");
  log(`   Manifest groups processed : ${alertsByDir.size}`);
  log(`   Dependabot alerts checked : ${totalAlerts}`);
  log(`   Overrides added/updated   : ${totalAdded}`);
  log(`   Overrides removed         : ${totalRemoved}`);

  // Aggregated deployment recommendation across all groups
  if (allRecommendations.length > 0) {
    log(`\n${"═".repeat(48)}`);
    logDeploymentRecommendation(allRecommendations);
  }
}

main().catch((err) => {
  console.error("\n💥 Unexpected error:", err);
  process.exit(1);
});
