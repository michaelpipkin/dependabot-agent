import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import type { ResolvedConfig } from "../src/config.js";
import { baseNameOfOverrideKey, computeOverrideChanges, run } from "../src/reconcile.js";
import type { DependabotAlert, VulnerablePackage } from "../src/types.js";

// Targeted mode's override keys must not change what compatible and latest do. The
// expected values here are what `main` (047f778) gives on the same input.

const KEY = "semver@>=7.0.0 <7.5.2";

const vulnerable: VulnerablePackage = {
  name: "semver",
  installedVersions: ["7.5.1"],
  patchedVersion: "7.5.4",
  severity: "high",
  scope: "production",
  foundInParents: [],
  alertNumber: 1,
  alertRanges: [{ range: ">= 7.5.0, < 7.5.4", patch: "7.5.4" }],
};

const dirs: string[] = [];
afterEach(() => {
  mock.restoreAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function alert(state: DependabotAlert["state"]): DependabotAlert {
  const vuln = {
    package: { ecosystem: "npm", name: "semver" },
    vulnerable_version_range: ">= 7.5.0, < 7.5.4",
    first_patched_version: { identifier: "7.5.4" },
  };
  return {
    number: 1,
    state,
    html_url: "https://example.test/alerts/1",
    dependency: { package: vuln.package, manifest_path: "package-lock.json", scope: "runtime" },
    security_advisory: { summary: "", severity: "high", vulnerabilities: [vuln] },
    security_vulnerability: vuln,
  };
}

/** A project holding an installed semver@7.5.1 and the override, as real as `npm ls` needs. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "compatible-keys-"));
  dirs.push(dir);
  const manifest = { name: "fx", version: "1.0.0", dependencies: { a: "^1.0.0" }, overrides: { [KEY]: ">=7.5.2" } };
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

async function compatibleRun(state: DependabotAlert["state"]): Promise<{ changes: number; logged: string; manifest: string }> {
  const dir = project();
  const manifest = readFileSync(join(dir, "package.json"), "utf-8");
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
    packages: [],
    updateWorkspaceMembers: true,
    limits: {},
  };
  // Only the alerts are real data; anything the run asks the registry gets a 404.
  mock.method(globalThis, "fetch", async (url: string | URL) =>
    String(url).includes("api.github.com") ? new Response(JSON.stringify([alert(state)]), { status: 200 }) : new Response("", { status: 404 }),
  );
  const lines: string[] = [];
  mock.method(console, "log", (message: unknown) => lines.push(String(message)));
  const result = await run(cfg);
  mock.restoreAll();
  assert.equal(readFileSync(join(dir, "package.json"), "utf-8"), manifest, "a dry run writes nothing");
  return { changes: result.overrideChanges, logged: lines.join("\n"), manifest };
}

describe("compatible and latest keep main's handling of override keys", () => {
  it("baseNameOfOverrideKey leaves a range selector whole", () => {
    assert.equal(baseNameOfOverrideKey(KEY), KEY);
    assert.equal(baseNameOfOverrideKey("@babel/core@>=7.0.0 <7.1.0"), "@babel/core@>=7.0.0 <7.1.0");
    assert.equal(baseNameOfOverrideKey("foo@<2.0.0"), "foo@<2.0.0");
    assert.equal(baseNameOfOverrideKey("js-yaml@3"), "js-yaml");
    assert.equal(baseNameOfOverrideKey("@babel/core@7"), "@babel/core");
    assert.equal(baseNameOfOverrideKey("@babel/core"), "@babel/core");
  });

  it("computeOverrideChanges, alert open: adds the package's key and leaves the range key", () => {
    const changes = computeOverrideChanges({ [KEY]: ">=7.5.2" }, [vulnerable], new Set());
    assert.deepEqual(changes.map((c) => [c.action, c.packageName]), [["add", "semver"]]);
  });

  it("computeOverrideChanges, alert fixed: no change", () => {
    assert.deepEqual(computeOverrideChanges({ [KEY]: ">=7.5.2" }, [], new Set(["semver"])), []);
  });

  it("computeOverrideChanges keeps a bare value on a range key out of the agent's hands", () => {
    assert.deepEqual(computeOverrideChanges({ "semver@>=7.0.0 <7.5.2": "7.5.2" }, [], new Set(["semver"])), []);
  });

  it("a compatible run, alert open: one key added, the range key not removed", async () => {
    const got = await compatibleRun("open");
    assert.equal(got.changes, 1);
    assert.doesNotMatch(got.logged, /semver@>=7\.0\.0 <7\.5\.2.*(?:remov|REMOVE)/i);
  });

  it("a compatible run, alert fixed: nothing changes", async () => {
    assert.equal((await compatibleRun("fixed")).changes, 0);
  });
});
