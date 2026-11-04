import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DirectBump, Plan } from "../src/targeted/plan.js";
import { treeProblems, verify, type VerifyInput } from "../src/targeted/verify.js";
import { makeLock } from "./helpers/lock.js";

type Packages = Record<string, object>;

function planOf(targets: Record<string, string>, bumps: DirectBump[] = []): Plan {
  return { alerts: [], bumps, addOverrides: {}, removeOverrideKeys: [], targets: new Map(Object.entries(targets)) };
}

function bump(
  name: string,
  field: DirectBump["field"],
  target: string,
  operator: "^" | "~" = "^",
  memberPath: string | null = null,
): DirectBump {
  return { manifestDir: memberPath ?? ".", memberPath, name, field, from: "", operator, target };
}

function run(
  before: Packages,
  after: Packages,
  targets: Record<string, string>,
  extra: Partial<VerifyInput> & { bumps?: DirectBump[] } = {},
) {
  const { bumps, ...rest } = extra;
  return verify({
    before: makeLock(before),
    after: makeLock(after),
    plan: planOf(targets, bumps),
    limits: {},
    overrides: {},
    pins: [],
    changedManifests: ["package.json"],
    expectedManifests: ["package.json"],
    stable: true,
    ...rest,
  });
}

const checks = (failures: ReturnType<typeof run>) => failures.map((f) => f.check);

// glob -> minimatch -> @isaacs/brace-expansion, the spike's shape.
const globBefore = (): Packages => ({
  "": { dependencies: { glob: "^13.0.0" } },
  "node_modules/glob": { version: "13.0.0", dependencies: { minimatch: "^10.1.1" } },
  "node_modules/minimatch": { version: "10.1.1", dependencies: { "@isaacs/brace-expansion": "^5.0.0" } },
  "node_modules/@isaacs/brace-expansion": { version: "5.0.0" },
});

describe("verify", () => {
  it("passes when only the target moved", () => {
    const before: Packages = {
      "": { dependencies: { minimatch: "^10.1.1" } },
      "node_modules/minimatch": { version: "10.1.1" },
    };
    const after: Packages = {
      "": { dependencies: { minimatch: "^10.1.2" } },
      "node_modules/minimatch": { version: "10.1.2" },
    };
    const bumps = [bump("minimatch", "dependencies", "10.1.2")];
    assert.deepEqual(run(before, after, { "node_modules/minimatch": "10.1.2" }, { bumps }), []);
  });

  it("fails fixed when a planned copy is not at its target", () => {
    const before = globBefore();
    const after = globBefore();
    const failures = run(before, after, { "node_modules/minimatch": "10.1.2" });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].check, "fixed");
    assert.equal(failures[0].path, "node_modules/minimatch");
  });

  it("allows a dependency the target now requires: @isaacs/brace-expansion 5.0.0 → 5.0.1", () => {
    const after: Packages = {
      ...globBefore(),
      "node_modules/minimatch": { version: "10.1.2", dependencies: { "@isaacs/brace-expansion": "^5.0.1" } },
      "node_modules/@isaacs/brace-expansion": { version: "5.0.1" },
    };
    assert.deepEqual(run(globBefore(), after, { "node_modules/minimatch": "10.1.2" }), []);
  });

  it("rejects a move inside the closure that nothing required", () => {
    const after: Packages = {
      ...globBefore(),
      "node_modules/minimatch": { version: "10.1.2", dependencies: { "@isaacs/brace-expansion": "^5.0.0" } },
      "node_modules/@isaacs/brace-expansion": { version: "5.0.1" },
    };
    const failures = run(globBefore(), after, { "node_modules/minimatch": "10.1.2" });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].check, "nothing-else-moved");
    assert.equal(failures[0].path, "node_modules/@isaacs/brace-expansion");
  });

  it("allows an added entry in the closure and rejects one outside it", () => {
    const withNew = (outsider: boolean): Packages => ({
      ...globBefore(),
      "node_modules/minimatch": {
        version: "10.1.2",
        dependencies: { "@isaacs/brace-expansion": "^5.0.0", balanced: "^4.0.0" },
      },
      "node_modules/balanced": { version: "4.0.0" },
      ...(outsider ? { "node_modules/stray": { version: "1.0.0" } } : {}),
    });
    assert.deepEqual(run(globBefore(), withNew(false), { "node_modules/minimatch": "10.1.2" }), []);
    const failures = run(globBefore(), withNew(true), { "node_modules/minimatch": "10.1.2" });
    assert.deepEqual(checks(failures), ["nothing-else-moved"]);
    assert.equal(failures[0].path, "node_modules/stray");
  });

  it("rejects a safe copy that moved: qs 6.9.4 → 6.11.0", () => {
    const lock = (top: string, nested: string): Packages => ({
      "": { dependencies: { express: "^4.0.0", a: "^1.0.0" } },
      "node_modules/express": { version: "4.18.0", dependencies: { qs: "^6.9.0" } },
      "node_modules/qs": { version: top },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "~6.5.0" } },
      "node_modules/a/node_modules/qs": { version: nested },
    });
    const failures = run(lock("6.9.4", "6.5.0"), lock("6.11.0", "6.5.3"), { "node_modules/a/node_modules/qs": "6.5.3" });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].check, "nothing-else-moved");
    assert.equal(failures[0].path, "node_modules/qs");
  });

  it("allows a target relocated by hoisting", () => {
    const before: Packages = {
      "": { dependencies: { a: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
      "node_modules/a/node_modules/qs": { version: "6.5.0" },
    };
    const after: Packages = {
      "": { dependencies: { a: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
      "node_modules/qs": { version: "6.5.3" },
    };
    assert.deepEqual(run(before, after, { "node_modules/a/node_modules/qs": "6.5.3" }), []);
  });

  it("allows an entry removed because only the old target needed it", () => {
    const after: Packages = {
      "": { dependencies: { glob: "^13.0.0" } },
      "node_modules/glob": { version: "13.0.0", dependencies: { minimatch: "^10.1.1" } },
      "node_modules/minimatch": { version: "10.1.2" },
    };
    assert.deepEqual(run(globBefore(), after, { "node_modules/minimatch": "10.1.2" }), []);
  });

  it("rejects an entry removed that nothing about the target explains", () => {
    const before: Packages = { ...globBefore(), "node_modules/left-pad": { version: "1.0.0" } };
    const after: Packages = {
      ...globBefore(),
      "node_modules/minimatch": { version: "10.1.2", dependencies: { "@isaacs/brace-expansion": "^5.0.0" } },
    };
    delete (after as Record<string, unknown>)["node_modules/left-pad"];
    const failures = run(before, after, { "node_modules/minimatch": "10.1.2" });
    assert.deepEqual(checks(failures), ["nothing-else-moved"]);
    assert.equal(failures[0].path, "node_modules/left-pad");
  });

  it("rejects a package missing from the lockfile even though nothing else changed", () => {
    // The spike's result: the target's entry is gone, and glob still needs it.
    const after: Packages = {
      "": { dependencies: { glob: "^13.0.0" } },
      "node_modules/glob": { version: "13.0.0", dependencies: { minimatch: "^10.1.1" } },
    };
    const failures = run(globBefore(), after, { "node_modules/minimatch": "10.1.2" });
    assert.deepEqual(checks(failures), ["tree-complete"]);
    assert.match(failures[0].detail, /node_modules\/glob -> minimatch@\^10\.1\.1/);
  });

  it("does not count an edge explained by an override as a problem", () => {
    const before: Packages = {
      "": { devDependencies: { "@angular/build": "^21.0.0" } },
      "node_modules/@angular/build": { version: "21.0.0", dependencies: { picomatch: "4.0.3" } },
      "node_modules/picomatch": { version: "4.0.3" },
    };
    const after: Packages = {
      ...before,
      "node_modules/picomatch": { version: "4.0.4" },
    };
    const targets = { "node_modules/picomatch": "4.0.4" };

    const without = run(before, after, targets);
    assert.deepEqual(checks(without), ["tree-complete"]);
    assert.match(without[0].detail, /@angular\/build -> picomatch@4\.0\.3/);

    const overrides = { "picomatch@>=4.0.0 <4.0.4": "4.0.4" };
    assert.deepEqual(run(before, after, targets, { overrides }), []);
  });

  it("uses the first override whose selector matches, as npm does", () => {
    const lock = (picomatch: string): Packages => ({
      "": { dependencies: { a: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { picomatch: "4.0.3" } },
      "node_modules/picomatch": { version: picomatch },
    });
    // The first key catches "4.0.3" and wants 4.0.5, so 4.0.4 isn't what it explains.
    const overrides = { "picomatch@>=4.0.0 <4.0.5": "4.0.5", "picomatch@>=4.0.0 <4.0.4": "4.0.4" };
    const failures = run(lock("4.0.3"), lock("4.0.4"), { "node_modules/picomatch": "4.0.4" }, { overrides });
    assert.deepEqual(checks(failures), ["tree-complete"]);
  });

  it("explains an edge with a flat override that has no selector", () => {
    const lock = (picomatch: string): Packages => ({
      "": { dependencies: { a: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { picomatch: "4.0.3" } },
      "node_modules/picomatch": { version: picomatch },
    });
    assert.deepEqual(
      run(lock("4.0.3"), lock("4.0.4"), { "node_modules/picomatch": "4.0.4" }, { overrides: { picomatch: "4.0.4" } }),
      [],
    );
  });

  it("ignores tree problems that already existed before the run", () => {
    const base = (extra: Packages): Packages => ({
      "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", peerDependencies: { react: "^18.0.0" } },
      "node_modules/b": { version: "1.0.0" },
      "node_modules/qs": { version: "6.5.0" },
      ...extra,
    });
    const targets = { "node_modules/qs": "6.5.3" };
    const before = base({});
    const afterSame = base({ "node_modules/qs": { version: "6.5.3" } });
    assert.deepEqual(run(before, afterSame, targets), []);

    const afterNew = base({
      "node_modules/qs": { version: "6.5.3" },
      "node_modules/b": { version: "1.0.0", peerDependencies: { vue: "^3.0.0" } },
    });
    const failures = run(before, afterNew, targets);
    assert.deepEqual(checks(failures), ["tree-complete"]);
    assert.match(failures[0].detail, /vue@\^3\.0\.0/);
  });

  it("fails tree-complete when a resolved version falls outside the declared range", () => {
    const lock = (minimatch: string): Packages => ({
      "": { dependencies: { glob: "^13.0.0" } },
      "node_modules/glob": { version: "13.0.0", dependencies: { minimatch: "^10.1.1" } },
      "node_modules/minimatch": { version: minimatch },
    });
    const failures = run(lock("10.1.1"), lock("9.0.0"), { "node_modules/minimatch": "9.0.0" });
    assert.ok(checks(failures).includes("tree-complete"));
  });

  it("rejects a moved pin", () => {
    const lock = (lodash: string): Packages => ({
      "": { dependencies: { lodash: "4.17.20", minimatch: "^10.0.0" } },
      "node_modules/lodash": { version: lodash },
      "node_modules/minimatch": { version: "10.1.2" },
    });
    const pins = [{ lockPath: "", name: "lodash", version: "4.17.20" }];
    const target = { "node_modules/minimatch": "10.1.2" };
    const failures = run(lock("4.17.20"), lock("4.17.21"), target, { pins });
    assert.ok(checks(failures).includes("pins-held"));
    assert.match(failures.find((f) => f.check === "pins-held")!.detail, /lodash/);
    assert.deepEqual(run(lock("4.17.20"), lock("4.17.20"), target, { pins }), []);
  });

  it("rejects a change past a limit, including a side-effect move", () => {
    const after: Packages = {
      ...globBefore(),
      "node_modules/minimatch": { version: "10.1.2", dependencies: { "@isaacs/brace-expansion": "^5.0.1" } },
      "node_modules/@isaacs/brace-expansion": { version: "5.0.1" },
    };
    const target = { "node_modules/minimatch": "10.1.2" };
    const failures = run(globBefore(), after, target, { limits: { "@isaacs/*": "<5.0.1" } });
    assert.deepEqual(checks(failures), ["limits-held"]);
    assert.equal(failures[0].path, "node_modules/@isaacs/brace-expansion");

    assert.deepEqual(run(globBefore(), after, target, { limits: { "@isaacs/*": "<6.0.0" } }), []);
  });

  it("rejects a limit the target itself breaks", () => {
    const lock = (v: string): Packages => ({
      "": { dependencies: { minimatch: "^10.0.0" } },
      "node_modules/minimatch": { version: v },
    });
    const failures = run(lock("10.1.1"), lock("10.1.2"), { "node_modules/minimatch": "10.1.2" }, { limits: { minimatch: "<10.1.2" } });
    assert.deepEqual(checks(failures), ["limits-held"]);
  });

  it("rejects an unexpected manifest change", () => {
    const lock = (v: string): Packages => ({
      "": { dependencies: { minimatch: "^10.0.0" } },
      "node_modules/minimatch": { version: v },
    });
    const failures = run(lock("10.1.1"), lock("10.1.2"), { "node_modules/minimatch": "10.1.2" }, {
      changedManifests: ["package.json", "packages/a/package.json"],
    });
    assert.deepEqual(checks(failures), ["manifests"]);
    assert.equal(failures[0].path, "packages/a/package.json");
  });

  it("rejects temporary devDependencies left in the root manifest", () => {
    const lock = (v: string, dev: Record<string, string>): Packages => ({
      "": { dependencies: { minimatch: "^10.0.0" }, devDependencies: dev },
      "node_modules/minimatch": { version: v },
      "node_modules/glob": { version: "13.0.0" },
    });
    const failures = run(lock("10.1.1", { jest: "^29.0.0" }), lock("10.1.2", { jest: "^29.0.0", glob: "^13.0.0" }), {
      "node_modules/minimatch": "10.1.2",
    });
    assert.deepEqual(checks(failures), ["manifests"]);
    assert.equal(failures[0].path, "package.json");
    assert.match(failures[0].detail, /glob/);
  });

  it("allows a direct devDependency bump to change a root devDependency range", () => {
    const lock = (v: string, range: string): Packages => ({
      "": { devDependencies: { minimatch: range } },
      "node_modules/minimatch": { version: v },
    });
    const bumps = [bump("minimatch", "devDependencies", "10.1.2")];
    const targets = { "node_modules/minimatch": "10.1.2" };
    assert.deepEqual(run(lock("10.1.1", "^10.1.1"), lock("10.1.2", "^10.1.2"), targets, { bumps }), []);
  });

  it("fails stable when a second install changes the lockfile", () => {
    const lock = (v: string): Packages => ({
      "": { dependencies: { minimatch: "^10.0.0" } },
      "node_modules/minimatch": { version: v },
    });
    const failures = run(lock("10.1.1"), lock("10.1.2"), { "node_modules/minimatch": "10.1.2" }, { stable: false });
    assert.deepEqual(checks(failures), ["stable"]);
  });

  it("copies reported as blocked may remain vulnerable", () => {
    const lock = (nested: string): Packages => ({
      "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "~6.5.0" } },
      "node_modules/a/node_modules/qs": { version: nested },
      "node_modules/b": { version: "1.0.0", dependencies: { qs: "~6.2.0" } },
      "node_modules/b/node_modules/qs": { version: "6.2.0" }, // blocked: not in plan.targets
    });
    assert.deepEqual(run(lock("6.5.0"), lock("6.5.3"), { "node_modules/a/node_modules/qs": "6.5.3" }), []);
  });
});

describe("verify: review findings", () => {
  it("1a. fails fixed when a planned copy vanishes and its dependent lands on an untouched vulnerable copy", () => {
    const before: Packages = {
      "": { dependencies: { a: "^1.0.0", qs: "6.5.0" } },
      "node_modules/qs": { version: "6.5.0" },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.4.0" } },
      "node_modules/a/node_modules/qs": { version: "6.4.0" },
    };
    const after: Packages = { ...before };
    delete after["node_modules/a/node_modules/qs"];
    const failures = run(before, after, { "node_modules/a/node_modules/qs": "6.5.3" });
    assert.deepEqual(checks(failures), ["fixed"]);
    assert.equal(failures[0].path, "node_modules/a/node_modules/qs");
  });

  it("1b. fails fixed when a planned copy relocates unfixed, even beside a sibling target", () => {
    const before: Packages = {
      "": { dependencies: { a: "^1.0.0", m: "^1.0.0" } },
      "node_modules/m": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
      "node_modules/m/node_modules/qs": { version: "6.0.0" },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
      "node_modules/a/node_modules/qs": { version: "6.5.0" },
    };
    const after: Packages = {
      "": { dependencies: { a: "^1.0.0", m: "^1.0.1" } },
      "node_modules/m": { version: "1.0.1", dependencies: { qs: "^6.5.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
      "node_modules/qs": { version: "6.5.0" },
    };
    const targets = { "node_modules/a/node_modules/qs": "6.5.3", "node_modules/m": "1.0.1" };
    const failures = run(before, after, targets, { bumps: [bump("m", "dependencies", "1.0.1")] });
    assert.ok(checks(failures).includes("fixed"));
    assert.equal(failures.find((f) => f.check === "fixed")!.path, "node_modules/a/node_modules/qs");
  });

  it("1c. passes when a planned copy is deduped onto an untouched safe copy on its line", () => {
    const before: Packages = {
      "": { dependencies: { a: "^1.0.0", qs: "6.5.3" } },
      "node_modules/qs": { version: "6.5.3" },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.4.0" } },
      "node_modules/a/node_modules/qs": { version: "6.4.0" },
    };
    const after: Packages = { ...before };
    delete after["node_modules/a/node_modules/qs"];
    assert.deepEqual(run(before, after, { "node_modules/a/node_modules/qs": "6.5.3" }), []);
  });

  it("2a. rejects a safe copy that moved onto another copy's target version", () => {
    const lock = (top: string, nested: string): Packages => ({
      "": { dependencies: { express: "^4.0.0", a: "^1.0.0" } },
      "node_modules/express": { version: "4.18.0", dependencies: { qs: "^6.9.0" } },
      "node_modules/qs": { version: top },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.10.0" } },
      "node_modules/a/node_modules/qs": { version: nested },
    });
    const targets = { "node_modules/a/node_modules/qs": "6.11.0" };
    for (const [from, label] of [
      ["6.9.4", "safe"],
      ["6.12.0", "downgraded"],
    ]) {
      const failures = run(lock(from, "6.10.0"), lock("6.11.0", "6.11.0"), targets);
      assert.deepEqual(checks(failures), ["nothing-else-moved"], label);
      assert.equal(failures[0].path, "node_modules/qs", label);
    }
  });

  it("2b. rejects a blocked copy that moved onto the target version", () => {
    const lock = (blocked: string, planned: string): Packages => ({
      "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
      "node_modules/a/node_modules/qs": { version: planned },
      "node_modules/b": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
      "node_modules/b/node_modules/qs": { version: blocked },
    });
    const failures = run(lock("6.2.0", "6.5.0"), lock("6.5.3", "6.5.3"), { "node_modules/a/node_modules/qs": "6.5.3" });
    assert.deepEqual(checks(failures), ["nothing-else-moved"]);
    assert.equal(failures[0].path, "node_modules/b/node_modules/qs");
  });

  it("2c. does not let an untouched copy at a target version widen the closure", () => {
    const lock = (extra: Packages, n: string): Packages => ({
      "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
      "node_modules/a/node_modules/qs": { version: n },
      "node_modules/b": { version: "1.0.0", dependencies: { qs: "^6.5.3" } },
      "node_modules/b/node_modules/qs": { version: "6.5.3", dependencies: { side: "^1.0.0" } },
      "node_modules/side": { version: "1.0.0" },
      ...extra,
    });
    const stray = { "node_modules/b/node_modules/qs/node_modules/side": { version: "1.9.9" } };
    const failures = run(lock({}, "6.5.0"), lock(stray, "6.5.3"), { "node_modules/a/node_modules/qs": "6.5.3" });
    assert.deepEqual(checks(failures), ["nothing-else-moved"]);
  });

  it("3a. fails tree-complete when a package vanishes although its edge was already out of range", () => {
    const before: Packages = {
      "": { devDependencies: { "@angular/build": "^21.0.0" } },
      "node_modules/@angular/build": { version: "21.0.0", dependencies: { picomatch: "4.0.3" } },
      "node_modules/picomatch": { version: "4.0.4" },
    };
    const after: Packages = {
      "": { devDependencies: { "@angular/build": "^21.0.0" } },
      "node_modules/@angular/build": { version: "21.0.0", dependencies: { picomatch: "4.0.3" } },
    };
    for (const overrides of [{}, { "picomatch@4": ">=4.0.4" }] as Array<Record<string, string>>) {
      const failures = run(before, after, { "node_modules/picomatch": "4.0.5" }, { overrides });
      assert.deepEqual(checks(failures), ["tree-complete"]);
    }
  });

  it("3b. rejects a move excused by a range the new version does not meet either", () => {
    const lock = (y: string): Packages => ({
      "": { dependencies: { m: "^1.0.0" } },
      "node_modules/m": { version: y === "1.0.0" ? "1.0.0" : "1.0.1", dependencies: { y: "^2.0.0" } },
      "node_modules/y": { version: y },
    });
    const failures = run(lock("1.0.0"), lock("3.0.0"), { "node_modules/m": "1.0.1" });
    assert.ok(checks(failures).includes("nothing-else-moved"));
    assert.equal(failures.find((f) => f.check === "nothing-else-moved")!.path, "node_modules/y");
  });

  it("4a. allows a redundant safe copy that npm pruned when the target moved onto its version", () => {
    const before: Packages = {
      "": { dependencies: { express: "^4.0.0", qs: "^6.5.0" } },
      "node_modules/express": { version: "4.18.0", dependencies: { qs: "~6.5.3" } },
      "node_modules/express/node_modules/qs": { version: "6.5.3" },
      "node_modules/qs": { version: "6.5.0" },
    };
    const after: Packages = {
      "": { dependencies: { express: "^4.0.0", qs: "^6.5.3" } },
      "node_modules/express": { version: "4.18.0", dependencies: { qs: "~6.5.3" } },
      "node_modules/qs": { version: "6.5.3" },
    };
    const bumps = [bump("qs", "dependencies", "6.5.3")];
    assert.deepEqual(run(before, after, { "node_modules/qs": "6.5.3" }, { bumps }), []);
  });

  it("4b. still rejects a removal whose dependents resolve to a different version", () => {
    const before: Packages = {
      "": { dependencies: { express: "^4.0.0", qs: "^6.5.0" } },
      "node_modules/express": { version: "4.18.0", dependencies: { qs: "^6.0.0" } },
      "node_modules/express/node_modules/qs": { version: "6.3.0" },
      "node_modules/qs": { version: "6.5.0" },
    };
    const after: Packages = {
      "": { dependencies: { express: "^4.0.0", qs: "^6.5.3" } },
      "node_modules/express": { version: "4.18.0", dependencies: { qs: "^6.0.0" } },
      "node_modules/qs": { version: "6.5.3" },
    };
    const bumps = [bump("qs", "dependencies", "6.5.3")];
    const failures = run(before, after, { "node_modules/qs": "6.5.3" }, { bumps });
    assert.deepEqual(checks(failures), ["nothing-else-moved"]);
    assert.equal(failures[0].path, "node_modules/express/node_modules/qs");
  });

  it("5a. accepts a floating range override as the explanation of an edge", () => {
    const before: Packages = {
      "": { dependencies: { m: "^1.0.0" } },
      "node_modules/m": { version: "1.0.0", dependencies: { x: "1.2.3" } },
      "node_modules/x": { version: "1.2.5" },
    };
    const after: Packages = {
      ...before,
      "node_modules/m": { version: "1.0.1", dependencies: { x: "1.2.4" } },
    };
    const targets = { "node_modules/m": "1.0.1" };
    assert.deepEqual(run(before, after, targets, { overrides: { "x@1": ">=1.2.5" } }), []);
    assert.deepEqual(checks(run(before, after, targets)), ["tree-complete"]);
  });

  it("5b. resolves a $ref override against the root's declared spec, and explains nothing when it cannot", () => {
    const lock = makeLock({
      "": { dependencies: { picomatch: "^4.0.4", a: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { picomatch: "4.0.3" } },
      "node_modules/picomatch": { version: "4.0.4" },
    });
    assert.equal(treeProblems(lock, { picomatch: "$picomatch" }).size, 0);
    assert.equal(treeProblems(lock, { picomatch: "$nothing" }).size, 1);
  });

  it("5c. an override selector semver cannot read explains nothing instead of throwing", () => {
    const lock = makeLock({
      "": { dependencies: { q: "^6.0.0" } },
      "node_modules/q": { version: "7.0.0" },
    });
    assert.equal(treeProblems(lock, { "q@latest": "7.0.0" }).size, 1);
  });

  it("6a. rejects an exact pin rewritten to a range at the same resolved version", () => {
    const lock = (spec: string, m: string): Packages => ({
      "": { dependencies: { lodash: spec, m: "^1.0.0" } },
      "node_modules/lodash": { version: "4.17.20" },
      "node_modules/m": { version: m },
    });
    const failures = run(lock("4.17.20", "1.0.0"), lock("^4.17.20", "1.0.1"), { "node_modules/m": "1.0.1" }, {
      pins: [{ lockPath: "", name: "lodash", version: "4.17.20" }],
      bumps: [bump("m", "dependencies", "1.0.1")],
    });
    assert.deepEqual(checks(failures), ["manifests"]);
    assert.match(failures[0].detail, /lodash/);
  });

  it("6b. rejects an unplanned root devDependency range change", () => {
    const lock = (dev: string, m: string): Packages => ({
      "": { devDependencies: { jest: dev }, dependencies: { m: "^1.0.0" } },
      "node_modules/jest": { version: "29.7.0" },
      "node_modules/m": { version: m },
    });
    const failures = run(lock("^29.0.0", "1.0.0"), lock("^29.7.0", "1.0.1"), { "node_modules/m": "1.0.1" });
    assert.deepEqual(checks(failures), ["manifests"]);
    assert.match(failures[0].detail, /jest/);
  });

  it("6c. rejects a bump written with the wrong operator, and accepts the right one on a member", () => {
    const lock = (spec: string, v: string): Packages => ({
      "": {},
      "packages/a": { version: "1.0.0", dependencies: { minimatch: spec } },
      "node_modules/minimatch": { version: v },
    });
    const targets = { "node_modules/minimatch": "10.1.2" };
    const extra = {
      bumps: [bump("minimatch", "dependencies", "10.1.2", "~", "packages/a")],
      expectedManifests: ["packages/a/package.json"],
      changedManifests: ["packages/a/package.json"],
    };
    const wrong = run(lock("~10.1.1", "10.1.1"), lock("^10.1.2", "10.1.2"), targets, extra);
    assert.deepEqual(checks(wrong), ["manifests"]);
    assert.equal(wrong[0].path, "packages/a/package.json");
    assert.deepEqual(run(lock("~10.1.1", "10.1.1"), lock("~10.1.2", "10.1.2"), targets, extra), []);
  });

  it("6d. rejects a temporary entry left in the root dependencies", () => {
    const lock = (deps: Record<string, string>, m: string): Packages => ({
      "": { dependencies: deps },
      "node_modules/jest": { version: "29.7.0" },
      "node_modules/m": { version: m },
    });
    const failures = run(lock({ m: "^1.0.0" }, "1.0.0"), lock({ m: "^1.0.0", jest: "^29.0.0" }, "1.0.1"), {
      "node_modules/m": "1.0.1",
    });
    assert.deepEqual(checks(failures), ["manifests"]);
  });

  it("7. does not fail a pin that resolves in neither lockfile", () => {
    const lock = (v: string): Packages => ({
      "": { peerDependencies: { ghost: "1.0.0" }, dependencies: { m: "^1.0.0" } },
      "node_modules/m": { version: v },
    });
    const failures = run(lock("1.0.0"), lock("1.0.1"), { "node_modules/m": "1.0.1" }, {
      pins: [{ lockPath: "", name: "ghost", version: "1.0.0" }],
      bumps: [bump("m", "dependencies", "1.0.1")],
    });
    assert.deepEqual(failures, []);
  });
});

describe("verify: re-review findings", () => {
  it("R1. ignores an edge from a package that survives but no longer declares the dependency", () => {
    const before: Packages = {
      "": { dependencies: { m: "^1.0.0", qs: "6.4.0" } },
      "node_modules/qs": { version: "6.4.0" },
      "node_modules/m": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
      "node_modules/m/node_modules/qs": { version: "6.5.0" },
    };
    const after: Packages = {
      "": { dependencies: { m: "^1.0.1", qs: "6.4.0" } },
      "node_modules/qs": { version: "6.4.0" },
      "node_modules/m": { version: "1.0.1" },
    };
    const targets = { "node_modules/m/node_modules/qs": "6.5.3", "node_modules/m": "1.0.1" };
    assert.deepEqual(run(before, after, targets, { bumps: [bump("m", "dependencies", "1.0.1")] }), []);
  });

  const hoistBefore = (): Packages => ({
    "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
    "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
    "node_modules/a/node_modules/qs": { version: "6.5.0" },
    "node_modules/b": { version: "1.0.0", dependencies: { qs: "^6.5.3" } },
    "node_modules/b/node_modules/qs": { version: "6.5.3" },
  });

  it("R2a. allows a planned copy and a safe copy at the target version merging into one hoisted path", () => {
    const after: Packages = {
      "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
      "node_modules/b": { version: "1.0.0", dependencies: { qs: "^6.5.3" } },
      "node_modules/qs": { version: "6.5.3" },
    };
    assert.deepEqual(run(hoistBefore(), after, { "node_modules/a/node_modules/qs": "6.5.3" }), []);
  });

  it("R2b. allows only the safe copy to relocate while the planned copy stays put", () => {
    const after: Packages = {
      "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
      "node_modules/a/node_modules/qs": { version: "6.5.3" },
      "node_modules/b": { version: "1.0.0", dependencies: { qs: "^6.5.3" } },
      "node_modules/qs": { version: "6.5.3" },
    };
    assert.deepEqual(run(hoistBefore(), after, { "node_modules/a/node_modules/qs": "6.5.3" }), []);
  });

  it("R2c. still rejects an added path at the target version when a dependent came from a different safe version", () => {
    const before: Packages = { ...hoistBefore(), "node_modules/b/node_modules/qs": { version: "6.5.4" } };
    const after: Packages = {
      "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
      "node_modules/b": { version: "1.0.0", dependencies: { qs: "^6.5.3" } },
      "node_modules/qs": { version: "6.5.3" },
    };
    const failures = run(before, after, { "node_modules/a/node_modules/qs": "6.5.3" });
    assert.ok(checks(failures).includes("nothing-else-moved"));
  });

  it("R3. fails fixed when a planned copy and its dependent both relocate unfixed", () => {
    const before: Packages = {
      "": { dependencies: { x: "^1.0.0", m: "^1.0.0" } },
      "node_modules/m": { version: "1.0.0" },
      "node_modules/x": { version: "1.0.0", dependencies: { a: "^1.0.0" } },
      "node_modules/x/node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
      "node_modules/x/node_modules/qs": { version: "6.5.0" },
    };
    const after: Packages = {
      "": { dependencies: { x: "^1.0.0", m: "^1.0.1" } },
      "node_modules/m": { version: "1.0.1", dependencies: { a: "^1.0.0" } },
      "node_modules/x": { version: "1.0.0", dependencies: { a: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
      "node_modules/qs": { version: "6.5.0" },
    };
    const targets = { "node_modules/x/node_modules/qs": "6.5.3", "node_modules/m": "1.0.1" };
    const failures = run(before, after, targets, { bumps: [bump("m", "dependencies", "1.0.1")] });
    assert.ok(checks(failures).includes("fixed"));
    assert.equal(failures.find((f) => f.check === "fixed")!.path, "node_modules/x/node_modules/qs");
  });
});

describe("treeProblems", () => {
  it("reports unresolved and out-of-range edges as '<from> -> <name>@<spec>'", () => {
    const lock = makeLock({
      "": { dependencies: { a: "^1.0.0", missing: "^1.0.0" } },
      "node_modules/a": { version: "2.0.0" },
    });
    assert.deepEqual([...treeProblems(lock, {})].sort(), [" -> a@^1.0.0", " -> missing@^1.0.0"]);
  });

  it("skips optional dependencies, optional peers and specs semver cannot read", () => {
    const lock = makeLock({
      "": { dependencies: { tagged: "latest", file: "file:../x", dir: "./local" } },
      "node_modules/tagged": { version: "1.0.0" },
      "node_modules/file": { version: "1.0.0" },
      "node_modules/dir": {
        version: "1.0.0",
        optionalDependencies: { fsevents: "^2.0.0" },
        peerDependencies: { react: "^18.0.0" },
        peerDependenciesMeta: { react: { optional: true } },
      },
    });
    assert.equal(treeProblems(lock, {}).size, 0);
  });

  it("sees through an alias spec when comparing versions", () => {
    const lock = makeLock({
      "": { dependencies: { foo: "npm:qs@^6.0.0" } },
      "node_modules/foo": { name: "qs", version: "6.5.0" },
    });
    assert.equal(treeProblems(lock, {}).size, 0);
    const bad = makeLock({
      "": { dependencies: { foo: "npm:qs@^6.0.0" } },
      "node_modules/foo": { name: "qs", version: "5.0.0" },
    });
    assert.equal(treeProblems(bad, {}).size, 1);
  });

  it("drops an edge only when the first matching override gives the resolved version", () => {
    const lock = makeLock({
      "": { dependencies: { a: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { picomatch: "4.0.3" } },
      "node_modules/picomatch": { version: "4.0.4" },
    });
    assert.equal(treeProblems(lock, {}).size, 1);
    assert.equal(treeProblems(lock, { "picomatch@>=4.0.0 <4.0.4": "4.0.4" }).size, 0);
    assert.equal(treeProblems(lock, { "picomatch@>=3.0.0 <3.0.4": "3.0.4" }).size, 1);
  });
});
