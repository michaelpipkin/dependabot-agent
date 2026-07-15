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
import { findInstalledVersions } from "./tree.js";
import {
  DependabotAlert,
  DependentRange,
  DeploymentRecommendation,
  DepScope,
  EscapingDependent,
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

/** Dependabot's per-alert scope, normalized. Absent/unrecognized → unknown. */
function alertScope(alert: DependabotAlert): DepScope {
  if (alert.dependency.scope === "runtime") return "production";
  if (alert.dependency.scope === "development") return "dev";
  return "unknown";
}

/**
 * Merge a package's scope across its alerts. Production wins: if any alert says
 * the vulnerable copy is reachable at runtime, the package is a deploy concern
 * regardless of what the other alerts say.
 */
function mergeScope(a: DepScope, b: DepScope): DepScope {
  if (a === "production" || b === "production") return "production";
  if (a === "dev" || b === "dev") return "dev";
  return "unknown";
}

// Multiple alerts for the same package — keep the highest patched version.
function mergeAlert(
  byName: Map<string, VulnerablePackage>,
  alert: DependabotAlert,
  pkgName: string,
  patchedVersion: string,
  installedVersions: string[],
): void {
  const existing = byName.get(pkgName);
  if (!existing) {
    byName.set(pkgName, {
      name: pkgName,
      installedVersions,
      patchedVersion,
      severity: alert.security_advisory.severity,
      scope: alertScope(alert),
      foundInParents: [],
      alertNumber: alert.number,
    });
    return;
  }

  const scope = mergeScope(existing.scope, alertScope(alert));
  const patch1 = parseSemver(existing.patchedVersion);
  const patch2 = parseSemver(patchedVersion);
  if (patch1 && patch2 && compareSemver(patch2, patch1) > 0) {
    byName.set(pkgName, { ...existing, patchedVersion, scope, alertNumber: alert.number });
  } else {
    byName.set(pkgName, { ...existing, scope });
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

    const installedVersions = findInstalledVersions(pkgName, tree);
    if (installedVersions.length === 0) {
      log(`   ℹ️  Alert #${alert.number} (${pkgName}) — package not found in installed tree, skipping.`);
      continue;
    }

    mergeAlert(byName, alert, pkgName, patchedVersion, installedVersions);
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
    const installedVersions = pkg?.installedVersions ?? [];

    // Bound against the HIGHEST copy so the ceiling can't exclude one that is
    // already safe; test escapes against EVERY copy, because the vulnerable one
    // is frequently not the one a by-name lookup would land on.
    const boundedSpec = computeBoundedSpec(versionSpec, installedVersions.at(-1));
    const escapingVersions = installedVersions.filter((v) => escapesCompatibleRange(versionSpec, v));
    const noInRangeFix = escapingVersions.length > 0;
    const escapeReason =
      `No in-range fix exists — earliest patch ${versionSpec} is outside the compatible range of ` +
      `installed ${escapingVersions.join(", ")}`;

    const existing = currentOverrides[name];
    if (!existing) {
      changes.push({
        packageName: name,
        action: "add",
        newVersion: boundedSpec,
        reason: noInRangeFix ? escapeReason : `Still vulnerable per Dependabot (needs ${boundedSpec})`,
        noInRangeFix,
        installedVersions,
        escapingVersions,
      });
    } else if (existing !== boundedSpec) {
      changes.push({
        packageName: name,
        action: "update",
        oldVersion: existing,
        newVersion: boundedSpec,
        reason: noInRangeFix ? escapeReason : `Updated version requirement to ${boundedSpec}`,
        noInRangeFix,
        installedVersions,
        escapingVersions,
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
 * Would moving this dependent to its own latest release clear the escape?
 *
 * Two ways it can: the latest release widened its range to accept the forced
 * version, or it dropped the dependency altogether — in which case it stops
 * being a dependent at all. Both need the latest manifest to have actually been
 * read; without it we know nothing and claim nothing.
 *
 * Note this says the *upstream fix exists*, not that the update is necessarily
 * reachable — whether the dependent can move depends on what constrains it.
 */
function isFixedByUpdate(dep: DependentRange, forcedVersion: string): boolean {
  if (!dep.latestKnown) return false;
  if (dep.latestRange === null) return true; // upstream dropped the dependency
  return !escapesCompatibleRange(forcedVersion, dep.latestRange);
}

/**
 * Which of this override's dependents does `forcedVersion` push past their
 * declared range?
 *
 * A non-empty result means the override is dragging those dependents beyond
 * what they asked for — the same "no in-range fix" condition that
 * computeOverrideChanges flags, but for an override already in place rather
 * than one being written.
 *
 * Pass the version actually resolved in the tree, not the spec's floor. An
 * unbounded spec can sit well above its own floor (">=4.2.0" resolving to
 * 5.0.0), and judging by the floor doesn't merely understate the severity — it
 * misses escapes outright: floor 0.28.1 sits inside a dependent's ^0.28.0, so
 * a drift to 0.29.5 reads as no escape at all.
 *
 * Each dependent is judged against the range its INSTALLED version declares,
 * which is the question that matters: what does the tree you have ask for?
 * Falls back to the latest published version's range only when the installed
 * one can't be resolved, and records which was used so the report can say so.
 *
 * Ranges it cannot parse (compound "^0.27.0 || ^0.28.0", wildcards) yield false
 * from escapesCompatibleRange and are skipped: only provable escapes are named.
 */
export function findEscapingDependents(forcedVersion: string, dependents: DependentRange[]): EscapingDependent[] {
  const escaping: EscapingDependent[] = [];

  for (const dep of dependents) {
    const range = dep.installedRange ?? dep.latestRange;
    if (!range) continue;
    if (!escapesCompatibleRange(forcedVersion, range)) continue;
    escaping.push({
      name: dep.dependent,
      version: dep.version,
      range,
      source: dep.installedRange ? "installed" : "latest",
      fixedByUpdate: isFixedByUpdate(dep, forcedVersion),
    });
  }

  return escaping;
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
function logEscapeList(escaped: OverrideChange[], orphanEscapes: OrphanEscape[]): void {
  if (escaped.length > 0) {
    log("   From open alerts (being written now):");
    for (const c of escaped) {
      const escaping = (c.escapingVersions ?? []).join(", ");
      // Name the other copies too: an escape on one of several is easy to
      // misread as an escape on all of them.
      const safe = (c.installedVersions ?? []).filter((v) => !(c.escapingVersions ?? []).includes(v));
      const alsoInstalled = safe.length > 0 ? `  (also installed, already in range: ${safe.join(", ")})` : "";
      log(`      ${c.packageName}: installed ${escaping} → forced to "${c.newVersion}"${alsoInstalled}`);
    }
  }

  if (orphanEscapes.length === 0) return;
  log("   Already in place (no open alert, kept because still load-bearing):");
  for (const o of orphanEscapes) {
    const resolvedSuffix = o.resolvedVersion ? ` → resolved ${o.resolvedVersion}` : "";
    log(`      ${o.packageName}: "${o.spec}"${resolvedSuffix} forces past what its dependents declare:`);
    for (const d of o.dependents) {
      log(`         ${d.name}@${d.version} declares ${d.range}`);
    }
  }
}

/**
 * Split the escaping dependents into the ones a user can just update away and
 * the ones that need a real judgement call — the distinction that decides what
 * they do next.
 */
function logEscapeGuidance(orphanEscapes: OrphanEscape[]): void {
  const allDeps = orphanEscapes.flatMap((o) => o.dependents);
  const fixable = [...new Set(allDeps.filter((d) => d.fixedByUpdate).map((d) => `${d.name}@${d.version}`))];
  const stuck = allDeps.filter((d) => !d.fixedByUpdate);

  if (fixable.length > 0) {
    const subject = fixable.length === 1 ? "is a stale dependent" : "are stale dependents";
    log("");
    log(`   ${fixable.length} ${subject} — the latest release either accepts the forced`);
    log("   version or dropped the dependency, so moving off the installed version");
    log("   clears the escape without touching the override:");
    for (const d of fixable) log(`      ${d}`);
  }

  if (stuck.length > 0) {
    const subject = stuck.length === 1 ? "has" : "have";
    log("");
    log(`   ${stuck.length} ${subject} no upstream fix available — verify these, or bound the`);
    log("   override lower if the dependent genuinely can't take the forced version:");
    for (const d of stuck) log(`      ${d.name}@${d.version} (wants ${d.range})`);
  }

  // Ranges are read at each dependent's installed version. Where that couldn't
  // be resolved we fell back to the latest published version, which may declare
  // a different range than the copy actually on disk — say so rather than let
  // the entry read as authoritative.
  const fellBack = allDeps.filter((d) => d.source === "latest");
  if (fellBack.length > 0) {
    log("");
    log(`   ${fellBack.length} could not be resolved at the installed version and were judged`);
    log("   against the dependent's latest published range instead:");
    for (const d of fellBack) log(`      ${d.name}@${d.version}`);
  }
}

function logNoInRangeFixWarning(
  escaped: OverrideChange[],
  orphanEscapes: OrphanEscape[],
  treeIsPreUpdate: boolean,
): void {
  const total = escaped.length + orphanEscapes.length;
  if (total === 0) return;

  log(`\n⚠️  NO IN-RANGE FIX — ${total} override(s) escape the compatible range of their dependents:`);
  logEscapeList(escaped, orphanEscapes);

  log("");
  log("   These install cleanly and their alerts read as fixed. That is not the same");
  log("   as being safe: dependents that asked for the old range will still call the");
  log("   old API, and the break shows up at runtime, not at install.");

  logEscapeGuidance(orphanEscapes);

  // Escapes are computed from the installed tree. When the update pass didn't
  // run, that tree is whatever was already on disk — so escapes caused purely
  // by an out-of-date dependent show up here but would not survive a real run.
  if (treeIsPreUpdate && orphanEscapes.length > 0) {
    log("");
    log("   NOTE: the update pass was skipped, so this reflects your current tree.");
    log("   A real run updates dependents first — escapes caused only by an");
    log("   out-of-date dependent may not appear there.");
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
  tree: InstalledTree[],
): Promise<OrphanEscape | null> {
  // Extract the patched version from the override spec, e.g. ">=11.1.1 <12" -> "11.1.1"
  const overrideSpec = source.overrides[name];
  const patchedVersion = overrideFloor(overrideSpec);

  log(`   🔍 Checking npm registry for upstream dependency ranges for ${name}...`);
  const dependents = await pm.collectDependentRanges(name, manifestDir);
  const latestRanges = [...new Set(dependents.map((d) => d.latestRange).filter((r): r is string => r !== null))];

  if (latestRanges.length === 0) {
    log(
      `   ℹ️  Override for ${name} (${overrideSpec}) has no open alert. ` +
        `Could not determine upstream ranges from registry. ` +
        `Keeping conservatively — remove manually once upstream packages ` +
        `raise their own minimum requirements.`,
    );
    return null;
  }

  // Removal asks a forward-looking question — "has upstream moved on?" — so it
  // reads the LATEST published ranges: after an update you resolve to those
  // dependents anyway.
  const stillNeeded = latestRanges.some((range) => rangeCouldResolveVulnerable(range, patchedVersion));
  if (!stillNeeded) {
    log(
      `   ✂️  Override for ${name} (${overrideSpec}) is no longer needed — ` +
        `latest upstream versions all request safe ranges: ${latestRanges.join(", ")}`,
    );
    allAlertedNames.add(name);
    return null;
  }

  // Load-bearing, but check *why*. If what this override actually resolves to
  // sits outside what the dependents declare, keeping it isn't routine — it's
  // forcing them past their range, the same condition an alert-driven override
  // gets flagged for. This asks about the tree you have, so it reads the
  // resolved version and the INSTALLED ranges.
  // An override normally collapses the tree to one copy, but not always (a
  // nested override or a peer-suffixed instance can survive). Judge by the
  // HIGHEST copy: escapesCompatibleRange() rises with the forced version, so
  // that's the copy pushing dependents furthest past their range.
  const resolvedVersions = findInstalledVersions(name, tree);
  const resolvedVersion = resolvedVersions.at(-1);
  const escaping = findEscapingDependents(resolvedVersion ?? patchedVersion, dependents);
  if (escaping.length > 0) {
    const resolvedSuffix = resolvedVersion ? ` → resolved ${resolvedVersion}` : "";
    log(
      `   ⚠️  Override for ${name} (${overrideSpec}${resolvedSuffix}) has ` +
        `no open alert and is still load-bearing, but no in-range fix exists for its dependents:`,
    );
    for (const d of escaping) {
      const via = d.source === "latest" ? " (latest — installed version unresolved)" : "";
      const hint = d.fixedByUpdate ? ` — updating ${d.name} resolves this` : "";
      log(`         ${d.name}@${d.version} declares ${d.range}${via}${hint}`);
    }
    return { packageName: name, spec: overrideSpec, floor: patchedVersion, resolvedVersion, dependents: escaping };
  }

  log(
    `   ℹ️  Override for ${name} (${overrideSpec}) has no open alert but is ` +
      `still load-bearing — latest upstream versions request: ${latestRanges.join(", ")}`,
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
    const escape = await reconcileOrphanedOverride(name, source, manifestDir, pm, allAlertedNames, tree);
    if (escape) orphanEscapes.push(escape);
  }

  const changes = computeOverrideChanges(source.overrides, stillVulnerable, allAlertedNames);
  applyOverrideChanges(changes, source.overrides, source, cfg.dryRun);
  const escapedChanges = changes.filter((c) => c.noInRangeFix);
  // The tree was read without an update pass, so it is whatever was already on
  // disk — escapes computed from it may not survive a real run.
  logNoInRangeFixWarning(escapedChanges, orphanEscapes, ctx.dryRun || ctx.skipUpdate);

  return {
    alerts: groupAlerts.length,
    added: changes.filter((c) => c.action !== "remove").length,
    removed: changes.filter((c) => c.action === "remove").length,
    noInRangeFix: escapedChanges.length + orphanEscapes.length,
    recommendations: groupAlerts.length > 0 ? stillVulnerable.map((v) => resolveScope(v, pm, manifestDir)) : [],
  };
}

/**
 * Decide whether a vulnerable package is a deploy concern.
 *
 * Prefers Dependabot's scope, which describes the *vulnerable copy* and is
 * therefore version-accurate. Walking the local tree by name is not: with a
 * vulnerable and a safe copy both installed, it finds the safe copy's
 * production path and reports the package as production even when the copy
 * under alert is dev-only. Falls back to the local walk only when GitHub
 * doesn't say (older payloads).
 */
function resolveScope(v: VulnerablePackage, pm: PackageManager, manifestDir: string): DeploymentRecommendation {
  if (v.scope === "unknown") return pm.analyseDeploymentImpact(v.name, manifestDir);

  const local = pm.analyseDeploymentImpact(v.name, manifestDir);
  return { ...local, scope: v.scope };
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
