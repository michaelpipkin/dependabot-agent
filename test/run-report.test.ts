import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import type { ResolvedConfig } from "../src/config.js";
import { run } from "../src/reconcile.js";
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
