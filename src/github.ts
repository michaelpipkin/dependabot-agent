import { readFileSync } from "node:fs";
import { DependabotAlert } from "./types.js";
import { exitWithError, log } from "./util.js";

export interface GitHubRepoConfig {
  owner: string;
  name: string;
  token: string;
}

// ---------------------------------------------------------------------------
// Read npm Dependabot alerts that something else fetched
// ---------------------------------------------------------------------------

function isAlert(value: unknown): boolean {
  const alert = value as Partial<DependabotAlert> | null;
  return (
    typeof alert?.number === "number" &&
    typeof alert.state === "string" &&
    typeof alert.dependency?.package?.ecosystem === "string" &&
    typeof alert.dependency.manifest_path === "string" &&
    typeof alert.security_vulnerability?.package?.name === "string"
  );
}

/**
 * The alerts in a file holding what GitHub's API returned, so the run needs no token.
 * Anything else is refused: taken for an empty list, it would read as nothing to fix.
 */
export function readDependabotAlertsFile(file: string): DependabotAlert[] {
  log(`📄 Reading Dependabot alerts from ${file}...`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    exitWithError(`Could not read the alerts file ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) {
    exitWithError(`The alerts file ${file} is not a list of alerts, as GitHub's API returns them.`);
  }
  const bad = parsed.findIndex((entry) => !isAlert(entry));
  if (bad !== -1) {
    exitWithError(`The alerts file ${file} isn't what GitHub's API returns: entry ${bad} isn't a Dependabot alert.`);
  }
  const alerts = (parsed as DependabotAlert[]).filter((a) => a.dependency.package.ecosystem === "npm");
  const openCount = alerts.filter((a) => a.state === "open").length;
  log(`   Found ${openCount} open npm Dependabot alert(s) (${alerts.length} across all states).`);
  return alerts;
}

// ---------------------------------------------------------------------------
// Fetch npm Dependabot alerts for a repository
// ---------------------------------------------------------------------------

/**
 * Fetches npm Dependabot alerts across ALL states, not just open. The caller
 * filters to open for the override decisions, but also needs the set of packages
 * that were EVER alerted: an override for a package that has never been alerted
 * is a hand-written pin the agent must not touch (README guarantee), and with a
 * state=open fetch that distinction is invisible — a resolved alert and a
 * never-existent one look identical (no open alert).
 */
export async function fetchDependabotAlerts(repo: GitHubRepoConfig): Promise<DependabotAlert[]> {
  log("📡 Fetching Dependabot alerts from GitHub...");

  const alerts: DependabotAlert[] = [];
  // Cursor-based pagination: GitHub returns a Link header with the next URL
  let nextUrl: string | null =
    `https://api.github.com/repos/${repo.owner}/${repo.name}/dependabot/alerts?ecosystem=npm&per_page=100`;

  while (nextUrl) {
    const response: Response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${repo.token}`,
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

  const openCount = alerts.filter((a) => a.state === "open").length;
  log(`   Found ${openCount} open npm Dependabot alert(s) (${alerts.length} across all states).`);
  return alerts;
}
