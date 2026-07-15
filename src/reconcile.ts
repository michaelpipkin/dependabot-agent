import * as path from "node:path";
import { ResolvedConfig } from "./config.js";
import { discoverIsolatedManifestDirs } from "./discover.js";
import { fetchDependabotAlerts } from "./github.js";
import { OverrideSource, selectOverrideSource } from "./override-source.js";
import {
  createPackageManager,
  detectPackageManager,
  PackageManager,
  RunContext,
} from "./package-manager/index.js";
import {
  compareSemver,
  computeBoundedSpec,
  escapesCompatibleRange,
  parseSemver,
  rangeCouldResolveVulnerable,
} from "./semver.js";
import { findInstalledVersion } from "./tree.js";
import {
  DependabotAlert,
  DeploymentRecommendation,
  InstalledTree,
  OrphanEscape,
  OverrideChange,
  PackageManagerId,
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

export function computeOverrideChanges(
  currentOverrides: Record<string, string>,
  stillVulnerable: VulnerablePackage[],
  resolvedAlertNames: Set<string>,
): OverrideChange[] {
  const changes: OverrideChange[] = [];
  const neededOverrides = new Map(stillVulnerable.map((v) => [v.name, v.patchedVersion]));

  // Add or update overrides for packages that still need them. The spec is
  // bounded at the first breaking version above the patch rather than left as
  // an unbounded >=, so applying a fix can't drag the tree further than it has
  // to. Where even that minimum lands outside what the installed version's
  // dependents can accept, the change is marked noInRangeFix for the report.
  for (const [name, versionSpec] of neededOverrides) {
    const pkg = stillVulnerable.find((v) => v.name === name);
    const boundedSpec = computeBoundedSpec(versionSpec, pkg?.installedVersion);
    const noInRangeFix = escapesCompatibleRange(versionSpec, pkg?.installedVersion);
    const escapeReason = `No in-range fix exists — earliest patch ${versionSpec} is outside the compatible range of installed ${pkg?.installedVersion}`;
    const existing = currentOverrides[name];
    if (!existing) {
      changes.push({
        packageName: name,
        action: "add",
        newVersion: boundedSpec,
        reason: noInRangeFix ? escapeReason : `Still vulnerable per Dependabot (needs ${boundedSpec})`,
        noInRangeFix,
        installedVersion: pkg?.installedVersion,
      });
    } else if (existing !== boundedSpec) {
      changes.push({
        packageName: name,
        action: "update",
        oldVersion: existing,
        newVersion: boundedSpec,
        reason: noInRangeFix ? escapeReason : `Updated version requirement to ${boundedSpec}`,
        noInRangeFix,
        installedVersion: pkg?.installedVersion,
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

/** The floor of an override spec: ">=11.1.1" and ">=7.29.6 <8" both yield the lower bound. */
export function overrideFloor(spec: string): string {
  return spec.replace(/^>=/, "").split(" ")[0].trim();
}

/**
 * Of the ranges this override's dependents declare, which does its floor fall
 * outside of?
 *
 * A non-empty result means the override is forcing those dependents past what
 * they asked for — the same "no in-range fix" condition that computeOverrideChanges
 * flags, but for an override already in place rather than one being written.
 * Ranges it cannot parse (compound "^0.27.0 || ^0.28.0", wildcards) yield false
 * from escapesCompatibleRange and are skipped: only provable escapes are named.
 */
export function findEscapingRanges(overrideSpec: string, dependentRanges: string[]): string[] {
  const floor = overrideFloor(overrideSpec);
  return dependentRanges.filter((range) => escapesCompatibleRange(floor, range));
}

/**
 * Surface the "no in-range fix exists" bucket separately from routine changes.
 *
 * These are the ones that need a human. The override itself will apply without
 * complaint — the package manager forces the version at resolution time, so a
 * dependent's declared range does not block it and the install exits 0.
 * Dependabot then closes the alert because the resolved version is patched.
 * Nothing in that sequence is a signal, which is exactly why it gets its own
 * block here rather than a line in the list above.
 */
function logNoInRangeFixWarning(escaped: OverrideChange[], orphanEscapes: OrphanEscape[]): void {
  const total = escaped.length + orphanEscapes.length;
  if (total === 0) return;

  log(`\n⚠️  NO IN-RANGE FIX — ${total} override(s) escape the compatible range of their dependents:`);

  if (escaped.length > 0) {
    log("   From open alerts (being written now):");
    for (const c of escaped) {
      log(`      ${c.packageName}: installed ${c.installedVersion} → forced to "${c.newVersion}"`);
    }
  }

  if (orphanEscapes.length > 0) {
    log("   Already in place (no open alert, kept because still load-bearing):");
    for (const o of orphanEscapes) {
      log(`      ${o.packageName}: "${o.spec}" forces dependents past ${o.dependentRanges.join(", ")}`);
    }
  }

  log("");
  log("   These install cleanly and their alerts read as fixed. That is not the same");
  log("   as being safe: dependents that asked for the old range will still call the");
  log("   old API, and the break shows up at runtime, not at install.");
  log("   Verify the dependents of each package above, or bump those dependents to");
  log("   versions that request the patched range.");
  if (orphanEscapes.length > 0) {
    log("");
    log("   The 'already in place' entries are compared against the ranges the LATEST");
    log("   published dependents declare, so this list can under-report: an older");
    log("   installed dependent may ask for an even lower range than shown.");
  }
}

export function applyOverrideChanges(
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
    const mark = change.noInRangeFix ? "⚠" : " ";
    if (change.action === "add") {
      log(`  ${mark}+ ADD    ${change.packageName}: "${change.newVersion}"`);
    } else if (change.action === "update") {
      log(`  ${mark}~ UPDATE ${change.packageName}: "${change.oldVersion}" → "${change.newVersion}"`);
    } else {
      log(`  ${mark}- REMOVE ${change.packageName}: "${change.oldVersion}"`);
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
): Promise<OrphanEscape | null> {
  // Extract the patched version from the override spec, e.g. ">=11.1.1 <12" -> "11.1.1"
  const overrideSpec = source.overrides[name];
  const patchedVersion = overrideFloor(overrideSpec);

  log(`   🔍 Checking npm registry for upstream dependency ranges for ${name}...`);
  const registryRanges = await pm.collectDependentRanges(name, manifestDir);

  if (registryRanges.length === 0) {
    log(
      `   ℹ️  Override for ${name} (${overrideSpec}) has no open alert. ` +
        `Could not determine upstream ranges from registry. ` +
        `Keeping conservatively — remove manually once upstream packages ` +
        `raise their own minimum requirements.`,
    );
    return null;
  }

  const stillNeeded = registryRanges.some((range) => rangeCouldResolveVulnerable(range, patchedVersion));
  if (!stillNeeded) {
    log(
      `   ✂️  Override for ${name} (${overrideSpec}) is no longer needed — ` +
        `latest upstream versions all request safe ranges: ${registryRanges.join(", ")}`,
    );
    allAlertedNames.add(name);
    return null;
  }

  // Load-bearing, but check *why*. If the floor sits outside what the dependents
  // declare, keeping it isn't routine — it's forcing them past their range, the
  // same condition an alert-driven override gets flagged for. Without this the
  // two are indistinguishable in the output.
  const escaping = findEscapingRanges(overrideSpec, registryRanges);
  if (escaping.length > 0) {
    log(
      `   ⚠️  Override for ${name} (${overrideSpec}) has no open alert and is still ` +
        `load-bearing, but no in-range fix exists for its dependents — ` +
        `latest upstream versions request: ${registryRanges.join(", ")}`,
    );
    return { packageName: name, spec: overrideSpec, floor: patchedVersion, dependentRanges: escaping };
  }

  log(
    `   ℹ️  Override for ${name} (${overrideSpec}) has no open alert but is ` +
      `still load-bearing — latest upstream versions request: ${registryRanges.join(", ")}`,
  );
  return null;
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
function groupAlertsByManifestDir(
  alerts: DependabotAlert[],
  workspaceRoot: string,
  extraDirs: string[],
): Map<string, DependabotAlert[]> {
  const alertsByDir = new Map<string, DependabotAlert[]>();
  for (const alert of alerts) {
    const rawDir = path.dirname(alert.dependency.manifest_path);
    const manifestDir = rawDir === "." ? workspaceRoot : path.join(workspaceRoot, rawDir);
    const group = alertsByDir.get(manifestDir) ?? [];
    group.push(alert);
    alertsByDir.set(manifestDir, group);
  }

  // Always include the root, plus any extra manifest dirs (discovered isolated
  // packages and explicitly-configured ones), for a cleanup pass even with no
  // alerts.
  for (const dir of [workspaceRoot, ...extraDirs]) {
    if (!alertsByDir.has(dir)) alertsByDir.set(dir, []);
  }

  return alertsByDir;
}

/**
 * Resolve the package manager for a manifest directory. An explicit
 * --package-manager setting wins everywhere; otherwise each isolated package is
 * detected from its own lockfile, falling back to the root's package manager.
 */
function resolvePmForDir(
  manifestDir: string,
  isRoot: boolean,
  rootPmId: PackageManagerId,
  cfg: ResolvedConfig,
): PackageManagerId {
  if (cfg.packageManager) return cfg.packageManager;
  if (isRoot) return rootPmId;
  return detectPackageManager(manifestDir) ?? rootPmId;
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

/** What one manifest group contributed, for the run-wide summary. */
interface GroupResult {
  alerts: number;
  added: number;
  removed: number;
  noInRangeFix: number;
  recommendations: DeploymentRecommendation[];
}

/**
 * Reconcile a single manifest directory: update, walk its tree, decide what
 * overrides it needs, clean up orphans, and report.
 */
async function processManifestGroup(
  manifestDir: string,
  groupAlerts: DependabotAlert[],
  cfg: ResolvedConfig,
  ctx: RunContext,
  rootPmId: PackageManagerId,
  globalAlertedNames: Set<string>,
): Promise<GroupResult> {
  const isRoot = manifestDir === cfg.workspaceRoot;
  const label = isRoot ? "root" : path.relative(cfg.workspaceRoot, manifestDir);
  const pmId = resolvePmForDir(manifestDir, isRoot, rootPmId, cfg);
  const pm = createPackageManager(pmId, ctx);

  log(`\n${"─".repeat(48)}`);
  log(`📂 Processing manifest: ${label} (${groupAlerts.length} alert(s)) [${pmId}]`);

  log("🗂️  Detecting override config location...");
  const source = selectOverrideSource(pmId, manifestDir, isRoot);

  pm.update(manifestDir, [...new Set(groupAlerts.map((a) => a.security_vulnerability.package.name))]);

  const tree = pm.getInstalledTree(manifestDir);
  const stillVulnerable = findVulnerableInstalls(groupAlerts, tree);

  // Only remove overrides for packages whose alert in this group is resolved.
  const allAlertedNames = new Set(groupAlerts.map((a) => a.security_vulnerability.package.name));

  // For overrides with no active alert in ANY group, check whether any
  // dependent still requests a vulnerable range.
  const orphanedOverrides = Object.keys(source.overrides).filter((name) => !globalAlertedNames.has(name));
  const orphanEscapes: OrphanEscape[] = [];
  for (const name of orphanedOverrides) {
    const escape = await reconcileOrphanedOverride(name, source, manifestDir, pm, allAlertedNames);
    if (escape) orphanEscapes.push(escape);
  }

  const changes = computeOverrideChanges(source.overrides, stillVulnerable, allAlertedNames);
  applyOverrideChanges(changes, source.overrides, source, cfg.dryRun);
  const escapedChanges = changes.filter((c) => c.noInRangeFix);
  logNoInRangeFixWarning(escapedChanges, orphanEscapes);

  return {
    alerts: groupAlerts.length,
    added: changes.filter((c) => c.action !== "remove").length,
    removed: changes.filter((c) => c.action === "remove").length,
    noInRangeFix: escapedChanges.length + orphanEscapes.length,
    recommendations:
      groupAlerts.length > 0 ? stillVulnerable.map((v) => pm.analyseDeploymentImpact(v.name, manifestDir)) : [],
  };
}

export async function run(cfg: ResolvedConfig): Promise<void> {
  log("🤖 Dependabot Override Agent");
  log("================================");
  if (cfg.dryRun) log("⚠️  DRY RUN MODE — no files will be modified\n");

  // Resolve the root package manager (explicit override or lockfile detection).
  const rootPmId = cfg.packageManager ?? detectPackageManager(cfg.workspaceRoot);
  if (!rootPmId) {
    exitWithError(
      `Could not detect a package manager in ${cfg.workspaceRoot} ` +
        `(no pnpm-lock.yaml or package-lock.json). Pass --package-manager pnpm|npm.`,
    );
  }
  log(`📦 Package manager: ${rootPmId}${cfg.packageManager ? " (explicit)" : " (auto-detected)"}`);
  log(`🔧 Update strategy: ${cfg.updateStrategy}`);

  const ctx: RunContext = {
    dryRun: cfg.dryRun,
    skipUpdate: cfg.skipUpdate,
    updateStrategy: cfg.updateStrategy,
  };

  // Additional manifest roots to reconcile beyond the workspace root: isolated
  // sub-packages with their own lockfile (auto-discovered) plus any explicitly
  // configured directories. Each is processed as its own group.
  const explicitDirs = cfg.packages.map((p) => path.resolve(cfg.workspaceRoot, p));
  const discoveredDirs = cfg.discoverPackages ? discoverIsolatedManifestDirs(cfg.workspaceRoot) : [];
  const extraDirs = [...new Set([...explicitDirs, ...discoveredDirs])];
  if (extraDirs.length > 0) {
    log(`🧩 Isolated package(s): ${extraDirs.map((d) => path.relative(cfg.workspaceRoot, d)).join(", ")}`);
  }

  // 1. Fetch all open npm alerts
  const alerts = await fetchDependabotAlerts({ owner: cfg.owner, name: cfg.name, token: cfg.token });

  // 2. Group alerts by manifest directory (plus root + extra dirs)
  const alertsByDir = groupAlertsByManifestDir(alerts, cfg.workspaceRoot, extraDirs);

  // 3. Process each manifest group independently
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalAlerts = 0;
  let totalNoInRangeFix = 0;
  const allRecommendations: DeploymentRecommendation[] = [];

  // Global set of all alerted package names across every group. Prevents a
  // package added as an override in one group from being treated as orphaned
  // and removed in another group's cleanup pass.
  const globalAlertedNames = new Set(alerts.map((a) => a.security_vulnerability.package.name));

  for (const [manifestDir, groupAlerts] of alertsByDir) {
    const result = await processManifestGroup(manifestDir, groupAlerts, cfg, ctx, rootPmId, globalAlertedNames);

    totalAlerts += result.alerts;
    totalAdded += result.added;
    totalRemoved += result.removed;
    totalNoInRangeFix += result.noInRangeFix;
    allRecommendations.push(...result.recommendations);
  }

  // Summary
  log(`\n${"═".repeat(48)}`);
  log("📊 Summary:");
  log(`   Manifest groups processed : ${alertsByDir.size}`);
  log(`   Dependabot alerts checked : ${totalAlerts}`);
  log(`   Overrides added/updated   : ${totalAdded}`);
  log(`   Overrides removed         : ${totalRemoved}`);
  if (totalNoInRangeFix > 0) {
    log(`   ⚠️  No in-range fix        : ${totalNoInRangeFix}  (escapes compatible range — verify dependents)`);
  }

  if (allRecommendations.length > 0) {
    log(`\n${"═".repeat(48)}`);
    logDeploymentRecommendation(allRecommendations);
  }
}
