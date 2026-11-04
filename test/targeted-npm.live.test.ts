import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { readDirectDependencies } from "../src/manifest.js";
import { readNpmOverrides } from "../src/override-source.js";
import { applyPlan, NpmRunner, resolveCommand, snapshotFiles } from "../src/targeted/apply.js";
import { readLockfile } from "../src/targeted/lockfile.js";
import { buildPlan, ManifestInfo, Plan } from "../src/targeted/plan.js";
import { runTargeted } from "../src/targeted/run.js";
import { DependabotAlert } from "../src/types.js";
import type { ResolvedConfig } from "../src/config.js";
import type { RunReport } from "../src/targeted/report.js";

// Real npm against the real registry. Off by default so `pnpm test` stays
// offline: run with DEPENDABOT_AGENT_LIVE_NPM=1. Projects live under os.tmpdir(),
// with lockfiles made using --before=<date> so that newer versions are available.
const LIVE = process.env.DEPENDABOT_AGENT_LIVE_NPM === "1";

const QUIET = "--ignore-scripts --no-audit --no-fund";

function npm(dir: string, args: string): void {
  execSync(`npm ${args}`, { cwd: dir, stdio: "pipe" });
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ProjectShape {
  root?: Record<string, unknown>;
  members?: Record<string, Record<string, unknown>>;
  npmrc?: string;
}

function write(dir: string, shape: ProjectShape): void {
  const members = shape.members ?? {};
  const root: Record<string, unknown> = { name: "fx", version: "1.0.0", private: true, ...shape.root };
  if (Object.keys(members).length > 0) root.workspaces = ["packages/*"];
  writeFileSync(join(dir, "package.json"), JSON.stringify(root, null, 2) + "\n");
  for (const [name, manifest] of Object.entries(members)) {
    const memberDir = join(dir, "packages", name);
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(join(memberDir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }, null, 2) + "\n");
  }
  if (shape.npmrc) writeFileSync(join(dir, ".npmrc"), shape.npmrc);
}

/** A throwaway project whose lockfile was resolved as of `before`. */
function project(before: string, shape: ProjectShape): string {
  const dir = mkdtempSync(join(tmpdir(), "targeted-live-"));
  dirs.push(dir);
  write(dir, shape);
  npm(dir, `install --before=${before} --package-lock-only ${QUIET}`);
  return dir;
}

function alert(number: number, name: string, range: string, patch: string): DependabotAlert {
  const vuln = {
    package: { ecosystem: "npm", name },
    vulnerable_version_range: range,
    first_patched_version: { identifier: patch },
  };
  return {
    number,
    state: "open",
    html_url: `https://example.test/alerts/${number}`,
    dependency: { package: vuln.package, manifest_path: "package.json", scope: "runtime" },
    security_advisory: { summary: "", severity: "high", vulnerabilities: [vuln] },
    security_vulnerability: vuln,
  };
}

function manifestsOf(dir: string): ManifestInfo[] {
  const lock = readLockfile(dir);
  const out: ManifestInfo[] = [];
  for (const entry of lock.entries.values()) {
    if (entry.link || entry.path.includes("node_modules/")) continue;
    const manifestDir = entry.path ? join(dir, entry.path) : dir;
    out.push({ dir: manifestDir, lockPath: entry.path, deps: readDirectDependencies(manifestDir) });
  }
  return out;
}

/** The real pipeline from a real lockfile. Every alert's patch counts as published. */
function planFor(dir: string, alerts: DependabotAlert[]): Plan {
  const published = new Map<string, string[] | null>();
  for (const a of alerts) {
    const name = a.security_vulnerability.package.name;
    published.set(name, [...(published.get(name) ?? []), a.security_vulnerability.first_patched_version!.identifier]);
  }
  return buildPlan({
    alerts,
    lock: readLockfile(dir),
    manifests: manifestsOf(dir),
    overrides: readNpmOverrides(dir),
    limits: {},
    published,
    updateWorkspaceMembers: true,
  });
}

const versions = (dir: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [path, entry] of readLockfile(dir).entries) if (entry.version) out.set(path, entry.version);
  return out;
};

/** Every path whose version changed, as "path: from -> to". Added or removed paths use "none". */
function movedBetween(before: Map<string, string>, after: Map<string, string>): string[] {
  const moved: string[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(path);
    const to = after.get(path);
    if (from !== to) moved.push(`${path}: ${from ?? "none"} -> ${to ?? "none"}`);
  }
  return moved.sort();
}

function counting(): { run: NpmRunner; commands: string[]; roots: Array<Record<string, unknown>> } {
  const commands: string[] = [];
  const roots: Array<Record<string, unknown>> = [];
  return {
    commands,
    roots,
    run(command, cwd) {
      commands.push(command);
      if (command === resolveCommand()) roots.push(JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8")));
      execSync(command, { cwd, stdio: "pipe" });
    },
  };
}

const resolveCount = (commands: string[]): number => commands.filter((c) => c === resolveCommand()).length;
const usedTemporaryRoot = (roots: Array<Record<string, unknown>>): boolean =>
  roots.some((r) => (r.devDependencies as Record<string, string> | undefined)?.glob !== undefined);

/** Apply and require success, naming every failure if there is one. */
function applied(dir: string, plan: Plan, run?: NpmRunner): void {
  const failures = applyPlan(dir, plan, { limits: {}, manifests: manifestsOf(dir), run });
  assert.deepEqual(failures, []);
}

const text = (dir: string, ...path: string[]): string => readFileSync(join(dir, ...path), "utf-8");
const json = (dir: string, ...path: string[]): Record<string, unknown> => JSON.parse(text(dir, ...path));

/** The root manifest as it should read if the overrides are all that changed. */
function withOverrides(original: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...JSON.parse(original), overrides };
}

const MINIMATCH_ALERT = alert(1, "minimatch", "<3.0.5", "3.0.5");
const MINIMATCH_KEY = "minimatch@>=3.0.0 <3.0.5";
const MOVED_ONE = ["node_modules/minimatch: 3.0.4 -> 3.0.5"];

describe("targeted npm, live", { skip: LIVE ? false : "set DEPENDABOT_AGENT_LIVE_NPM=1 to run" }, () => {
  it("single package: moves minimatch 3.0.4 to 3.0.5 and nothing else", () => {
    const dir = project("2020-06-01", { root: { dependencies: { glob: "^7.1.6" } } });
    const before = versions(dir);
    const plan = planFor(dir, [MINIMATCH_ALERT]);
    assert.deepEqual(plan.addOverrides, { [MINIMATCH_KEY]: "3.0.5" });

    const { run, roots } = counting();
    applied(dir, plan, run);

    assert.deepEqual(movedBetween(before, versions(dir)), MOVED_ONE);
    assert.equal(usedTemporaryRoot(roots), false);
    npm(dir, `ci ${QUIET}`);
  });

  it("workspace, member only: same result through the temporary-root step, manifests otherwise unchanged", () => {
    const dir = project("2020-06-01", { members: { a: { dependencies: { glob: "^7.1.6" } } } });
    const before = versions(dir);
    const rootText = text(dir, "package.json");
    const memberText = text(dir, "packages", "a", "package.json");
    const plan = planFor(dir, [MINIMATCH_ALERT]);

    const { run, roots } = counting();
    applied(dir, plan, run);

    assert.equal(usedTemporaryRoot(roots), true, "the temporary-root step should have run");
    assert.deepEqual(movedBetween(before, versions(dir)), MOVED_ONE);
    assert.deepEqual(json(dir, "package.json"), withOverrides(rootText, { [MINIMATCH_KEY]: "3.0.5" }));
    assert.equal(text(dir, "packages", "a", "package.json"), memberText);
    npm(dir, `ci ${QUIET}`);
  });

  it("workspace, reachable from root: no temporary-root step needed", () => {
    const dir = project("2020-06-01", {
      root: { devDependencies: { glob: "^7.1.6" } },
      members: { a: { dependencies: { glob: "^7.1.6" } } },
    });
    const before = versions(dir);
    const plan = planFor(dir, [MINIMATCH_ALERT]);

    const { run, commands } = counting();
    applied(dir, plan, run);

    assert.equal(resolveCount(commands), 2, "first resolve and the stability check");
    assert.deepEqual(movedBetween(before, versions(dir)), MOVED_ONE);
    npm(dir, `ci ${QUIET}`);
  });

  it("workspace, members declaring different ranges of the owner", () => {
    const dir = project("2020-06-01", {
      members: { a: { dependencies: { glob: "^7.1.6" } }, b: { dependencies: { glob: "^6.0.4" } } },
    });
    const before = versions(dir);
    applied(dir, planFor(dir, [MINIMATCH_ALERT]));
    assert.deepEqual(movedBetween(before, versions(dir)), MOVED_ONE);
    npm(dir, `ci ${QUIET}`);
  });

  it("workspace, a member reaching the target through a sibling member", () => {
    const dir = project("2020-06-01", {
      members: { a: { dependencies: { b: "^1.0.0" } }, b: { dependencies: { glob: "^7.1.6" } } },
    });
    const before = versions(dir);
    const { run, roots } = counting();
    applied(dir, planFor(dir, [MINIMATCH_ALERT]), run);

    assert.deepEqual(movedBetween(before, versions(dir)), MOVED_ONE);
    assert.deepEqual(roots[1].devDependencies, { glob: "^7.1.6" });
    npm(dir, `ci ${QUIET}`);
  });

  it("two majors: each line moves within itself", () => {
    const dir = project("2023-06-01", { root: { dependencies: { glob: "^7.1.6", filelist: "^1.0.4" } } });
    const before = versions(dir);
    const plan = planFor(dir, [alert(1, "minimatch", "<3.1.3", "3.1.3"), alert(2, "minimatch", ">=5.0.0, <5.1.7", "5.1.7")]);
    assert.deepEqual(plan.addOverrides, { "minimatch@>=3.0.0 <3.1.3": "3.1.3", "minimatch@>=5.0.0 <5.1.7": "5.1.7" });

    applied(dir, plan);

    assert.deepEqual(movedBetween(before, versions(dir)), [
      "node_modules/glob/node_modules/minimatch: 3.1.2 -> 3.1.3",
      "node_modules/minimatch: 5.1.6 -> 5.1.7",
    ]);
    npm(dir, `ci ${QUIET}`);
  });

  it("two majors, member only: each line moves within itself", () => {
    const dir = project("2023-06-01", { members: { a: { dependencies: { glob: "^7.1.6", filelist: "^1.0.4" } } } });
    const before = versions(dir);
    applied(dir, planFor(dir, [alert(1, "minimatch", "<3.1.3", "3.1.3"), alert(2, "minimatch", ">=5.0.0, <5.1.7", "5.1.7")]));
    assert.deepEqual(movedBetween(before, versions(dir)), [
      "node_modules/glob/node_modules/minimatch: 3.1.2 -> 3.1.3",
      "node_modules/minimatch: 5.1.6 -> 5.1.7",
    ]);
    npm(dir, `ci ${QUIET}`);
  });

  it("direct bump with ~ in a member: chalk ~4.0.0 becomes ~4.1.2", () => {
    const dir = project("2020-05-01", { members: { a: { dependencies: { chalk: "~4.0.0" } } } });
    const plan = planFor(dir, [alert(1, "chalk", "<4.1.2", "4.1.2")]);
    assert.equal(plan.bumps.length, 1);

    applied(dir, plan);

    assert.deepEqual(json(dir, "packages", "a", "package.json").dependencies, { chalk: "~4.1.2" });
    assert.equal(versions(dir).get("node_modules/chalk"), "4.1.2");
    assert.equal(json(dir, "package.json").overrides, undefined);
    npm(dir, `ci ${QUIET}`);
  });

  it("direct bump with ^ through a real shell, with .npmrc pulling the other way", () => {
    const dir = project("2020-05-01", {
      root: { devDependencies: { chalk: "^4.0.0" } },
      npmrc: "save-exact=true\nsave-prefix=~\n",
    });
    const plan = planFor(dir, [alert(1, "chalk", "<4.1.2", "4.1.2")]);

    applied(dir, plan);

    assert.deepEqual(json(dir, "package.json").devDependencies, { chalk: "^4.1.2" });
    assert.equal(versions(dir).get("node_modules/chalk"), "4.1.2");
    npm(dir, `ci ${QUIET}`);
  });

  it("direct bump with ~, with .npmrc pulling the other way", () => {
    const dir = project("2020-05-01", {
      root: { dependencies: { chalk: "~4.0.0" } },
      npmrc: "save-exact=true\nsave-prefix=^\n",
    });
    applied(dir, planFor(dir, [alert(1, "chalk", "<4.1.2", "4.1.2")]));
    assert.deepEqual(json(dir, "package.json").dependencies, { chalk: "~4.1.2" });
  });

  it("a safe copy moved by a too-high target: returns a nothing-else-moved failure", () => {
    // Two copies on one line: globule's minimatch 3.0.4 (it declares ~3.0.2), and
    // 3.1.2 under recursive-readdir, safe from an alert that stops at 3.0.5.
    const dir = project("2020-06-01", { members: { a: { dependencies: { globule: "1.3.1" } } } });
    write(dir, { members: { a: { dependencies: { globule: "1.3.1", "recursive-readdir": "2.2.3" } } } });
    npm(dir, `install --before=2023-06-01 --package-lock-only ${QUIET}`);
    const before = versions(dir);
    const safe = "node_modules/recursive-readdir/node_modules/minimatch";
    assert.equal(before.get("node_modules/minimatch"), "3.0.4");
    assert.equal(before.get(safe), "3.1.2");

    // The plan refuses to write this key. A plan that did is what check 2 is for.
    const refused = planFor(dir, [alert(1, "minimatch", "<3.0.5", "3.1.3")]);
    assert.deepEqual(refused.addOverrides, {});
    assert.equal(refused.alerts[0].copies[0].reason, "selector-conflict");

    const tooHigh: Plan = {
      alerts: [],
      bumps: [],
      addOverrides: { "minimatch@>=3.0.0 <3.1.3": "3.1.3" },
      removeOverrideKeys: [],
      targets: new Map([["node_modules/minimatch", "3.1.3"]]),
    };
    const failures = applyPlan(dir, tooHigh, { limits: {}, manifests: manifestsOf(dir) });
    assert.ok(
      failures.some((f) => f.check === "nothing-else-moved" && f.path === safe),
      JSON.stringify(failures),
    );
  });

  it("a target that brings new bundled packages fails verification, rather than a lockfile that lies about them", () => {
    // npm bundles its dependencies, and 8.1.2's bundle differs from 8.1.0's. Putting
    // those entries back passed every check while `npm ci` installed something else.
    const dir = project("2030-01-01", { root: { dependencies: { npm: "8.1.0" } } });
    write(dir, { root: { dependencies: { npm: "^8.1.0" } } });
    npm(dir, `install --package-lock-only ${QUIET}`);
    assert.equal(versions(dir).get("node_modules/npm"), "8.1.0");

    const failures = applyPlan(dir, planFor(dir, [alert(1, "npm", "<8.1.2", "8.1.2")]), { limits: {}, manifests: manifestsOf(dir) });

    assert.ok(
      failures.some((f) => f.check === "nothing-else-moved" && f.path?.startsWith("node_modules/npm/node_modules/")),
      JSON.stringify(failures.slice(0, 3)),
    );
  });

  describe("a package npm refetches because only a replaced package used it", () => {
    // balanced-match is used only by brace-expansion. Replacing brace-expansion made
    // npm fetch it again at the newest ^1.0.0, which the policy doesn't allow.
    const alerts = [alert(1, "minimatch", "<3.1.4", "3.1.4"), alert(2, "brace-expansion", "<1.1.21", "1.1.21")];
    const MOVED = ["node_modules/brace-expansion: 1.1.11 -> 1.1.21", "node_modules/minimatch: 3.0.4 -> 3.1.4"];
    const shapes: Array<[string, ProjectShape]> = [
      ["reachable from the root", { root: { dependencies: { glob: "^7.1.6" } } }],
      ["reachable only through a member", { members: { a: { dependencies: { glob: "^7.1.6" } } } }],
    ];

    for (const [label, shape] of shapes) {
      it(`${label}: stays where it was, and the tree holds`, () => {
        const dir = project("2020-06-01", shape);
        const before = versions(dir);
        assert.equal(before.get("node_modules/balanced-match"), "1.0.0");

        applied(dir, planFor(dir, alerts));

        const after = versions(dir);
        assert.deepEqual(movedBetween(before, after), MOVED);
        npm(dir, `install --package-lock-only ${QUIET}`);
        assert.deepEqual(movedBetween(after, versions(dir)), []);
        npm(dir, `ci ${QUIET}`);
      });
    }
  });

  describe("must be proven, item 3: a later npm install keeps the versions", () => {
    function holds(dir: string, plan: Plan, moved: string[]): void {
      const before = versions(dir);
      applied(dir, plan);
      const after = versions(dir);
      assert.deepEqual(movedBetween(before, after), moved);
      const lockText = text(dir, "package-lock.json");

      npm(dir, `ci ${QUIET}`);
      assert.equal(json(dir, "node_modules", "minimatch", "package.json").version, "3.0.5");

      npm(dir, `install ${QUIET}`);
      assert.equal(text(dir, "package-lock.json"), lockText, "npm install with node_modules present");
      assert.equal(json(dir, "node_modules", "minimatch", "package.json").version, "3.0.5");

      rmSync(join(dir, "node_modules"), { recursive: true, force: true });
      npm(dir, `install ${QUIET}`);
      assert.equal(text(dir, "package-lock.json"), lockText, "npm install with no node_modules");
      assert.equal(json(dir, "node_modules", "minimatch", "package.json").version, "3.0.5");
    }

    it("single package", () => {
      const dir = project("2020-06-01", { root: { dependencies: { glob: "^7.1.6" } } });
      holds(dir, planFor(dir, [MINIMATCH_ALERT]), MOVED_ONE);
    });

    it("workspace, member only", () => {
      const dir = project("2020-06-01", { members: { a: { dependencies: { glob: "^7.1.6" } } } });
      holds(dir, planFor(dir, [MINIMATCH_ALERT]), MOVED_ONE);
    });
  });

  describe("must be proven, item 4: a member's exact pin overlapping a selector", () => {
    const forced: () => Plan = () => ({
      alerts: [],
      bumps: [],
      addOverrides: { [MINIMATCH_KEY]: "3.0.5" },
      removeOverrideKeys: [],
      targets: new Map([["node_modules/minimatch", "3.0.5"]]),
    });

    it("the plan blocks the pin and writes no override, so the pin stays", () => {
      const dir = project("2020-06-01", {
        members: { a: { dependencies: { minimatch: "3.0.4" } }, b: { dependencies: { glob: "^7.1.6" } } },
      });
      const before = versions(dir);
      const plan = planFor(dir, [MINIMATCH_ALERT]);
      assert.deepEqual(plan.addOverrides, {});
      assert.equal(plan.alerts[0].status, "blocked");
      assert.equal(plan.alerts[0].copies[0].reason, "pin");

      const { run, commands } = counting();
      applied(dir, plan, run);
      assert.deepEqual(commands, [], "a plan with no changes runs no npm command");
      assert.deepEqual(movedBetween(before, versions(dir)), []);
      assert.deepEqual(json(dir, "packages", "a", "package.json").dependencies, { minimatch: "3.0.4" });
    });

    it("verification stops a plan that would have moved the pin anyway", () => {
      const dir = project("2020-06-01", {
        members: { a: { dependencies: { minimatch: "3.0.4" } }, b: { dependencies: { glob: "^7.1.6" } } },
      });
      const snapshot = snapshotFiles([join(dir, "package.json"), join(dir, "package-lock.json")]);
      const failures = applyPlan(dir, forced(), { limits: {}, manifests: manifestsOf(dir) });
      // From npm 11.14 it moves the pinned copy, leaving the member's manifest saying
      // 3.0.4 and `npm ci` content. This check is all that stops it reaching a PR.
      // Earlier versions leave the copy alone, so the plan's fix is what fails.
      const moved = versions(dir).get("node_modules/minimatch") === "3.0.5";
      assert.deepEqual(
        failures.map((f) => f.check),
        moved ? ["pins-held"] : ["fixed"],
      );
      snapshot.restore();
      assert.equal(versions(dir).get("node_modules/minimatch"), "3.0.4");
    });
  });

  describe("must be proven, item 5: existing overrides", () => {
    it("replaces a floating override with the new key shape", () => {
      const dir = project("2020-06-01", {
        root: { dependencies: { glob: "^7.1.6" }, overrides: { minimatch: ">=3.0.0" } },
      });
      const before = versions(dir);
      const plan = planFor(dir, [MINIMATCH_ALERT]);
      assert.deepEqual(plan.removeOverrideKeys, ["minimatch"]);
      assert.deepEqual(plan.addOverrides, { [MINIMATCH_KEY]: "3.0.5" });

      applied(dir, plan);

      assert.deepEqual(json(dir, "package.json").overrides, { [MINIMATCH_KEY]: "3.0.5" });
      assert.deepEqual(movedBetween(before, versions(dir)), MOVED_ONE);
      npm(dir, `ci ${QUIET}`);
    });

    it("replaces a floating override, member only", () => {
      const dir = project("2020-06-01", {
        root: { overrides: { minimatch: ">=3.0.0" } },
        members: { a: { dependencies: { glob: "^7.1.6" } } },
      });
      const before = versions(dir);
      applied(dir, planFor(dir, [MINIMATCH_ALERT]));
      assert.deepEqual(json(dir, "package.json").overrides, { [MINIMATCH_KEY]: "3.0.5" });
      assert.deepEqual(movedBetween(before, versions(dir)), MOVED_ONE);
      npm(dir, `ci ${QUIET}`);
    });

    for (const key of ["chalk", "chalk@4"]) {
      it(`replaces ${key}: ">=4.0.0" while bumping a member's direct dependency, which it must not steer`, () => {
        const dir = project("2020-05-01", { members: { a: { dependencies: { chalk: "^4.0.0" } } } });
        const rootManifest = json(dir, "package.json");
        writeFileSync(join(dir, "package.json"), JSON.stringify({ ...rootManifest, overrides: { [key]: ">=4.0.0" } }, null, 2) + "\n");
        const before = versions(dir);
        const plan = planFor(dir, [alert(1, "chalk", "<4.1.2", "4.1.2")]);
        assert.deepEqual(plan.removeOverrideKeys, [key]);
        assert.equal(plan.bumps.length, 1);

        applied(dir, plan);

        assert.deepEqual(movedBetween(before, versions(dir)), ["node_modules/chalk: 4.0.0 -> 4.1.2"]);
        assert.deepEqual(json(dir, "packages", "a", "package.json").dependencies, { chalk: "^4.1.2" });
        assert.deepEqual(json(dir, "package.json").overrides, plan.addOverrides);
        npm(dir, `ci ${QUIET}`);
      });
    }

    it("writes a selector beside an existing selector for the same package", () => {
      const dir = project("2023-06-01", { root: { dependencies: { glob: "^7.1.6", filelist: "^1.0.4" } } });
      applied(dir, planFor(dir, [alert(2, "minimatch", ">=5.0.0, <5.1.7", "5.1.7")]));
      assert.equal(versions(dir).get("node_modules/minimatch"), "5.1.7");
      assert.equal(versions(dir).get("node_modules/glob/node_modules/minimatch"), "3.1.2");

      const before = versions(dir);
      const plan = planFor(dir, [alert(1, "minimatch", "<3.1.3", "3.1.3")]);
      assert.deepEqual(plan.removeOverrideKeys, []);
      applied(dir, plan);

      assert.deepEqual(json(dir, "package.json").overrides, {
        "minimatch@>=3.0.0 <3.1.3": "3.1.3",
        "minimatch@>=5.0.0 <5.1.7": "5.1.7",
      });
      assert.deepEqual(movedBetween(before, versions(dir)), ["node_modules/glob/node_modules/minimatch: 3.1.2 -> 3.1.3"]);
      npm(dir, `ci ${QUIET}`);
    });

    it("writes a selector beside an existing floating selector for the same package", () => {
      const dir = project("2023-06-01", {
        root: { dependencies: { glob: "^7.1.6", filelist: "^1.0.4" }, overrides: { "minimatch@5": ">=5.1.6" } },
      });
      const before = versions(dir);
      const plan = planFor(dir, [alert(1, "minimatch", "<3.1.3", "3.1.3")]);
      assert.deepEqual(plan.removeOverrideKeys, []);

      applied(dir, plan);

      assert.deepEqual(json(dir, "package.json").overrides, { "minimatch@5": ">=5.1.6", "minimatch@>=3.0.0 <3.1.3": "3.1.3" });
      assert.deepEqual(movedBetween(before, versions(dir)), ["node_modules/glob/node_modules/minimatch: 3.1.2 -> 3.1.3"]);
      npm(dir, `ci ${QUIET}`);
    });
  });

  describe("a target reachable only through a member's weaker edge", () => {
    for (const [label, field] of [
      ["peer", "peerDependencies"],
      ["optional", "optionalDependencies"],
    ]) {
      it(`${label}: moves through the temporary-root step, manifests otherwise unchanged`, () => {
        const dir = project("2020-06-01", { members: { a: { [field]: { glob: "^7.1.6" } } } });
        const before = versions(dir);
        const rootText = text(dir, "package.json");
        const memberText = text(dir, "packages", "a", "package.json");

        const { run, roots } = counting();
        applied(dir, planFor(dir, [MINIMATCH_ALERT]), run);

        assert.equal(usedTemporaryRoot(roots), true);
        assert.deepEqual(movedBetween(before, versions(dir)), MOVED_ONE);
        assert.deepEqual(json(dir, "package.json"), withOverrides(rootText, { [MINIMATCH_KEY]: "3.0.5" }));
        assert.equal(text(dir, "packages", "a", "package.json"), memberText);
        npm(dir, `ci ${QUIET}`);
      });
    }
  });

  describe("formatting of the root manifest", () => {
    /** Tabs, CRLF, no trailing newline. */
    const tabbed = (value: unknown): string => JSON.stringify(value, null, "\t").replaceAll("\n", "\r\n");

    it("override only, single package: the resolves leave the bytes as written", () => {
      const dir = project("2020-06-01", { root: { dependencies: { glob: "^7.1.6" } } });
      const original = json(dir, "package.json");
      writeFileSync(join(dir, "package.json"), tabbed(original));
      applied(dir, planFor(dir, [MINIMATCH_ALERT]));
      assert.equal(text(dir, "package.json"), tabbed({ ...original, overrides: { [MINIMATCH_KEY]: "3.0.5" } }));
    });

    it("override only, member only: the temporary-root step leaves the bytes as written", () => {
      const dir = project("2020-06-01", { members: { a: { dependencies: { glob: "^7.1.6" } } } });
      const original = json(dir, "package.json");
      writeFileSync(join(dir, "package.json"), tabbed(original));
      const { run, roots } = counting();
      applied(dir, planFor(dir, [MINIMATCH_ALERT]), run);
      assert.equal(usedTemporaryRoot(roots), true);
      assert.equal(text(dir, "package.json"), tabbed({ ...original, overrides: { [MINIMATCH_KEY]: "3.0.5" } }));
    });

    it("a bump: npm keeps the indent and line endings, but adds a trailing newline", () => {
      const dir = project("2020-05-01", { root: { dependencies: { chalk: "~4.0.0" } } });
      const original = json(dir, "package.json");
      writeFileSync(join(dir, "package.json"), tabbed(original));
      applied(dir, planFor(dir, [alert(1, "chalk", "<4.1.2", "4.1.2")]));
      assert.equal(text(dir, "package.json"), tabbed({ ...original, dependencies: { chalk: "~4.1.2" } }) + "\r\n");
    });

    it("a member's bump leaves the root alone", () => {
      const dir = project("2020-05-01", { members: { a: { dependencies: { chalk: "~4.0.0" } } } });
      const original = tabbed(json(dir, "package.json"));
      writeFileSync(join(dir, "package.json"), original);
      applied(dir, planFor(dir, [alert(1, "chalk", "<4.1.2", "4.1.2")]));
      assert.equal(text(dir, "package.json"), original);
    });
  });

  describe("a target nested in a member, under the range that lost", () => {
    const shape = { members: { a: { dependencies: { glob: "^7.1.6" } }, b: { dependencies: { glob: "^8.0.0" } } } };

    it("the plan blocks that copy, fixes the one it can reach, and applying finds no failures", () => {
      const dir = project("2023-06-01", shape);
      const before = versions(dir);
      const nestedCopy = "packages/b/node_modules/minimatch";
      assert.equal(before.get(nestedCopy), "5.1.6");
      assert.equal(before.get("node_modules/minimatch"), "3.1.2");

      const plan = planFor(dir, [alert(2, "minimatch", ">=5.0.0, <5.1.7", "5.1.7"), alert(1, "minimatch", "<3.1.3", "3.1.3")]);
      assert.deepEqual(
        plan.alerts.map((a) => a.status),
        ["blocked", "fixed"],
      );
      assert.equal(plan.alerts[0].copies[0].path, nestedCopy);
      assert.equal(plan.alerts[0].copies[0].reason, "selector-conflict");
      assert.deepEqual(plan.addOverrides, { "minimatch@>=3.0.0 <3.1.3": "3.1.3" });

      applied(dir, plan);

      assert.deepEqual(movedBetween(before, versions(dir)), ["node_modules/minimatch: 3.1.2 -> 3.1.3"]);
      npm(dir, `ci ${QUIET}`);
    });

    it("with only the blocked alert open, there's nothing to run", () => {
      const dir = project("2023-06-01", shape);
      const before = versions(dir);
      const plan = planFor(dir, [alert(2, "minimatch", ">=5.0.0, <5.1.7", "5.1.7")]);
      assert.equal(plan.alerts[0].status, "blocked");

      const { run, commands } = counting();
      applied(dir, plan, run);
      assert.deepEqual(commands, []);
      assert.deepEqual(movedBetween(before, versions(dir)), []);
    });
  });

  describe("a manifest's version ahead of the lock", () => {
    const ahead = (dir: string, ...path: string[]): void => {
      const manifest = json(dir, ...path);
      writeFileSync(join(dir, ...path), JSON.stringify({ ...manifest, version: "1.0.1" }, null, 2) + "\n");
    };

    it("root, with a real fix to apply", () => {
      const dir = project("2020-06-01", { members: { a: { dependencies: { glob: "^7.1.6" } } } });
      const before = versions(dir);
      const plan = planFor(dir, [MINIMATCH_ALERT]);
      ahead(dir, "package.json");
      applied(dir, plan);
      assert.deepEqual(movedBetween(before, versions(dir)), [": 1.0.0 -> 1.0.1", ...MOVED_ONE]);
    });

    it("member, with a real fix to apply", () => {
      const dir = project("2020-06-01", { members: { a: { dependencies: { glob: "^7.1.6" } } } });
      const before = versions(dir);
      const plan = planFor(dir, [MINIMATCH_ALERT]);
      ahead(dir, "packages", "a", "package.json");
      applied(dir, plan);
      assert.deepEqual(movedBetween(before, versions(dir)), [...MOVED_ONE, "packages/a: 1.0.0 -> 1.0.1"]);
    });
  });

  it("a real non-zero exit from npm comes back as a failure", () => {
    const dir = project("2020-05-01", { root: { dependencies: { chalk: "^4.0.0" } } });
    const plan = planFor(dir, [alert(1, "chalk", "<4.1.2", "4.1.2")]);
    plan.bumps[0].target = "99.99.99";
    const failures = applyPlan(dir, plan, { limits: {}, manifests: manifestsOf(dir) });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].check, "run");
    assert.match(failures[0].detail, /chalk@99\.99\.99/);
    assert.match(failures[0].detail, /npm error code ETARGET/);
    assert.doesNotMatch(failures[0].detail, /complete log/);
  });

  it("a package declared in both dependencies and devDependencies is blocked before npm can drop one", () => {
    const dir = project("2020-05-01", { root: { dependencies: { chalk: "^4.0.0" }, devDependencies: { chalk: "^4.0.0" } } });
    const rootText = text(dir, "package.json");
    const before = versions(dir);
    const plan = planFor(dir, [alert(1, "chalk", "<4.1.2", "4.1.2")]);
    assert.equal(plan.alerts[0].copies[0].reason, "unrewritable-spec");
    assert.deepEqual(plan.bumps, []);

    const { run, commands } = counting();
    applied(dir, plan, run);
    assert.deepEqual(commands, [], "a plan with no changes runs no npm command");
    assert.equal(text(dir, "package.json"), rootText);
    assert.deepEqual(movedBetween(before, versions(dir)), []);

    // Why: npm "removes dependencies.chalk in favor of devDependencies.chalk" as it
    // saves. A production dependency turning dev-only is what the manifests check
    // is the backstop for, should a plan ever ask for it.
    const forced: Plan = {
      alerts: [],
      bumps: [{ manifestDir: dir, memberPath: null, name: "chalk", field: "dependencies", from: "^4.0.0", operator: "^", target: "4.1.2" }],
      addOverrides: {},
      removeOverrideKeys: [],
      targets: new Map([["node_modules/chalk", "4.1.2"]]),
    };
    const failures = applyPlan(dir, forced, { limits: {}, manifests: manifestsOf(dir) });
    assert.ok(
      failures.some((f) => f.check === "manifests" && f.detail === 'dependencies "chalk": "^4.0.0" went missing during the run.'),
      JSON.stringify(failures),
    );
  });

  describe("runTargeted, the whole run", () => {
    // Only the alerts are injected. npm and the npm registry are real.
    beforeEach(() => {
      mock.method(console, "log", () => {});
    });
    afterEach(() => {
      mock.restoreAll();
    });

    /** A member at apps/web/site under a glob no workspace reader resolves, with its own manifest. */
    function unseenMemberProject(rootDeps: Record<string, string>, memberDeps: Record<string, string>, workspaces: string[] = ["apps/**"], at = "apps/web/site"): string {
      const dir = mkdtempSync(join(tmpdir(), "targeted-live-"));
      dirs.push(dir);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fx", version: "1.0.0", private: true, workspaces, dependencies: rootDeps }, null, 2) + "\n");
      mkdirSync(join(dir, at), { recursive: true });
      writeFileSync(join(dir, at, "package.json"), JSON.stringify({ name: "site", version: "1.0.0", dependencies: memberDeps }, null, 2) + "\n");
      npm(dir, `install --before=2020-06-01 --package-lock-only ${QUIET}`);
      return dir;
    }

    it("a member under apps/** that pins the copy keeps it, though the root reaches the same copy", async () => {
      const dir = unseenMemberProject({ glob: "^7.1.6" }, { minimatch: "3.0.4" });
      const reportDir = mkdtempSync(join(tmpdir(), "targeted-live-report-"));
      dirs.push(reportDir);
      const lockBefore = text(dir, "package-lock.json");
      const memberBefore = text(dir, "apps", "web", "site", "package.json");

      await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => [MINIMATCH_ALERT] });

      const r = report(reportDir);
      assert.equal(r.outcome, "blocked-only");
      assert.equal(r.alerts[0].status, "blocked");
      assert.equal(r.alerts[0].copies[0].reason, "pin");
      assert.equal(json(dir, "package.json").overrides, undefined);
      assert.equal(text(dir, "package-lock.json"), lockBefore);
      assert.equal(text(dir, "apps", "web", "site", "package.json"), memberBefore);
    });

    it("a member-only ^3.0.4 under apps/** is bumped with -w", async () => {
      const dir = unseenMemberProject({}, { minimatch: "^3.0.4" });
      const reportDir = mkdtempSync(join(tmpdir(), "targeted-live-report-"));
      dirs.push(reportDir);

      await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => [MINIMATCH_ALERT] });

      assert.equal(report(reportDir).outcome, "changes");
      assert.deepEqual(json(dir, "apps", "web", "site", "package.json").dependencies, { minimatch: "^3.0.5" });
      assert.equal(json(dir, "package.json").overrides, undefined);
      assert.equal(versions(dir).get("node_modules/minimatch"), "3.0.5");
      npm(dir, `ci ${QUIET}`);
    });

    it("a copy reached only through a member under apps/** goes through the temporary-root step", async () => {
      const dir = unseenMemberProject({}, { glob: "^7.1.6" });
      const reportDir = mkdtempSync(join(tmpdir(), "targeted-live-report-"));
      dirs.push(reportDir);
      const rootBefore = json(dir, "package.json");

      await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => [MINIMATCH_ALERT] });

      assert.deepEqual(report(reportDir).failures, []);
      assert.deepEqual(json(dir, "package.json"), { ...rootBefore, overrides: { [MINIMATCH_KEY]: "3.0.5" } });
      assert.equal(versions(dir).get("node_modules/minimatch"), "3.0.5");
      npm(dir, `ci ${QUIET}`);
    });

    // Patterns this tool has no reader for: npm accepted them, so what its lockfile holds is a member.
    for (const pattern of ["apps/{web,api}", "apps/[wa]*"]) {
      it(`a member under ${pattern} is bumped with -w, and one reached through glob goes through the temporary root`, async () => {
        const reportDir = mkdtempSync(join(tmpdir(), "targeted-live-report-"));
        dirs.push(reportDir);

        const direct = unseenMemberProject({}, { minimatch: "^3.0.4" }, [pattern], "apps/web");
        await runTargeted(cfg(direct, reportDir), { fetchAlerts: async () => [MINIMATCH_ALERT] });
        assert.equal(report(reportDir).outcome, "changes");
        assert.deepEqual(json(direct, "apps", "web", "package.json").dependencies, { minimatch: "^3.0.5" });
        assert.equal(json(direct, "package.json").overrides, undefined);
        npm(direct, `ci ${QUIET}`);

        const viaGlob = unseenMemberProject({}, { glob: "^7.1.6" }, [pattern], "apps/web");
        const rootBefore = json(viaGlob, "package.json");
        await runTargeted(cfg(viaGlob, reportDir), { fetchAlerts: async () => [MINIMATCH_ALERT] });
        assert.deepEqual(report(reportDir).failures, []);
        assert.deepEqual(json(viaGlob, "package.json"), { ...rootBefore, overrides: { [MINIMATCH_KEY]: "3.0.5" } });
        assert.equal(versions(viaGlob).get("node_modules/minimatch"), "3.0.5");
      });
    }

    function cfg(dir: string, reportDir: string): ResolvedConfig {
      return {
        token: "",
        repo: "o/r",
        owner: "o",
        name: "r",
        workspaceRoot: dir,
        updateStrategy: "targeted",
        allowPrerelease: false,
        dryRun: false,
        skipUpdate: false,
        exitCode: false,
        discoverPackages: true,
        packages: [],
        updateWorkspaceMembers: true,
        limits: {},
        reportDir,
      };
    }

    const report = (reportDir: string): RunReport => JSON.parse(readFileSync(join(reportDir, "report.json"), "utf-8")) as RunReport;

    for (const [label, shape] of [
      ["single package", { root: { dependencies: { glob: "^7.1.6" } } }],
      ["workspace, member only", { members: { a: { dependencies: { glob: "^7.1.6" } } } }],
    ] as const) {
      it(`${label}: fixes the alert, reports it, and a second run changes nothing`, async () => {
        const dir = project("2020-06-01", shape);
        const reportDir = mkdtempSync(join(tmpdir(), "targeted-live-report-"));
        dirs.push(reportDir);
        const before = versions(dir);
        const open = [MINIMATCH_ALERT];

        const result = await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => open });

        assert.deepEqual(movedBetween(before, versions(dir)), MOVED_ONE);
        assert.deepEqual(json(dir, "package.json").overrides, { [MINIMATCH_KEY]: "3.0.5" });
        const first = report(reportDir);
        assert.equal(first.outcome, "changes");
        assert.equal(first.alerts[0].status, "fixed");
        assert.deepEqual(first.otherChanges, []);
        assert.deepEqual(first.failures, []);
        assert.equal(result.overrideChanges, 1);
        const md = readFileSync(join(reportDir, "report.md"), "utf-8");
        assert.match(md, /3\.0\.4 → 3\.0\.5/);
        assert.match(md, /\[#1\]\(https:\/\/example\.test\/alerts\/1\)/);
        npm(dir, `ci ${QUIET}`);

        // The same alert, still open as GitHub hasn't rescanned: nothing to do.
        const settled = text(dir, "package-lock.json");
        const again = await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => open });
        assert.equal(report(reportDir).outcome, "clean");
        assert.equal(report(reportDir).alerts[0].status, "awaiting-close");
        assert.equal(again.overrideChanges, 0);
        assert.equal(text(dir, "package-lock.json"), settled);

        // Once it is closed, glob 7.1.6 still declares ^3.0.4, so the override has to stay.
        const closed = [{ ...MINIMATCH_ALERT, state: "fixed" as const }];
        await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => closed });
        assert.equal(report(reportDir).outcome, "clean");
        assert.deepEqual(json(dir, "package.json").overrides, { [MINIMATCH_KEY]: "3.0.5" });
        assert.equal(text(dir, "package-lock.json"), settled);
      });
    }

    describe("an alert on a lockfile discovery prunes", () => {
      const X = ".github/actions/x";
      const onX = (patch: Partial<DependabotAlert["dependency"]> = {}): DependabotAlert => {
        const base = alert(1, "minimatch", ">= 3.0.0, < 3.0.5", "3.0.5");
        return { ...base, dependency: { ...base.dependency, manifest_path: `${X}/package-lock.json`, ...patch } };
      };
      const withAction = (rootDeps: Record<string, string>): string => {
        const dir = project("2021-01-01", { root: { dependencies: rootDeps } });
        const sub = join(dir, X);
        mkdirSync(sub, { recursive: true });
        write(sub, { root: { name: "action", dependencies: { glob: "^7.1.6" } } });
        npm(sub, `install --before=2021-01-01 --package-lock-only ${QUIET}`);
        return dir;
      };

      it("is fixed in its own lockfile, with nothing vulnerable at the root", async () => {
        const dir = withAction({ chalk: "^4.0.0" });
        const reportDir = mkdtempSync(join(tmpdir(), "targeted-live-report-"));
        dirs.push(reportDir);
        const rootLock = text(dir, "package-lock.json");

        await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => [onX()] });

        const got = report(reportDir);
        assert.equal(got.outcome, "changes");
        assert.deepEqual(got.alerts.map((a) => [a.number, a.packageName, a.status]), [[1, "minimatch", "fixed"]]);
        assert.equal(readLockfile(join(dir, X)).entries.get("node_modules/minimatch")?.version, "3.0.5");
        assert.equal(text(dir, "package-lock.json"), rootLock);
      });

      it("leaves a vulnerable copy at the root alone", async () => {
        const dir = withAction({ glob: "^7.1.6" });
        const reportDir = mkdtempSync(join(tmpdir(), "targeted-live-report-"));
        dirs.push(reportDir);
        const rootLock = text(dir, "package-lock.json");

        await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => [onX()] });

        assert.equal(readLockfile(join(dir, X)).entries.get("node_modules/minimatch")?.version, "3.0.5");
        assert.equal(text(dir, "package-lock.json"), rootLock);
      });

      it("with discovery off, is blocked by name and nothing moves", async () => {
        const dir = withAction({ glob: "^7.1.6" });
        const reportDir = mkdtempSync(join(tmpdir(), "targeted-live-report-"));
        dirs.push(reportDir);
        const rootLock = text(dir, "package-lock.json");

        await runTargeted({ ...cfg(dir, reportDir), discoverPackages: false }, { fetchAlerts: async () => [onX()] });

        const got = report(reportDir);
        assert.equal(got.outcome, "blocked-only");
        assert.equal(got.alerts[0].copies[0].reason, "manifest-not-processed");
        assert.ok((got.alerts[0].copies[0].detail ?? "").includes(`${X}/package-lock.json`));
        assert.equal(text(dir, "package-lock.json"), rootLock);
      });
    });

    describe("a bundled copy", () => {
      const ANSI_ALERT = alert(1, "ansi-regex", ">= 5.0.0, < 5.0.1", "5.0.1");

      it("blocks only itself: a run on npm@8.0.0 no longer fails on it", async () => {
        const dir = project("2030-01-01", { root: { dependencies: { npm: "8.0.0", chalk: "^4.0.0" } } });
        const reportDir = mkdtempSync(join(tmpdir(), "targeted-live-report-"));
        dirs.push(reportDir);
        const before = text(dir, "package-lock.json");

        await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => [ANSI_ALERT] });

        const got = report(reportDir);
        assert.equal(got.outcome, "blocked-only");
        const bundled = got.alerts[0].copies.find((c) => c.path === "node_modules/npm/node_modules/cli-table3/node_modules/ansi-regex");
        assert.equal(bundled?.reason, "bundled");
        assert.match(bundled?.detail ?? "", /upgrad/i);
        assert.equal(text(dir, "package-lock.json"), before);
      });

      it("doesn't stop the hoisted copy beside it from being fixed", async () => {
        const dir = project("2021-08-01", { root: { dependencies: { npm: "7.20.0", "strip-ansi": "^6.0.0" } } });
        const reportDir = mkdtempSync(join(tmpdir(), "targeted-live-report-"));
        dirs.push(reportDir);
        const before = versions(dir);

        await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => [ANSI_ALERT] });

        const got = report(reportDir);
        assert.deepEqual(got.failures, []);
        assert.equal(got.outcome, "changes");
        assert.equal(got.alerts[0].status, "partly-fixed");
        assert.deepEqual(movedBetween(before, versions(dir)), ["node_modules/ansi-regex: 5.0.0 -> 5.0.1"]);
        assert.deepEqual(json(dir, "package.json").overrides, { "ansi-regex@>=5.0.0 <5.0.1": "5.0.1" });
      });
    });

    describe("the temporary-root step with an override on the owner", () => {
      for (const [label, overrides] of [
        ["an exact value", { glob: "7.1.6" }],
        ["a range value", { glob: ">=7.1.6 <8" }],
        ["a nested value", { glob: { ".": "7.1.6" } }],
      ] as Array<[string, Record<string, unknown>]>) {
        it(`${label}: moves the target, and gives the manifest back`, async () => {
          const dir = project("2021-01-01", { root: { overrides }, members: { a: { dependencies: { glob: "^7.1.6" } } } });
          const reportDir = mkdtempSync(join(tmpdir(), "targeted-live-report-"));
          dirs.push(reportDir);
          const before = versions(dir);

          await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => [MINIMATCH_ALERT] });

          const got = report(reportDir);
          assert.deepEqual(got.failures, []);
          assert.equal(got.outcome, "changes");
          assert.deepEqual(movedBetween(before, versions(dir)), MOVED_ONE);
          assert.deepEqual(json(dir, "package.json").overrides, { ...overrides, [MINIMATCH_KEY]: "3.0.5" });
          assert.equal(json(dir, "package.json").devDependencies, undefined);
          npm(dir, `ci ${QUIET}`);
        });
      }
    });

    describe("an Angular tree that lives only in a workspace member", { skip: Number(execSync("npm --version", { encoding: "utf-8" }).split(".")[0]) < 11 && "npm 10 can fail this one safely: see the README" }, () => {
      it("moves nanoid through the temporary-root step on the npm the workflow runs", async () => {
        const dir = project("2024-12-15", {
          members: {
            web: {
              dependencies: { "@angular/core": "^19.0.0", "@angular/common": "^19.0.0", rxjs: "^7.8.0", "zone.js": "^0.15.0" },
              devDependencies: { "@angular/build": "^19.0.0", "@angular/compiler-cli": "^19.0.0", "@angular/compiler": "^19.0.0", typescript: "~5.6.0" },
            },
          },
        });
        const reportDir = mkdtempSync(join(tmpdir(), "targeted-live-report-"));
        dirs.push(reportDir);

        await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => [alert(1, "nanoid", ">= 3.0.0, < 3.3.11", "3.3.11")] });

        const got = report(reportDir);
        assert.deepEqual(got.failures, []);
        assert.equal(got.outcome, "changes");
        assert.equal(readLockfile(dir).entries.get("node_modules/nanoid")?.version, "3.3.11");
        assert.equal(got.npmVersion, execSync("npm --version", { encoding: "utf-8" }).trim());
      });
    });

    describe("removing an override", () => {
      it("a real removal: the key goes, the outcome is changes, and the next run is clean", async () => {
        const key = MINIMATCH_KEY;
        const closed = { ...MINIMATCH_ALERT, state: "fixed" as const };
        const dir = project("2030-01-01", { root: { overrides: { [key]: "3.0.5" }, dependencies: { glob: "7.2.3" } } });
        const reportDir = mkdtempSync(join(tmpdir(), "targeted-live-report-"));
        dirs.push(reportDir);
        const before = versions(dir);

        const first = await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => [closed] });

        const got = report(reportDir);
        assert.deepEqual(got.failures, []);
        assert.equal(got.outcome, "changes");
        assert.deepEqual(got.removedOverrides.map((o) => o.key), [key]);
        assert.equal(first.overrideChanges, 1);
        assert.equal(json(dir, "package.json").overrides, undefined);
        assert.deepEqual(movedBetween(before, versions(dir)), [], "a removal moves no version");

        const settled = text(dir, "package-lock.json");
        const manifest = text(dir, "package.json");
        const second = await runTargeted(cfg(dir, reportDir), { fetchAlerts: async () => [closed] });
        assert.equal(report(reportDir).outcome, "clean");
        assert.equal(second.overrideChanges, 0);
        assert.equal(text(dir, "package-lock.json"), settled);
        assert.equal(text(dir, "package.json"), manifest);
      });
    });
  });
});
