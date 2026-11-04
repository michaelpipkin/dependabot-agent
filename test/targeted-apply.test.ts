import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { applyPlan, bumpCommand, NpmRunner, resolveCommand, snapshotFiles, tryRemoveOverride } from "../src/targeted/apply.js";
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

  it("dedupes a package declared in both dependencies and devDependencies", () => {
    const project = memberProject();
    const { run, commands } = fakeNpm(project, { reachable: true });
    const plan = emptyPlan({
      bumps: [bump({ manifestDir: project.dir }), bump({ manifestDir: project.dir, field: "devDependencies" })],
    });
    applyPlan(project.dir, plan, { limits: {}, manifests: project.manifests, run });
    assert.equal(commands.filter((c) => c === bumpCommand(plan.bumps[0])).length, 1);
  });

  it("keeps bumps apart when their operators differ", () => {
    const project = memberProject();
    const { run, commands } = fakeNpm(project, { reachable: true });
    const plan = emptyPlan({
      bumps: [bump({ manifestDir: project.dir }), bump({ manifestDir: project.dir, field: "devDependencies", operator: "~" })],
    });
    applyPlan(project.dir, plan, { limits: {}, manifests: project.manifests, run });
    assert.equal(commands.filter((c) => c !== resolveCommand()).length, 2);
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

  it("leaves the root manifest's bytes alone when the plan writes no override", () => {
    const project = memberProject();
    const text = '{\n\t"name": "fx",\n\t"workspaces": ["packages/*"]\n}\n';
    writeFileSync(project.rootFile, text);
    const failures = applyPlan(project.dir, emptyPlan(), { limits: {}, manifests: project.manifests, run: () => {} });
    assert.equal(readFileSync(project.rootFile, "utf-8"), text);
    assert.deepEqual(failures, []);
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
    assert.equal(failures[0].check, "stable");
    assert.match(failures[0].detail, /ERESOLVE/);
    assert.equal(readJson(project.rootFile).devDependencies, undefined);
  });

  it("doesn't add a member's peer or optional edges as temporary root entries", () => {
    const project = memberProject({
      member: { dependencies: undefined, peerDependencies: { glob: "^7.1.6" }, optionalDependencies: { rimraf: "^3.0.0" } },
      packages: { "node_modules/rimraf": { version: "3.0.2", dependencies: { glob: "^7.1.3" } } },
    });
    const { run, commands } = fakeNpm(project);
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.equal(resolves(commands), 2, "no temporary step, so nothing else to resolve");
    assert.ok(failures.some((f) => f.check === "fixed" && f.path === "node_modules/minimatch"));
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
    assert.equal(failures[0].check, "stable");
    assert.match(failures[0].detail, /EOVERRIDE/);
  });

  it("returns a failure when a name can't go on a command line, running nothing", () => {
    const project = memberProject();
    const { run, commands } = fakeNpm(project);
    const failures = applyPlan(project.dir, emptyPlan({ bumps: [bump({ name: "x;calc" })] }), {
      limits: {},
      manifests: project.manifests,
      run,
    });
    assert.equal(failures[0].check, "stable");
    assert.deepEqual(commands, []);
  });

  it("returns a failure rather than throwing when npm leaves an unreadable lockfile", () => {
    const project = memberProject();
    const run: NpmRunner = () => writeFileSync(project.lockFile, "{ not json");
    const failures = applyPlan(project.dir, overridePlan(), { limits: {}, manifests: project.manifests, run });
    assert.equal(failures[0].check, "stable");
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
