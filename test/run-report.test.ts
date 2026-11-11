import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import type { ResolvedConfig } from "../src/config.js";
import { boundedWarnings, repoPathOf, run } from "../src/reconcile.js";
import type { StrategyReport } from "../src/report/strategy-report.js";
import type { DependabotAlert } from "../src/types.js";
import { AgentError } from "../src/util.js";

// --report under compatible: a dry run over a project with one vulnerable,
// production copy of semver writes the plan as a pull request description.

const dirs: string[] = [];
afterEach(() => {
  mock.restoreAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const vuln = {
  package: { ecosystem: "npm", name: "semver" },
  vulnerable_version_range: ">= 7.5.0, < 7.5.4",
  first_patched_version: { identifier: "7.5.4" },
};

const alert: DependabotAlert = {
  number: 1,
  state: "open",
  html_url: "https://example.test/alerts/1",
  dependency: { package: vuln.package, manifest_path: "package-lock.json", scope: "runtime" },
  security_advisory: { summary: "", severity: "high", vulnerabilities: [vuln] },
  security_vulnerability: vuln,
};

/** A project holding an installed semver@7.5.1 under a runtime dependency, as real as `npm ls` needs. */
function project(): string {
  const dir = tempDir("run-report-");
  const manifest = { name: "fx", version: "1.0.0", dependencies: { a: "^1.0.0" } };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({
      name: "fx",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "fx", version: "1.0.0", dependencies: { a: "^1.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { semver: "^7.5.0" } },
        "node_modules/semver": { version: "7.5.1" },
      },
    }),
  );
  mkdirSync(join(dir, "node_modules", "a"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "a", "package.json"), JSON.stringify({ name: "a", version: "1.0.0", dependencies: { semver: "^7.5.0" } }));
  mkdirSync(join(dir, "node_modules", "semver"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "semver", "package.json"), JSON.stringify({ name: "semver", version: "7.5.1" }));
  return dir;
}

async function compatibleRun(reportDir: string): Promise<number> {
  const cfg: ResolvedConfig = {
    token: "t",
    repo: "o/r",
    owner: "o",
    name: "r",
    packageManager: "npm",
    workspaceRoot: project(),
    updateStrategy: "compatible",
    allowPrerelease: false,
    dryRun: true,
    skipUpdate: true,
    exitCode: false,
    discoverPackages: false,
    packages: [],
    updateWorkspaceMembers: true,
    limits: {},
    reportDir,
  };
  // Only the alerts are real data; anything the run asks the registry gets a 404.
  mock.method(globalThis, "fetch", async (url: string | URL) =>
    String(url).includes("api.github.com") ? new Response(JSON.stringify([alert]), { status: 200 }) : new Response("", { status: 404 }),
  );
  mock.method(console, "log", () => undefined);
  const result = await run(cfg);
  return result.overrideChanges;
}

describe("run — --report under compatible", () => {
  it("writes the plan: the deploy box and the alert, fixed by an override", async () => {
    const out = join(tempDir("run-report-out-"), "report");
    assert.equal(await compatibleRun(out), 1, "the override change still counts toward the exit code");

    const body = readFileSync(join(out, "report.md"), "utf-8");
    assert.match(body, /^# Dependency overrides reconciled — plan/);
    assert.match(body, /\*\*Deploy:\*\* fixed packages are in production code/);
    assert.match(body, /\| \[#1\]\(https:\/\/example\.test\/alerts\/1\) \| high \| `semver` \| 7\.5\.1 → .*7\.5\.4 \| override \|/);

    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf-8"));
    assert.equal(report.strategy, "compatible");
    assert.equal(report.dryRun, true);
    assert.equal(report.summary.addressed, 1);
    assert.equal(report.summary.overridesAddedOrUpdated, 1);
    assert.equal(report.summary.packagesUpdated, 0, "no update ran, so nothing counts as updated");
    assert.equal(report.deploy.outcome, "deploy");
  });

  it("compares with the start of the run outside a git repository", async () => {
    const out = join(tempDir("run-report-out-"), "report");
    await compatibleRun(out);

    const body = readFileSync(join(out, "report.md"), "utf-8");
    assert.ok(body.includes("Compared with the packages installed at the start of the run."));
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf-8"));
    assert.deepEqual(report.baseline, { kind: "run-start", fallbacks: [] });
  });

  it("names the directory when the report can't be written", async () => {
    const blocker = join(tempDir("run-report-out-"), "a-file");
    writeFileSync(blocker, "");
    const out = join(blocker, "report");
    await assert.rejects(compatibleRun(out), (e: unknown) => {
      assert.ok(e instanceof AgentError);
      assert.match(e.message, /^Could not write the report to /);
      assert.ok(e.message.includes(out));
      return true;
    });
    assert.ok(!existsSync(out));
  });
});

// The deploy recommendation compares the working copy's lockfile with a baseline
// standing for what's deployed: the last commit, or `compareTo` read from GitHub.

/** A package-lock.json whose one dependency `a` pulls in semver at `semverVersion`. */
function rootLock(semverVersion: string): string {
  return JSON.stringify({
    name: "fx",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "fx", version: "1.0.0", dependencies: { a: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { semver: "^7.5.0" } },
      "node_modules/semver": { version: semverVersion },
    },
  });
}

function writeFile(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** The root project, installed: package.json, its lockfile and node_modules, all at `semverVersion`. */
function writeRoot(dir: string, semverVersion: string): void {
  writeFile(join(dir, "package.json"), JSON.stringify({ name: "fx", version: "1.0.0", dependencies: { a: "^1.0.0" } }, null, 2) + "\n");
  writeFile(join(dir, "package-lock.json"), rootLock(semverVersion));
  writeFile(join(dir, "node_modules", "a", "package.json"), JSON.stringify({ name: "a", version: "1.0.0", dependencies: { semver: "^7.5.0" } }));
  writeFile(join(dir, "node_modules", "semver", "package.json"), JSON.stringify({ name: "semver", version: semverVersion }));
}

/** An isolated `functions/` with its own lockfile and one dependency, `b`. */
function writeFunctions(dir: string): void {
  const fn = join(dir, "functions");
  writeFile(join(fn, "package.json"), JSON.stringify({ name: "fn", version: "1.0.0", dependencies: { b: "^1.0.0" } }, null, 2) + "\n");
  writeFile(
    join(fn, "package-lock.json"),
    JSON.stringify({
      name: "fn",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "fn", version: "1.0.0", dependencies: { b: "^1.0.0" } }, "node_modules/b": { version: "1.0.0" } },
    }),
  );
  writeFile(join(fn, "node_modules", "b", "package.json"), JSON.stringify({ name: "b", version: "1.0.0" }));
}

/**
 * A git repo whose last commit has the vulnerable semver 7.5.1 and whose working copy
 * has the patched 7.5.4, uncommitted: an update made before the run. With
 * `commitPatched`, the patched state is committed too.
 */
function gitProject(options: { functions?: boolean; commitPatched?: boolean } = {}): { dir: string; sha: string } {
  const dir = tempDir("run-baseline-");
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  writeRoot(dir, "7.5.1");
  if (options.functions) writeFunctions(dir);
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  git("commit", "-q", "-m", "vulnerable");
  writeRoot(dir, "7.5.4");
  if (options.commitPatched) {
    git("add", ".");
    git("commit", "-q", "-m", "patched");
  }
  return { dir, sha: git("rev-parse", "HEAD").trim() };
}

interface BaselineRun {
  changes: number;
  body: string;
  report: StrategyReport;
  console: string;
  contentUrls: string[];
}

/** A dry compatible run over `dir`. `contents` answers the contents API by repo path; anything it lacks is a 404. */
async function baselineRun(
  dir: string,
  options: { compareTo?: string; packages?: string[]; contents?: Record<string, string> } = {},
): Promise<BaselineRun> {
  const out = join(tempDir("run-baseline-out-"), "report");
  const cfg: ResolvedConfig = {
    token: "t",
    repo: "o/r",
    owner: "o",
    name: "r",
    packageManager: "npm",
    workspaceRoot: dir,
    updateStrategy: "compatible",
    allowPrerelease: false,
    dryRun: true,
    skipUpdate: true,
    exitCode: false,
    discoverPackages: false,
    packages: options.packages ?? [],
    updateWorkspaceMembers: true,
    limits: {},
    reportDir: out,
    compareTo: options.compareTo,
  };
  const contentUrls: string[] = [];
  mock.method(globalThis, "fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/dependabot/alerts")) return new Response(JSON.stringify([alert]), { status: 200 });
    const contents = /\/contents\/([^?]+)\?ref=/.exec(url);
    if (contents) {
      contentUrls.push(url);
      const text = options.contents?.[decodeURIComponent(contents[1])];
      return text === undefined ? new Response("Not Found", { status: 404 }) : new Response(text, { status: 200 });
    }
    return new Response("", { status: 404 });
  });
  const lines: string[] = [];
  mock.method(console, "log", (msg: unknown) => {
    lines.push(String(msg));
  });
  const result = await run(cfg);
  return {
    changes: result.overrideChanges,
    body: readFileSync(join(out, "report.md"), "utf-8"),
    report: JSON.parse(readFileSync(join(out, "report.json"), "utf-8")) as StrategyReport,
    console: lines.join("\n"),
    contentUrls,
  };
}

const UPDATE_ROW = /\| \[#1\]\(https:\/\/example\.test\/alerts\/1\) \| high \| `semver` \| 7\.5\.1 → 7\.5\.4 \| update \|/;
const DEPLOY_BOX = /\*\*Deploy:\*\* fixed packages are in production code/;

describe("run — compared with the deployed baseline", () => {
  it("compares with the last commit: an uncommitted update is a fix, and the box says Deploy", async () => {
    const { dir, sha } = gitProject();
    const r = await baselineRun(dir);

    assert.ok(r.body.includes(`Compared with the last commit (\`${sha.slice(0, 7)}\`).`));
    assert.match(r.body, UPDATE_ROW);
    assert.match(r.body, DEPLOY_BOX);
    assert.deepEqual(r.report.baseline, { kind: "commit", sha, fallbacks: [] });
    assert.deepEqual(r.report.warnings, []);
    assert.equal(r.report.deploy.outcome, "deploy");
    assert.equal(r.report.summary.packagesUpdated, 1, "semver changed since the last commit");
    assert.equal(r.report.outcome, "changes", "the run still writes an override");
    assert.equal(r.changes, 1, "the override decision is unchanged");
    assert.match(r.console, /Compared with the last commit/);
    assert.match(r.console, /Recommendation: DEPLOY/);
    assert.deepEqual(r.contentUrls, [], "no compareTo, no GitHub read");
  });

  it("falls back to the last commit when compareTo can't be read, and says so", async () => {
    const { dir } = gitProject();
    const plain = await baselineRun(dir);
    mock.restoreAll();
    const r = await baselineRun(dir, { compareTo: "release" });

    const warning = `⚠️  Couldn't read package-lock.json on "release" from GitHub (404); compared with the last commit instead.`;
    assert.ok(r.console.includes(warning), "the console warns");
    assert.ok(r.body.includes(warning), "the report warns");
    assert.ok(r.body.includes("Compared with `release` on GitHub."), "the report names the baseline asked for");
    assert.deepEqual(r.report.baseline, {
      kind: "ref",
      ref: "release",
      fallbacks: [{ manifest: "root", kind: "commit", reason: "404" }],
    });
    assert.match(r.body, UPDATE_ROW, "compared with the last commit");
    assert.match(r.body, DEPLOY_BOX);
    assert.equal(r.changes, plain.changes, "exit code as without compareTo");
    assert.equal(r.report.summary.overridesAddedOrUpdated, plain.report.summary.overridesAddedOrUpdated);
  });

  it("compares with compareTo on GitHub when it can be read", async () => {
    // Everything is committed, so against the last commit there would be nothing to deploy.
    const { dir } = gitProject({ commitPatched: true });
    const r = await baselineRun(dir, { compareTo: "release", contents: { "package-lock.json": rootLock("7.5.1") } });

    assert.ok(r.body.includes("Compared with `release` on GitHub."));
    assert.deepEqual(r.report.baseline, { kind: "ref", ref: "release", fallbacks: [] });
    assert.deepEqual(r.report.warnings, []);
    assert.match(r.body, UPDATE_ROW);
    assert.match(r.body, DEPLOY_BOX);
    assert.equal(r.report.deploy.outcome, "deploy");
    assert.ok(r.contentUrls.includes("https://api.github.com/repos/o/r/contents/package-lock.json?ref=release"));
  });

  it("falls back for one manifest group alone when only its lockfile is missing on compareTo", async () => {
    const { dir } = gitProject({ functions: true });
    const r = await baselineRun(dir, {
      compareTo: "release",
      packages: ["functions"],
      contents: { "package-lock.json": rootLock("7.5.1") },
    });

    assert.deepEqual(r.report.baseline.fallbacks, [{ manifest: "functions", kind: "commit", reason: "404" }]);
    const warning = `⚠️  Couldn't read functions/package-lock.json on "release" from GitHub (404); compared with the last commit instead.`;
    assert.ok(r.body.includes(warning));
    assert.ok(r.contentUrls.includes("https://api.github.com/repos/o/r/contents/functions/package-lock.json?ref=release"));
    assert.match(r.body, DEPLOY_BOX, "the root group still compares with release");
  });

  it("compares installed trees, never a tree with a lockfile, when the working lockfile is missing", async () => {
    const { dir } = gitProject();
    rmSync(join(dir, "package-lock.json"));
    const r = await baselineRun(dir);

    assert.equal(r.report.baseline.kind, "commit");
    assert.deepEqual(r.report.baseline.fallbacks, [{ manifest: "root", kind: "run-start", reason: "not found" }]);
    assert.deepEqual(r.report.warnings, [
      "⚠️  Couldn't read the working copy's package-lock.json (not found); compared with the packages installed at the start of the run instead.",
    ]);
    // Against the start of the run, the installed 7.5.4 was already patched (1.4.0's rule).
    assert.equal(r.report.notAddressed[0]?.status, "awaiting-close");
    assert.equal(r.report.summary.addressed, 0);
    assert.equal(r.changes, 1, "the override decision is unchanged");
  });

  it("falls back to the start of the run when the baseline lockfile can't be parsed", async () => {
    const { dir } = gitProject();
    const r = await baselineRun(dir, { compareTo: "release", contents: { "package-lock.json": "<html>not a lockfile" } });

    assert.equal(r.report.baseline.fallbacks.length, 1);
    assert.equal(r.report.baseline.fallbacks[0].kind, "run-start");
    assert.match(r.report.baseline.fallbacks[0].reason, /^could not parse package-lock\.json: /);
    assert.equal(r.report.warnings.length, 1);
    assert.match(
      r.report.warnings[0],
      /^⚠️ {2}Couldn't read package-lock\.json on "release" from GitHub \(could not parse package-lock\.json: .*\); compared with the packages installed at the start of the run instead\.$/,
    );
    assert.equal(r.report.notAddressed[0]?.status, "awaiting-close");
  });
});

describe("boundedWarnings", () => {
  it("drops duplicates and keeps order", () => {
    assert.deepEqual(boundedWarnings(["a", "b", "a"]), ["a", "b"]);
  });

  it("shows at most ten, then how many more", () => {
    const many = Array.from({ length: 13 }, (_, i) => `w${i}`);
    assert.deepEqual(boundedWarnings(many), [...many.slice(0, 10), "…and 3 more"]);
  });
});

describe("repoPathOf", () => {
  it("is relative to the root with forward slashes, for a file that needn't exist", () => {
    const root = tempDir("repo-path-");
    mkdirSync(join(root, "packages", "functions"), { recursive: true });
    assert.equal(repoPathOf(root, join(root, "packages", "functions", "pnpm-lock.yaml")), "packages/functions/pnpm-lock.yaml");
    assert.equal(repoPathOf(root, join(root, "package-lock.json")), "package-lock.json");
  });
});
