import { execFileSync } from "node:child_process";
import { fetchRepoFile, type GitHubRepoConfig } from "../github.js";

/** What the working copy's lockfile is compared with: what's deployed, or the nearest stand-in. */
export type Baseline = { kind: "commit"; sha: string } | { kind: "ref"; ref: string } | { kind: "run-start" };

/** A manifest whose baseline fell back to something weaker than the rest of the run's. */
export interface BaselineFallback {
  manifest: string;
  kind: "commit" | "run-start";
  reason: string;
}

/** What report.json carries. */
export type ReportBaseline = Baseline & { fallbacks: BaselineFallback[] };

/** The baseline as it reads mid-sentence in the report and the console. */
export function baselinePhrase(b: Baseline): string {
  switch (b.kind) {
    case "commit":
      return "the last commit";
    case "ref":
      return `\`${b.ref}\``;
    case "run-start":
      return "the packages installed at the start of the run";
  }
}

/** The "Compared with ..." line of the report. */
export function comparedWithLine(b: Baseline): string {
  switch (b.kind) {
    case "commit":
      return `Compared with the last commit (\`${b.sha.slice(0, 7)}\`).`;
    case "ref":
      return `Compared with \`${b.ref}\` on GitHub.`;
    case "run-start":
      return "Compared with the packages installed at the start of the run.";
  }
}

// ---------------------------------------------------------------------------
// git (read-only: rev-parse and show, never fetch or write)
// ---------------------------------------------------------------------------

const GIT_MAX_BUFFER = 256 * 1024 * 1024; // lockfiles run to tens of MB

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: GIT_MAX_BUFFER,
  });
}

/** The repository `dir` is in and its HEAD commit; null on any failure, git missing included. */
export function gitRepoInfo(dir: string): { toplevel: string; headSha: string } | null {
  try {
    const toplevel = git(dir, ["rev-parse", "--show-toplevel"]).trim();
    const headSha = git(dir, ["rev-parse", "HEAD"]).trim();
    return toplevel && headSha ? { toplevel, headSha } : null;
  } catch {
    return null;
  }
}

/** `repoPath` (relative to the repository root) as committed at HEAD; null on any failure. */
export function gitShowFile(toplevel: string, repoPath: string): string | null {
  try {
    return git(toplevel, ["show", `HEAD:${repoPath.replace(/\\/g, "/")}`]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The fallback chain: compareTo on GitHub, else the last commit, else the run's start
// ---------------------------------------------------------------------------

export interface BaselineFiles {
  baseline: Baseline;
  /** repoPath to text, for the paths readable at the baseline level */
  texts: Map<string, string>;
  warnings: string[];
}

/**
 * Reads the baseline's copy of `repoPaths`. The first path is the lockfile and decides the
 * level; the rest (override source files) are optional, so one missing at an otherwise-good
 * level is just left out. A failed level warns and drops to the next; nothing here throws.
 */
export async function readBaselineFiles(input: {
  repo: GitHubRepoConfig | null;
  compareTo?: string;
  git: { toplevel: string; headSha: string } | null;
  repoPaths: string[];
}): Promise<BaselineFiles> {
  const { repo, compareTo, git: gitInfo, repoPaths } = input;
  const lockfile = repoPaths[0];
  const warnings: string[] = [];

  if (compareTo) {
    let reason = "no token";
    if (repo) {
      const results = await Promise.all(repoPaths.map((p) => fetchRepoFile(repo, compareTo, p)));
      if (results[0].ok) {
        const texts = new Map<string, string>();
        repoPaths.forEach((p, i) => {
          const r = results[i];
          if (r.ok) texts.set(p, r.text);
        });
        return { baseline: { kind: "ref", ref: compareTo }, texts, warnings };
      }
      reason = results[0].reason;
    }
    warnings.push(
      `⚠️  Couldn't read ${lockfile} on "${compareTo}" from GitHub (${reason}); compared with the last commit instead.`,
    );
  }

  let reason = "not a git repository";
  if (gitInfo) {
    const lockText = gitShowFile(gitInfo.toplevel, lockfile);
    if (lockText !== null) {
      const texts = new Map<string, string>([[lockfile, lockText]]);
      for (const p of repoPaths.slice(1)) {
        const text = gitShowFile(gitInfo.toplevel, p);
        if (text !== null) texts.set(p, text);
      }
      return { baseline: { kind: "commit", sha: gitInfo.headSha }, texts, warnings };
    }
    reason = "not in the last commit";
  }
  warnings.push(
    `⚠️  Couldn't read ${lockfile} from the last commit (${reason}); compared with the packages installed at the start of the run instead.`,
  );
  return { baseline: { kind: "run-start" }, texts: new Map(), warnings };
}
