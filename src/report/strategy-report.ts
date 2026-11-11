import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baselinePhrase, comparedWithLine, type Baseline, type ReportBaseline } from "../baseline/source.js";
import type { DepScope, DeploymentRecommendation, PackageManagerId } from "../types.js";
import { isFixed, type AlertFix, type FixStatus } from "./alert-fixes.js";
import { recommendDeploy, renderDeploySection, type DeployInput, type DeployRecommendation } from "./deploy.js";
import { cell, inline, MAX_BODY_CHARS, renderSummaryLine, SCOPE_LABEL, type SummaryCounts } from "./markdown.js";

export interface StrategyReport {
  strategy: "compatible" | "latest";
  packageManager: PackageManagerId;
  dryRun: boolean;
  /** "changes" when this run changed something; "clean" when it didn't, whatever it is compared with. */
  outcome: "changes" | "clean";
  /** What the working copy was compared with, and any manifest that fell back to something weaker. */
  baseline: ReportBaseline;
  /** Why the baseline isn't what was asked for, and anything else worth saying under the Compared line. */
  warnings: string[];
  summary: SummaryCounts;
  deploy: DeployRecommendation;
  /** The alerts this run fixed. */
  fixes: AlertFix[];
  /** The rest, each with the reason it wasn't. */
  notAddressed: AlertFix[];
}

/** One deploy input per fixed alert; the rest never count toward a deploy. impactOf supplies the scope only where the alert's own is unknown. */
export function deployInputsOf(
  fixes: AlertFix[],
  impactOf: (packageName: string) => DeploymentRecommendation,
): DeployInput[] {
  return fixes.filter(isFixed).map((f) => {
    const impact = impactOf(f.packageName);
    const scope = f.scope === "unknown" ? impact.scope : f.scope;
    // The paths that pulled it in: the production ones, the dev ones, or both when we can't tell.
    const via =
      scope === "production" ? impact.productionPaths : scope === "dev" ? impact.devPaths : [...impact.productionPaths, ...impact.devPaths];
    return { packageName: f.packageName, scope, manifest: f.manifest, via };
  });
}

export function assembleStrategyReport(input: {
  strategy: "compatible" | "latest";
  packageManager: PackageManagerId;
  dryRun: boolean;
  fixes: AlertFix[];
  deployInputs: DeployInput[];
  overridesAddedOrUpdated: number;
  overridesRemoved: number;
  removedOverrideKeys: string[];
  packagesUpdated: number;
  baseline: ReportBaseline;
  warnings: string[];
  /** Open alerts in scope, the ones the deploy recommendation has to account for. */
  openAlerts: number;
  /** Whether this run changed overrides or installed anything; not how far the working copy is from the baseline. */
  changedThisRun: boolean;
}): StrategyReport {
  const { fixes } = input;
  const fixed = fixes.filter(isFixed);
  return {
    strategy: input.strategy,
    packageManager: input.packageManager,
    dryRun: input.dryRun,
    outcome: input.changedThisRun ? "changes" : "clean",
    baseline: input.baseline,
    warnings: input.warnings,
    summary: {
      addressed: fixed.length,
      open: fixes.length,
      overridesAddedOrUpdated: input.overridesAddedOrUpdated,
      overridesRemoved: input.overridesRemoved,
      packagesUpdated: input.packagesUpdated,
      // Against the start of the run the count is the update pass's, as in 1.4.0.
      ...(input.baseline.kind === "run-start" ? {} : { packagesSince: baselinePhrase(input.baseline) }),
      updatePassOnly: true,
    },
    deploy: recommendDeploy(input.deployInputs, input.removedOverrideKeys, { openAlerts: input.openAlerts }),
    fixes: fixed,
    notAddressed: fixes.filter((f) => !isFixed(f)),
  };
}

const MAX_NOT_ADDRESSED = 20;

/** Why an alert wasn't addressed; some reasons name the baseline, `phrase` being its baselinePhrase. */
const REASON: Record<FixStatus, (phrase: string) => string> = {
  update: () => "updated",
  override: () => "overridden",
  "awaiting-close": () => "already patched, awaiting close",
  covered: () => "an existing override is meant to cover it",
  "no-patch": () => "no patched version",
  "not-installed": () => "not installed",
  "introduced-covered": (phrase) => `not vulnerable in ${phrase}; an override covers it`,
  introduced: (phrase) => `not vulnerable in ${phrase}; still vulnerable here`,
  "not-in-baseline": (phrase) => `not in ${phrase}`,
  "still-vulnerable": () => "still vulnerable after this run",
};

const SCOPE_ORDER: Record<DepScope, number> = { production: 0, dev: 1, unknown: 2 };

/** A name as a code span. Backticks can't appear inside one, so they become '. */
const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``;

const alertLink = (f: AlertFix): string => (f.url ? `[#${f.number}](${f.url})` : `#${f.number}`);

const TABLE_HEAD = ["Alert", "Severity", "Package", "Change", "How", "Scope", "Manifest"];

function row(f: AlertFix): string {
  const cols = [
    alertLink(f),
    f.severity,
    code(f.packageName),
    `${f.from.length > 0 ? f.from.join(", ") : "?"} → ${f.to ?? "?"}`,
    f.status === "override" ? "override" : "update",
    SCOPE_LABEL[f.scope],
    code(f.manifest),
  ];
  return `| ${cols.map(cell).join(" | ")} |`;
}

/** Plain code-unit order, so row order doesn't depend on the runtime's locale. */
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortedFixes(fixes: AlertFix[]): AlertFix[] {
  return [...fixes].sort(
    (a, b) =>
      SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
      compareText(a.packageName, b.packageName) ||
      a.number - b.number,
  );
}

/** By alert number, so the cut keeps the oldest alerts. */
function notAddressedLine(fixes: AlertFix[], baseline: Baseline): string {
  const phrase = baselinePhrase(baseline);
  const entries = [...fixes]
    .sort((a, b) => a.number - b.number)
    .slice(0, MAX_NOT_ADDRESSED)
    .map((f) => inline(`${alertLink(f)} ${code(f.packageName)}: ${REASON[f.status](phrase)}`));
  const more = fixes.length - MAX_NOT_ADDRESSED;
  if (more > 0) entries.push(`and ${more} more`);
  return `**Not addressed:** ${entries.join("; ")}`;
}

const CUT_NOTE =
  "_This report was cut to fit GitHub's size limit. Not shown in full: Packages. " +
  "The complete report is in the workflow run's job summary._";

export function renderStrategyReport(report: StrategyReport, options: { full?: boolean } = {}): string {
  const top = [report.dryRun ? "# Dependency overrides reconciled — plan" : "# Dependency overrides reconciled", ""];
  if (report.dryRun) top.push("> **Dry run.** This is the plan of what the tool would do. Nothing was changed.", "");
  top.push(
    renderSummaryLine(report.summary, report.dryRun),
    "",
    `Strategy \`${report.strategy}\` on ${report.packageManager}.`,
    "",
    comparedWithLine(report.baseline),
  );
  for (const warning of report.warnings) top.push("", `_${inline(warning)}_`);
  const deploy = renderDeploySection(report.deploy, report.baseline);
  const head = [top.join("\n"), ...(deploy ? [deploy] : [])];

  const tail = report.notAddressed.length > 0 ? [notAddressedLine(report.notAddressed, report.baseline)] : [];
  const join = (parts: string[]): string => parts.join("\n\n") + "\n";

  if (report.fixes.length === 0) return join([...head, `No alert was fixed compared with ${baselinePhrase(report.baseline)}.`, ...tail]);

  const tableHead = [`| ${TABLE_HEAD.join(" | ")} |`, `|${TABLE_HEAD.map(() => " --- ").join("|")}|`];
  const rows = sortedFixes(report.fixes).map(row);
  const whole = join([...head, ["## Packages", "", ...tableHead, ...rows].join("\n"), ...tail]);
  if (options.full || whole.length <= MAX_BODY_CHARS) return whole;

  // Cut rows from the end; the header, summary, deploy section and Not addressed line stay.
  const fixed = join([...head, ["## Packages", "", ...tableHead].join("\n"), ...tail, CUT_NOTE]).length;
  let budget = MAX_BODY_CHARS - fixed;
  const kept: string[] = [];
  for (const r of rows) {
    if (r.length + 1 > budget) break;
    kept.push(r);
    budget -= r.length + 1;
  }
  return join([...head, ["## Packages", "", ...tableHead, ...kept].join("\n"), ...tail, CUT_NOTE]);
}

/** Writes report.md (the PR body), report.json (what the workflow reads) and, when the body was cut, report-full.md. */
export function writeStrategyReport(dir: string, report: StrategyReport): void {
  mkdirSync(dir, { recursive: true });
  const body = renderStrategyReport(report);
  writeFileSync(join(dir, "report.md"), body);
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  // The cut-down body points at the job summary, so the full text has to exist for it.
  const full = renderStrategyReport(report, { full: true });
  if (full !== body) writeFileSync(join(dir, "report-full.md"), full);
}
