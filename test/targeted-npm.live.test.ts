import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { readDirectDependencies } from "../src/manifest.js";
import { readNpmOverrides } from "../src/override-source.js";
import { applyPlan, NpmRunner, resolveCommand, snapshotFiles } from "../src/targeted/apply.js";
import { readLockfile } from "../src/targeted/lockfile.js";
import { buildPlan, ManifestInfo, Plan } from "../src/targeted/plan.js";
import { DependabotAlert } from "../src/types.js";

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

      applied(dir, plan);
      assert.deepEqual(movedBetween(before, versions(dir)), []);
      assert.deepEqual(json(dir, "packages", "a", "package.json").dependencies, { minimatch: "3.0.4" });
    });

    it("verification stops a plan that would have moved the pin anyway", () => {
      const dir = project("2020-06-01", {
        members: { a: { dependencies: { minimatch: "3.0.4" } }, b: { dependencies: { glob: "^7.1.6" } } },
      });
      const snapshot = snapshotFiles([join(dir, "package.json"), join(dir, "package-lock.json")]);
      const failures = applyPlan(dir, forced(), { limits: {}, manifests: manifestsOf(dir) });
      // npm does move the pinned copy, leaving the member's manifest saying 3.0.4
      // and `npm ci` content. This check is all that stops it reaching a PR.
      assert.equal(versions(dir).get("node_modules/minimatch"), "3.0.5");
      assert.deepEqual(
        failures.map((f) => f.check),
        ["pins-held"],
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

  it("a real non-zero exit from npm comes back as a failure", () => {
    const dir = project("2020-05-01", { root: { dependencies: { chalk: "^4.0.0" } } });
    const plan = planFor(dir, [alert(1, "chalk", "<4.1.2", "4.1.2")]);
    plan.bumps[0].target = "99.99.99";
    const failures = applyPlan(dir, plan, { limits: {}, manifests: manifestsOf(dir) });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].check, "stable");
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

    applied(dir, plan);
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
});
