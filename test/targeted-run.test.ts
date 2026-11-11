import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import semver from "semver";
import type { ResolvedConfig } from "../src/config.js";
import { NpmRunner, resolveCommand } from "../src/targeted/apply.js";
import type { RunReport } from "../src/targeted/report.js";
import { assertTargetedSupported, groupAlertsByNearestLockfile, runTargeted, type TargetedDeps } from "../src/targeted/run.js";
import type { DependabotAlert } from "../src/types.js";
import { AgentError } from "../src/util.js";

type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// Temp projects with real-shaped lockfiles
// ---------------------------------------------------------------------------

const dirs: string[] = [];
let logs: string[] = [];

beforeEach(() => {
  logs = [];
  mock.method(console, "log", (message: unknown) => logs.push(String(message)));
  mock.method(console, "warn", () => {});
});
afterEach(() => {
  mock.restoreAll();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "targeted-run-"));
  dirs.push(dir);
  return dir;
}

const readJson = (file: string): Json => JSON.parse(readFileSync(file, "utf-8")) as Json;
const writeJson = (file: string, value: unknown): void => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const readLock = (dir: string): Json => readJson(join(dir, "package-lock.json"));
const writeLock = (dir: string, raw: Json): void => writeJson(join(dir, "package-lock.json"), raw);

interface ProjectSpec {
  root?: Json;
  members?: Record<string, Json>;
  /** Packages at any path (path -> manifest), each linked from node_modules, as a workspace member or a file: dependency is. */
  placed?: Record<string, Json>;
  /** Lock entries below node_modules, by path. */
  packages: Record<string, Json>;
}

const MANIFEST_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "workspaces"];

/** A package.json (and member manifests) plus the package-lock.json npm would have written for them. */
function writeProject(dir: string, spec: ProjectSpec): void {
  mkdirSync(dir, { recursive: true });
  const members = spec.members ?? {};
  const manifest: Json = {
    name: "fx",
    version: "1.0.0",
    private: true,
    ...(Object.keys(members).length > 0 ? { workspaces: ["packages/*"] } : {}),
    ...spec.root,
  };
  writeJson(join(dir, "package.json"), manifest);

  const entry = (m: Json): Json => Object.fromEntries(Object.entries(m).filter(([k]) => ["name", "version", ...MANIFEST_FIELDS].includes(k)));
  const packages: Record<string, Json> = { "": entry(manifest) };
  for (const [name, m] of Object.entries(members)) {
    const memberManifest = { name, version: "1.0.0", ...m };
    mkdirSync(join(dir, "packages", name), { recursive: true });
    writeJson(join(dir, "packages", name, "package.json"), memberManifest);
    packages[`packages/${name}`] = entry(memberManifest);
    packages[`node_modules/${name}`] = { resolved: `packages/${name}`, link: true };
  }
  for (const [at, m] of Object.entries(spec.placed ?? {})) {
    const placedManifest: Json = { version: "1.0.0", ...m };
    mkdirSync(join(dir, at), { recursive: true });
    writeJson(join(dir, at, "package.json"), placedManifest);
    packages[at] = entry(placedManifest);
    packages[`node_modules/${placedManifest.name}`] = { resolved: at, link: true };
  }
  Object.assign(packages, spec.packages);
  writeLock(dir, { name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true, packages });
}

/** Every file under a directory, by relative path, with its text. */
function treeOf(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const e of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(relative(dir, full).replaceAll("\\", "/"), readFileSync(full, "utf-8"));
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// A stand-in for npm that edits the lockfile the way testing showed it does
// ---------------------------------------------------------------------------

interface FakeOptions {
  /** What a bump to `name@target` also brings: that package's own dependencies, and the entries they need. */
  extras?: Record<string, { dependencies: Record<string, string>; packages: Record<string, Json> }>;
  /** Called after each resolve, to make npm do something beyond applying overrides. */
  onResolve?: (dir: string) => void;
  /** Fail any resolve run in this directory. */
  failIn?: string;
  /** Apply overrides only while the root declares this package, as npm does for a copy reachable only through members. */
  reachableVia?: string;
}

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];

function fakeNpm(opts: FakeOptions = {}): { run: NpmRunner; commands: string[]; roots: Json[] } {
  const commands: string[] = [];
  const roots: Json[] = [];
  const run: NpmRunner = (command, cwd) => {
    commands.push(command);

    const bump = /^npm install (\S+?)@(\d\S*)(?: -w (\S+))? "--save-prefix=(.)"/.exec(command);
    if (bump) {
      const [, name, target, member, prefix] = bump;
      const manifestFile = join(cwd, member ?? "", "package.json");
      const manifest = readJson(manifestFile);
      const lock = readLock(cwd);
      const lockEntry = lock.packages[member ?? ""];
      for (const field of DEP_FIELDS) {
        if (manifest[field]?.[name] === undefined) continue;
        manifest[field][name] = `${prefix}${target}`;
        lockEntry[field][name] = `${prefix}${target}`;
      }
      writeJson(manifestFile, manifest);
      lock.packages[`node_modules/${name}`].version = target;
      const extra = opts.extras?.[`${name}@${target}`];
      if (extra) {
        lock.packages[`node_modules/${name}`].dependencies = extra.dependencies;
        Object.assign(lock.packages, extra.packages);
      }
      writeLock(cwd, lock);
      return;
    }

    assert.equal(command, resolveCommand(), `unexpected command: ${command}`);
    if (opts.failIn && cwd === opts.failIn) {
      throw Object.assign(new Error(`Command failed: ${command}`), { stderr: "npm error code ETARGET\nnpm error notarget No matching version" });
    }
    const rootManifest = readJson(join(cwd, "package.json"));
    roots.push(rootManifest);
    const declared = { ...rootManifest.dependencies, ...rootManifest.devDependencies };
    const reaches = opts.reachableVia === undefined || declared[opts.reachableVia] !== undefined;
    const overrides = (reaches ? (rootManifest.overrides ?? {}) : {}) as Record<string, string>;
    const lock = readLock(cwd);
    for (const [key, value] of Object.entries(overrides)) {
      const at = key.lastIndexOf("@");
      const name = at > 0 ? key.slice(0, at) : key;
      const selector = at > 0 ? key.slice(at + 1) : "*";
      for (const [path, entry] of Object.entries<Json>(lock.packages)) {
        if (!path.includes("node_modules/") || path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length) !== name) continue;
        if (semver.satisfies(entry.version, selector)) entry.version = value;
      }
    }
    writeLock(cwd, lock);
    opts.onResolve?.(cwd);
  };
  return { run, commands, roots };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function alert(
  number: number,
  name: string,
  range: string,
  patch: string | null,
  over: { manifest?: string; state?: DependabotAlert["state"] } = {},
): DependabotAlert {
  const vuln = {
    package: { ecosystem: "npm", name },
    vulnerable_version_range: range,
    first_patched_version: patch ? { identifier: patch } : null,
  };
  return {
    number,
    state: over.state ?? "open",
    html_url: `https://example.test/alerts/${number}`,
    dependency: { package: vuln.package, manifest_path: over.manifest ?? "package.json", scope: "runtime" },
    security_advisory: { summary: "", severity: "high", vulnerabilities: [vuln] },
    security_vulnerability: vuln,
  };
}

const QS_KEY = "qs@>=6.0.0 <6.5.3";
const qsAlert = (over: Parameters<typeof alert>[4] = {}): DependabotAlert => alert(1, "qs", "< 6.5.3", "6.5.3", over);

/** qs reached only through `a`, which accepts the fix: an override moves it. */
const qsProject = (): ProjectSpec => ({
  root: { dependencies: { a: "^1.0.0" } },
  packages: { "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.0.0" } }, "node_modules/qs": { version: "6.5.0" } },
});

/** The same project after a fix, with the override still in place and its alert closed. */
const fixedQsProject = (spec: { aWants: string }): ProjectSpec => ({
  root: { dependencies: { a: "^1.0.0" }, overrides: { [QS_KEY]: "6.5.3" } },
  packages: { "node_modules/a": { version: "1.0.0", dependencies: { qs: spec.aWants } }, "node_modules/qs": { version: "6.5.3" } },
});

/** An isolated sub-package with its own lockfile, whose ms 2.0.0 is reached only through b. */
const functionsProject = (): ProjectSpec => ({
  root: { name: "functions", dependencies: { b: "^1.0.0" } },
  packages: { "node_modules/b": { version: "1.0.0", dependencies: { ms: "^2.0.0" } }, "node_modules/ms": { version: "2.0.0" } },
});
const msAlert = (number = 2): DependabotAlert => alert(number, "ms", "< 2.0.5", "2.0.5", { manifest: "functions/package.json" });

const PUBLISHED: Record<string, string[]> = {
  qs: ["6.5.0", "6.5.3"],
  ms: ["2.0.0", "2.0.5", "2.1.3"],
  pinned: ["1.0.0", "1.0.1"],
  minimatch: ["3.0.4", "3.0.5"],
};

function cfgFor(dir: string, over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    token: "t",
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
    ...over,
  };
}

type Dependents = NonNullable<TargetedDeps["fetchDependents"]>;
const SAFE: Awaited<ReturnType<Dependents>> = { installedRange: "^6.5.3", latestRange: "^6.5.3", latestKnown: true };

function depsFor(alerts: DependabotAlert[], npm: { run: NpmRunner }, dependents?: Dependents): Partial<TargetedDeps> {
  return {
    fetchAlerts: async () => alerts,
    fetchPackage: async (name) => (PUBLISHED[name] ? new Map(PUBLISHED[name].map((version) => [version, { dependencies: {}, peerDependencies: {} }])) : null),
    fetchAdvisories: async () => ({}),
    fetchDependents: dependents ?? (async () => ({ installedRange: null, latestRange: null, latestKnown: false })),
    run: npm.run,
    npmVersion: () => "11.16.0",
  };
}

const reportIn = (dir: string): RunReport => readJson(join(dir, "report.json")) as unknown as RunReport;
const reportMd = (dir: string): string => readFileSync(join(dir, "report.md"), "utf-8");

// ---------------------------------------------------------------------------

describe("startup checks", () => {
  it("stops at startup when the root is pnpm", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const before = treeOf(dir);
    let fetched = false;
    await assert.rejects(
      runTargeted(cfgFor(dir), {
        fetchAlerts: async () => {
          fetched = true;
          return [];
        },
      }),
      (e: Error) => e instanceof AgentError && /npm only/.test(e.message) && e.message.includes(dir),
    );
    assert.equal(fetched, false, "it stops before asking GitHub for anything");
    assert.deepEqual(treeOf(dir), before);
  });

  it("stops at startup when an isolated sub-package is pnpm, naming it", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    mkdirSync(join(dir, "functions"));
    writeFileSync(join(dir, "functions", "package.json"), "{}\n");
    writeFileSync(join(dir, "functions", "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const before = treeOf(dir);
    const npm = fakeNpm();
    await assert.rejects(
      runTargeted(cfgFor(dir), depsFor([qsAlert()], npm)),
      (e: Error) => e instanceof AgentError && /npm only/.test(e.message) && e.message.includes("functions"),
    );
    assert.deepEqual(npm.commands, []);
    assert.deepEqual(treeOf(dir), before, "nothing was written, not even for the npm group");
  });

  it("assertTargetedSupported honours an explicit --package-manager everywhere", () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    assert.doesNotThrow(() => assertTargetedSupported([dir], cfgFor(dir)));
    assert.throws(() => assertTargetedSupported([dir], cfgFor(dir, { packageManager: "pnpm" })), /npm only/);
  });

  it("stops with a clear error when there is no package-lock.json", async () => {
    const dir = tempDir();
    writeJson(join(dir, "package.json"), { name: "fx", version: "1.0.0" });
    await assert.rejects(
      runTargeted(cfgFor(dir, { packageManager: "npm" }), depsFor([], fakeNpm())),
      (e: Error) => e instanceof AgentError && /No package-lock\.json found/.test(e.message),
    );
  });
});

describe("a dry run and a run with nothing to do", () => {
  it("dry run writes the report and leaves every file byte-identical", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, qsProject());
    const before = treeOf(dir);
    const npm = fakeNpm();

    const result = await runTargeted(cfgFor(dir, { dryRun: true, reportDir }), depsFor([qsAlert()], npm));

    assert.deepEqual(treeOf(dir), before);
    assert.deepEqual(npm.commands, []);
    const report = reportIn(reportDir);
    assert.equal(report.dryRun, true);
    assert.equal(report.outcome, "changes");
    assert.equal(report.alerts[0].status, "fixed");
    assert.match(reportMd(reportDir), /^# Targeted dependency fixes — plan/);
    assert.equal(result.overrideChanges, 1, "a dry run counts what is planned");
    assert.ok(logs.some((l) => l.includes("# Targeted dependency fixes — plan")), "the report is printed to the log");
  });

  it("all alerts blocked: outcome blocked-only, nothing changed", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, qsProject());
    const before = treeOf(dir);
    const npm = fakeNpm();

    const result = await runTargeted(cfgFor(dir, { reportDir }), depsFor([alert(1, "qs", "< 6.5.3", null)], npm));

    assert.deepEqual(treeOf(dir), before);
    assert.deepEqual(npm.commands, []);
    const report = reportIn(reportDir);
    assert.equal(report.outcome, "blocked-only");
    assert.equal(report.blockedCount, 1);
    assert.equal(result.overrideChanges, 0);
    assert.match(reportMd(reportDir), /## Blocked/);
  });

  it("no alerts at all is clean", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, qsProject());
    await runTargeted(cfgFor(dir, { reportDir }), depsFor([], fakeNpm()));
    assert.equal(reportIn(reportDir).outcome, "clean");
  });
});

describe("applying", () => {
  it("fixes an override-reachable alert, reports it, and does not call the update pass", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, qsProject());
    const npm = fakeNpm();

    const result = await runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert()], npm));

    assert.deepEqual(readJson(join(dir, "package.json")).overrides, { [QS_KEY]: "6.5.3" });
    assert.equal(readLock(dir).packages["node_modules/qs"].version, "6.5.3");
    assert.ok(npm.commands.length > 0);
    assert.ok(npm.commands.every((c) => !/\bnpm update\b/.test(c)), npm.commands.join("\n"));
    assert.equal(reportIn(reportDir).outcome, "changes");
    assert.equal(result.overrideChanges, 1);
  });

  it("merges two groups into one report", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, qsProject());
    writeProject(join(dir, "functions"), functionsProject());
    const npm = fakeNpm();

    const result = await runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert(), msAlert()], npm));

    const report = reportIn(reportDir);
    assert.deepEqual(report.alerts.map((a) => [a.number, a.packageName, a.status]), [
      [1, "qs", "fixed"],
      [2, "ms", "fixed"],
    ]);
    assert.equal(report.outcome, "changes");
    assert.equal(result.overrideChanges, 2);
    assert.equal(readLock(join(dir, "functions")).packages["node_modules/ms"].version, "2.0.5");
    assert.equal(readLock(dir).packages["node_modules/qs"].version, "6.5.3");
    assert.deepEqual(readJson(join(dir, "functions", "package.json")).overrides, { "ms@>=2.0.0 <2.0.5": "2.0.5" });
  });

  it("a verification failure restores every file in every group and sets outcome failed", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, qsProject());
    writeProject(join(dir, "functions"), functionsProject());
    const before = treeOf(dir);
    const npm = fakeNpm({ failIn: join(dir, "functions") });

    await assert.rejects(
      runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert(), msAlert()], npm)),
      (e: Error) => e instanceof AgentError && /failed in functions: run/.test(e.message),
    );

    // The root group had already succeeded, and its files are back as they were.
    assert.deepEqual(treeOf(dir), before);
    assert.ok(npm.commands.length >= 2, "the root group was applied before functions failed");
    const report = reportIn(reportDir);
    assert.equal(report.outcome, "failed");
    assert.equal(report.failures[0].check, "run");
    assert.match(report.failures[0].detail, /^In functions: /);
    assert.match(report.failures[0].detail, /ETARGET/);
  });

  it("writes the report before exiting 1 on failure, and prints it", async () => {
    const dir = tempDir();
    const reportDir = join(tempDir(), "out");
    writeProject(dir, qsProject());
    const npm = fakeNpm({ failIn: dir });

    await assert.rejects(runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert()], npm)), AgentError);

    assert.equal(reportIn(reportDir).outcome, "failed");
    assert.match(reportMd(reportDir), /## Failures/);
    assert.ok(logs.some((l) => l.includes("## Failures")));
  });

  it("writes no report on failure when no report directory is set", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    const before = treeOf(dir);
    await assert.rejects(runTargeted(cfgFor(dir), depsFor([qsAlert()], fakeNpm({ failIn: dir }))), AgentError);
    assert.deepEqual(treeOf(dir), before);
    assert.ok(logs.some((l) => l.includes("## Failures")), "still printed");
  });
});

describe("removing orphaned overrides", () => {
  const FIXED = [alert(1, "qs", "< 6.5.3", "6.5.3", { state: "fixed" })];

  it("removes one only when nothing moves", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, fixedQsProject({ aWants: "^6.5.3" }));
    const npm = fakeNpm();

    const result = await runTargeted(cfgFor(dir, { reportDir }), depsFor(FIXED, npm, async () => SAFE));

    assert.equal(readJson(join(dir, "package.json")).overrides, undefined);
    assert.equal(readLock(dir).packages["node_modules/qs"].version, "6.5.3");
    assert.deepEqual(npm.commands, [resolveCommand()]);
    const report = reportIn(reportDir);
    assert.equal(report.outcome, "changes", "the manifest changed");
    assert.deepEqual(report.keptOverrides, []);
    assert.equal(result.overrideChanges, 1);
    // The report says so: its body must not contradict the diff.
    assert.deepEqual(report.removedOverrides.map((r) => r.key), [QS_KEY]);
    const md = reportMd(reportDir);
    assert.match(md, /^## Overrides removed$/m);
    assert.match(md, new RegExp(`\`${QS_KEY}\``));
    assert.match(md, /\*\*1\*\* override removed as no longer needed/);
  });

  it("keeps it and lists it when removing it would move a version", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, fixedQsProject({ aWants: "^6.5.3" }));
    const before = treeOf(dir);
    const npm = fakeNpm({
      onResolve(cwd) {
        // Without its override, npm settles back on the older version.
        if (readJson(join(cwd, "package.json")).overrides) return;
        const lock = readLock(cwd);
        lock.packages["node_modules/qs"].version = "6.5.0";
        writeLock(cwd, lock);
      },
    });

    const result = await runTargeted(cfgFor(dir, { reportDir }), depsFor(FIXED, npm, async () => SAFE));

    assert.deepEqual(treeOf(dir), before, "put back exactly");
    const report = reportIn(reportDir);
    assert.equal(report.outcome, "clean");
    assert.deepEqual(report.keptOverrides.map((k) => k.key), [QS_KEY]);
    assert.match(reportMd(reportDir), /## Overrides kept/);
    assert.equal(result.overrideChanges, 0);
  });

  it("keeps it and lists it when removing it would leave a dependent outside its range", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    // a declares a union that reads as safe to the floor check, which only looks at the first number, but
    // 6.5.3 satisfies neither half: only the override explains it. The verdict is remove,
    // nothing moves, and the tree would break.
    writeProject(dir, fixedQsProject({ aWants: "6.5.3-beta.1 || 6.4.0" }));
    const before = treeOf(dir);

    await runTargeted(cfgFor(dir, { reportDir }), depsFor(FIXED, fakeNpm(), async () => SAFE));

    assert.deepEqual(treeOf(dir), before);
    const kept = reportIn(reportDir).keptOverrides;
    assert.deepEqual(kept.map((k) => k.key), [QS_KEY]);
    assert.match(kept[0].reason, /node_modules\/a -> qs@6\.5\.3-beta\.1 \|\| 6\.4\.0/);
  });

  it("does not try when a dependent could still resolve below the floor", async () => {
    const dir = tempDir();
    writeProject(dir, fixedQsProject({ aWants: "^6.0.0" }));
    const before = treeOf(dir);
    const npm = fakeNpm();
    await runTargeted(
      cfgFor(dir),
      depsFor(FIXED, npm, async () => ({ installedRange: "^6.0.0", latestRange: "^6.0.0", latestKnown: true })),
    );
    assert.deepEqual(npm.commands, []);
    assert.deepEqual(treeOf(dir), before);
  });

  it("never removes an override for a dismissed alert", async () => {
    const dir = tempDir();
    writeProject(dir, fixedQsProject({ aWants: "^6.5.3" }));
    const before = treeOf(dir);
    const npm = fakeNpm();
    await runTargeted(
      cfgFor(dir),
      depsFor([alert(1, "qs", "< 6.5.3", "6.5.3", { state: "dismissed" })], npm, async () => SAFE),
    );
    assert.deepEqual(npm.commands, []);
    assert.deepEqual(treeOf(dir), before);
  });

  it("never removes one for a package that was never alerted, or one a person wrote", async () => {
    const dir = tempDir();
    const spec = fixedQsProject({ aWants: "^6.5.3" });
    spec.root = { ...spec.root, overrides: { [QS_KEY]: "6.5.3", qs: "6.5.3" } };
    writeProject(dir, spec);
    const before = treeOf(dir);
    const npm = fakeNpm();
    // No alert of any state names qs, so neither key can be the agent's.
    await runTargeted(cfgFor(dir), depsFor([], npm, async () => SAFE));
    assert.deepEqual(npm.commands, []);
    assert.deepEqual(treeOf(dir), before);
  });

  it("leaves a hand-written override alone even for an alerted package", async () => {
    const dir = tempDir();
    const spec = fixedQsProject({ aWants: "^6.5.3" });
    spec.root = { ...spec.root, overrides: { qs: "6.5.3" } };
    writeProject(dir, spec);
    const before = treeOf(dir);
    const npm = fakeNpm();
    await runTargeted(cfgFor(dir), depsFor(FIXED, npm, async () => SAFE));
    assert.deepEqual(npm.commands, []);
    assert.deepEqual(treeOf(dir), before);
  });
});

describe("end to end, offline", () => {
  it("a workspace with an override, a bump that brings a new package, and a pin: the report says what happened", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, {
      members: { a: { dependencies: { ms: "^2.0.0", a1: "^1.0.0", pinned: "1.0.0" } } },
      packages: {
        "node_modules/ms": { version: "2.0.0" },
        "node_modules/a1": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
        "node_modules/qs": { version: "6.5.0" },
        "node_modules/pinned": { version: "1.0.0" },
      },
    });
    const rootBefore = readJson(join(dir, "package.json"));
    const npm = fakeNpm({
      extras: {
        "ms@2.1.3": { dependencies: { bar: "^1.0.0" }, packages: { "node_modules/bar": { version: "1.0.0" } } },
      },
    });
    const alerts = [
      qsAlert(),
      alert(2, "ms", "< 2.1.3", "2.1.3"),
      alert(3, "pinned", "< 1.0.1", "1.0.1"),
      alert(4, "old", "< 1.0.0", "1.0.0", { state: "dismissed" }),
    ];

    const result = await runTargeted(cfgFor(dir, { reportDir }), depsFor(alerts, npm));

    // The files.
    assert.deepEqual(readJson(join(dir, "package.json")), { ...rootBefore, overrides: { [QS_KEY]: "6.5.3" } });
    assert.deepEqual(readJson(join(dir, "packages", "a", "package.json")).dependencies, {
      ms: "^2.1.3",
      a1: "^1.0.0",
      pinned: "1.0.0",
    });
    const lock = readLock(dir);
    assert.equal(lock.packages["node_modules/ms"].version, "2.1.3");
    assert.equal(lock.packages["node_modules/qs"].version, "6.5.3");
    assert.equal(lock.packages["node_modules/pinned"].version, "1.0.0");

    // The report's data.
    const report = reportIn(reportDir);
    assert.equal(report.outcome, "changes");
    assert.equal(report.dryRun, false);
    assert.equal(report.blockedCount, 1);
    assert.deepEqual(report.alerts.map((a) => [a.number, a.status]), [
      [1, "fixed"],
      [2, "fixed"],
      [3, "blocked"],
    ]);
    assert.deepEqual(report.alerts[1].copies.map((c) => [c.action, c.version, c.target]), [["bump", "2.0.0", "2.1.3"]]);
    assert.deepEqual(report.alerts[0].copies.map((c) => [c.action, c.version, c.target]), [["override", "6.5.0", "6.5.3"]]);
    assert.equal(report.alerts[0].url, "https://example.test/alerts/1");
    assert.deepEqual(report.otherChanges, [{ path: "node_modules/bar", to: "1.0.0" }]);
    assert.deepEqual(report.keptOverrides, []);
    assert.deepEqual(report.failures, []);
    assert.equal(result.overrideChanges, 2, "one bump and one override added");

    // The text a reviewer reads.
    const md = reportMd(reportDir);
    for (const heading of ["Fixed", "Blocked", "Other changes"]) assert.match(md, new RegExp(`^## ${heading}$`, "m"));
    assert.match(md, /\[#1\]\(https:\/\/example\.test\/alerts\/1\)/);
    assert.match(md, /6\.5\.0 → 6\.5\.3/);
    assert.match(md, /2\.0\.0 → 2\.1\.3/);
    assert.match(md, /Pinned at "1\.0\.0" in packages\/a\/package\.json/);
    assert.match(md, /`node_modules\/bar`: added at 1\.0\.0/);
    assert.doesNotMatch(md, /^## Failures/m);
    assert.ok(logs.some((l) => l.includes("## Other changes")));
    assert.ok(npm.commands.every((c) => !/\bnpm update\b/.test(c)));
  });

  it("names the group when a multi-group run moves something no alert asked for", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, qsProject());
    writeProject(join(dir, "functions"), functionsProject());
    const npm = fakeNpm({
      // An override moving ms also drags in a package that the new ms needs.
      onResolve(cwd) {
        if (!cwd.endsWith("functions")) return;
        const lock = readLock(cwd);
        if (lock.packages["node_modules/ms"].version !== "2.0.5" || lock.packages["node_modules/baz"]) return;
        lock.packages["node_modules/ms"].dependencies = { baz: "^1.0.0" };
        lock.packages["node_modules/baz"] = { version: "1.0.0" };
        writeLock(cwd, lock);
      },
    });

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert(), msAlert()], npm));

    assert.deepEqual(reportIn(reportDir).otherChanges, [{ path: "functions/node_modules/baz", to: "1.0.0" }]);
  });
});

// ---------------------------------------------------------------------------
// Members are whatever the lockfile holds, not whatever a glob reader can see
// ---------------------------------------------------------------------------

const MM_ALERT = alert(1, "minimatch", "< 3.0.5", "3.0.5");
const MM_KEY = "minimatch@>=3.0.0 <3.0.5";

/** Root reaches minimatch through glob; a package at apps/web/site declares it as `declared`. */
const siteProject = (workspaces: unknown, declared: string, over: Partial<ProjectSpec> = {}): ProjectSpec => ({
  root: { workspaces, dependencies: { glob: "^7.1.6" } },
  placed: { "apps/web/site": { name: "site", dependencies: { minimatch: declared } } },
  packages: {
    "node_modules/glob": { version: "7.1.6", dependencies: { minimatch: "^3.0.4" } },
    "node_modules/minimatch": { version: "3.0.4" },
  },
  ...over,
});

async function expectBlocked(dir: string, reason: string, detail: RegExp): Promise<void> {
  const reportDir = tempDir();
  const before = treeOf(dir);
  const npm = fakeNpm();
  await runTargeted(cfgFor(dir, { reportDir }), depsFor([MM_ALERT], npm));
  const report = reportIn(reportDir);
  assert.equal(report.alerts[0].status, "blocked", JSON.stringify(report.alerts[0].copies));
  assert.equal(report.alerts[0].copies[0].reason, reason);
  assert.match(report.alerts[0].copies[0].detail ?? "", detail);
  assert.equal(report.outcome, "blocked-only");
  assert.deepEqual(npm.commands, [], "nothing to run: no override, no bump");
  assert.deepEqual(treeOf(dir), before);
}

describe("workspace members the lockfile holds", () => {

  it("an exact pin in a member under apps/** blocks the alert, though no workspace reader lists it", async () => {
    const dir = tempDir();
    writeProject(dir, siteProject(["apps/**"], "3.0.4"));
    await expectBlocked(dir, "pin", /Pinned at "3\.0\.4" in apps\/web\/site\/package\.json/);
  });

  it("an exact pin in a member under apps/*/*, in the object form of `workspaces`", async () => {
    const dir = tempDir();
    writeProject(dir, siteProject({ packages: ["apps/*/*"] }, "3.0.4"));
    await expectBlocked(dir, "pin", /apps\/web\/site\/package\.json/);
  });

  it("an exact pin in a file: dependency blocks the alert", async () => {
    const dir = tempDir();
    writeProject(dir, siteProject(undefined, "3.0.4", { root: { dependencies: { glob: "^7.1.6", site: "file:apps/web/site" } } }));
    await expectBlocked(dir, "pin", /apps\/web\/site\/package\.json/);
  });

  it("a range in a file: dependency is blocked as unrewritable, not bumped with -w", async () => {
    const dir = tempDir();
    writeProject(dir, siteProject(undefined, "^3.0.4", { root: { dependencies: { glob: "^7.1.6", site: "file:apps/web/site" } } }));
    await expectBlocked(dir, "unrewritable-spec", /file: dependency and not a workspace member/);
  });

  it("a member-only ^3.0.4 under apps/** gets a bump through -w, not an override", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, {
      root: { workspaces: ["apps/**"] },
      placed: { "apps/web/site": { name: "site", dependencies: { minimatch: "^3.0.4" } } },
      packages: { "node_modules/minimatch": { version: "3.0.4" } },
    });
    const npm = fakeNpm();

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([MM_ALERT], npm));

    assert.ok(npm.commands.some((c) => c.startsWith("npm install minimatch@3.0.5 -w apps/web/site ")), npm.commands.join("\n"));
    assert.deepEqual(readJson(join(dir, "apps", "web", "site", "package.json")).dependencies, { minimatch: "^3.0.5" });
    assert.equal(readJson(join(dir, "package.json")).overrides, undefined);
    assert.equal(readLock(dir).packages["node_modules/minimatch"].version, "3.0.5");
    assert.equal(reportIn(reportDir).alerts[0].copies[0].action, "bump");
  });

  it("a copy reached only through a member under apps/** gets the temporary-root owners", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, {
      root: { workspaces: ["apps/**"] },
      placed: { "apps/web/site": { name: "site", dependencies: { glob: "^7.1.6" } } },
      packages: {
        "node_modules/glob": { version: "7.1.6", dependencies: { minimatch: "^3.0.4" } },
        "node_modules/minimatch": { version: "3.0.4" },
      },
    });
    const npm = fakeNpm({ reachableVia: "glob" });

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([MM_ALERT], npm));

    assert.ok(npm.roots.some((r) => r.devDependencies?.glob === "^7.1.6"), "glob was declared at the root for one resolve");
    const root = readJson(join(dir, "package.json"));
    assert.equal(root.devDependencies, undefined, "and taken away again");
    assert.deepEqual(root.overrides, { [MM_KEY]: "3.0.5" });
    assert.equal(readLock(dir).packages["node_modules/minimatch"].version, "3.0.5");
    assert.deepEqual(reportIn(reportDir).failures, []);
  });

  it("a confirmable member whose package.json is missing stops the run at startup", async () => {
    const dir = tempDir();
    writeProject(dir, siteProject(["apps/**"], "3.0.4"));
    rmSync(join(dir, "apps", "web", "site"), { recursive: true });
    await assert.rejects(
      runTargeted(cfgFor(dir), depsFor([MM_ALERT], fakeNpm())),
      (e: Error) => e instanceof AgentError && /apps\/web\/site is a workspace member/.test(e.message),
    );
  });
});

// ---------------------------------------------------------------------------
// What the lockfile says about dependents
// ---------------------------------------------------------------------------

describe("judging an orphaned override by the lockfile's own ranges", () => {
  const FIXED = [alert(1, "qs", "< 6.5.3", "6.5.3", { state: "fixed" })];

  it("a member under apps/** that still declares ^6.0.0 holds the override", async () => {
    const dir = tempDir();
    writeProject(dir, {
      root: { workspaces: ["apps/**"], dependencies: { a: "^1.0.0" }, overrides: { [QS_KEY]: "6.5.3" } },
      placed: { "apps/web/site": { name: "site", dependencies: { qs: "^6.0.0" } } },
      packages: {
        "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.3" } },
        "node_modules/qs": { version: "6.5.3" },
      },
    });
    const before = treeOf(dir);
    const npm = fakeNpm();
    await runTargeted(cfgFor(dir), depsFor(FIXED, npm, async () => SAFE));
    assert.deepEqual(npm.commands, []);
    assert.deepEqual(treeOf(dir), before);
  });

  it("a dependent the registry can't answer for still counts, by the range the lockfile holds", async () => {
    const dir = tempDir();
    writeProject(dir, {
      root: { dependencies: { "@corp/lib": "^1.0.0", a: "^1.0.0" }, overrides: { [QS_KEY]: "6.5.3" } },
      packages: {
        "node_modules/@corp/lib": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.3" } },
        "node_modules/qs": { version: "6.5.3" },
      },
    });
    const before = treeOf(dir);
    const npm = fakeNpm();
    await runTargeted(
      cfgFor(dir),
      depsFor(FIXED, npm, async (dependent) =>
        dependent === "a" ? SAFE : { installedRange: null, latestRange: null, latestKnown: false },
      ),
    );
    assert.deepEqual(npm.commands, []);
    assert.deepEqual(treeOf(dir), before);
  });
});

// ---------------------------------------------------------------------------
// Dry run and real run agree; removals show in the report
// ---------------------------------------------------------------------------

describe("dry run and real run", () => {
  const FIXED = [alert(1, "qs", "< 6.5.3", "6.5.3", { state: "fixed" })];

  it("a dry run reports the overrides it would try to remove, and counts them", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, fixedQsProject({ aWants: "^6.5.3" }));
    const before = treeOf(dir);
    const npm = fakeNpm();

    const result = await runTargeted(cfgFor(dir, { dryRun: true, reportDir }), depsFor(FIXED, npm, async () => SAFE));

    assert.deepEqual(treeOf(dir), before);
    assert.deepEqual(npm.commands, []);
    const report = reportIn(reportDir);
    assert.equal(report.outcome, "changes");
    assert.equal(result.overrideChanges, 1);
    assert.deepEqual(report.removedOverrides.map((r) => r.key), [QS_KEY]);
    const md = reportMd(reportDir);
    assert.match(md, /would try to remove/);
    assert.match(md, /\*\*1\*\* override would be removed/);
  });

  it("a stale lockfile with the key already written gives the same outcome and count either way", async () => {
    const results: Array<[number, string]> = [];
    for (const dryRun of [true, false]) {
      const dir = tempDir();
      const reportDir = tempDir();
      writeProject(dir, {
        root: { dependencies: { a: "^1.0.0" }, overrides: { [QS_KEY]: "6.5.3" } },
        packages: { "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.0.0" } }, "node_modules/qs": { version: "6.5.0" } },
      });
      const result = await runTargeted(cfgFor(dir, { dryRun, reportDir }), depsFor([qsAlert()], fakeNpm()));
      results.push([result.overrideChanges, reportIn(reportDir).outcome]);
    }
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[1], [1, "changes"]);
  });
});

// ---------------------------------------------------------------------------
// A report on any failure
// ---------------------------------------------------------------------------

describe("a failed run reports, whatever failed", () => {
  it("a GitHub error: report.json says failed, with a run failure and the reason", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, qsProject());
    await assert.rejects(
      runTargeted(cfgFor(dir, { reportDir }), {
        fetchAlerts: async () => {
          throw new AgentError("GitHub API error 401: Bad credentials");
        },
      }),
      /401/,
    );
    const report = reportIn(reportDir);
    assert.equal(report.outcome, "failed");
    assert.deepEqual(report.failures.map((f) => f.check), ["run"]);
    assert.match(report.failures[0].detail, /GitHub API error 401/);
    assert.match(reportMd(reportDir), /## Failures/);
    assert.doesNotMatch(reportMd(reportDir), /No open alerts needed attention/);
  });

  it("a pnpm stop writes a report too", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, qsProject());
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await assert.rejects(runTargeted(cfgFor(dir, { reportDir }), depsFor([], fakeNpm())), /npm only/);
    assert.match(reportIn(reportDir).failures[0].detail, /npm only/);
  });

  it("an unreadable lockfile writes a report too", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeJson(join(dir, "package.json"), { name: "fx", version: "1.0.0" });
    await assert.rejects(runTargeted(cfgFor(dir, { packageManager: "npm", reportDir }), depsFor([], fakeNpm())), /No package-lock\.json/);
    assert.equal(reportIn(reportDir).outcome, "failed");
  });

  it("a throw after the fixes were applied restores every file, and still reports", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, {
      root: { dependencies: { a: "^1.0.0", b: "^1.0.0" }, overrides: { "ms@>=2.0.0 <2.0.5": "2.0.5" } },
      packages: {
        "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
        "node_modules/qs": { version: "6.5.0" },
        "node_modules/b": { version: "1.0.0", dependencies: { ms: "^2.0.5" } },
        "node_modules/ms": { version: "2.0.5" },
      },
    });
    const before = treeOf(dir);
    await assert.rejects(
      runTargeted(
        cfgFor(dir, { reportDir }),
        depsFor([qsAlert(), alert(2, "ms", "< 2.0.5", "2.0.5", { state: "fixed" })], fakeNpm(), async () => {
          throw new Error("boom in the orphan phase");
        }),
      ),
      /boom/,
    );
    assert.deepEqual(treeOf(dir), before);
    const report = reportIn(reportDir);
    assert.equal(report.outcome, "failed");
    assert.match(report.failures[0].detail, /boom in the orphan phase/);
    assert.equal(report.alerts[0].packageName, "qs", "the plan is in the report");
  });

  it("a report that can't be written restores the tree and says why", async () => {
    const dir = tempDir();
    const reportDir = join(tempDir(), "taken");
    writeFileSync(reportDir, "a file, not a directory");
    writeProject(dir, qsProject());
    const before = treeOf(dir);
    await assert.rejects(
      runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert()], fakeNpm())),
      (e: Error) => e instanceof AgentError && /Could not write the report to .*Every file was restored/.test(e.message),
    );
    assert.deepEqual(treeOf(dir), before);
  });

  it("a report that can't be written doesn't hide a verification failure", async () => {
    const dir = tempDir();
    const reportDir = join(tempDir(), "taken");
    writeFileSync(reportDir, "a file, not a directory");
    writeProject(dir, qsProject());
    await assert.rejects(
      runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert()], fakeNpm({ failIn: dir }))),
      /failed in root: run/,
    );
  });
});

// ---------------------------------------------------------------------------
// An alert on a member of an isolated package
// ---------------------------------------------------------------------------

describe("grouping alerts by the nearest lockfile", () => {
  it("an alert keyed to a member of an isolated package is fixed in that package's lockfile", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, { root: { dependencies: { a: "^1.0.0" } }, packages: { "node_modules/a": { version: "1.0.0" } } });
    writeProject(join(dir, "functions"), {
      root: { name: "functions", workspaces: ["pkg/*"] },
      placed: { "pkg/x": { name: "x", dependencies: { b: "^1.0.0" } } },
      packages: {
        "node_modules/b": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
        "node_modules/qs": { version: "6.5.0" },
      },
    });

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert({ manifest: "functions/pkg/x/package.json" })], fakeNpm()));

    assert.equal(reportIn(reportDir).alerts[0].status, "fixed");
    assert.equal(readLock(join(dir, "functions")).packages["node_modules/qs"].version, "6.5.3");
    assert.deepEqual(readJson(join(dir, "functions", "package.json")).overrides, { [QS_KEY]: "6.5.3" });
  });

  it("groupAlertsByNearestLockfile picks the deepest owner and keeps empty groups", () => {
    const root = path.resolve("/repo");
    const a = (manifest: string): DependabotAlert => alert(1, "qs", "<1", "1", { manifest });
    const groups = groupAlertsByNearestLockfile(
      [a("package.json"), a("package-lock.json"), a("functions/package.json"), a("functions/pkg/x/package.json"), a("apps/web/package.json")],
      root,
      [path.join(root, "functions"), path.join(root, "other")],
    );
    assert.deepEqual(
      [...groups].map(([dir, list]) => [path.relative(root, dir), list.length]),
      [["", 3], ["functions", 2], ["other", 0]],
    );
  });
});

// ---------------------------------------------------------------------------
// Workspace globs are npm's business: anything the lockfile holds that no file: spec reaches is a member
// ---------------------------------------------------------------------------

describe("workspace patterns this tool doesn't read", () => {
  for (const pattern of ["apps/{web,api}", "apps/[wa]*", "apps\\*"]) {
    it(`a member under ${pattern} is bumped with -w, not blocked as a file: package`, async () => {
      const dir = tempDir();
      writeProject(dir, {
        root: { workspaces: [pattern] },
        placed: { "apps/web": { name: "web", dependencies: { minimatch: "^3.0.4" } } },
        packages: { "node_modules/minimatch": { version: "3.0.4" } },
      });
      const npm = fakeNpm();
      await runTargeted(cfgFor(dir), depsFor([MM_ALERT], npm));
      assert.ok(npm.commands.some((c) => c.startsWith("npm install minimatch@3.0.5 -w apps/web ")), npm.commands.join("\n"));
      assert.deepEqual(readJson(join(dir, "apps", "web", "package.json")).dependencies, { minimatch: "^3.0.5" });
    });

    it(`a member under ${pattern} that reaches the copy through glob gets the temporary-root owners`, async () => {
      const dir = tempDir();
      writeProject(dir, {
        root: { workspaces: [pattern] },
        placed: { "apps/web": { name: "web", dependencies: { glob: "^7.1.6" } } },
        packages: {
          "node_modules/glob": { version: "7.1.6", dependencies: { minimatch: "^3.0.4" } },
          "node_modules/minimatch": { version: "3.0.4" },
        },
      });
      const npm = fakeNpm({ reachableVia: "glob" });
      await runTargeted(cfgFor(dir), depsFor([MM_ALERT], npm));
      assert.ok(npm.roots.some((r) => r.devDependencies?.glob === "^7.1.6"));
      assert.equal(readLock(dir).packages["node_modules/minimatch"].version, "3.0.5");
    });
  }
});

// ---------------------------------------------------------------------------
// file: packages outside the root are never read, snapshotted or written
// ---------------------------------------------------------------------------

describe("a file: package outside the repository", () => {
  function externalProject(siblingDeps: Json, extra: Record<string, Json> = {}): { repo: string; sibling: string } {
    const base = tempDir();
    const repo = join(base, "repo");
    writeProject(repo, {
      root: { dependencies: { glob: "^7.1.6", a: "^1.0.0", x: "file:../x" } },
      placed: { "../x": { name: "x", dependencies: siblingDeps } },
      packages: {
        "node_modules/glob": { version: "7.1.6", dependencies: { minimatch: "^3.0.4" } },
        "node_modules/minimatch": { version: "3.0.4" },
        "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
        "node_modules/qs": { version: "6.5.0" },
        "node_modules/ms": { version: "2.0.0" },
        ...extra,
      },
    });
    return { repo, sibling: join(base, "x") };
  }

  /** The alert's verdict on its copy, with the sibling checked out or not. */
  async function verdicts(siblingDeps: Json, alerts: DependabotAlert[]): Promise<Array<{ reason?: string; detail?: string; commands: string[] }>> {
    const out = [];
    for (const present of [true, false]) {
      const { repo, sibling } = externalProject(siblingDeps);
      if (!present) rmSync(sibling, { recursive: true });
      const reportDir = tempDir();
      const npm = fakeNpm();
      await runTargeted(cfgFor(repo, { reportDir }), depsFor(alerts, npm));
      const copy = reportIn(reportDir).alerts[0].copies[0];
      out.push({ reason: copy.reason, detail: copy.detail, commands: npm.commands });
    }
    return out;
  }

  it("a pin there blocks the alert whether or not the sibling is checked out", async () => {
    const [present, absent] = await verdicts({ minimatch: "3.0.4" }, [MM_ALERT]);
    assert.equal(present.reason, "pin");
    assert.deepEqual(absent, present);
    assert.deepEqual(present.commands, []);
  });

  it("a range there is blocked, never bumped with -w ../x, whether or not it is checked out", async () => {
    const [present, absent] = await verdicts({ minimatch: "^3.0.4" }, [MM_ALERT]);
    assert.equal(present.reason, "unrewritable-spec");
    assert.match(present.detail ?? "", /file: dependency/);
    assert.deepEqual(absent, present);
    assert.ok(present.commands.every((c) => !c.includes("../x")));
  });

  it("a failed run leaves the sibling's file untouched, bytes and mtime", async () => {
    const { repo, sibling } = externalProject({ ms: "^2.0.0" });
    const file = join(sibling, "package.json");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(file, old, old);
    const bytes = readFileSync(file);
    const mtime = statSync(file).mtimeMs;
    const npm = fakeNpm({ failIn: repo });

    await assert.rejects(runTargeted(cfgFor(repo), depsFor([qsAlert()], npm)), /failed in root/);

    assert.ok(npm.commands.length > 0, "the run did try to apply a fix");
    assert.ok(npm.commands.every((c) => !c.includes("../x")));
    assert.ok(readFileSync(file).equals(bytes));
    assert.equal(statSync(file).mtimeMs, mtime, "restore didn't rewrite it");
  });
});

// ---------------------------------------------------------------------------
// When putting the files back fails
// ---------------------------------------------------------------------------

describe("a restore that fails", () => {
  it("tries every file, says so in the report, and keeps the original error beside the restore error", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, {
      members: { a: { dependencies: { a1: "^1.0.0" } } },
      packages: {
        "node_modules/a1": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
        "node_modules/qs": { version: "6.5.0" },
      },
    });
    const rootBefore = readFileSync(join(dir, "package.json"), "utf-8");
    const lockBefore = readFileSync(join(dir, "package-lock.json"), "utf-8");
    // npm dies after taking the member's directory with it, so its manifest can't be written back.
    const run: NpmRunner = (_command, cwd) => {
      rmSync(join(cwd, "packages", "a"), { recursive: true, force: true });
      throw new Error("npm died");
    };

    await assert.rejects(
      runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert()], { run })),
      (e: Error) =>
        e instanceof AgentError &&
        /failed in root: run/.test(e.message) &&
        /Restoring the files failed/.test(e.message) &&
        /Could not restore 1 file\(s\)/.test(e.message) &&
        !/Every file was restored/.test(e.message),
    );

    assert.equal(readFileSync(join(dir, "package.json"), "utf-8"), rootBefore, "one bad path didn't strand the others");
    assert.equal(readFileSync(join(dir, "package-lock.json"), "utf-8"), lockBefore);
    const report = reportIn(reportDir);
    assert.equal(report.outcome, "failed");
    assert.match(report.restoreError ?? "", /Could not restore 1 file/);
    assert.match(report.failures[0].detail, /npm died/);
    const md = reportMd(reportDir);
    assert.match(md, /restoring the files failed too/);
    assert.doesNotMatch(md, /No changes were kept/);
  });
});

describe("a failed report that can't be written", () => {
  it("is published once, so the specific failure stays what is reported", async () => {
    const dir = tempDir();
    const reportDir = join(tempDir(), "taken");
    writeFileSync(reportDir, "a file, not a directory");
    writeProject(dir, qsProject());

    await assert.rejects(
      runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert()], fakeNpm({ failIn: dir }))),
      /failed in root: run/,
    );

    const printed = logs.filter((l) => l.includes("## Failures"));
    assert.equal(printed.length, 1, "one report, not two");
    assert.match(printed[0], /ETARGET/);
    assert.doesNotMatch(printed[0], /Could not write the report/);
  });
});

// ---------------------------------------------------------------------------
// The registry: only a 404 says anything about the package
// ---------------------------------------------------------------------------

describe("the npm registry", () => {
  /** The real fetchPublished, against a registry that answers with this. */
  const withRegistry = (answer: () => Promise<Response>, alerts: DependabotAlert[], npm: { run: NpmRunner }): Partial<TargetedDeps> => {
    mock.method(globalThis, "fetch", answer);
    return { fetchAlerts: async () => alerts, run: npm.run };
  };

  for (const [label, answer] of [
    ["a 503", async () => new Response("", { status: 503 })],
    ["a network failure", async () => Promise.reject(new TypeError("fetch failed"))],
  ] as Array<[string, () => Promise<Response>]>) {
    it(`${label} fails the run, rather than reading as every alert's target being unavailable`, async () => {
      const dir = tempDir();
      const reportDir = tempDir();
      writeProject(dir, qsProject());
      const before = treeOf(dir);
      const npm = fakeNpm();

      await assert.rejects(
        runTargeted(cfgFor(dir, { reportDir }), withRegistry(answer, [qsAlert()], npm)),
        (e: Error) => e instanceof AgentError && /npm registry/.test(e.message) && e.message.includes("qs"),
      );

      const report = reportIn(reportDir);
      assert.equal(report.outcome, "failed");
      assert.equal(report.failures[0].check, "run");
      assert.match(report.failures[0].detail, /npm registry/);
      assert.deepEqual(npm.commands, []);
      assert.deepEqual(treeOf(dir), before);
    });
  }

  it("a 404 stays target-unavailable for that alert", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, qsProject());
    const npm = fakeNpm();

    await runTargeted(cfgFor(dir, { reportDir }), withRegistry(async () => new Response("", { status: 404 }), [qsAlert()], npm));

    const report = reportIn(reportDir);
    assert.equal(report.outcome, "blocked-only");
    assert.equal(report.alerts[0].copies[0].reason, "target-unavailable");
    assert.match(report.alerts[0].copies[0].detail ?? "", /isn't on the npm registry/);
  });
});

// ---------------------------------------------------------------------------
// An alert's manifest decides which lockfile answers for it
// ---------------------------------------------------------------------------

describe("an alert on a lockfile discovery doesn't find", () => {
  const X = ".github/actions/x";
  const xMs = (over: { manifest?: string } = {}): DependabotAlert => alert(2, "ms", "< 2.0.5", "2.0.5", { manifest: `${X}/package-lock.json`, ...over });

  /** A root with nothing vulnerable, and a pruned directory holding ms 2.0.0 in a lockfile of its own. */
  const prunedProject = (at = X): string => {
    const dir = tempDir();
    writeProject(dir, { root: { dependencies: { a: "^1.0.0" } }, packages: { "node_modules/a": { version: "1.0.0" } } });
    writeProject(join(dir, at), functionsProject());
    return dir;
  };

  it("is fixed in that lockfile, rather than reported as nothing to change", async () => {
    const dir = prunedProject();
    const reportDir = tempDir();
    const npm = fakeNpm();

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([xMs()], npm));

    const report = reportIn(reportDir);
    assert.equal(report.outcome, "changes");
    assert.deepEqual(report.alerts.map((a) => [a.number, a.packageName, a.status]), [[2, "ms", "fixed"]]);
    assert.equal(report.alerts[0].copies[0].path, `${X}/node_modules/ms`);
    assert.equal(readLock(join(dir, X)).packages["node_modules/ms"].version, "2.0.5");
    assert.deepEqual(readJson(join(dir, X, "package.json")).overrides, { "ms@>=2.0.0 <2.0.5": "2.0.5" });
  });

  it("leaves a vulnerable copy at the root alone, since the alert isn't about it", async () => {
    const dir = tempDir();
    writeProject(dir, functionsProject());
    writeProject(join(dir, X), functionsProject());
    const reportDir = tempDir();
    const rootLock = readFileSync(join(dir, "package-lock.json"), "utf-8");

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([xMs()], fakeNpm()));

    assert.equal(readFileSync(join(dir, "package-lock.json"), "utf-8"), rootLock);
    assert.equal(readLock(join(dir, X)).packages["node_modules/ms"].version, "2.0.5");
    assert.equal(reportIn(reportDir).alerts[0].status, "fixed");
  });

  for (const pruned of ["build/app", "dist/x", "coverage/y", "out/z"]) {
    it(`finds one under ${pruned}, too`, async () => {
      const dir = prunedProject(pruned);
      const reportDir = tempDir();
      await runTargeted(cfgFor(dir, { reportDir }), depsFor([xMs({ manifest: `${pruned}/package.json` })], fakeNpm()));
      assert.equal(reportIn(reportDir).alerts[0].status, "fixed");
      assert.equal(readLock(join(dir, pruned)).packages["node_modules/ms"].version, "2.0.5");
    });
  }

  it("a member of that directory's lockfile answers to it", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    const project = functionsProject();
    writeProject(join(dir, X), { ...project, root: { ...project.root, workspaces: ["sub"] }, placed: { sub: { name: "sub" } } });
    const reportDir = tempDir();
    await runTargeted(cfgFor(dir, { reportDir }), depsFor([xMs({ manifest: `${X}/sub/package.json` })], fakeNpm()));
    assert.equal(readLock(join(dir, X)).packages["node_modules/ms"].version, "2.0.5");
  });

  it("two alerts on it make one group", async () => {
    const dir = prunedProject();
    const reportDir = tempDir();
    await runTargeted(cfgFor(dir, { reportDir }), depsFor([xMs(), alert(3, "ms", "< 2.0.5", "2.0.5", { manifest: `${X}/package.json` })], fakeNpm()));
    assert.deepEqual(reportIn(reportDir).alerts.map((a) => [a.number, a.status]), [[2, "fixed"], [3, "fixed"]]);
  });

  it("stops if that directory is pnpm, naming it, before anything is written", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    mkdirSync(join(dir, X), { recursive: true });
    writeFileSync(join(dir, X, "package.json"), "{}\n");
    writeFileSync(join(dir, X, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const before = treeOf(dir);
    const npm = fakeNpm();
    await assert.rejects(
      runTargeted(cfgFor(dir), depsFor([qsAlert(), xMs({ manifest: `${X}/pnpm-lock.yaml` })], npm)),
      (e: Error) => e instanceof AgentError && /npm only/.test(e.message) && e.message.includes(X),
    );
    assert.deepEqual(npm.commands, []);
    assert.deepEqual(treeOf(dir), before);
  });

  it("an alert that isn't open doesn't bring the directory in", async () => {
    const dir = prunedProject();
    const before = treeOf(dir);
    await runTargeted(cfgFor(dir), depsFor([{ ...xMs(), state: "fixed" }], fakeNpm()));
    assert.deepEqual(treeOf(dir), before);
  });

  describe("with discovery off", () => {
    it("is blocked, naming the manifest, and not folded into the root", async () => {
      const dir = tempDir();
      writeProject(dir, functionsProject());
      writeProject(join(dir, X), functionsProject());
      const reportDir = tempDir();
      const before = treeOf(dir);
      const npm = fakeNpm();

      await runTargeted(cfgFor(dir, { reportDir, discoverPackages: false }), depsFor([xMs()], npm));

      const report = reportIn(reportDir);
      assert.equal(report.outcome, "blocked-only");
      assert.equal(report.blockedCount, 1);
      assert.equal(report.alerts[0].status, "blocked");
      assert.equal(report.alerts[0].copies[0].reason, "manifest-not-processed");
      assert.match(report.alerts[0].copies[0].detail ?? "", /discoverPackages/);
      assert.ok(reportMd(reportDir).includes(`${X}/package-lock.json`));
      assert.deepEqual(npm.commands, []);
      assert.deepEqual(treeOf(dir), before);
    });

    it("listing the directory under packages processes it", async () => {
      const dir = prunedProject();
      const reportDir = tempDir();
      await runTargeted(cfgFor(dir, { reportDir, discoverPackages: false, packages: [X] }), depsFor([xMs()], fakeNpm()));
      assert.equal(reportIn(reportDir).alerts[0].status, "fixed");
    });

    it("a workspace member with no lockfile still answers to the root", async () => {
      const dir = tempDir();
      writeProject(dir, { ...qsProject(), members: { web: {} } });
      const reportDir = tempDir();
      await runTargeted(cfgFor(dir, { reportDir, discoverPackages: false }), depsFor([qsAlert({ manifest: "packages/web/package.json" })], fakeNpm()));
      assert.equal(reportIn(reportDir).alerts[0].status, "fixed");
    });
  });

  it("a directory holding a lockfile but no package.json is blocked, not folded into the root", async () => {
    const dir = tempDir();
    writeProject(dir, functionsProject());
    mkdirSync(join(dir, X), { recursive: true });
    writeFileSync(join(dir, X, "package-lock.json"), "{}\n");
    const reportDir = tempDir();
    const before = treeOf(dir);

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([xMs()], fakeNpm()));

    assert.equal(reportIn(reportDir).alerts[0].copies[0].reason, "manifest-not-processed");
    assert.deepEqual(treeOf(dir), before);
  });
});

describe("an alert whose manifest directory is gone", () => {
  it("is blocked, naming the manifest, and the rest of the run carries on", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    const reportDir = tempDir();
    const gone = alert(2, "qs", "< 6.5.3", "6.5.3", { manifest: "services/old/package-lock.json" });

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert(), gone], fakeNpm()));

    const report = reportIn(reportDir);
    assert.equal(report.outcome, "changes");
    assert.deepEqual(report.alerts.map((a) => [a.number, a.status]), [[1, "fixed"], [2, "blocked"]]);
    assert.equal(report.blockedCount, 1);
    const [copy] = report.alerts[1].copies;
    assert.equal(copy.reason, "manifest-not-processed");
    assert.match(copy.detail ?? "", /services\/old\/package-lock\.json/);
    assert.match(copy.detail ?? "", /no longer exists/);
    assert.match(reportMd(reportDir), /services\/old\/package-lock\.json/);
  });

  it("on its own, the outcome is blocked-only and nothing is written", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    const reportDir = tempDir();
    const before = treeOf(dir);
    const npm = fakeNpm();

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([alert(2, "qs", "< 6.5.3", "6.5.3", { manifest: "services/old/package.json" })], npm));

    assert.equal(reportIn(reportDir).outcome, "blocked-only");
    assert.deepEqual(npm.commands, []);
    assert.deepEqual(treeOf(dir), before);
  });

  it("a manifest path outside the repository is blocked too", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    const reportDir = tempDir();
    await runTargeted(cfgFor(dir, { reportDir }), depsFor([alert(2, "qs", "< 6.5.3", "6.5.3", { manifest: "../elsewhere/package.json" })], fakeNpm()));
    assert.equal(reportIn(reportDir).alerts[0].copies[0].reason, "manifest-not-processed");
  });
});

describe("an alert on a manifest that no lockfile in the run answers for", () => {
  const writeFiles = (dir: string, files: string[]): void => {
    for (const file of files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), "{}\n");
    }
  };
  const assertBlocked = (reportDir: string, manifest: string): void => {
    const report = reportIn(reportDir);
    assert.equal(report.outcome, "blocked-only");
    assert.equal(report.blockedCount, 1);
    assert.equal(report.alerts[0].status, "blocked");
    assert.equal(report.alerts[0].copies[0].reason, "manifest-not-processed");
    assert.ok(report.alerts[0].copies[0].detail?.includes(manifest));
    assert.ok(reportMd(reportDir).includes(manifest));
  };

  const shapes = [
    { name: "a package.json with no lockfile", manifest: "examples/demo/package.json", files: ["examples/demo/package.json"] },
    { name: "a yarn project", manifest: "web/yarn.lock", files: ["web/package.json", "web/yarn.lock"] },
    { name: "an npm-shrinkwrap.json", manifest: "web/npm-shrinkwrap.json", files: ["web/package.json", "web/npm-shrinkwrap.json"] },
    { name: "a sub-project whose lockfile was deleted", manifest: "functions/package.json", files: ["functions/package.json"] },
  ];
  const rootStates: { name: string; project: ProjectSpec }[] = [
    { name: "a vulnerable copy at the root", project: qsProject() },
    {
      name: "a safe copy at the root",
      project: { root: { dependencies: { a: "^1.0.0" } }, packages: { "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.0.0" } }, "node_modules/qs": { version: "6.5.3" } } },
    },
    { name: "no copy at the root", project: { root: { dependencies: { a: "^1.0.0" } }, packages: { "node_modules/a": { version: "1.0.0" } } } },
  ];

  for (const shape of shapes) {
    for (const state of rootStates) {
      it(`${shape.name}, with ${state.name}, is blocked and writes nothing`, async () => {
        const dir = tempDir();
        writeProject(dir, state.project);
        writeFiles(dir, shape.files);
        const reportDir = tempDir();
        const before = treeOf(dir);
        const npm = fakeNpm();

        await runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert({ manifest: shape.manifest })], npm));

        assertBlocked(reportDir, shape.manifest);
        assert.deepEqual(npm.commands, []);
        assert.deepEqual(treeOf(dir), before);
      });
    }
  }

  for (const manifest of ["yarn.lock", "npm-shrinkwrap.json", "packages/web/yarn.lock"]) {
    it(`${manifest} is blocked even where a package-lock.json covers the directory`, async () => {
      const dir = tempDir();
      writeProject(dir, { ...qsProject(), members: { web: {} } });
      writeFiles(dir, [manifest]);
      const reportDir = tempDir();
      const before = treeOf(dir);

      await runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert({ manifest })], fakeNpm()));

      assertBlocked(reportDir, manifest);
      assert.deepEqual(treeOf(dir), before);
    });
  }

  it("a yarn.lock beside an isolated package's own package-lock.json is blocked", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    writeProject(join(dir, "functions"), functionsProject());
    writeFiles(dir, ["functions/yarn.lock"]);
    const reportDir = tempDir();
    const before = treeOf(dir);

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([alert(2, "ms", "< 2.0.5", "2.0.5", { manifest: "functions/yarn.lock" })], fakeNpm()));

    assertBlocked(reportDir, "functions/yarn.lock");
    assert.deepEqual(treeOf(dir), before);
  });

  it("a folder below an isolated package that its lockfile doesn't hold is blocked", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    writeProject(join(dir, "functions"), functionsProject());
    writeFiles(dir, ["functions/tools/x/package.json"]);
    const reportDir = tempDir();
    const before = treeOf(dir);

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([alert(2, "ms", "< 2.0.5", "2.0.5", { manifest: "functions/tools/x/package.json" })], fakeNpm()));

    assertBlocked(reportDir, "functions/tools/x/package.json");
    assert.deepEqual(treeOf(dir), before);
  });

  it("a folder below a directory discovery skips, that its lockfile doesn't hold, is blocked", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    writeProject(join(dir, ".github/actions/x"), functionsProject());
    writeFiles(dir, [".github/actions/x/sub/package.json"]);
    const reportDir = tempDir();
    const before = treeOf(dir);

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([alert(2, "ms", "< 2.0.5", "2.0.5", { manifest: ".github/actions/x/sub/package.json" })], fakeNpm()));

    assertBlocked(reportDir, ".github/actions/x/sub/package.json");
    assert.deepEqual(treeOf(dir), before);
  });

  it("a package.json inside a committed node_modules is blocked, though the lockfile holds that path", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    writeFiles(dir, ["node_modules/a/package.json"]);
    const reportDir = tempDir();

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert({ manifest: "node_modules/a/package.json" })], fakeNpm()));

    assertBlocked(reportDir, "node_modules/a/package.json");
  });

  it("a pnpm-lock.yaml is blocked when the config forces npm, so the pnpm check passes", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const reportDir = tempDir();
    const before = treeOf(dir);

    await runTargeted(cfgFor(dir, { reportDir, packageManager: "npm" }), depsFor([qsAlert({ manifest: "pnpm-lock.yaml" })], fakeNpm()));

    assertBlocked(reportDir, "pnpm-lock.yaml");
    assert.deepEqual(treeOf(dir), before);
  });

  it("a stuck pin in an isolated package names a path that exists", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    writeProject(join(dir, "functions"), {
      root: { name: "functions", dependencies: { ms: "2.0.0" } },
      packages: { "node_modules/ms": { version: "2.0.5" } },
    });
    const reportDir = tempDir();

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([msAlert()], fakeNpm()));

    const [copy] = reportIn(reportDir).alerts[0].copies;
    assert.equal(reportIn(reportDir).alerts[0].status, "blocked");
    assert.equal(copy.reason, "pin");
    assert.equal(copy.path, "functions/package.json");
  });

  it("the rest of the run carries on, and the blocked alert is counted", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    writeFiles(dir, ["examples/demo/package.json"]);
    const reportDir = tempDir();

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert(), alert(2, "qs", "< 6.5.3", "6.5.3", { manifest: "examples/demo/package.json" })], fakeNpm()));

    const report = reportIn(reportDir);
    assert.equal(report.outcome, "changes");
    assert.equal(report.blockedCount, 1);
    assert.deepEqual(report.alerts.map((a) => [a.number, a.status]), [[1, "fixed"], [2, "blocked"]]);
    assert.equal(readLock(dir).packages["node_modules/qs"].version, "6.5.3");
  });

  it("a dry run reports it the same way", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    writeFiles(dir, ["examples/demo/package.json"]);
    const reportDir = tempDir();

    await runTargeted(cfgFor(dir, { reportDir, dryRun: true }), depsFor([qsAlert({ manifest: "examples/demo/package.json" })], fakeNpm()));

    assertBlocked(reportDir, "examples/demo/package.json");
  });
});

describe("a failed run beside an npm-shrinkwrap.json", () => {
  it("restores the shrinkwrap too: npm writes to it, and the report says every file was restored", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    writeFileSync(join(dir, "npm-shrinkwrap.json"), '{"lockfileVersion":3,"packages":{}}\n');
    const before = treeOf(dir);
    const npm = fakeNpm({
      onResolve(cwd) {
        writeFileSync(join(cwd, "npm-shrinkwrap.json"), '{"lockfileVersion":3,"changed":true,"packages":{}}\n');
      },
    });
    const failing: NpmRunner = (command, cwd) => {
      npm.run(command, cwd);
      throw new Error("npm error code E500");
    };

    await assert.rejects(runTargeted(cfgFor(dir), depsFor([qsAlert()], { run: failing })), AgentError);

    assert.deepEqual(treeOf(dir), before);
  });
});

describe("a report across two lockfiles", () => {
  /** minimatch pinned at the root's copy and in functions/, each its own group. */
  const twoPins = (): string => {
    const dir = tempDir();
    const pinned = (name: string): ProjectSpec => ({
      root: { name, dependencies: { minimatch: "3.0.4" } },
      packages: { "node_modules/minimatch": { version: "3.0.4" } },
    });
    writeProject(dir, pinned("fx"));
    writeProject(join(dir, "functions"), pinned("functions"));
    return dir;
  };
  const alerts = [alert(1, "minimatch", "< 3.0.5", "3.0.5", { manifest: "package-lock.json" }), alert(2, "minimatch", "< 3.0.5", "3.0.5", { manifest: "functions/package-lock.json" })];

  it("names the copy and the manifest of the group it came from", async () => {
    const dir = twoPins();
    const reportDir = tempDir();

    await runTargeted(cfgFor(dir, { reportDir }), depsFor(alerts, fakeNpm()));

    const report = reportIn(reportDir);
    const [root, functions] = report.alerts.map((a) => a.copies[0]);
    assert.equal(root.path, "node_modules/minimatch");
    assert.equal(root.detail, 'Pinned at "3.0.4" in package.json.');
    assert.equal(functions.path, "functions/node_modules/minimatch");
    assert.equal(functions.detail, 'In functions: Pinned at "3.0.4" in package.json.');
    const md = reportMd(reportDir);
    assert.match(md, /`functions\/node_modules\/minimatch`: In functions: Pinned at "3\.0\.4" in package\.json\./);
    assert.match(md, /`node_modules\/minimatch`: Pinned at "3\.0\.4" in package\.json\./);
  });

  it("the plan itself keeps the group's own paths: the files were still found", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    writeProject(join(dir, "functions"), functionsProject());
    const reportDir = tempDir();

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert(), msAlert()], fakeNpm()));

    assert.equal(readLock(join(dir, "functions")).packages["node_modules/ms"].version, "2.0.5");
    assert.deepEqual(reportIn(reportDir).alerts.map((a) => a.copies[0].path), ["node_modules/qs", "functions/node_modules/ms"]);
  });
});

describe("an isolated directory that can't be read", () => {
  const v1 = (dir: string): void => {
    const lock = readLock(dir);
    writeLock(dir, { name: lock.name, version: lock.version, lockfileVersion: 1, requires: true, dependencies: {} });
  };

  it("with no alerts and a v1 lockfile: warned about and skipped, and the rest of the run goes ahead", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    writeProject(join(dir, "functions"), functionsProject());
    v1(join(dir, "functions"));
    const reportDir = tempDir();
    const skipped = readFileSync(join(dir, "functions", "package-lock.json"), "utf-8");
    const warnings = mock.method(console, "warn", () => {});

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert()], fakeNpm()));

    assert.equal(reportIn(reportDir).outcome, "changes");
    assert.equal(readLock(dir).packages["node_modules/qs"].version, "6.5.3");
    assert.equal(readFileSync(join(dir, "functions", "package-lock.json"), "utf-8"), skipped);
    assert.ok(warnings.mock.calls.some((call) => /functions/.test(String(call.arguments[0])) && /lockfileVersion/.test(String(call.arguments[0]))));
  });

  it("with an alert on it, a v1 lockfile still stops the run: that alert can't be skipped silently", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    writeProject(join(dir, "functions"), functionsProject());
    v1(join(dir, "functions"));
    await assert.rejects(runTargeted(cfgFor(dir), depsFor([msAlert()], fakeNpm())), (e: Error) => e instanceof AgentError && /lockfileVersion/.test(e.message));
  });

  it("a v1 lockfile at the root still stops the run", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    v1(dir);
    await assert.rejects(runTargeted(cfgFor(dir), depsFor([], fakeNpm())), (e: Error) => e instanceof AgentError && /lockfileVersion/.test(e.message));
  });
});

describe("the npm that ran", () => {
  it("is in the log and the report, on a real run and a dry run", async () => {
    for (const dryRun of [false, true]) {
      const dir = tempDir();
      writeProject(dir, qsProject());
      const reportDir = tempDir();
      await runTargeted(cfgFor(dir, { reportDir, dryRun }), depsFor([qsAlert()], fakeNpm()));
      assert.equal(reportIn(reportDir).npmVersion, "11.16.0");
      assert.match(reportMd(reportDir), /npm 11\.16\.0/);
      assert.ok(logs.some((line) => /npm 11\.16\.0/.test(line) && !line.startsWith("#")));
    }
  });

  it("is in a failed report too", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    const reportDir = tempDir();
    const npm = fakeNpm();
    await assert.rejects(
      runTargeted(cfgFor(dir, { reportDir }), {
        ...depsFor([], npm),
        fetchAlerts: async () => {
          throw new AgentError("GitHub API error 401");
        },
      }),
    );
    assert.equal(reportIn(reportDir).npmVersion, "11.16.0");
    assert.match(reportMd(reportDir), /npm 11\.16\.0/);
  });

  it("not being able to read it doesn't stop the run, and the report says so", async () => {
    const dir = tempDir();
    writeProject(dir, qsProject());
    const reportDir = tempDir();
    await runTargeted(cfgFor(dir, { reportDir }), { ...depsFor([qsAlert()], fakeNpm()), npmVersion: () => null });
    assert.equal(reportIn(reportDir).outcome, "changes");
    assert.equal(reportIn(reportDir).npmVersion, null);
    assert.match(reportMd(reportDir), /npm version unknown/);
  });
});

// ---------------------------------------------------------------------------
// One stubborn package doesn't cost the others their fixes
// ---------------------------------------------------------------------------

describe("a package that won't verify", () => {
  /** qs and ms, each reached only through a package that accepts its fix. */
  const twoAlerts = (): ProjectSpec => ({
    root: { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
    packages: {
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
      "node_modules/qs": { version: "6.5.0" },
      "node_modules/b": { version: "1.0.0", dependencies: { ms: "^2.0.0" } },
      "node_modules/ms": { version: "2.0.0" },
    },
  });
  const rootMs = (): DependabotAlert => alert(2, "ms", "< 2.0.5", "2.0.5");

  /** While an override for ms is in place, npm leaves ms somewhere the plan doesn't say. */
  const stubbornMs = (dir: string): void => {
    const overrides = readJson(join(dir, "package.json")).overrides ?? {};
    if (!Object.keys(overrides).some((key) => key.startsWith("ms@"))) return;
    const lock = readLock(dir);
    lock.packages["node_modules/ms"].version = "2.1.3";
    writeLock(dir, lock);
  };

  it("blocks that package, keeps the other fix, and says why", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, twoAlerts());
    const npm = fakeNpm({ onResolve: stubbornMs });

    await runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert(), rootMs()], npm));

    const report = reportIn(reportDir);
    assert.equal(report.outcome, "changes");
    const status = Object.fromEntries(report.alerts.map((a) => [a.packageName, a.status]));
    assert.deepEqual(status, { qs: "fixed", ms: "blocked" });
    const ms = report.alerts.find((a) => a.packageName === "ms")!.copies[0];
    assert.equal(ms.reason, "failed-verification");
    assert.match(ms.detail!, /2\.1\.3/);
    assert.match(reportMd(reportDir), /## Blocked[\s\S]*ms/);
  });

  it("leaves nothing of the failed attempt behind", async () => {
    const dir = tempDir();
    writeProject(dir, twoAlerts());
    await runTargeted(cfgFor(dir), depsFor([qsAlert(), rootMs()], fakeNpm({ onResolve: stubbornMs })));

    assert.deepEqual(readJson(join(dir, "package.json")).overrides, { [QS_KEY]: "6.5.3" });
    const lock = readLock(dir);
    assert.equal(lock.packages["node_modules/qs"].version, "6.5.3");
    assert.equal(lock.packages["node_modules/ms"].version, "2.0.0");
  });

  it("ends blocked-only, with every file as it was, when that was the only fix", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, twoAlerts());
    const before = treeOf(dir);
    await runTargeted(cfgFor(dir, { reportDir }), depsFor([rootMs()], fakeNpm({ onResolve: stubbornMs })));
    assert.equal(reportIn(reportDir).outcome, "blocked-only");
    assert.deepEqual(treeOf(dir), before);
  });

  it("keeps a fix already made in another lockfile while it retries this one", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, qsProject());
    writeProject(join(dir, "functions"), functionsProject());
    await runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert(), msAlert()], fakeNpm({ onResolve: stubbornMs })));

    assert.equal(readLock(dir).packages["node_modules/qs"].version, "6.5.3");
    assert.equal(readLock(join(dir, "functions")).packages["node_modules/ms"].version, "2.0.0");
    const status = Object.fromEntries(reportIn(reportDir).alerts.map((a) => [a.packageName, a.status]));
    assert.deepEqual(status, { qs: "fixed", ms: "blocked" });
  });

  it("stops retrying after a bound, restores everything, and fails", async () => {
    const names = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, {
      root: { dependencies: Object.fromEntries(names.map((name) => [`via-${name}`, "^1.0.0"])) },
      packages: Object.fromEntries(
        names.flatMap((name) => [
          [`node_modules/via-${name}`, { version: "1.0.0", dependencies: { [name]: "^1.0.0" } }],
          [`node_modules/${name}`, { version: "1.0.0" }],
        ]),
      ),
    });
    const before = treeOf(dir);
    // Only the first package still planned goes wrong, so each attempt rules out exactly one.
    const onePerAttempt = (at: string): void => {
      const overrides = readJson(join(at, "package.json")).overrides ?? {};
      const first = names.find((name) => Object.keys(overrides).some((key) => key.startsWith(`${name}@`)));
      if (!first) return;
      const lock = readLock(at);
      lock.packages[`node_modules/${first}`].version = "1.9.9";
      writeLock(at, lock);
    };
    const npm = fakeNpm({ onResolve: onePerAttempt });
    const deps = depsFor(names.map((name, i) => alert(10 + i, name, "< 1.0.5", "1.0.5")), npm);

    await assert.rejects(
      runTargeted(cfgFor(dir, { reportDir }), {
        ...deps,
        fetchPackage: async () => new Map(["1.0.0", "1.0.5"].map((v) => [v, { dependencies: {}, peerDependencies: {} }])),
      }),
      /failed verification/,
    );
    assert.equal(reportIn(reportDir).outcome, "failed");
    assert.deepEqual(treeOf(dir), before);
  });

  it("still stops the whole run on a failure nothing ties to a package", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, twoAlerts());
    const before = treeOf(dir);
    await assert.rejects(
      runTargeted(cfgFor(dir, { reportDir }), depsFor([qsAlert(), rootMs()], fakeNpm({ failIn: dir }))),
      /failed in root: run/,
    );
    assert.equal(reportIn(reportDir).outcome, "failed");
    assert.deepEqual(treeOf(dir), before);
  });
});

describe("what moved because a fix needed it", () => {
  const project = (): ProjectSpec => ({
    root: { dependencies: { core: "^1.1.0", forms: "^1.1.0" } },
    packages: {
      "node_modules/core": { version: "1.1.2" },
      "node_modules/forms": { version: "1.1.2", peerDependencies: { core: "1.1.2" } },
    },
  });
  const published = async (name: string) =>
    name === "core"
      ? new Map([["1.1.2", { dependencies: {}, peerDependencies: {} }], ["1.2.20", { dependencies: {}, peerDependencies: {} }]])
      : new Map([["1.1.2", { dependencies: {}, peerDependencies: { core: "1.1.2" } }], ["1.2.20", { dependencies: {}, peerDependencies: { core: "1.2.20" } }]]);
  const coreAlert = (): DependabotAlert => alert(1, "core", ">= 1.0.0, < 1.2.20", "1.2.20");

  it("reads a plan's reason from the registry, and shows the unalerted package in the report", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, project());
    await runTargeted(cfgFor(dir, { reportDir, dryRun: true }), { ...depsFor([coreAlert()], fakeNpm()), fetchPackage: published });

    const report = reportIn(reportDir);
    assert.deepEqual(
      report.movedWith?.map((m) => `${m.name} ${m.from}>${m.to}`),
      ["forms 1.1.2>1.2.20"],
    );
    const md = reportMd(reportDir);
    assert.match(md, /## Moved with a fix/);
    assert.match(md, /`forms`.*1\.1\.2 → 1\.2\.20/);
    assert.match(md, /peers core at "1\.1\.2"/);
  });

  it("says nothing about it when nothing moved along", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, qsProject());
    await runTargeted(cfgFor(dir, { reportDir, dryRun: true }), depsFor([qsAlert()], fakeNpm()));
    assert.doesNotMatch(reportMd(reportDir), /Moved with a fix/);
  });
});

describe("what a retry rules out", () => {
  const noPeers = (versions: string[], deps: Record<string, Record<string, string>> = {}) =>
    new Map(versions.map((v) => [v, { dependencies: deps[v] ?? {}, peerDependencies: {} }]));

  it("takes the package driving a move first, so the moved package can still have its own earliest fix", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, {
      root: { dependencies: { top: "^1.0.0" } },
      packages: {
        "node_modules/top": { version: "1.0.0", dependencies: { parent: "^1.0.0", other: "^1.0.0" } },
        "node_modules/parent": { version: "1.0.0", dependencies: { child: "^1.0.0" } },
        "node_modules/other": { version: "1.0.0", dependencies: { child: "^1.0.0" } },
        "node_modules/child": { version: "1.0.0" },
      },
    });
    // child goes wrong only when something pushes it to the higher version.
    const onResolve = (at: string): void => {
      const overrides = readJson(join(at, "package.json")).overrides ?? {};
      if (!Object.keys(overrides).some((key) => key.startsWith("child@") && key.endsWith("<1.0.5"))) return;
      const lock = readLock(at);
      lock.packages["node_modules/child"].version = "1.9.9";
      writeLock(at, lock);
    };
    const npm = fakeNpm({ onResolve });
    await runTargeted(cfgFor(dir, { reportDir }), {
      ...depsFor([alert(1, "parent", "< 1.0.1", "1.0.1"), alert(2, "child", "< 1.0.2", "1.0.2")], npm),
      fetchPackage: async (name) =>
        name === "parent"
          ? noPeers(["1.0.0", "1.0.1"], { "1.0.1": { child: "^1.0.5" } })
          : noPeers(["1.0.0", "1.0.2", "1.0.5"]),
    });

    const status = Object.fromEntries(reportIn(reportDir).alerts.map((a) => [a.packageName, a.status]));
    assert.deepEqual(status, { parent: "blocked", child: "fixed" });
    assert.equal(readLock(dir).packages["node_modules/child"].version, "1.0.2");
  });

  it("leaves an alert on another line of the package alone", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, {
      root: { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
      packages: {
        "node_modules/a": { version: "1.0.0", dependencies: { nanoid: "^3.0.0" } },
        "node_modules/nanoid": { version: "3.3.0" },
        "node_modules/b": { version: "1.0.0", dependencies: { nanoid: "^5.0.0" } },
        "node_modules/b/node_modules/nanoid": { version: "5.0.0" },
      },
    });
    const onResolve = (at: string): void => {
      const overrides = readJson(join(at, "package.json")).overrides ?? {};
      if (!Object.keys(overrides).some((key) => key.includes("<3.3.1"))) return;
      const lock = readLock(at);
      lock.packages["node_modules/nanoid"].version = "3.9.9";
      writeLock(at, lock);
    };
    await runTargeted(cfgFor(dir, { reportDir }), {
      ...depsFor([alert(1, "nanoid", ">= 3.0.0, < 3.3.1", "3.3.1"), alert(2, "nanoid", ">= 5.0.0, < 5.0.1", "5.0.1")], fakeNpm({ onResolve })),
      fetchPackage: async () => noPeers(["3.3.0", "3.3.1", "5.0.0", "5.0.1"]),
    });

    const status = Object.fromEntries(reportIn(reportDir).alerts.map((a) => [a.number, a.status]));
    assert.deepEqual(status, { 1: "blocked", 2: "fixed" });
    assert.equal(readLock(dir).packages["node_modules/b/node_modules/nanoid"].version, "5.0.1");
  });

  for (const [label, edge] of [
    ["a peer", `peer core@"1.2.25" from forms@1.2.25`],
    ["a dev dependency", `dev core@"1.2.25" from the root project`],
    ["a plain dependency", `core@"1.2.25" from the root project`],
  ] as Array<[string, string]>) {
    it(`reads the package from npm's ERESOLVE when the edge is ${label}`, async () => {
      const dir = tempDir();
      const reportDir = tempDir();
      writeProject(dir, {
        root: { dependencies: { core: "^1.0.0", a: "^1.0.0" } },
        packages: {
          "node_modules/core": { version: "1.0.0" },
          "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
          "node_modules/qs": { version: "6.5.0" },
        },
      });
      const fake = fakeNpm();
      const run: NpmRunner = (command, cwd) => {
        if (command.startsWith("npm install core@")) {
          throw Object.assign(new Error(`Command failed: ${command}`), {
            stderr: `npm error code ERESOLVE\nnpm error ERESOLVE could not resolve\nnpm error\nnpm error While resolving: fx@1.0.0\nnpm error\nnpm error Could not resolve dependency:\nnpm error ${edge}\n`,
          });
        }
        fake.run(command, cwd);
      };
      await runTargeted(cfgFor(dir, { reportDir }), {
        ...depsFor([alert(1, "core", "< 1.2.25", "1.2.25"), qsAlert({})], { run }),
        fetchPackage: async (name) => (name === "core" ? noPeers(["1.0.0", "1.2.25"]) : noPeers(["6.5.0", "6.5.3"])),
      });
      const status = Object.fromEntries(reportIn(reportDir).alerts.map((a) => [a.packageName, a.status]));
      assert.deepEqual(status, { core: "blocked", qs: "fixed" });
    });
  }
});

describe("advisories on a fix version, in the report", () => {
  const dryRun = async (fetchAdvisories: TargetedDeps["fetchAdvisories"]) => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, qsProject());
    await runTargeted(cfgFor(dir, { reportDir, dryRun: true }), { ...depsFor([qsAlert()], fakeNpm()), fetchAdvisories });
    return reportDir;
  };

  it("lists a fix that stays inside another advisory, for a person to look at", async () => {
    const reportDir = await dryRun(async () => ({ qs: [{ url: "https://example.test/advisory", vulnerable_versions: ">=6.0.0 <7.0.0" }] }));
    assert.deepEqual(reportIn(reportDir).advised, [{ name: "qs", version: "6.5.3", advisory: "https://example.test/advisory" }]);
    const md = reportMd(reportDir);
    assert.match(md, /## Fix still inside another advisory/);
    assert.match(md, /`qs` 6\.5\.3.*https:\/\/example\.test\/advisory/);
  });

  it("says when the check couldn't run, so a clean report isn't read as a clean check", async () => {
    const reportDir = await dryRun(async () => {
      throw new Error("blocked by a proxy");
    });
    assert.match(reportIn(reportDir).advisoriesUnchecked ?? "", /blocked by a proxy/);
    assert.match(reportMd(reportDir), /weren't checked for advisories of their own.*blocked by a proxy/);
  });

  it("says nothing when the check ran and found nothing", async () => {
    const md = reportMd(await dryRun(async () => ({})));
    assert.doesNotMatch(md, /inside another advisory/);
    assert.doesNotMatch(md, /weren't checked/);
  });
});

describe("a raised version that won't verify", () => {
  const project = (): ProjectSpec => ({
    root: { dependencies: { b: "^1.0.0" } },
    packages: { "node_modules/b": { version: "1.0.0", dependencies: { ms: "^2.0.0" } }, "node_modules/ms": { version: "2.0.0" } },
  });
  const rootMs = (): DependabotAlert => alert(2, "ms", "< 2.0.5", "2.0.5");
  const withRaise = (npm: { run: NpmRunner }): Partial<TargetedDeps> => ({
    ...depsFor([rootMs()], npm),
    fetchPackage: async () => new Map(["2.0.0", "2.0.5", "2.0.7"].map((v) => [v, { dependencies: {}, peerDependencies: {} }])),
    fetchAdvisories: async () => ({ ms: [{ url: "https://example.test/ms", vulnerable_versions: ">=2.0.1 <2.0.7" }] }),
  });
  const raising = (at: string): boolean =>
    Object.keys(readJson(join(at, "package.json")).overrides ?? {}).some((key) => key.startsWith("ms@") && key.endsWith("<2.0.7"));

  it("falls back to the fix itself, and reports it's still inside the advisory", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, project());
    const stubborn = (at: string): void => {
      if (!raising(at)) return;
      const lock = readLock(at);
      lock.packages["node_modules/ms"].version = "2.9.9";
      writeLock(at, lock);
    };
    await runTargeted(cfgFor(dir, { reportDir }), withRaise(fakeNpm({ onResolve: stubborn })));

    const report = reportIn(reportDir);
    assert.equal(report.alerts[0].status, "fixed");
    assert.equal(readLock(dir).packages["node_modules/ms"].version, "2.0.5");
    assert.deepEqual(report.advised?.map((a) => `${a.name} ${a.version}`), ["ms 2.0.5"]);
  });

  it("does the same when npm fails in a way that names no package", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    writeProject(dir, project());
    const fake = fakeNpm();
    const run: NpmRunner = (command, cwd) => {
      if (raising(cwd)) throw Object.assign(new Error(`Command failed: ${command}`), { stderr: "npm error code ETARGET\nnpm error notarget No matching version" });
      fake.run(command, cwd);
    };
    await runTargeted(cfgFor(dir, { reportDir }), withRaise({ run }));

    assert.equal(reportIn(reportDir).alerts[0].status, "fixed");
    assert.equal(readLock(dir).packages["node_modules/ms"].version, "2.0.5");
  });
});

// ---------------------------------------------------------------------------
// The deploy box and the Compared line against a baseline
// ---------------------------------------------------------------------------

describe("compared with the deployed baseline", () => {
  /** qs 6.5.0 (vulnerable) or 6.5.3 (patched), reached through a. */
  const qsAt = (version: string): ProjectSpec => ({
    root: { dependencies: { a: "^1.0.0" } },
    packages: { "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.0.0" } }, "node_modules/qs": { version } },
  });

  /** A git repo whose last commit has qs `committed`; the working copy then gets `working`, uncommitted. */
  function gitProject(committed: string, working: string): { dir: string; sha: string } {
    const dir = tempDir();
    const git = (...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    writeProject(dir, qsAt(committed));
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    git("add", ".");
    git("commit", "-q", "-m", "committed");
    writeProject(dir, qsAt(working));
    return { dir, sha: git("rev-parse", "HEAD").trim() };
  }

  async function runIn(
    dir: string,
    over: Partial<ResolvedConfig> = {},
    fetched: Record<string, string> = {},
    alerts: DependabotAlert[] = [qsAlert()],
  ): Promise<{ report: RunReport; md: string; urls: string[] }> {
    const reportDir = tempDir();
    const urls: string[] = [];
    mock.method(globalThis, "fetch", async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      const contents = /\/contents\/([^?]+)\?ref=/.exec(url);
      const text = contents ? fetched[decodeURIComponent(contents[1])] : undefined;
      return text === undefined ? new Response("Not Found", { status: 404 }) : new Response(text, { status: 200 });
    });
    await runTargeted(cfgFor(dir, { reportDir, ...over }), depsFor(alerts, fakeNpm()));
    return { report: reportIn(reportDir), md: reportMd(reportDir), urls };
  }

  it("an alert already patched in the working lockfile but vulnerable in the last commit gets the Deploy box", async () => {
    const { dir, sha } = gitProject("6.5.0", "6.5.3");
    const { report, md } = await runIn(dir);

    assert.equal(report.alerts[0].status, "awaiting-close");
    assert.equal(report.outcome, "clean");
    assert.deepEqual(report.baselineVulnerable, [1]);
    assert.deepEqual(report.baseline, { kind: "commit", sha, fallbacks: [] });
    assert.ok(md.includes(`Compared with the last commit (\`${sha.slice(0, 7)}\`).`), md);
    assert.ok(md.includes("[!IMPORTANT]") && md.includes("`qs`"), md);
    assert.ok(md.indexOf("Compared with") < md.indexOf("## Deploy recommendation"));
  });

  it("an alert whose package wasn't vulnerable in the last commit never counts, and the box isn't silent", async () => {
    const { dir } = gitProject("6.6.0", "6.5.3");
    const { report, md } = await runIn(dir);

    assert.deepEqual(report.baselineVulnerable, []);
    assert.doesNotMatch(md, /\[!IMPORTANT\]/);
    assert.ok(md.includes("No deploy needed:") && md.includes("compared with the last commit"), md);
  });

  it("outside a git repository it compares with the start of the run and keeps 1.4.0's rule", async () => {
    const dir = tempDir();
    writeProject(dir, qsAt("6.5.3"));
    const { report, md } = await runIn(dir);

    assert.equal(report.baselineVulnerable, undefined);
    assert.equal(report.baseline?.kind, "run-start");
    assert.ok(md.includes("Compared with the packages installed at the start of the run."), md);
    assert.doesNotMatch(md, /\[!IMPORTANT\]/);
    assert.equal(report.outcome, "clean");
  });

  it("the last commit has no lockfile: a warning and the start of the run, and the run goes on", async () => {
    const { dir } = gitProject("6.5.0", "6.5.3");
    execFileSync("git", ["rm", "-q", "--cached", "package-lock.json"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e.test", "commit", "-q", "-m", "drop lock"], { cwd: dir });
    const { report, md } = await runIn(dir);

    assert.equal(report.baselineVulnerable, undefined);
    assert.deepEqual(report.baseline?.fallbacks.map((f) => [f.manifest, f.kind]), [["root", "run-start"]]);
    assert.ok(md.includes("Couldn't read package-lock.json from the last commit (not in the last commit); compared with the packages installed at the start of the run instead."), md);
    assert.ok(md.includes("Compared with the last commit ("), md);
    assert.ok(!md.includes("Compared with the packages installed"), md);
    assert.equal(report.outcome, "clean");
  });

  it("compareTo is read from GitHub", async () => {
    const { dir } = gitProject("6.6.0", "6.5.3");
    const release = JSON.stringify(readLock(dir)).replace("6.5.3", "6.5.0");
    const { report, md, urls } = await runIn(dir, { compareTo: "release" }, { "package-lock.json": release });

    assert.ok(urls.includes("https://api.github.com/repos/o/r/contents/package-lock.json?ref=release"), urls.join(", "));
    assert.deepEqual(urls.filter((u) => u.includes("/contents/")), ["https://api.github.com/repos/o/r/contents/package-lock.json?ref=release"], "only the lockfile is read at the baseline");
    assert.deepEqual(report.baseline, { kind: "ref", ref: "release", fallbacks: [] });
    assert.deepEqual(report.baselineVulnerable, [1]);
    assert.ok(md.includes("Compared with `release` on GitHub."), md);
    assert.ok(md.includes("[!IMPORTANT]"), md);
  });

  it("an unreadable compareTo warns and falls back to the last commit", async () => {
    const { dir } = gitProject("6.5.0", "6.5.3");
    const { report, md } = await runIn(dir, { compareTo: "release" });

    assert.deepEqual(report.baseline?.fallbacks.map((f) => [f.manifest, f.kind, f.reason]), [["root", "commit", "404"]]);
    assert.deepEqual(report.baselineVulnerable, [1]);
    assert.ok(md.includes('Compared with `release` on GitHub.'), md);
    assert.ok(md.includes(`Couldn't read package-lock.json on "release" from GitHub (404); compared with the last commit instead.`), md);
    assert.ok(md.includes("[!IMPORTANT]"), md);
    assert.equal(report.baseline?.kind, "ref");
  });

  it("compareTo with no token (an alerts file) falls back to the last commit without asking GitHub", async () => {
    const { dir } = gitProject("6.5.0", "6.5.3");
    const { report, md, urls } = await runIn(dir, { compareTo: "release", token: "" });

    assert.deepEqual(urls.filter((u) => u.includes("/contents/")), []);
    assert.ok(md.includes('on "release" from GitHub (no token); compared with the last commit instead.'), md);
    assert.ok(md.includes("Compared with `release` on GitHub."), md);
    assert.deepEqual(report.baselineVulnerable, [1]);
  });

  it("an isolated package whose lockfile isn't at the baseline falls back on its own and its alerts count", async () => {
    // The root is committed (and on `release`); functions/ has a lockfile in the working copy only.
    const { dir } = gitProject("6.5.0", "6.5.3");
    writeProject(join(dir, "functions"), functionsProject());
    const release = JSON.stringify(readLock(dir)).replace("6.5.3", "6.5.0");
    const { report, md, urls } = await runIn(dir, { compareTo: "release" }, { "package-lock.json": release }, [qsAlert(), msAlert()]);

    // qs was vulnerable at the baseline; ms can't be told, so it counts as in 1.4.0.
    assert.deepEqual(report.baselineVulnerable, [1, 2]);
    assert.deepEqual(report.baseline?.fallbacks.map((f) => [f.manifest, f.kind]), [["functions", "run-start"]]);
    const read = urls.filter((u) => u.includes("/contents/"));
    assert.ok(read.includes("https://api.github.com/repos/o/r/contents/package-lock.json?ref=release"), read.join(", "));
    assert.ok(read.includes("https://api.github.com/repos/o/r/contents/functions/package-lock.json?ref=release"), read.join(", "));
    assert.ok(md.includes("Compared with `release` on GitHub."), md);
    assert.ok(md.includes(`Couldn't read functions/package-lock.json on "release" from GitHub (404); compared with the last commit instead.`), md);
    assert.ok(md.includes("Couldn't read functions/package-lock.json from the last commit (not in the last commit); compared with the packages installed at the start of the run instead."), md);
    assert.ok(!md.includes("Couldn't read package-lock.json"), md);
  });

  it("an unexpected failure reading the baseline is a warning: the run goes on and the box keeps its 1.4.0 rule", async () => {
    const { dir } = gitProject("6.5.0", "6.5.3");
    const reportDir = tempDir();
    const cfg = cfgFor(dir, { reportDir });
    Object.defineProperty(cfg, "owner", { get: () => { throw new Error("boom"); } });
    mock.method(globalThis, "fetch", async () => new Response("", { status: 404 }));
    await runTargeted(cfg, depsFor([qsAlert()], fakeNpm()));

    const report = reportIn(reportDir);
    assert.equal(report.outcome, "clean");
    assert.equal(report.baseline, undefined);
    assert.equal(report.baselineVulnerable, undefined);
    assert.deepEqual(report.warnings, ["⚠️  Couldn't read the baseline (boom); the deploy box keeps its 1.4.0 rule."]);
    const md = reportMd(reportDir);
    assert.ok(md.includes("Couldn't read the baseline (boom)"), md);
    assert.doesNotMatch(md, /Compared with/);
  });

  it("the files the workflow reads are unchanged by the baseline", async () => {
    const { dir } = gitProject("6.5.0", "6.5.3");
    const { report } = await runIn(dir);
    assert.equal(report.outcome, "clean");
    assert.equal(report.blockedCount, 0);
    assert.equal(report.restoreError, undefined);
  });
});
