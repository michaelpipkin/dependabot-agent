import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  baselinePhrase,
  comparedWithLine,
  gitRepoInfo,
  gitShowFile,
  readBaselineFiles,
} from "../src/baseline/source.js";
import { fetchRepoFile, type GitHubRepoConfig } from "../src/github.js";
import { parseOverridesText } from "../src/override-source.js";

const REPO: GitHubRepoConfig = { owner: "o", name: "r", token: "tok" };
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces global fetch with a stub answering from a map of path to body or status code. */
function stubFetch(answers: Record<string, string | number>): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const repoPath = decodeURIComponent(/\/contents\/([^?]+)/.exec(url)?.[1] ?? "");
    const answer = answers[repoPath] ?? 404;
    if (typeof answer === "number") return new Response("nope", { status: answer });
    return new Response(answer, { status: 200 });
  }) as typeof fetch;
  return urls;
}

/** A throwaway git repo with the given files committed; user identity is set in the repo only. */
function tempGitRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text, "utf-8");
    git("add", name);
  }
  git("commit", "-q", "-m", "init");
  return dir;
}

describe("fetchRepoFile", () => {
  it("reads the raw file from the contents API with the documented headers", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      seen = { url: String(input), headers: init?.headers as Record<string, string> };
      return new Response("lock text", { status: 200 });
    }) as typeof fetch;

    const result = await fetchRepoFile(REPO, "release", "functions/pnpm-lock.yaml");

    assert.deepEqual(result, { ok: true, text: "lock text" });
    assert.equal(seen?.url, "https://api.github.com/repos/o/r/contents/functions/pnpm-lock.yaml?ref=release");
    assert.equal(seen?.headers.Accept, "application/vnd.github.raw");
    assert.equal(seen?.headers.Authorization, "Bearer tok");
    assert.equal(seen?.headers["X-GitHub-Api-Version"], "2022-11-28");
  });

  it("URL-encodes each path segment and the ref", async () => {
    const urls = stubFetch({});
    await fetchRepoFile(REPO, "feature/a b", "my dir/pnpm-lock.yaml");
    assert.equal(urls[0], "https://api.github.com/repos/o/r/contents/my%20dir/pnpm-lock.yaml?ref=feature%2Fa%20b");
  });

  it("answers a 404 with the status as the reason", async () => {
    stubFetch({});
    assert.deepEqual(await fetchRepoFile(REPO, "release", "pnpm-lock.yaml"), { ok: false, reason: "404" });
  });

  it("answers a rejected fetch with the error message, never throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    }) as typeof fetch;
    assert.deepEqual(await fetchRepoFile(REPO, "release", "pnpm-lock.yaml"), {
      ok: false,
      reason: "getaddrinfo ENOTFOUND api.github.com",
    });
  });
});

describe("git readers", () => {
  it("gitRepoInfo returns the toplevel and HEAD sha, null outside a repo", () => {
    const dir = tempGitRepo({ "pnpm-lock.yaml": "a" });
    const info = gitRepoInfo(dir);
    assert.ok(info);
    assert.match(info.headSha, /^[0-9a-f]{40}$/);
    assert.equal(fs.realpathSync(info.toplevel), fs.realpathSync(dir));

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-nogit-"));
    assert.equal(gitRepoInfo(outside), null);
  });

  it("gitShowFile reads a committed file, including in a folder, and returns null for an uncommitted one", () => {
    const dir = tempGitRepo({ "pnpm-lock.yaml": "root lock", "functions/pnpm-lock.yaml": "functions lock" });
    fs.writeFileSync(path.join(dir, "new.txt"), "x", "utf-8");
    const info = gitRepoInfo(dir);
    assert.ok(info);
    assert.equal(gitShowFile(info.toplevel, "pnpm-lock.yaml"), "root lock");
    assert.equal(gitShowFile(info.toplevel, "functions/pnpm-lock.yaml"), "functions lock");
    assert.equal(gitShowFile(info.toplevel, "new.txt"), null);
  });
});

describe("readBaselineFiles", () => {
  it("takes the ref's files when the lockfile reads, leaving a missing optional file out without a warning", async () => {
    stubFetch({ "pnpm-lock.yaml": "ref lock" });
    const result = await readBaselineFiles({
      repo: REPO,
      compareTo: "release",
      git: null,
      repoPaths: ["pnpm-lock.yaml", "pnpm-workspace.yaml"],
    });
    assert.deepEqual(result.baseline, { kind: "ref", ref: "release" });
    assert.deepEqual([...result.texts], [["pnpm-lock.yaml", "ref lock"]]);
    assert.deepEqual(result.warnings, []);
  });

  it("falls back to the last commit when the ref's lockfile is unreadable, with one warning", async () => {
    stubFetch({ "pnpm-lock.yaml": 403 });
    const dir = tempGitRepo({ "pnpm-lock.yaml": "committed lock", "pnpm-workspace.yaml": "overrides: {}\n" });
    const git = gitRepoInfo(dir);
    assert.ok(git);

    const result = await readBaselineFiles({
      repo: REPO,
      compareTo: "release",
      git,
      repoPaths: ["pnpm-lock.yaml", "pnpm-workspace.yaml"],
    });

    assert.deepEqual(result.baseline, { kind: "commit", sha: git.headSha });
    assert.equal(result.texts.get("pnpm-lock.yaml"), "committed lock");
    assert.equal(result.texts.get("pnpm-workspace.yaml"), "overrides: {}\n");
    assert.equal(result.warnings.length, 1);
    assert.ok(
      result.warnings[0].includes(
        `Couldn't read pnpm-lock.yaml on "release" from GitHub (403); compared with the last commit instead.`,
      ),
      result.warnings[0],
    );
  });

  it("names the folder in a warning for a lockfile in a package folder", async () => {
    stubFetch({});
    const result = await readBaselineFiles({
      repo: REPO,
      compareTo: "release",
      git: null,
      repoPaths: ["functions/pnpm-lock.yaml"],
    });
    assert.ok(result.warnings[0].includes(`Couldn't read functions/pnpm-lock.yaml on "release" from GitHub (404)`));
  });

  it("falls back to the start of the run when git has nothing either, with two warnings", async () => {
    stubFetch({ "pnpm-lock.yaml": 403 });
    const result = await readBaselineFiles({
      repo: REPO,
      compareTo: "release",
      git: null,
      repoPaths: ["pnpm-lock.yaml"],
    });
    assert.deepEqual(result.baseline, { kind: "run-start" });
    assert.equal(result.texts.size, 0);
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings[0].startsWith(`⚠️  Couldn't read pnpm-lock.yaml on "release" from GitHub (403)`));
    assert.ok(
      result.warnings[1].startsWith("⚠️  Couldn't read pnpm-lock.yaml from the last commit ("),
      result.warnings[1],
    );
    assert.ok(
      result.warnings[1].endsWith("); compared with the packages installed at the start of the run instead."),
      result.warnings[1],
    );
  });

  it("falls to the start of the run when the lockfile is not in the last commit", async () => {
    const dir = tempGitRepo({ "package.json": "{}" });
    const git = gitRepoInfo(dir);
    assert.ok(git);
    const result = await readBaselineFiles({ repo: null, git, repoPaths: ["pnpm-lock.yaml"] });
    assert.deepEqual(result.baseline, { kind: "run-start" });
    assert.equal(result.warnings.length, 1);
  });

  it("treats compareTo as unreadable with reason 'no token' when there is no repo config", async () => {
    const urls = stubFetch({});
    const dir = tempGitRepo({ "pnpm-lock.yaml": "committed lock" });
    const git = gitRepoInfo(dir);
    assert.ok(git);

    const result = await readBaselineFiles({ repo: null, compareTo: "release", git, repoPaths: ["pnpm-lock.yaml"] });

    assert.equal(result.baseline.kind, "commit");
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes(`on "release" from GitHub (no token); compared with the last commit instead.`));
    assert.deepEqual(urls, []);
  });

  it("goes straight to the last commit, with no warning, when there is no compareTo", async () => {
    const dir = tempGitRepo({ "pnpm-lock.yaml": "committed lock" });
    const git = gitRepoInfo(dir);
    assert.ok(git);
    const result = await readBaselineFiles({ repo: null, git, repoPaths: ["pnpm-lock.yaml"] });
    assert.deepEqual(result.baseline, { kind: "commit", sha: git.headSha });
    assert.deepEqual(result.warnings, []);
  });

  it("reports run-start with one warning when there is no compareTo and no git", async () => {
    const result = await readBaselineFiles({ repo: null, git: null, repoPaths: ["pnpm-lock.yaml"] });
    assert.deepEqual(result.baseline, { kind: "run-start" });
    assert.equal(result.warnings.length, 1);
  });
});

describe("baseline wording", () => {
  it("baselinePhrase", () => {
    assert.equal(baselinePhrase({ kind: "commit", sha: "abcdef0123456" }), "the last commit");
    assert.equal(baselinePhrase({ kind: "ref", ref: "release" }), "`release`");
    assert.equal(baselinePhrase({ kind: "run-start" }), "the packages installed at the start of the run");
  });

  it("keeps a ref inside its code span", () => {
    assert.equal(baselinePhrase({ kind: "ref", ref: "a`b\nc" }), "`a'b c`");
    assert.equal(comparedWithLine({ kind: "ref", ref: "a`b" }), "Compared with `a'b` on GitHub.");
  });

  it("comparedWithLine", () => {
    assert.equal(
      comparedWithLine({ kind: "commit", sha: "abcdef0123456" }),
      "Compared with the last commit (`abcdef0`).",
    );
    assert.equal(comparedWithLine({ kind: "ref", ref: "release" }), "Compared with `release` on GitHub.");
    assert.equal(
      comparedWithLine({ kind: "run-start" }),
      "Compared with the packages installed at the start of the run.",
    );
  });
});

describe("parseOverridesText", () => {
  it("reads a pnpm-workspace.yaml's top-level overrides", () => {
    assert.deepEqual(parseOverridesText("pnpm-workspace.yaml", "pnpm", "overrides:\n  zod: '>=4.6.6 <5'\n"), {
      zod: ">=4.6.6 <5",
    });
  });

  it("falls back to pnpm.overrides in a pnpm-workspace.yaml that only has that", () => {
    assert.deepEqual(parseOverridesText("pnpm-workspace.yaml", "pnpm", "pnpm:\n  overrides:\n    zod: '^4.6.6'\n"), {
      zod: "^4.6.6",
    });
  });

  it("reads package.json overrides for npm, dropping nested objects", () => {
    const text = JSON.stringify({ overrides: { zod: "^4.6.6", webpack: { "loader-utils": "^2.0.4" } } });
    assert.deepEqual(parseOverridesText("package.json", "npm", text), { zod: "^4.6.6" });
  });

  it("reads package.json pnpm.overrides for pnpm, ignoring a top-level overrides key", () => {
    const text = JSON.stringify({ overrides: { other: "1" }, pnpm: { overrides: { zod: "^4.6.6" } } });
    assert.deepEqual(parseOverridesText("package.json", "pnpm", text), { zod: "^4.6.6" });
  });

  it("returns {} for unparseable text or no overrides", () => {
    assert.deepEqual(parseOverridesText("package.json", "npm", "{ not json"), {});
    assert.deepEqual(parseOverridesText("pnpm-workspace.yaml", "pnpm", "a: [unclosed"), {});
    assert.deepEqual(parseOverridesText("package.json", "npm", "{}"), {});
    assert.deepEqual(parseOverridesText("pnpm-workspace.yaml", "pnpm", ""), {});
  });
});
