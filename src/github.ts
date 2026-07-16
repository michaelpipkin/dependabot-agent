import { DependabotAlert } from "./types.js";
import { exitWithError, log } from "./util.js";

export interface GitHubRepoConfig {
  owner: string;
  name: string;
  token: string;
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
