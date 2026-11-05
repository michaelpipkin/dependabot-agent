import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyPlan, batchedBumpCommands, bumpCommand, NpmRunner, resolveCommand, snapshotFiles, tryRemoveOverride } from "../src/targeted/apply.js";
import { DirectBump, ManifestInfo, Plan } from "../src/targeted/plan.js";

function bump(over: Partial<DirectBump> = {}): DirectBump {
  return {
    manifestDir: "/repo",
    memberPath: null,
    name: "debug",
    field: "dependencies",
    from: "^4.1.0",
    operator: "^",
    target: "4.3.1",
    ...over,
  };
}

function emptyPlan(over: Partial<Plan> = {}): Plan {
  return { alerts: [], bumps: [], addOverrides: {}, removeOverrideKeys: [], targets: new Map(), ...over };
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "targeted-apply-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

const readJson = (file: string): Json => JSON.parse(readFileSync(file, "utf-8")) as Json;
const writeJson = (file: string, value: unknown): void => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

interface Project {
  dir: string;
  rootFile: string;
  lockFile: string;
  memberFile: string;
  manifests: ManifestInfo[];
}

/** A workspace whose one member reaches minimatch through glob: the shape npm won't re-apply overrides to. */
function memberProject(
  over: { root?: Json; member?: Json; packages?: Record<string, object> } = {},
): Project {
  const dir = tempDir();
  const member: Json = { name: "a", version: "1.0.0", dependencies: { glob: "^7.1.6" }, ...over.member };
  const root: Json = { name: "fx", version: "1.0.0", workspaces: ["packages/*"], ...over.root };
  mkdirSync(join(dir, "packages", "a"), { recursive: true });
  const rootFile = join(dir, "package.json");
  const memberFile = join(dir, "packages", "a", "package.json");
  const lockFile = join(dir, "package-lock.json");
  writeJson(rootFile, root);
  writeJson(memberFile, member);
  writeJson(lockFile, {
    name: "fx",
    lockfileVersion: 3,
    packages: {
      "": { name: "fx", version: "1.0.0", workspaces: ["packages/*"], devDependencies: root.devDependencies },
      "packages/a": { name: "a", version: "1.0.0", ...member },
      "node_modules/a": { link: true, resolved: "packages/a" },
      "node_modules/glob": { version: "7.1.6", dependencies: { minimatch: "^3.0.4" } },
      "node_modules/minimatch": { version: "3.0.4" },
      ...over.packages,
    },
  });
  return {
    dir,
    rootFile,
    lockFile,
    memberFile,
    manifests: [
      { dir, lockPath: "", deps: [] },
      { dir: join(dir, "packages", "a"), lockPath: "packages/a", deps: [] },
    ],
  };
}

const overridePlan = (): Plan =>
  emptyPlan({
    addOverrides: { "minimatch@>=3.0.0 <3.0.5": "3.0.5" },
    targets: new Map([["node_modules/minimatch", "3.0.5"]]),
  });

function setLockVersion(project: Project, path: string, version: string): void {
  const lock = readJson(project.lockFile) as { packages: Record<string, Json> };
  lock.packages[path].version = version;
  writeJson(project.lockFile, lock);
}

/** Copy root devDependencies into the lock's root entry, as a real resolve does. */
function syncRootEntry(project: Project): void {
  const lock = readJson(project.lockFile) as { packages: Record<string, Json> };
  const root = readJson(project.rootFile);
  lock.packages[""].devDependencies = root.devDependencies;
  writeJson(project.lockFile, lock);
}

/**
 * A stand-in for npm that behaves as testing showed the real one does: a resolve
 * moves minimatch only once something leading to it is declared at the root.
 */
function fakeNpm(project: Project, opts: { reachable?: boolean; onResolve?: (rootText: string) => void } = {}) {
  const commands: string[] = [];
  const run: NpmRunner = (command) => {
    commands.push(command);
    if (command !== resolveCommand()) return;
    opts.onResolve?.(readFileSync(project.rootFile, "utf-8"));
    const root = readJson(project.rootFile);
    if (opts.reachable || "glob" in ((root.devDependencies as Json | undefined) ?? {})) {
      setLockVersion(project, "node_modules/minimatch", "3.0.5");
    }
    syncRootEntry(project);
  };
  return { run, commands };
}

const resolves = (commands: string[]): number => commands.filter((c) => c === resolveCommand()).length;

describe("bumpCommand", () => {
  // Review Focus 2
  it("quotes the prefix so cmd.exe keeps ^", () => {
    const cmd = bumpCommand(bump());
    assert.match(cmd, /^npm install debug@4\.3\.1 /);
    assert.match(cmd, /"--save-prefix=\^"/);
    assert.match(cmd, /--save-exact=false/);
    assert.match(cmd, /--package-lock-only/);
    assert.match(cmd, /--ignore-scripts/);
    assert.match(cmd, /--no-audit/);
    assert.match(cmd, /--no-fund/);
    assert.doesNotMatch(cmd, / -w /);
  });

  it("targets a member with -w", () => {
    assert.match(bumpCommand(bump({ memberPath: "packages/a" })), / -w packages\/a /);
  });

  it("quotes a member path holding a space", () => {
    assert.match(bumpCommand(bump({ memberPath: "packages/my app" })), / -w "packages\/my app" /);
  });

  it("keeps ~", () => {
    const cmd = bumpCommand(bump({ operator: "~" }));
    assert.match(cmd, /"--save-prefix=~"/);
    assert.doesNotMatch(cmd, /\^/);
  });

  it("keeps a scoped name", () => {
    assert.match(bumpCommand(bump({ name: "@scope/pkg" })), /^npm install @scope\/pkg@4\.3\.1 /);
  });

  it("refuses a name or path a shell would read as more than a word", () => {
    assert.throws(() => bumpCommand(bump({ name: "x;rm -rf ." })), /shell/);
    assert.throws(() => bumpCommand(bump({ name: "x&calc" })), /shell/);
    assert.throws(() => bumpCommand(bump({ memberPath: 'a" && calc "' })), /shell/);
    assert.throws(() => bumpCommand(bump({ memberPath: "a%PATH%" })), /shell/);
    assert.throws(() => bumpCommand(bump({ memberPath: "$(calc)" })), /shell/);
  });
});

describe("resolveCommand", () => {
  it("resolves the lockfile alone, running nothing", () => {
    const cmd = resolveCommand();
    assert.match(cmd, /^npm install /);
    for (const flag of ["--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]) {
      assert.ok(cmd.includes(flag), flag);
    }
  });
});

describe("snapshotFiles", () => {
  it("snapshot restore returns the exact bytes", () => {
    const file = join(tempDir(), "x.json");
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x0d, 0x0a, 0x09, 0x7d, 0x0d, 0x0a, 0xff]);
    writeFileSync(file, bytes);
    const snap = snapshotFiles([file]);
    writeFileSync(file, "changed");
    snap.restore();
    assert.deepEqual(readFileSync(file), bytes);
  });

  it("removes a file that didn't exist when the snapshot was taken", () => {
    const dir = tempDir();
    const file = join(dir, "new.json");
    const snap = snapshotFiles([file]);
    writeFileSync(file, "created");
    snap.restore();
    assert.throws(() => readFileSync(file), /ENOENT/);
  });

  it("tries every file even when one can't be restored, then reports all the failures together", () => {
    const dir = tempDir();
    const first = join(dir, "gone", "a.json");
    const second = join(dir, "b.json");
    const third = join(dir, "gone", "c.json");
    const fourth = join(dir, "d.json");
    mkdirSync(join(dir, "gone"));
    for (const file of [first, second, third, fourth]) writeFileSync(file, "original");
    const snap = snapshotFiles([first, second, third, fourth]);
    writeFileSync(second, "changed");
    writeFileSync(fourth, "changed");
    // A directory that has vanished makes its files unwritable.
    rmSync(join(dir, "gone"), { recursive: true });

    assert.throws(
      () => snap.restore(),
      (e: Error) => /Could not restore 2 file\(s\)/.test(e.message) && e.message.includes("a.json") && e.message.includes("c.json"),
    );
    assert.equal(readFileSync(second, "utf-8"), "original", "the files after the first failure are restored too");
    assert.equal(readFileSync(fourth, "utf-8"), "original");
  });
});

describe("applyPlan", () => {
  it("runs bumps, then writes overrides, then resolves", () => {
    const project = memberProject({ root: { dependencies: { debug: "^4.1.0" } } });
    const seen: string[] = [];
    const run: NpmRunner = (command) => {
      const overrides = readJson(project.rootFile).overrides;
      seen.push(command === resolveCommand() ? `resolve:${overrides ? "overrides" : "none"}` : `bump:${overrides ? "overrides" : "none"}`);
      if (command === resolveCommand()) setLockVersion(project, "node_modules/minimatch", "3.0.5");
    };
    applyPlan(project.dir, { ...overridePlan(), bumps: [bump({ manifestDir: project.dir })] }, {
      limits: {},
      manifests: project.manifests,
      run,
    });
    assert.deepEqual(seen, ["bump:none", "resolve:overrides", "resolve:overrides"]);
  });

  it("runs bump commands from the project root", () => {
    const project = memberProject();
    const cwds: string[] = [];
    const run: NpmRunner = (_command, cwd) => {
      cwds.push(cwd);
    };
    applyPlan(project.dir, emptyPlan({ bumps: [bump({ manifestDir: join(project.dir, "packages/a"), memberPath: "packages/a" })] }), {
      limits: {},
      manifests: project.manifests,
      run,
    });
    assert.ok(cwds.length > 0);
    assert.ok(cwds.every((cwd) => cwd === project.dir));
  });

  it("removes the keys it replaces and keeps nested overrides", () => {
    const project = memberProject({
      root: { overrides: { minimatch: ">=3.0.0", webpack: { "loader-utils": "^2.0.4" }, ms: "2.1.3" } },
    });
    const { run } = fakeNpm(project, { reachable: true });
    applyPlan(project.dir, { ...overridePlan(), removeOverrideKeys: ["minimatch"] }, {
      limits: {},
      manifests: project.manifests,
      run,
    });
    assert.deepEqual(readJson(project.rootFile).overrides, {
      "minimatch@>=3.0.0 <3.0.5": "3.0.5",
      ms: "2.1.3",
      webpack: { "loader-utils": "^2.0.4" },
    });
  });

  it("a plan with no changes runs no npm command and touches nothing", () => {
    const project = memberProject();
    const text = '{\n\t"name": "fx",\n\t"workspaces": ["packages/*"]\n}\n';
    writeFileSync(project.rootFile, text);
    const { run, commands } = fakeNpm(project);
    const failures = applyPlan(project.dir, emptyPlan(), { limits: {}, manifests: project.manifests, run });
    assert.deepEqual(commands, []);
    assert.deepEqual(failures, []);
    assert.equal(readFileSync(project.rootFile, "utf-8"), text);
  });

  it("a plan with no changes doesn't need a lockfile it can read", () => {
    const project = memberProject();
    writeFileSync(project.lockFile, "{ not json");
    assert.deepEqual(applyPlan(project.dir, emptyPlan(), { limits: {}, manifests: project.manifests, run: () => {} }), []);
  });

  it("a plan with targets alone still runs, writing no override", () => {
    const project = memberProject();
    const text = readFileSync(project.rootFile, "utf-8");
    const { run, commands } = fakeNpm(project, { reachable: true });
    const plan = emptyPlan({ targets: new Map([["node_modules/minimatch", "3.0.5"]]) });
    const failures = applyPlan(project.dir, plan, { limits: {}, manifests: project.manifests, run });
    assert.equal(resolves(commands), 2);
    assert.deepEqual(failures, []);
    assert.equal(readFileSync(project.rootFile, "utf-8"), text);
  });

  it("deletes the keys being replaced before the bumps, and adds new keys after them", () => {
    const project = memberProject({ root: { overrides: { debug: ">=4.0.0", ms: "2.1.3" } } });
    const seen: Array<[string, unknown]> = [];
    const run: NpmRunner = (command) => {
      seen.push([command === resolveCommand() ? "resolve" : "bump", readJson(project.rootFile).overrides]);
    };
    const plan = emptyPlan({
      bumps: [bump({ memberPath: "packages/a" })],
      addOverrides: { "debug@>=4.0.0 <4.3.1": "4.3.1" },
      removeOverrideKeys: ["debug"],
    });
    applyPlan(project.dir, plan, { limits: {}, manifests: project.manifests, run });
    assert.deepEqual(seen, [
      ["bump", { ms: "2.1.3" }],
      ["resolve", { "debug@>=4.0.0 <4.3.1": "4.3.1", ms: "2.1.3" }],
      ["resolve", { "debug@>=4.0.0 <4.3.1": "4.3.1", ms: "2.1.3" }],
    ]);
  });

  it("uses the temporary-root step only for copies that did not move", () => {
    // fake runner leaves minimatch at the old version on the first resolve
    // → adds glob to root devDependencies, resolves, restores, resolves
    const project = memberProject();
    const roots: Array<Json | undefined> = [];
    const { run, commands } = fakeNpm(project, {
      onResolve: (text) => roots.push((JSON.parse(text) as Json).devDependencies as Json | undefined),
    });
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.deepEqual(failures, []);
    // first resolve, with the temporary entry, after restoring, the stability check
    assert.equal(resolves(commands), 4);
    assert.deepEqual(roots, [undefined, { glob: "^7.1.6" }, undefined, undefined]);
  });

  it("skips the temporary-root step when the first resolve moved everything", () => {
    const project = memberProject();
    const roots: Array<Json | undefined> = [];
    const { run, commands } = fakeNpm(project, {
      reachable: true,
      onResolve: (text) => roots.push((JSON.parse(text) as Json).devDependencies as Json | undefined),
    });
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.deepEqual(failures, []);
    assert.equal(resolves(commands), 2);
    assert.deepEqual(roots, [undefined, undefined]);
  });

  it("restores root devDependencies byte-for-byte after the temporary-root step", () => {
    const project = memberProject({ root: { devDependencies: { typescript: "^5.0.0" } } });
    let beforeStep: string | undefined;
    const { run } = fakeNpm(project, {
      onResolve: (text) => {
        beforeStep ??= text;
      },
    });
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.deepEqual(failures, []);
    assert.equal(readFileSync(project.rootFile, "utf-8"), beforeStep);
    assert.deepEqual(readJson(project.rootFile).devDependencies, { typescript: "^5.0.0" });
  });

  it("lets an entry the root already declares win", () => {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const project = memberProject({ root: { [field]: { glob: "7.1.6" } } });
      const during: Json[] = [];
      const run: NpmRunner = (command) => {
        if (command === resolveCommand()) during.push(readJson(project.rootFile));
      };
      applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
      for (const seen of during) {
        assert.deepEqual(seen[field], { glob: "7.1.6" }, field);
        if (field !== "devDependencies") assert.equal(seen.devDependencies, undefined, field);
      }
    }
  });

  it("restores the root even when the temporary resolve fails", () => {
    const project = memberProject();
    let calls = 0;
    const run: NpmRunner = (command) => {
      if (command === resolveCommand() && ++calls === 2) throw new Error("npm ERR! ERESOLVE");
    };
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.equal(failures[0].check, "run");
    assert.match(failures[0].detail, /ERESOLVE/);
    assert.equal(readJson(project.rootFile).devDependencies, undefined);
  });

  it("adds a member's peer and optional edges as temporary root entries", () => {
    const project = memberProject({
      member: { dependencies: undefined, peerDependencies: { glob: "^7.1.6" }, optionalDependencies: { rimraf: "^3.0.0" } },
      packages: { "node_modules/rimraf": { version: "3.0.2", dependencies: { glob: "^7.1.3" } } },
    });
    const during: Array<Json | undefined> = [];
    const { run, commands } = fakeNpm(project, {
      onResolve: (text) => during.push((JSON.parse(text) as Json).devDependencies as Json | undefined),
    });
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.deepEqual(failures, []);
    assert.equal(resolves(commands), 4);
    assert.deepEqual(during[1], { glob: "^7.1.6", rimraf: "^3.0.0" });
  });

  it("adds a member's dev edge even when the same name is also its peer", () => {
    const project = memberProject({
      member: { dependencies: undefined, peerDependencies: { glob: "^7.0.0" }, devDependencies: { glob: "^7.1.6" } },
    });
    const during: Array<Json | undefined> = [];
    const { run } = fakeNpm(project, {
      onResolve: (text) => during.push((JSON.parse(text) as Json).devDependencies as Json | undefined),
    });
    applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.deepEqual(during[1], { glob: "^7.1.6" });
  });

  it("uses another member's real dependency when the first only peers on it", () => {
    const project = memberProject({
      member: { dependencies: undefined, peerDependencies: { glob: "^7.0.0" } },
      packages: { "packages/b": { name: "b", version: "1.0.0", dependencies: { glob: "^7.1.6" } } },
    });
    const during: Array<Json | undefined> = [];
    const { run } = fakeNpm(project, {
      onResolve: (text) => during.push((JSON.parse(text) as Json).devDependencies as Json | undefined),
    });
    const manifests = [...project.manifests, { dir: join(project.dir, "packages/b"), lockPath: "packages/b", deps: [] }];
    applyPlan(project.dir, overridePlan(), { limits: {}, manifests, run });
    assert.deepEqual(during[1], { glob: "^7.1.6" });
  });

  it("doesn't add a sibling workspace member as a temporary root entry", () => {
    const project = memberProject({
      member: { dependencies: { b: "^1.0.0" } },
      packages: {
        "packages/b": { name: "b", version: "1.0.0", dependencies: { glob: "^7.1.6" } },
        "node_modules/b": { link: true, resolved: "packages/b" },
      },
    });
    const during: Array<Json | undefined> = [];
    const { run } = fakeNpm(project, {
      onResolve: (text) => during.push((JSON.parse(text) as Json).devDependencies as Json | undefined),
    });
    const manifests = [...project.manifests, { dir: join(project.dir, "packages/b"), lockPath: "packages/b", deps: [] }];
    applyPlan(project.dir, overridePlan(), { limits: {}, manifests, run });
    assert.deepEqual(during[1], { glob: "^7.1.6" });
  });

  it("returns a failure rather than throwing when npm exits non-zero", () => {
    const project = memberProject();
    const run: NpmRunner = () => {
      throw new Error("Command failed: npm install\nnpm ERR! code EOVERRIDE");
    };
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].check, "run");
    assert.match(failures[0].detail, /EOVERRIDE/);
  });

  it("puts npm's error code and message in the detail, and leaves out the noise", () => {
    const project = memberProject();
    const stderr = [
      "npm warn deprecated glob@7.1.6: old",
      "npm error code EOVERRIDE",
      "npm error Override for minimatch@^3.0.4 conflicts with direct dependency",
      "npm error A complete log of this run can be found in: C:\\npm-cache\\_logs\\x-debug-0.log",
      "",
    ].join("\r\n");
    const run: NpmRunner = (command) => {
      throw Object.assign(new Error(`Command failed: ${command}\n${stderr}`), { stderr: Buffer.from(stderr) });
    };
    const [failure] = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.equal(failure.check, "run");
    assert.match(failure.detail, /^Command failed: npm install /);
    assert.match(failure.detail, /npm error code EOVERRIDE/);
    assert.match(failure.detail, /Override for minimatch@\^3\.0\.4 conflicts/);
    assert.doesNotMatch(failure.detail, /npm warn/);
    assert.doesNotMatch(failure.detail, /complete log/);
  });

  it("keeps a shell's own complaint when npm never got to say anything", () => {
    const project = memberProject();
    const run: NpmRunner = () => {
      throw Object.assign(new Error("Command failed: npm install"), { stderr: "'npm' is not recognized\r\n" });
    };
    const [failure] = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.match(failure.detail, /Command failed: npm install/);
    assert.match(failure.detail, /not recognized/);
  });

  it("returns a failure when a name can't go on a command line, running nothing", () => {
    const project = memberProject();
    const { run, commands } = fakeNpm(project);
    const failures = applyPlan(project.dir, emptyPlan({ bumps: [bump({ name: "x;calc" })] }), {
      limits: {},
      manifests: project.manifests,
      run,
    });
    assert.equal(failures[0].check, "run");
    assert.deepEqual(commands, []);
  });

  it("returns a failure rather than throwing when npm leaves an unreadable lockfile", () => {
    const project = memberProject();
    const run: NpmRunner = () => writeFileSync(project.lockFile, "{ not json");
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.equal(failures[0].check, "run");
    assert.match(failures[0].detail, /parse/i);
  });

  it("returns a failure rather than throwing when verification itself throws", () => {
    const project = memberProject();
    const { run } = fakeNpm(project, { reachable: true });
    // Only verify reads the limits, and only once an entry has changed.
    const limits = {
      get odd(): string {
        throw new Error("odd override key");
      },
    };
    const failures = applyPlan(project.dir, overridePlan(), { limits, manifests: project.manifests, run });
    assert.equal(failures.length, 1);
    assert.match(failures[0].detail, /odd override key/);
  });

  it("reports an unstable lockfile", () => {
    const project = memberProject();
    let calls = 0;
    const run: NpmRunner = (command) => {
      if (command !== resolveCommand()) return;
      setLockVersion(project, "node_modules/minimatch", "3.0.5");
      if (++calls === 2) writeFileSync(project.lockFile, readFileSync(project.lockFile, "utf-8") + "\n");
    };
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.deepEqual(failures.map((f) => f.check), ["stable"]);
  });

  it("reports a temporary entry npm left in the lockfile's root entry", () => {
    const project = memberProject();
    const run: NpmRunner = (command) => {
      if (command !== resolveCommand()) return;
      setLockVersion(project, "node_modules/minimatch", "3.0.5");
      const lock = readJson(project.lockFile) as { packages: Record<string, Json> };
      lock.packages[""].devDependencies = { glob: "^7.1.6" };
      writeJson(project.lockFile, lock);
    };
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.ok(failures.some((f) => f.check === "manifests" && /glob/.test(f.detail)));
  });

  it("names a member manifest that changed without a planned bump", () => {
    const project = memberProject();
    const { run: inner } = fakeNpm(project, { reachable: true });
    const run: NpmRunner = (command, cwd) => {
      inner(command, cwd);
      writeJson(project.memberFile, { name: "a", version: "1.0.1" });
    };
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.ok(failures.some((f) => f.check === "manifests" && f.path === "packages/a/package.json"));
  });

  it("expects the manifests the plan names to change", () => {
    const project = memberProject();
    const { run: inner } = fakeNpm(project, { reachable: true });
    const run: NpmRunner = (command, cwd) => {
      inner(command, cwd);
      if (command !== resolveCommand()) writeJson(project.memberFile, { name: "a", version: "1.0.0", dependencies: { glob: "^7.1.6" }, x: 1 });
    };
    const plan = { ...overridePlan(), bumps: [bump({ name: "debug", memberPath: "packages/a" })] };
    const failures = applyPlan(project.dir, plan, { limits: {}, manifests: project.manifests, run });
    assert.deepEqual(failures, []);
  });

  it("records each exact pin's version before anything runs", () => {
    const project = memberProject({
      member: { dependencies: { glob: "^7.1.6", minimatch: "3.0.4" } },
    });
    const manifests: ManifestInfo[] = [
      project.manifests[0],
      { ...project.manifests[1], deps: [{ name: "minimatch", spec: "3.0.4", field: "dependencies" }] },
    ];
    const { run } = fakeNpm(project, { reachable: true });
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests, run });
    assert.ok(failures.some((f) => f.check === "pins-held" && /minimatch/.test(f.detail)));
  });

  it("passes the limits through to verification", () => {
    const project = memberProject();
    const { run } = fakeNpm(project, { reachable: true });
    const failures = applyPlan(project.dir, overridePlan(), {
      limits: { minimatch: "<3.0.5" },
      manifests: project.manifests,
      run,
    });
    assert.ok(failures.some((f) => f.check === "limits-held"));
  });
});

describe("a package npm moves beside a fix", () => {
  const OLD = { version: "1.0.0", resolved: "https://registry.test/balanced-match-1.0.0.tgz", integrity: "sha512-old" };
  const NEW = { version: "1.0.2", resolved: "https://registry.test/balanced-match-1.0.2.tgz", integrity: "sha512-new" };
  type Lock = { packages: Record<string, Json> };
  const lockOf = (project: Project): Lock => readJson(project.lockFile) as Lock;

  /** minimatch's dependency on balanced-match declares `range`, and the lock holds 1.0.0. */
  const floatProject = (range: string): Project =>
    memberProject({
      root: { devDependencies: { glob: "^7.1.6" } },
      packages: {
        "node_modules/minimatch": { version: "3.0.4", dependencies: { "balanced-match": range } },
        "node_modules/balanced-match": OLD,
      },
    });

  /** npm as it behaved live: replacing minimatch refetches what only it used at the newest in range. */
  const floatingNpm = (project: Project, floats: (resolve: number) => boolean) => {
    const commands: string[] = [];
    let resolve = 0;
    const run: NpmRunner = (command) => {
      commands.push(command);
      resolve += 1;
      const lock = lockOf(project);
      lock.packages["node_modules/minimatch"].version = "3.0.5";
      if (floats(resolve)) lock.packages["node_modules/balanced-match"] = NEW;
      writeJson(project.lockFile, lock);
    };
    return { run, commands };
  };
  const apply = (project: Project, run: NpmRunner) => applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });

  it("is put back exactly as it was when nothing requires the move", () => {
    const project = floatProject("^1.0.0");
    const { run } = floatingNpm(project, (resolve) => resolve === 1);

    assert.deepEqual(apply(project, run), []);

    const { packages } = lockOf(project);
    assert.deepEqual(packages["node_modules/balanced-match"], OLD);
    assert.equal(packages["node_modules/minimatch"].version, "3.0.5");
  });

  it("stays moved when the fix's own range requires it, with no extra resolve", () => {
    const project = floatProject("^1.0.2");
    const { run, commands } = floatingNpm(project, (resolve) => resolve === 1);

    assert.deepEqual(apply(project, run), []);

    assert.deepEqual(lockOf(project).packages["node_modules/balanced-match"], NEW);
    assert.equal(commands.length, 2);
  });

  it("is never put back when bundled: its version comes from the tarball, so the lockfile would be false", () => {
    const project = floatProject("^1.0.0");
    const lockBefore = lockOf(project);
    lockBefore.packages["node_modules/balanced-match"] = { ...OLD, inBundle: true };
    writeJson(project.lockFile, lockBefore);
    const bundledNew = { ...NEW, inBundle: true };
    const commands: string[] = [];
    const run: NpmRunner = (command) => {
      commands.push(command);
      const lock = lockOf(project);
      lock.packages["node_modules/minimatch"].version = "3.0.5";
      lock.packages["node_modules/balanced-match"] = bundledNew;
      writeJson(project.lockFile, lock);
    };

    const failures = apply(project, run);

    assert.ok(failures.some((f) => f.check === "nothing-else-moved" && f.path === "node_modules/balanced-match"), JSON.stringify(failures));
    assert.deepEqual(lockOf(project).packages["node_modules/balanced-match"], bundledNew);
    assert.equal(commands.length, 2, "no resolve was spent putting it back");
  });

  it("fails verification if npm keeps moving it, and gives up after a few tries", () => {
    const project = floatProject("^1.0.0");
    const { run, commands } = floatingNpm(project, () => true);

    const failures = apply(project, run);

    assert.ok(failures.some((f) => f.check === "nothing-else-moved" && f.path === "node_modules/balanced-match"), JSON.stringify(failures));
    assert.ok(commands.length <= 6, `ran ${commands.length} resolves`);
  });
});

describe("writing overrides keeps the manifest's formatting", () => {
  /** Apply the plan with an npm that does nothing, and return the root manifest's bytes. */
  function written(text: string, plan: Plan): string {
    const project = memberProject();
    writeFileSync(project.rootFile, text);
    applyPlan(project.dir, plan, { limits: {}, manifests: project.manifests, run: () => {} });
    return readFileSync(project.rootFile, "utf-8");
  }

  const KEY = '"minimatch@>=3.0.0 <3.0.5": "3.0.5"';

  it("tabs, CRLF and no trailing newline: adding the block touches only the overrides lines", () => {
    const text = '{\r\n\t"name": "fx",\r\n\t"workspaces": [\r\n\t\t"packages/*"\r\n\t]\r\n}';
    assert.equal(
      written(text, overridePlan()),
      `{\r\n\t"name": "fx",\r\n\t"workspaces": [\r\n\t\t"packages/*"\r\n\t],\r\n\t"overrides": {\r\n\t\t${KEY}\r\n\t}\r\n}`,
    );
  });

  it("tabs, CRLF and no trailing newline: an existing block in mid-file, nested and sorted", () => {
    const head = '{\r\n\t"name": "fx",\r\n\t"overrides": {\r\n';
    const tail = '\r\n\t},\r\n\t"workspaces": [ "packages/*" ],\r\n\t"scripts": {\r\n\t\t"x": "y"\r\n\t}\r\n}';
    const nested = '\t\t"webpack": {\r\n\t\t\t"loader-utils": "^2.0.4"\r\n\t\t}';
    const text = `${head}\t\t"ms": "2.1.3",\r\n${nested},\r\n\t\t"minimatch": ">=3.0.0"${tail}`;
    assert.equal(
      written(text, { ...overridePlan(), removeOverrideKeys: ["minimatch"] }),
      `${head}\t\t${KEY},\r\n\t\t"ms": "2.1.3",\r\n${nested}${tail}`,
    );
  });

  it("replacing the only key keeps the block where it is in the file", () => {
    const text = '{\r\n\t"name": "fx",\r\n\t"overrides": {\r\n\t\t"minimatch": ">=3.0.0"\r\n\t},\r\n\t"workspaces": [ "packages/*" ]\r\n}';
    const seen: string[] = [];
    const project = memberProject();
    writeFileSync(project.rootFile, text);
    const plan = { ...overridePlan(), removeOverrideKeys: ["minimatch"], bumps: [bump({ memberPath: "packages/a" })] };
    const run: NpmRunner = (command) => {
      if (command !== resolveCommand()) seen.push(readFileSync(project.rootFile, "utf-8"));
    };
    applyPlan(project.dir, plan, { limits: {}, manifests: project.manifests, run });
    assert.equal(seen[0], '{\r\n\t"name": "fx",\r\n\t"overrides": {},\r\n\t"workspaces": [ "packages/*" ]\r\n}');
    assert.equal(
      readFileSync(project.rootFile, "utf-8"),
      `{\r\n\t"name": "fx",\r\n\t"overrides": {\r\n\t\t${KEY}\r\n\t},\r\n\t"workspaces": [ "packages/*" ]\r\n}`,
    );
  });

  it("removing the only key with nothing to add drops the block", () => {
    const text = '{\n  "name": "fx",\n  "overrides": {\n    "minimatch": ">=3.0.0"\n  },\n  "workspaces": ["packages/*"]\n}\n';
    assert.equal(written(text, emptyPlan({ removeOverrideKeys: ["minimatch"] })), '{\n  "name": "fx",\n  "workspaces": ["packages/*"]\n}\n');
  });

  it("four spaces and LF with a trailing newline", () => {
    const text = '{\n    "name": "fx",\n    "workspaces": ["packages/*"]\n}\n';
    assert.equal(
      written(text, overridePlan()),
      `{\n    "name": "fx",\n    "workspaces": ["packages/*"],\n    "overrides": {\n        ${KEY}\n    }\n}\n`,
    );
  });

  it("a blank line before the closing brace and a trailing blank line", () => {
    const text = '{\n  "name": "fx",\n  "workspaces": ["packages/*"]\n\n}\n\n';
    assert.equal(
      written(text, overridePlan()),
      `{\n  "name": "fx",\n  "workspaces": ["packages/*"],\n  "overrides": {\n    ${KEY}\n  }\n}\n\n`,
    );
  });

  it("an empty manifest takes the block with no stray comma", () => {
    assert.deepEqual(JSON.parse(written("{}", overridePlan())), { overrides: { "minimatch@>=3.0.0 <3.0.5": "3.0.5" } });
  });

  it("isn't fooled by a dependency named overrides", () => {
    const text = '{\n  "dependencies": {\n    "overrides": "^1.0.0"\n  },\n  "workspaces": ["packages/*"]\n}\n';
    assert.equal(
      written(text, overridePlan()),
      `{\n  "dependencies": {\n    "overrides": "^1.0.0"\n  },\n  "workspaces": ["packages/*"],\n  "overrides": {\n    ${KEY}\n  }\n}\n`,
    );
  });

  describe("removing the last key drops the block", () => {
    const removed = (text: string): string => {
      const project = memberProject();
      writeFileSync(project.rootFile, text);
      assert.equal(tryRemoveOverride(project.dir, "ms", () => {}), true);
      return readFileSync(project.rootFile, "utf-8");
    };
    const block = '"overrides": {\r\n\t\t"ms": "2.1.3"\r\n\t}';

    it("at the end", () => {
      assert.equal(removed(`{\r\n\t"name": "fx",\r\n\t${block}\r\n}`), '{\r\n\t"name": "fx"\r\n}');
    });

    it("in the middle", () => {
      assert.equal(
        removed(`{\r\n\t"name": "fx",\r\n\t${block},\r\n\t"version": "1.0.0"\r\n}`),
        '{\r\n\t"name": "fx",\r\n\t"version": "1.0.0"\r\n}',
      );
    });

    it("at the start", () => {
      assert.equal(removed(`{\r\n\t${block},\r\n\t"name": "fx"\r\n}`), '{\r\n\t"name": "fx"\r\n}');
    });

    it("as the only key", () => {
      assert.equal(removed(`{\r\n\t${block}\r\n}`), "{\r\n}");
    });
  });

  it("removing one of several keeps the rest in the same format", () => {
    const project = memberProject();
    writeFileSync(project.rootFile, '{\r\n\t"overrides": {\r\n\t\t"a": "1.0.0",\r\n\t\t"ms": "2.1.3"\r\n\t}\r\n}');
    assert.equal(tryRemoveOverride(project.dir, "ms", () => {}), true);
    assert.equal(readFileSync(project.rootFile, "utf-8"), '{\r\n\t"overrides": {\r\n\t\t"a": "1.0.0"\r\n\t}\r\n}');
  });

  it("a removal that moved something restores the original bytes", () => {
    const project = memberProject();
    const text = '{\r\n\t"overrides": {\r\n\t\t"ms": "2.1.3"\r\n\t}\r\n}';
    writeFileSync(project.rootFile, text);
    const moved = tryRemoveOverride(project.dir, "ms", () => setLockVersion(project, "node_modules/minimatch", "9.9.9"));
    assert.equal(moved, false);
    assert.equal(readFileSync(project.rootFile, "utf-8"), text);
  });
});

describe("tryRemoveOverride", () => {
  const withOverride = () => memberProject({ root: { overrides: { "minimatch@>=3.0.0 <3.0.5": "3.0.5", ms: "2.1.3" } } });

  it("drops the key and keeps it dropped when no version moved", () => {
    const project = withOverride();
    const commands: string[] = [];
    const removed = tryRemoveOverride(project.dir, "ms", (c) => {
      commands.push(c);
    });
    assert.equal(removed, true);
    assert.deepEqual(readJson(project.rootFile).overrides, { "minimatch@>=3.0.0 <3.0.5": "3.0.5" });
    assert.deepEqual(commands, [resolveCommand()]);
  });

  it("returns false with the key restored if any lockfile version moved", () => {
    const project = withOverride();
    const rootText = readFileSync(project.rootFile, "utf-8");
    const lockText = readFileSync(project.lockFile, "utf-8");
    const removed = tryRemoveOverride(project.dir, "minimatch@>=3.0.0 <3.0.5", () => {
      setLockVersion(project, "node_modules/minimatch", "3.0.4-rollback");
    });
    assert.equal(removed, false);
    assert.equal(readFileSync(project.rootFile, "utf-8"), rootText);
    assert.equal(readFileSync(project.lockFile, "utf-8"), lockText);
  });

  it("treats a package that vanished as a move", () => {
    const project = withOverride();
    const rootText = readFileSync(project.rootFile, "utf-8");
    const removed = tryRemoveOverride(project.dir, "ms", () => {
      const lock = readJson(project.lockFile) as { packages: Record<string, Json> };
      delete lock.packages["node_modules/minimatch"];
      writeJson(project.lockFile, lock);
    });
    assert.equal(removed, false);
    assert.equal(readFileSync(project.rootFile, "utf-8"), rootText);
  });

  it("treats a package that appeared as a move", () => {
    const project = withOverride();
    const removed = tryRemoveOverride(project.dir, "ms", () => {
      const lock = readJson(project.lockFile) as { packages: Record<string, Json> };
      lock.packages["node_modules/ms"] = { version: "2.1.3" };
      writeJson(project.lockFile, lock);
    });
    assert.equal(removed, false);
  });

  it("returns false with everything restored when npm fails", () => {
    const project = withOverride();
    const rootText = readFileSync(project.rootFile, "utf-8");
    const removed = tryRemoveOverride(project.dir, "ms", () => {
      writeFileSync(project.lockFile, "half-written");
      throw new Error("npm ERR!");
    });
    assert.equal(removed, false);
    assert.equal(readFileSync(project.rootFile, "utf-8"), rootText);
    assert.equal(readJson(project.lockFile).name, "fx");
  });

  it("leaves a key it can't find alone and runs nothing", () => {
    const project = memberProject({ root: { overrides: { webpack: { "loader-utils": "^2.0.4" } } } });
    const rootText = readFileSync(project.rootFile, "utf-8");
    const commands: string[] = [];
    const missing = tryRemoveOverride(project.dir, "nope", (c) => {
      commands.push(c);
    });
    const nested = tryRemoveOverride(project.dir, "webpack", (c) => {
      commands.push(c);
    });
    assert.equal(missing, false);
    assert.equal(nested, false);
    assert.deepEqual(commands, []);
    assert.equal(readFileSync(project.rootFile, "utf-8"), rootText);
  });
});

describe("the temporary-root step, when an override already names the owner", () => {
  const tempSpecs = (overrides: Json, rootExtra: Json = {}): { temporary: unknown; root: Json } => {
    const project = memberProject({ root: { overrides, ...rootExtra } });
    const seen: Array<Json | undefined> = [];
    const { run } = fakeNpm(project, { onResolve: (text) => seen.push((JSON.parse(text) as Json).devDependencies as Json | undefined) });
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.deepEqual(failures.filter((f) => f.check === "run"), []);
    return { temporary: seen.find((dev) => dev && "glob" in dev)?.glob, root: readJson(project.rootFile) };
  };

  it("an exact value is the temporary spec, since npm refuses (EOVERRIDE) a root entry the override disagrees with", () => {
    assert.equal(tempSpecs({ glob: "7.1.6" }).temporary, "7.1.6");
  });

  it("a range value is the temporary spec too", () => {
    assert.equal(tempSpecs({ glob: ">=7.1.6 <8" }).temporary, ">=7.1.6 <8");
  });

  it("a selector that catches the member's range counts", () => {
    assert.equal(tempSpecs({ "glob@^7": "7.1.6" }).temporary, "7.1.6");
  });

  it("a selector that doesn't leaves the member's range", () => {
    assert.equal(tempSpecs({ "glob@^8": "8.0.1" }).temporary, "^7.1.6");
  });

  it("an override for another package leaves it too", () => {
    assert.equal(tempSpecs({ chalk: "4.1.0" }).temporary, "^7.1.6");
  });

  it("a nested override's own '.' value counts", () => {
    assert.equal(tempSpecs({ glob: { ".": "7.1.6", "inflight": "1.0.6" } }).temporary, "7.1.6");
  });

  it("a nested override without one leaves it", () => {
    assert.equal(tempSpecs({ glob: { inflight: "1.0.6" } }).temporary, "^7.1.6");
  });

  it("a reference to another root dependency takes that dependency's spec", () => {
    assert.equal(tempSpecs({ glob: "$other" }, { devDependencies: { other: "7.1.7" } }).temporary, "7.1.7");
  });

  it("the overrides and devDependencies are back as they were afterwards", () => {
    const { root } = tempSpecs({ glob: "7.1.6" });
    assert.equal(root.devDependencies, undefined);
    assert.deepEqual(root.overrides, { glob: "7.1.6", "minimatch@>=3.0.0 <3.0.5": "3.0.5" });
  });
});

describe("what a failed npm step is called", () => {
  it("npm's own error is a run failure, not an unstable lockfile", () => {
    const project = memberProject();
    for (const code of ["EOVERRIDE", "ERESOLVE", "E404"]) {
      const run: NpmRunner = () => {
        throw Object.assign(new Error("Command failed: npm install"), { stderr: `npm error code ${code}\nnpm error nope` });
      };
      const [failure] = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
      assert.equal(failure.check, "run", code);
      assert.match(failure.detail, new RegExp(code));
    }
  });

  it("a lockfile that changes on the second resolve is still called unstable", () => {
    const project = memberProject();
    let resolves = 0;
    const { run: fake } = fakeNpm(project, { reachable: true });
    const run: NpmRunner = (command, cwd) => {
      fake(command, cwd);
      if (command === resolveCommand() && ++resolves === 2) writeFileSync(project.lockFile, readFileSync(project.lockFile, "utf-8") + "\n");
    };
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.deepEqual(failures.map((f) => f.check), ["stable"]);
  });
});

describe("batchedBumpCommands", () => {
  const family = (over: Partial<DirectBump>[]): Plan => ({
    ...emptyPlan({ bumps: over.map((o) => bump(o)) }),
    batched: new Set(over.map((o) => o.name!)),
  });

  it("installs a family at the root in one command, always saving a caret", () => {
    const plan = family([
      { name: "core", target: "1.2.25" },
      { name: "forms", target: "1.2.25", operator: "~" },
    ]);
    assert.deepEqual(batchedBumpCommands(plan), [
      'npm install core@1.2.25 forms@1.2.25 "--save-prefix=^" --save-exact=false --package-lock-only --ignore-scripts --no-audit --no-fund',
    ]);
  });

  it("names every member that wants the same versions in one command", () => {
    const plan = family([
      { name: "core", target: "1.2.25", memberPath: "apps/tasks" },
      { name: "core", target: "1.2.25", memberPath: "apps/admin" },
    ]);
    assert.match(batchedBumpCommands(plan)[0], /^npm install core@1\.2\.25 -w apps\/admin -w apps\/tasks /);
    assert.equal(batchedBumpCommands(plan).length, 1);
  });

  it("gives a member wanting something different its own command, so nobody gains a dependency", () => {
    const plan = family([
      { name: "core", target: "1.2.25", memberPath: "apps/tasks" },
      { name: "forms", target: "1.2.25", memberPath: "apps/tasks" },
      { name: "core", target: "1.2.25", memberPath: "apps/admin" },
    ]);
    const commands = batchedBumpCommands(plan);
    assert.equal(commands.length, 2);
    assert.ok(commands.some((c) => c.startsWith("npm install core@1.2.25 -w apps/admin ")));
    assert.ok(commands.some((c) => c.startsWith("npm install core@1.2.25 forms@1.2.25 -w apps/tasks ")));
  });

  it("keeps the root apart from a member: -w wouldn't reach it", () => {
    const plan = family([
      { name: "core", target: "1.2.25" },
      { name: "core", target: "1.2.25", memberPath: "apps/tasks" },
    ]);
    const commands = batchedBumpCommands(plan);
    assert.equal(commands.length, 2);
    assert.ok(commands.some((c) => !c.includes(" -w ")));
  });

  it("leaves out anything not tied to the family", () => {
    const plan = { ...emptyPlan({ bumps: [bump({ name: "core" }), bump({ name: "express" })] }), batched: new Set(["core"]) };
    assert.equal(batchedBumpCommands(plan).length, 1);
    assert.doesNotMatch(batchedBumpCommands(plan)[0], /express/);
  });

  it("is nothing at all for a plan with no family", () => {
    assert.deepEqual(batchedBumpCommands(emptyPlan({ bumps: [bump()] })), []);
  });
});

describe("moving a family in one install", () => {
  interface FamilyProject {
    dir: string;
    rootFile: string;
    lockFile: string;
    manifests: ManifestInfo[];
  }

  function familyProject(formsSpec = "^1.1.0"): FamilyProject {
    const dir = tempDir();
    const rootFile = join(dir, "package.json");
    const lockFile = join(dir, "package-lock.json");
    const dependencies = { core: "^1.1.0", forms: formsSpec };
    writeJson(rootFile, { name: "fx", version: "1.0.0", dependencies });
    writeJson(lockFile, {
      name: "fx",
      lockfileVersion: 3,
      packages: {
        "": { name: "fx", version: "1.0.0", dependencies },
        "node_modules/core": { version: "1.1.2" },
        "node_modules/forms": { version: "1.1.2", peerDependencies: { core: "1.1.2" } },
      },
    });
    return { dir, rootFile, lockFile, manifests: [{ dir, lockPath: "", deps: [] }] };
  }

  const familyPlan = (project: FamilyProject, formsOperator: "^" | "~" = "^"): Plan => ({
    ...emptyPlan({
      bumps: [
        bump({ manifestDir: project.dir, name: "core", from: "^1.1.0", target: "1.2.25" }),
        bump({ manifestDir: project.dir, name: "forms", from: `${formsOperator}1.1.0`, operator: formsOperator, target: "1.2.25" }),
      ],
      targets: new Map([
        ["node_modules/core", "1.2.25"],
        ["node_modules/forms", "1.2.25"],
      ]),
    }),
    batched: new Set(["core", "forms"]),
  });

  /** npm as testing showed it: it refuses while the old family is still in the lockfile, and saves whatever prefix it's given. */
  function familyNpm(project: FamilyProject) {
    const commands: string[] = [];
    const run: NpmRunner = (command) => {
      commands.push(command);
      const lock = readJson(project.lockFile) as { packages: Record<string, Json> };
      if (command.startsWith("npm install core@")) {
        if (lock.packages["node_modules/core"] || lock.packages["node_modules/forms"]) throw new Error("ERESOLVE could not resolve");
        const root = readJson(project.rootFile) as { dependencies: Record<string, string> };
        root.dependencies = { core: "^1.2.25", forms: "^1.2.25" };
        writeJson(project.rootFile, root);
        lock.packages["node_modules/core"] = { version: "1.2.25" };
        lock.packages["node_modules/forms"] = { version: "1.2.25", peerDependencies: { core: "1.2.25" } };
      }
      lock.packages[""].dependencies = (readJson(project.rootFile) as { dependencies: Json }).dependencies;
      writeJson(project.lockFile, lock);
    };
    return { run, commands };
  }

  it("takes the old family out of the lockfile first, which is what lets npm install it", () => {
    const project = familyProject();
    const npm = familyNpm(project);
    const failures = applyPlan(project.dir, familyPlan(project), { limits: {}, manifests: project.manifests, run: npm.run });
    assert.deepEqual(failures, []);
    const lock = readJson(project.lockFile) as { packages: Record<string, Json> };
    assert.equal(lock.packages["node_modules/core"].version, "1.2.25");
    assert.equal(lock.packages["node_modules/forms"].version, "1.2.25");
  });

  it("installs the family once, and not package by package", () => {
    const project = familyProject();
    const npm = familyNpm(project);
    applyPlan(project.dir, familyPlan(project), { limits: {}, manifests: project.manifests, run: npm.run });
    assert.equal(npm.commands.filter((c) => c !== resolveCommand()).length, 1);
  });

  it("puts a tilde range back after the install that saved it with a caret", () => {
    const project = familyProject("~1.1.0");
    const npm = familyNpm(project);
    const failures = applyPlan(project.dir, familyPlan(project, "~"), { limits: {}, manifests: project.manifests, run: npm.run });
    assert.deepEqual(failures, []);
    const { dependencies } = readJson(project.rootFile) as { dependencies: Record<string, string> };
    assert.deepEqual(dependencies, { core: "^1.2.25", forms: "~1.2.25" });
  });

  it("doesn't touch the lockfile's entries for a package outside the family", () => {
    const project = familyProject();
    const lock = readJson(project.lockFile) as { packages: Record<string, Json> };
    lock.packages["node_modules/other"] = { version: "1.0.0" };
    writeJson(project.lockFile, lock);
    let seen: Json | undefined;
    const npm = familyNpm(project);
    const run: NpmRunner = (command, cwd) => {
      seen ??= (readJson(project.lockFile) as { packages: Json }).packages as Json;
      npm.run(command, cwd);
    };
    applyPlan(project.dir, familyPlan(project), { limits: {}, manifests: project.manifests, run });
    assert.ok(seen && "node_modules/other" in seen);
    assert.ok(!("node_modules/core" in seen));
  });
});

describe("a planned copy npm carries past its target", () => {
  /** parent -> nanoid: parent's new release accepts 3.3.16 up, so npm fetches the newest it can. */
  function project() {
    const dir = tempDir();
    const rootFile = join(dir, "package.json");
    const lockFile = join(dir, "package-lock.json");
    const dependencies = { parent: "^1.0.0" };
    writeJson(rootFile, { name: "fx", version: "1.0.0", dependencies });
    writeJson(lockFile, {
      name: "fx",
      lockfileVersion: 3,
      packages: {
        "": { name: "fx", version: "1.0.0", dependencies },
        "node_modules/parent": { version: "1.0.0", dependencies: { nanoid: "^3.3.16" } },
        "node_modules/nanoid": { version: "3.3.11" },
      },
    });
    return { dir, rootFile, lockFile, manifests: [{ dir, lockPath: "", deps: [] }] as ManifestInfo[] };
  }
  const plan = (): Plan =>
    emptyPlan({
      addOverrides: { "nanoid@>=3.0.0 <3.3.16": "3.3.16" },
      targets: new Map([["node_modules/nanoid", "3.3.16"]]),
    });

  /** Moves nanoid to whatever an override says, and otherwise to the newest in range unless it's already at or past what's asked. */
  function npmFor(p: ReturnType<typeof project>) {
    const seen: string[][] = [];
    const run: NpmRunner = () => {
      const { overrides = {} } = readJson(p.rootFile) as { overrides?: Record<string, string> };
      seen.push(Object.keys(overrides));
      const lock = readJson(p.lockFile) as { packages: Record<string, Json> };
      const pulled = Object.keys(overrides).some((k) => k.startsWith("nanoid@>=3.3.16"));
      const version = lock.packages["node_modules/nanoid"].version as string;
      if (pulled) lock.packages["node_modules/nanoid"].version = "3.3.16";
      else if (version === "3.3.11") lock.packages["node_modules/nanoid"].version = "3.3.20";
      writeJson(p.lockFile, lock);
    };
    return { run, seen };
  }

  it("pulls it back down to the earliest fix", () => {
    const p = project();
    const failures = applyPlan(p.dir, plan(), { limits: {}, manifests: p.manifests, run: npmFor(p).run });
    assert.deepEqual(failures, []);
    assert.equal((readJson(p.lockFile) as { packages: Record<string, Json> }).packages["node_modules/nanoid"].version, "3.3.16");
  });

  it("leaves only the plan's override behind", () => {
    const p = project();
    applyPlan(p.dir, plan(), { limits: {}, manifests: p.manifests, run: npmFor(p).run });
    assert.deepEqual((readJson(p.rootFile) as { overrides: Json }).overrides, { "nanoid@>=3.0.0 <3.3.16": "3.3.16" });
  });

  it("selects only what's at or above the target, so it can't argue with the plan's own override", () => {
    const p = project();
    const npm = npmFor(p);
    applyPlan(p.dir, plan(), { limits: {}, manifests: p.manifests, run: npm.run });
    assert.ok(npm.seen.flat().includes("nanoid@>=3.3.16 <4.0.0"), JSON.stringify(npm.seen));
  });

  it("leaves a path now holding another line of the package: that isn't an overshoot, and pulling it down would undo a dependent's move", () => {
    const p = project();
    const seen: string[][] = [];
    const run: NpmRunner = () => {
      seen.push(Object.keys((readJson(p.rootFile) as { overrides?: Json }).overrides ?? {}));
      const lock = readJson(p.lockFile) as { packages: Record<string, Json> };
      lock.packages["node_modules/nanoid"].version = "5.0.12";
      writeJson(p.lockFile, lock);
    };
    applyPlan(p.dir, plan(), { limits: {}, manifests: p.manifests, run });
    assert.equal(seen.flat().some((key) => key.startsWith("nanoid@>=3.3.16")), false);
  });

  it("does nothing extra when nothing overshot", () => {
    const p = project();
    const seen: string[][] = [];
    const run: NpmRunner = () => {
      seen.push(Object.keys((readJson(p.rootFile) as { overrides?: Json }).overrides ?? {}));
      const lock = readJson(p.lockFile) as { packages: Record<string, Json> };
      lock.packages["node_modules/nanoid"].version = "3.3.16";
      writeJson(p.lockFile, lock);
    };
    applyPlan(p.dir, plan(), { limits: {}, manifests: p.manifests, run });
    assert.equal(seen.flat().includes("nanoid@>=3.3.16 <4.0.0"), false);
  });

  it("leaves a package a manifest declares for the install command to answer for: npm refuses an override matching it", () => {
    const p = project();
    const manifests: ManifestInfo[] = [{ dir: p.dir, lockPath: "", deps: [{ name: "nanoid", spec: "^3.3.11", field: "dependencies" }] }];
    const npm = npmFor(p);
    const failures = applyPlan(p.dir, plan(), { limits: {}, manifests, run: npm.run });
    assert.equal(npm.seen.flat().includes("nanoid@>=3.3.16 <4.0.0"), false);
    assert.ok(failures.some((f) => f.check === "fixed"), JSON.stringify(failures));
  });
});
