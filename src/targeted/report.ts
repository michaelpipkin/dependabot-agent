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
  /** Overrides taken out of package.json as no longer needed (or, in a dry run, that would be tried). */
  removedOverrides: Array<{ key: string; reason: string }>;
  failures: VerificationFailure[];
  /** What `npm --version` said when the run started, or null if it couldn't be read. */
  npmVersion: string | null;
  /** Set when the run failed and putting the files back failed too: the working tree may hold partial changes. */
  restoreError?: string;
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

// Left as written: a code span (paired backticks, matched left to right as markdown does)
// or a link, whose text is cleaned separately and whose destination is kept.
const SPAN = /`[^`]*`|\[([^\][]+)\]\(([^)\s]*)\)/g;
// A bare @name. Not preceded by a word character, so a@b.com stays an email.
const MENTION = /(?<!\w)@\w[^\s`]*/g;
// Punctuation that ends a sentence, not a name.
const TRAILING = ".,;:!?)]}'\"";

/** Text outside any span. A backtick left here is unpaired: it becomes ' so it can't open a span later. */
function plain(text: string): string {
  return text.replaceAll("`", "'").replace(MENTION, (token) => {
    let end = token.length;
    while (end > 1 && TRAILING.includes(token[end - 1])) end--;
    return `\`${token.slice(0, end)}\`${token.slice(end)}`;
  });
}

/**
 * Free text made safe for a bullet or table cell. Line breaks become spaces, so text
 * can't start a heading or a new row. A bare @name, which GitHub treats as a mention
 * and notifies, goes in backticks, so it stays copyable and tells nobody anything.
 */
export function inline(text: string): string {
  const flat = text.replace(/\r?\n|\r/g, " ");
  let out = "";
  let last = 0;
  for (const m of flat.matchAll(SPAN)) {
    out += plain(flat.slice(last, m.index));
    out += m[0].startsWith("`") ? m[0] : `[${inline(m[1])}](${m[2]})`;
    last = m.index + m[0].length;
  }
  return out + plain(flat.slice(last));
}

/** A table cell: safe free text, and no pipes that would split the row. */
function cell(text: string): string {
  return inline(text).replace(/\|/g, "\\|");
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
      `\`${alert.manifest}\``,
    ];
    if (extra) cols.push(extra(alert));
    return `| ${cols.map(cell).join(" | ")} |`;
  });
}

function changeTable(alerts: AlertOutcome[], extraHeader?: string, extra?: (alert: AlertOutcome) => string): Pick<Section, "intro" | "items"> {
  const head = ["Alert", "Severity", "Package", "Change", "How", "Scope", "Manifest"];
  if (extraHeader) head.push(extraHeader);
  return {
    intro: [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`],
    items: alerts.flatMap((a) => changeRows(a, extra)),
  };
}

function summaryLine(alerts: AlertOutcome[], planned: boolean): string {
  const count = (...statuses: string[]): number => alerts.filter((a) => statuses.includes(a.status)).length;
  const parts = [
    [count("fixed"), "fixed"],
    [count("partly-fixed"), "partly fixed"],
    [count("blocked"), "blocked"],
    [count("awaiting-close", "not-found"), "awaiting close or not found"],
  ] as const;
  const shown = parts.filter(([n]) => n > 0).map(([n, label]) => `**${n}** ${label}`);
  if (shown.length === 0) return "No open alerts needed attention.";
  return `${planned ? "Alerts in the plan, not applied" : "Alerts"}: ${shown.join(", ")}.`;
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
    const onManifest = `on \`${alert.manifest}\``;
    const blocked = alert.copies.filter(isBlocked);
    if (blocked.length === 0) {
      items.push(`- ${lead} ${onManifest}: blocked, with no detail recorded.`);
      continue;
    }
    for (const copy of blocked) {
      const version = copy.version ? ` ${copy.version}` : "";
      const where = copy.path === alert.manifest ? "" : ` at \`${copy.path}\``;
      items.push(`- ${lead}${version} ${onManifest}${where}: ${copy.detail ?? copy.reason ?? "blocked"}`);
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
      items.push(`- ${alertLink(alert)} \`${alert.packageName}\` ${arrow(copy.version, copy.target)} on \`${alert.manifest}\`: ${dependents}`);
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
          : "not in that manifest's lockfile, so there is nothing to change here";
      return `- ${alertLink(a)} ${a.severity}, \`${a.packageName}\` on \`${a.manifest}\`: ${note}.`;
    });
}

function otherChangeText(change: RunReport["otherChanges"][number]): string {
  if (change.from && change.to) return arrow(change.from, change.to);
  return change.from ? `removed (was ${change.from})` : `added at ${change.to ?? "?"}`;
}

function buildSections(report: RunReport): Section[] {
  const withStatus = (...statuses: string[]): AlertOutcome[] => report.alerts.filter((a) => statuses.includes(a.status));
  const planned = report.outcome === "failed" || report.dryRun;
  const plannedNote =
    report.outcome === "failed"
      ? "Planned, not applied: the run failed, so none of these changes were kept."
      : "Planned, not applied: this is a dry run.";
  const sections: Section[] = [];

  sections.push({
    heading: "Failures",
    intro: [
      (report.restoreError ? "The run failed, and the files could not all be restored." : "The run failed, so no changes were kept.") +
        " Each line names the check that failed and where.",
      "",
    ],
    items: report.failures.map(failureItem),
  });

  sections.push({
    heading: "Fixed",
    intro: [
      (planned
        ? `${plannedNote} `
        : "These alerts are resolved in the lockfile. ") +
        "A range bump raises a direct dependency's declared range; an override pins the copy a package pulls in indirectly.",
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
      (planned ? `${plannedNote} The copies below would be fixed. ` : "The copies below were fixed. ") +
        "Another copy of the same package is blocked, so the alert stays open until that is resolved. The blocked copies are listed under Blocked.",
      "",
      ...partlyTable.intro,
    ],
    items: partlyTable.items,
  });

  sections.push({
    heading: "Applied past a declared range — review these",
    intro: [
      (planned ? "Each fix below would install" : "Each fix below installs") +
        " a version outside the range a dependent declares. npm applies it anyway, but that dependent was not written against it, so check that CI passes and that the dependent still behaves.",
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
    intro: [`These entries ${planned ? "would also change" : "also changed"}: a fixed package needs them, or npm relocated a fixed copy to another path.`, ""],
    items: report.otherChanges.map((c) => `- \`${c.path}\`: ${otherChangeText(c)}`),
  });

  sections.push({
    heading: "Overrides removed",
    intro: [
      planned
        ? "Planned, not applied: a dry run judged these overrides no longer needed and would try to remove them. A removal is kept only if it moves no locked version."
        : "These overrides were removed from package.json: their alert is fixed, every dependent now asks for a safe version, and removing them moved no locked version.",
      "",
    ],
    items: report.removedOverrides.map((o) => `- \`${o.key}\`: ${o.reason}`),
  });

  sections.push({
    heading: "Overrides kept",
    intro: ["These existing overrides were left in place.", ""],
    items: report.keptOverrides.map((o) => `- \`${o.key}\`: ${o.reason}`),
  });

  return sections
    .filter((s) => s.items.length > 0)
    .map((s) => ({ ...s, items: s.items.map(inline) }));
}

function headerBlock(report: RunReport): string {
  const lines = [report.dryRun ? "# Targeted dependency fixes — plan" : "# Targeted dependency fixes", ""];
  if (report.dryRun) {
    lines.push("> **Dry run.** This is the plan of what the tool would do. Nothing was changed.", "");
  }
  if (report.outcome === "failed" && report.restoreError) {
    lines.push(`> **The run failed, and restoring the files failed too.** The working tree may hold partial changes: ${inline(report.restoreError)}`, "");
  } else if (report.outcome === "failed") {
    lines.push("> **The run failed.** No changes were kept.", "");
  }
  // A failed run that never got as far as planning has no alerts to summarise.
  if (report.outcome !== "failed" || report.alerts.length > 0) {
    lines.push(summaryLine(report.alerts, report.outcome === "failed" || report.dryRun));
  }
  const removed = report.removedOverrides.length;
  if (removed > 0) {
    const verb = report.dryRun ? "would be removed" : "removed";
    lines.push("", `**${removed}** override${removed === 1 ? "" : "s"} ${verb} as no longer needed.`);
  }
  if (lines.at(-1) !== "") lines.push("");
  lines.push(report.npmVersion ? `Run with npm ${report.npmVersion}.` : "npm version unknown.");
  return lines.join("\n");
}

const sectionText = (s: Section, items: string[]): string =>
  [`## ${s.heading}`, "", ...s.intro, ...items].join("\n");

// What a person must act on comes first when space runs out.
const PRIORITY = [
  "Failures",
  "Blocked",
  "Applied past a declared range — review these",
  "Overrides removed",
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
