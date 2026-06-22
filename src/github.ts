import { DependabotAlert } from "./types.js";
import { exitWithError, log } from "./util.js";

export interface GitHubRepoConfig {
  owner: string;
  name: string;
  token: string;
}

// ---------------------------------------------------------------------------
// Fetch open npm Dependabot alerts for a repository
// ---------------------------------------------------------------------------

export async function fetchDependabotAlerts(repo: GitHubRepoConfig): Promise<DependabotAlert[]> {
  log("📡 Fetching Dependabot alerts from GitHub...");

  const alerts: DependabotAlert[] = [];
  // Cursor-based pagination: GitHub returns a Link header with the next URL
  let nextUrl: string | null =
    `https://api.github.com/repos/${repo.owner}/${repo.name}/dependabot/alerts?state=open&ecosystem=npm&per_page=100`;

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

  log(`   Found ${alerts.length} open npm Dependabot alert(s).`);
  return alerts;
}
