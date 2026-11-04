import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DepScope } from "../types.js";
import type { AlertOutcome, CopyDecision } from "./plan.js";
import type { VerificationFailure } from "./verify.js";

export type Outcome = "changes" | "blocked-only" | "clean" | "failed";

export interface RunReport {
  outcome: Outcome;
  dryRun: boolean;
  blockedCount: number;
  alerts: AlertOutcome[];
  otherChanges: Array<{ path: string; from?: string; to?: string }>;
  keptOverrides: Array<{ key: string; reason: string }>;
  failures: VerificationFailure[];
}

/** GitHub rejects a PR or issue body over 65536 characters; leave room. */
export const MAX_BODY_CHARS = 60000;

/** The spec's order: a failure beats everything, then any changed file, then any blocked copy. */
export function computeOutcome(input: { failed: boolean; changedFiles: number; blockedCount: number }): Outcome {
  if (input.failed) return "failed";
  if (input.changedFiles > 0) return "changes";
  if (input.blockedCount > 0) return "blocked-only";
  return "clean";
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

const SCOPE_LABEL: Record<DepScope, string> = {
  production: "production",
  dev: "dev/test only",
  unknown: "undetermined",
};

/** A table cell: no pipes or line breaks that would split the row. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function alertLink(alert: AlertOutcome): string {
  return alert.url ? `[#${alert.number}](${alert.url})` : `#${alert.number}`;
}

const isBlocked = (copy: CopyDecision): boolean => copy.action === "blocked";
const arrow = (from: string, to?: string): string => `${from || "?"} → ${to ?? "?"}`;
const mechanism = (copy: CopyDecision): string => (copy.action === "override" ? "override" : "range bump");

/** The package a lockfile path names: whatever follows the last `node_modules/`. */
function packageOfPath(path: string): string | undefined {
  const marker = "node_modules/";
  const at = path.lastIndexOf(marker);
  return at < 0 ? undefined : path.slice(at + marker.length);
}

interface Section {
  heading: string;
  /** Text under the heading, kept with it (including a table's header rows). */
  intro: string[];
  /** Rows or bullets; the unit truncation drops. */
  items: string[];
}

/** One row per distinct change, so a package fixed in three places reads as one line with a count. */
function changeRows(alert: AlertOutcome, extra?: (alert: AlertOutcome) => string): string[] {
  const groups = new Map<string, { copy: CopyDecision; count: number }>();
  for (const copy of alert.copies.filter((c) => !isBlocked(c))) {
    const key = `${copy.action}|${copy.version}|${copy.target}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { copy, count: 1 });
  }
  return [...groups.values()].map(({ copy, count }) => {
    const change = arrow(copy.version, copy.target) + (count > 1 ? ` (${count} copies)` : "");
    const cols = [
      alertLink(alert),
      alert.severity,
      `\`${alert.packageName}\``,
      change,
      mechanism(copy),
      SCOPE_LABEL[alert.scope],
    ];
    if (extra) cols.push(extra(alert));
    return `| ${cols.map(cell).join(" | ")} |`;
  });
}

function changeTable(alerts: AlertOutcome[], extraHeader?: string, extra?: (alert: AlertOutcome) => string): Pick<Section, "intro" | "items"> {
  const head = ["Alert", "Severity", "Package", "Change", "How", "Scope"];
  if (extraHeader) head.push(extraHeader);
  return {
    intro: [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`],
    items: alerts.flatMap((a) => changeRows(a, extra)),
  };
}

function summaryLine(alerts: AlertOutcome[]): string {
  const count = (...statuses: string[]): number => alerts.filter((a) => statuses.includes(a.status)).length;
  const parts = [
    [count("fixed"), "fixed"],
    [count("partly-fixed"), "partly fixed"],
    [count("blocked"), "blocked"],
    [count("awaiting-close", "not-found"), "awaiting close or not found"],
  ] as const;
  const shown = parts.filter(([n]) => n > 0).map(([n, label]) => `**${n}** ${label}`);
  if (shown.length === 0) return "No open alerts needed attention.";
  return `Alerts: ${shown.join(", ")}.`;
}

function failureItem(failure: VerificationFailure): string {
  const name = failure.path ? packageOfPath(failure.path) : undefined;
  const where = failure.path ? (name ? ` on \`${name}\` (\`${failure.path}\`)` : ` at \`${failure.path}\``) : "";
  return `- **${failure.check}**${where}: ${failure.detail}`;
}

function blockedItems(alerts: AlertOutcome[]): string[] {
  const items: string[] = [];
  for (const alert of alerts) {
    if (alert.status !== "blocked" && alert.status !== "partly-fixed") continue;
    const lead = `${alertLink(alert)} ${alert.severity}, \`${alert.packageName}\``;
    const blocked = alert.copies.filter(isBlocked);
    if (blocked.length === 0) {
      items.push(`- ${lead}: blocked, with no detail recorded.`);
      continue;
    }
    for (const copy of blocked) {
      const at = copy.version ? ` ${copy.version}` : "";
      items.push(`- ${lead}${at} at \`${copy.path}\`: ${copy.detail ?? copy.reason ?? "blocked"}`);
    }
  }
  return items;
}

function pastDeclaredItems(alerts: AlertOutcome[]): string[] {
  const items: string[] = [];
  for (const alert of alerts) {
    for (const copy of alert.copies) {
      if (isBlocked(copy) || copy.pastDeclared.length === 0) continue;
      const dependents = copy.pastDeclared.map((d) => `\`${d.dependent}\` declares \`${d.range}\``).join("; ");
      items.push(`- ${alertLink(alert)} \`${alert.packageName}\` ${arrow(copy.version, copy.target)}: ${dependents}`);
    }
  }
  return items;
}

function awaitingItems(alerts: AlertOutcome[]): string[] {
  return alerts
    .filter((a) => a.status === "awaiting-close" || a.status === "not-found")
    .map((a) => {
      const note =
        a.status === "awaiting-close"
          ? "no installed copy is in the vulnerable range, so GitHub should close it on its next scan"
          : "not in the lockfile, so there is nothing to change here";
      return `- ${alertLink(a)} ${a.severity}, \`${a.packageName}\`: ${note}.`;
    });
}

function buildSections(report: RunReport): Section[] {
  const withStatus = (...statuses: string[]): AlertOutcome[] => report.alerts.filter((a) => statuses.includes(a.status));
  const sections: Section[] = [];

  sections.push({
    heading: "Failures",
    intro: ["The run failed verification, so no changes were kept. Each line names the check that failed and where."],
    items: report.failures.map(failureItem),
  });

  sections.push({
    heading: "Fixed",
    intro: [
      "These alerts are resolved in the lockfile. A range bump raised a direct dependency's declared range; an override pins the copy a package pulls in indirectly.",
      "",
      ...changeTable(withStatus("fixed")).intro,
    ],
    items: changeTable(withStatus("fixed")).items,
  });

  const partly = withStatus("partly-fixed");
  const partlyTable = changeTable(partly, "Still open", (a) => {
    const n = a.copies.filter(isBlocked).length;
    return `${n} of ${a.copies.length} copies blocked`;
  });
  sections.push({
    heading: "Partly fixed",
    intro: [
      "The copies below were fixed. Another copy of the same package is blocked, so the alert stays open until that is resolved. The blocked copies are listed under Blocked.",
      "",
      ...partlyTable.intro,
    ],
    items: partlyTable.items,
  });

  sections.push({
    heading: "Applied past a declared range — review these",
    intro: [
      "Each fix below installs a version outside the range a dependent declares. npm applies it anyway, but that dependent was not written against it, so check that CI passes and that the dependent still behaves.",
      "",
    ],
    items: pastDeclaredItems(report.alerts),
  });

  sections.push({
    heading: "Blocked",
    intro: [
      "The tool left these copies alone. Each needs a person to decide; the reason names the limit, pin or override that stopped it.",
      "",
    ],
    items: blockedItems(report.alerts),
  });

  sections.push({
    heading: "Awaiting close or not found",
    intro: ["Nothing to change for these alerts.", ""],
    items: awaitingItems(report.alerts),
  });

  sections.push({
    heading: "Other changes",
    intro: ["These packages moved only because a fixed package needs them.", ""],
    items: report.otherChanges.map((c) => `- \`${c.path}\`: ${c.from && c.to ? arrow(c.from, c.to) : `added at ${c.to ?? "?"}`}`),
  });

  sections.push({
    heading: "Overrides kept",
    intro: ["These existing overrides were left in place.", ""],
    items: report.keptOverrides.map((o) => `- \`${o.key}\`: ${o.reason}`),
  });

  return sections.filter((s) => s.items.length > 0);
}

function headerBlock(report: RunReport): string {
  const lines = [report.dryRun ? "# Targeted dependency fixes — plan" : "# Targeted dependency fixes", ""];
  if (report.dryRun) {
    lines.push("> **Dry run.** This is the plan of what the tool would do. Nothing was changed.", "");
  }
  if (report.outcome === "failed") {
    lines.push("> **The run failed.** No changes were kept.", "");
  }
  lines.push(summaryLine(report.alerts));
  return lines.join("\n");
}

const sectionText = (s: Section, items: string[]): string =>
  [`## ${s.heading}`, "", ...s.intro, ...items].join("\n");

// What a person must act on comes first when space runs out.
const PRIORITY = [
  "Failures",
  "Blocked",
  "Applied past a declared range — review these",
  "Partly fixed",
  "Fixed",
  "Awaiting close or not found",
  "Other changes",
  "Overrides kept",
];

export function renderMarkdown(report: RunReport, options: { full?: boolean } = {}): string {
  const header = headerBlock(report);
  const sections = buildSections(report);
  const join = (parts: string[]): string => parts.join("\n\n") + "\n";

  const whole = join([header, ...sections.map((s) => sectionText(s, s.items))]);
  if (options.full || whole.length <= MAX_BODY_CHARS) return whole;

  // Truncate: fill sections in priority order, each as far as it fits, then restore document order.
  const reserved = 400; // room for the closing note
  let budget = MAX_BODY_CHARS - header.length - reserved;
  const kept = new Map<string, string[]>();
  const incomplete: string[] = [];
  const byPriority = [...sections].sort((a, b) => PRIORITY.indexOf(a.heading) - PRIORITY.indexOf(b.heading));
  for (const section of byPriority) {
    const base = sectionText(section, []).length + 2;
    const items: string[] = [];
    let used = base;
    for (const item of section.items) {
      if (used + item.length + 1 > budget) break;
      items.push(item);
      used += item.length + 1;
    }
    if (items.length === 0) {
      incomplete.push(section.heading);
      continue;
    }
    if (items.length < section.items.length) incomplete.push(section.heading);
    kept.set(section.heading, items);
    budget -= used + 2;
  }

  const body = sections.filter((s) => kept.has(s.heading)).map((s) => sectionText(s, kept.get(s.heading)!));
  const note =
    `_This report was cut to fit GitHub's size limit. Not shown in full: ${incomplete.join(", ")}. ` +
    "The complete report is in the workflow run's job summary._";
  return join([header, ...body, note]);
}

/** Writes report.md (the PR or issue body) and report.json (what the workflow reads). */
export function writeReport(dir: string, report: RunReport): void {
  mkdirSync(dir, { recursive: true });
  const body = renderMarkdown(report);
  writeFileSync(join(dir, "report.md"), body);
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  // The cut-down body points at the job summary, so the full text has to exist for it.
  const full = renderMarkdown(report, { full: true });
  if (full !== body) writeFileSync(join(dir, "report-full.md"), full);
}
