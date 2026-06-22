import * as path from "node:path";
import { ResolvedConfig } from "./config.js";
import { fetchDependabotAlerts } from "./github.js";
import { OverrideSource, selectOverrideSource } from "./override-source.js";
import { createPackageManager, detectPackageManager, PackageManager } from "./package-manager/index.js";
import { compareSemver, computeBoundedSpec, parseSemver, rangeCouldResolveVulnerable } from "./semver.js";
import { findInstalledVersion } from "./tree.js";
import {
  DependabotAlert,
  DeploymentRecommendation,
  InstalledTree,
  OverrideChange,
  VulnerablePackage,
} from "./types.js";
import { exitWithError, log } from "./util.js";

// ---------------------------------------------------------------------------
// Determine which alerts still need overrides
// ---------------------------------------------------------------------------

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

/**
 * Builds the list of packages that need overrides from open Dependabot alerts.
 *
 * Approach: trust the alert state rather than the installed versions. The
 * installed tree reflects overrides already applied, so a package that has been
 * overridden will always appear "safe" on disk — checking installed versions
 * produces a false "all clear" and removes overrides that are still necessary.
 * We still confirm the package is present in the tree (no point overriding
 * something absent) and use its version to bound the override spec.
 */
function findVulnerableInstalls(alerts: DependabotAlert[], tree: InstalledTree[]): VulnerablePackage[] {
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
// Compute and apply override changes
// ---------------------------------------------------------------------------

function computeOverrideChanges(
  currentOverrides: Record<string, string>,
  stillVulnerable: VulnerablePackage[],
  resolvedAlertNames: Set<string>,
): OverrideChange[] {
  const changes: OverrideChange[] = [];
  const neededOverrides = new Map(stillVulnerable.map((v) => [v.name, `>=${v.patchedVersion}`]));

  // Add or update overrides for packages that still need them. We write a
  // major-bounded spec (>=patchedVersion <currentMajor+1) rather than an
  // unbounded >= to prevent jumping to a new major with breaking changes.
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
  dryRun: boolean,
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

  if (dryRun) {
    log("\n🚫 Dry run — no changes written.");
    return;
  }

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
  log("   Run your package manager's install to apply the new overrides to your lockfile.");
}

// ---------------------------------------------------------------------------
// Orphaned-override reconciliation
// ---------------------------------------------------------------------------

/**
 * For an override with no open alert in any group, decide whether it is still
 * load-bearing by checking the upstream ranges dependents declare in the npm
 * registry (registry data is unaffected by local overrides — unlike
 * node_modules, which reflects whatever the PM resolved after overrides
 * applied). If every upstream range now requests a safe version, mark it
 * eligible for removal by adding it to allAlertedNames.
 */
async function reconcileOrphanedOverride(
  name: string,
  source: OverrideSource,
  manifestDir: string,
  pm: PackageManager,
  allAlertedNames: Set<string>,
): Promise<void> {
  // Extract the patched version from the override spec, e.g. ">=11.1.1 <12" -> "11.1.1"
  const overrideSpec = source.overrides[name];
  const patchedVersion = overrideSpec.replace(/^>=/, "").split(" ")[0].trim();

  log(`   🔍 Checking npm registry for upstream dependency ranges for ${name}...`);
  const registryRanges = await pm.collectDependentRanges(name, manifestDir);

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

// ---------------------------------------------------------------------------
// Deployment-impact reporting
// ---------------------------------------------------------------------------

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
// Grouping
// ---------------------------------------------------------------------------

/**
 * Group alerts by the directory containing their manifest. Always include the
 * workspace root (even with no alerts) so stale root overrides get a cleanup
 * pass. Any non-root directory only appears because an alert referenced its
 * manifest — so no directories are synthesized.
 *
 * manifest_path is relative to repo root, e.g. "package.json" or
 * "functions/package.json"; "." means the repo root.
 */
function groupAlertsByManifestDir(alerts: DependabotAlert[], workspaceRoot: string): Map<string, DependabotAlert[]> {
  const alertsByDir = new Map<string, DependabotAlert[]>();
  for (const alert of alerts) {
    const rawDir = path.dirname(alert.dependency.manifest_path);
    const manifestDir = rawDir === "." ? workspaceRoot : path.join(workspaceRoot, rawDir);
    const group = alertsByDir.get(manifestDir) ?? [];
    group.push(alert);
    alertsByDir.set(manifestDir, group);
  }

  // Always include the root for a cleanup pass, even with no alerts.
  if (!alertsByDir.has(workspaceRoot)) {
    alertsByDir.set(workspaceRoot, []);
  }

  return alertsByDir;
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

export async function run(cfg: ResolvedConfig): Promise<void> {
  log("🤖 Dependabot Override Agent");
  log("================================");
  if (cfg.dryRun) log("⚠️  DRY RUN MODE — no files will be modified\n");

  // Resolve the package manager (explicit override or lockfile auto-detection).
  const pmId = cfg.packageManager ?? detectPackageManager(cfg.workspaceRoot);
  if (!pmId) {
    exitWithError(
      `Could not detect a package manager in ${cfg.workspaceRoot} ` +
        `(no pnpm-lock.yaml or package-lock.json). Pass --package-manager pnpm|npm.`,
    );
  }
  log(`📦 Package manager: ${pmId}${cfg.packageManager ? " (explicit)" : " (auto-detected)"}`);
  log(`🔧 Update strategy: ${cfg.updateStrategy}`);

  const pm = createPackageManager(pmId, {
    dryRun: cfg.dryRun,
    skipUpdate: cfg.skipUpdate,
    updateStrategy: cfg.updateStrategy,
  });

  // 1. Fetch all open npm alerts
  const alerts = await fetchDependabotAlerts({ owner: cfg.owner, name: cfg.name, token: cfg.token });

  // 2. Group alerts by manifest directory
  const alertsByDir = groupAlertsByManifestDir(alerts, cfg.workspaceRoot);

  // 3. Process each manifest group independently
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalAlerts = 0;
  const allRecommendations: DeploymentRecommendation[] = [];

  // Global set of all alerted package names across every group. Prevents a
  // package added as an override in one group from being treated as orphaned
  // and removed in another group's cleanup pass.
  const globalAlertedNames = new Set(alerts.map((a) => a.security_vulnerability.package.name));

  for (const [manifestDir, groupAlerts] of alertsByDir) {
    const isRoot = manifestDir === cfg.workspaceRoot;
    const label = isRoot ? "root" : path.relative(cfg.workspaceRoot, manifestDir);

    log(`\n${"─".repeat(48)}`);
    log(`📂 Processing manifest: ${label} (${groupAlerts.length} alert(s))`);

    log("🗂️  Detecting override config location...");
    const source = selectOverrideSource(pmId, manifestDir, isRoot);

    // Update packages in this directory
    pm.update(manifestDir, [...new Set(groupAlerts.map((a) => a.security_vulnerability.package.name))]);

    // Walk its installed tree
    const tree = pm.getInstalledTree(manifestDir);

    // Determine which packages still need overrides
    const stillVulnerable = findVulnerableInstalls(groupAlerts, tree);

    // Only remove overrides for packages whose alert in this group is resolved.
    const allAlertedNames = new Set(groupAlerts.map((a) => a.security_vulnerability.package.name));

    // For overrides with no active alert in ANY group, check whether any
    // dependent still requests a vulnerable range.
    const orphanedOverrides = Object.keys(source.overrides).filter((name) => !globalAlertedNames.has(name));
    for (const name of orphanedOverrides) {
      await reconcileOrphanedOverride(name, source, manifestDir, pm, allAlertedNames);
    }

    const changes = computeOverrideChanges(source.overrides, stillVulnerable, allAlertedNames);
    applyOverrideChanges(changes, source.overrides, source, cfg.dryRun);

    if (groupAlerts.length > 0) {
      const groupRecs = stillVulnerable.map((v) => pm.analyseDeploymentImpact(v.name, manifestDir));
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

  if (allRecommendations.length > 0) {
    log(`\n${"═".repeat(48)}`);
    logDeploymentRecommendation(allRecommendations);
  }
}
