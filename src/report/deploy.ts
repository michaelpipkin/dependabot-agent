import type { DepScope } from "../types.js";
import { log } from "../util.js";
import { inline } from "./markdown.js";

export interface DeployInput {
  packageName: string;
  scope: DepScope;
  /** The alert's manifest_path: repo-relative, posix. */
  manifest: string;
  /** Parent packages that pulled it in; may be `name@version`. */
  via: string[];
}

export interface DeployEntry {
  packageName: string;
  /** Where it was fixed: "root" first, then the other manifest directories, sorted. */
  places: string[];
  via: string[];
}

export type DeployOutcome = "deploy" | "no-deploy" | "check" | "none";

export interface DeployRecommendation {
  outcome: DeployOutcome;
  production: DeployEntry[];
  development: DeployEntry[];
  unknown: DeployEntry[];
  removedOverrides: string[];
}

const MAX_VIA = 5;
/** The most packages (or removed overrides) a list in the deploy box names; the header is never cut, so the box must stay small. */
export const MAX_DEPLOY_ENTRIES = 30;
const OVERRIDES_REMOVED_LINE =
  "❓ **Check before deciding:** overrides were removed, which can change installed versions at the next install";

/** "package-lock.json" is "root"; "functions/pnpm-lock.yaml" is "functions/". */
export function manifestLabel(manifestPath: string): string {
  const slash = manifestPath.lastIndexOf("/");
  return slash < 0 ? "root" : manifestPath.slice(0, slash + 1);
}

/** "name@1.2.3" to "name", keeping a leading "@scope/". */
function stripVersion(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Production over dev over unknown, as mergeScope in reconcile.ts. */
function mergeScope(a: DepScope, b: DepScope): DepScope {
  if (a === "production" || b === "production") return "production";
  if (a === "dev" || b === "dev") return "dev";
  return "unknown";
}

export function recommendDeploy(inputs: DeployInput[], removedOverrides: string[]): DeployRecommendation {
  interface Acc {
    scope: DepScope;
    places: Set<string>;
    via: Set<string>;
  }
  const byName = new Map<string, Acc>();
  for (const input of inputs) {
    let acc = byName.get(input.packageName);
    if (!acc) {
      acc = { scope: input.scope, places: new Set(), via: new Set() };
      byName.set(input.packageName, acc);
    }
    acc.scope = mergeScope(acc.scope, input.scope);
    acc.places.add(manifestLabel(input.manifest));
    for (const v of input.via) {
      // A direct dependency's path is empty or names itself; neither says what pulled it in.
      const name = stripVersion(v).trim();
      if (name !== "" && name !== input.packageName) acc.via.add(name);
    }
  }

  const production: DeployEntry[] = [];
  const development: DeployEntry[] = [];
  const unknown: DeployEntry[] = [];
  for (const [packageName, acc] of byName) {
    const rest = [...acc.places].filter((p) => p !== "root").sort();
    const entry: DeployEntry = {
      packageName,
      places: acc.places.has("root") ? ["root", ...rest] : rest,
      via: [...acc.via],
    };
    (acc.scope === "production" ? production : acc.scope === "dev" ? development : unknown).push(entry);
  }

  let outcome: DeployOutcome;
  if (production.length > 0) outcome = "deploy";
  else if (unknown.length > 0) outcome = "check";
  else if (development.length > 0) outcome = "no-deploy";
  else outcome = removedOverrides.length > 0 ? "check" : "none";

  return { outcome, production, development, unknown, removedOverrides };
}

/** A name as a code span. Backticks can't appear inside one, so they become '. */
const code = (name: string): string => `\`${name.replace(/`/g, "'").replace(/\s+/g, " ")}\``;

function joinAnd(items: string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function bullet(entry: DeployEntry): string {
  let text = code(entry.packageName);
  if (entry.via.length > 0) {
    const shown = entry.via.slice(0, MAX_VIA).map(code).join(", ");
    const more = entry.via.length - MAX_VIA;
    text += ` via ${shown}${more > 0 ? `, and ${more} more` : ""}`;
  }
  if (entry.places.length > 1) {
    text += ` (${joinAnd(entry.places.map((p) => (p === "root" ? p : code(p))))})`;
  }
  return text;
}

/** At most MAX_DEPLOY_ENTRIES names, then how many more. */
function cappedNames(names: string[]): string {
  const shown = names.slice(0, MAX_DEPLOY_ENTRIES).map(code).join(", ");
  const more = names.length - MAX_DEPLOY_ENTRIES;
  return more > 0 ? `${shown}, and ${more} more` : shown;
}

/** At most MAX_DEPLOY_ENTRIES bullets, then one line saying how many more. */
function cappedBullets(entries: DeployEntry[]): string[] {
  const lines = entries.slice(0, MAX_DEPLOY_ENTRIES).map((e) => `- ${bullet(e)}`);
  const more = entries.length - MAX_DEPLOY_ENTRIES;
  if (more > 0) lines.push(`- …and ${more} more`);
  return lines;
}

function developmentLine(rec: DeployRecommendation, prefix: string): string[] {
  if (rec.development.length === 0) return [];
  return [`${prefix}${cappedNames(rec.development.map((e) => e.packageName))}`];
}

/** An empty quote line, which ends a list inside the box. */
const BLANK = "";

/**
 * Bullets, then the development line. A line straight after a list item is a lazy
 * continuation of it in GFM, so without a blank quote line between them the
 * development names would render inside the last bullet.
 */
function bulletsThenDevelopment(entries: DeployEntry[], rec: DeployRecommendation): string[] {
  const bullets = cappedBullets(entries);
  const dev = developmentLine(rec, "Development only: ");
  return bullets.length > 0 && dev.length > 0 ? [...bullets, BLANK, ...dev] : [...bullets, ...dev];
}

/** The deploy section of a report: heading plus a GitHub alert box. Empty when there is nothing to say. */
export function renderDeploySection(rec: DeployRecommendation): string {
  if (rec.outcome === "none") return "";

  let type: string;
  let first: string;
  let body: string[];
  if (rec.outcome === "deploy") {
    type = "IMPORTANT";
    first = "🚀 **Deploy:** fixed packages are in production code";
    body = bulletsThenDevelopment(rec.production, rec);
  } else if (rec.outcome === "no-deploy") {
    type = "TIP";
    first = "✅ **No deploy needed:** every fixed package is development-only";
    body = developmentLine(rec, "");
  } else if (rec.unknown.length > 0) {
    type = "WARNING";
    first = "❓ **Check before deciding:** couldn't tell whether these reach production";
    body = bulletsThenDevelopment(rec.unknown, rec);
  } else {
    type = "WARNING";
    first = OVERRIDES_REMOVED_LINE;
    body = [`Overrides removed: ${cappedNames(rec.removedOverrides)}`];
  }

  const box = [`[!${type}]`, first, ...body].map((line) => (line === BLANK ? ">" : `> ${inline(line)}`));
  return ["## Deploy recommendation", "", ...box].join("\n");
}

function plainLine(entry: DeployEntry, marker: string): string {
  let text = `      ${marker} ${entry.packageName}`;
  if (entry.via.length > 0) text += ` — via: ${entry.via.join(", ")}`;
  if (entry.places.length > 1) text += ` (${joinAnd(entry.places)})`;
  return text;
}

/** The console version of the deploy section: the same entries as plain text. */
export function logDeployRecommendation(rec: DeployRecommendation): void {
  if (rec.outcome === "none") return;

  log("\n🚀 Deployment impact analysis:");
  if (rec.production.length > 0) {
    log("   Packages in the PRODUCTION dependency graph:");
    for (const e of rec.production) log(plainLine(e, "⚠️ "));
  }
  if (rec.development.length > 0) {
    log("   Packages in DEV/TEST dependencies only:");
    for (const e of rec.development) log(plainLine(e, "✅"));
  }
  if (rec.unknown.length > 0) {
    log("   Packages with undetermined scope (review manually):");
    for (const e of rec.unknown) log(plainLine(e, "❓"));
  }
  if (rec.removedOverrides.length > 0) {
    log(`   Overrides removed: ${rec.removedOverrides.join(", ")}`);
  }

  log("");
  if (rec.outcome === "deploy") {
    log("   🚀 Recommendation: DEPLOY — fixed packages are in production code.");
  } else if (rec.outcome === "no-deploy") {
    log("   ✅ Recommendation: NO DEPLOY NEEDED — every fixed package is development-only.");
  } else if (rec.unknown.length > 0) {
    log("   ❓ Recommendation: CHECK BEFORE DECIDING — couldn't tell whether these reach production.");
  } else {
    log("   ❓ Recommendation: CHECK BEFORE DECIDING — overrides were removed, which can change installed versions at the next install.");
  }
}
