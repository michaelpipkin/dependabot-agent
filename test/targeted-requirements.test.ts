import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DirectDep } from "../src/manifest.js";
import type { LockIndex } from "../src/targeted/lockfile.js";
import type { ManifestInfo, Plan } from "../src/targeted/plan.js";
import { buildPlan } from "../src/targeted/plan.js";
import { planWithRequirements, solvePlan, type PublishedPackage, type ReadAdvisories, type ReadPackage } from "../src/targeted/requirements.js";
import type { DependabotAlert } from "../src/types.js";
import { makeLock } from "./helpers/lock.js";

function alert(number: number, name: string, range: string, patch: string): DependabotAlert {
  const vuln = {
    package: { ecosystem: "npm", name },
    vulnerable_version_range: range,
    first_patched_version: { identifier: patch },
  };
  return {
    number,
    state: "open",
    dependency: { package: vuln.package, manifest_path: "package.json", scope: "runtime" },
    security_advisory: { summary: "", severity: "high", vulnerabilities: [vuln] },
    security_vulnerability: vuln,
  };
}

type Versions = Record<string, { peers?: Record<string, string>; deps?: Record<string, string> }>;

function registry(packages: Record<string, Versions>): { read: ReadPackage; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    read: async (name) => {
      asked.push(name);
      const versions = packages[name];
      if (!versions) return null;
      const out: PublishedPackage = new Map();
      for (const [version, info] of Object.entries(versions)) {
        out.set(version, { dependencies: info.deps ?? {}, peerDependencies: info.peers ?? {} });
      }
      return out;
    },
  };
}

interface Setup {
  alerts: DependabotAlert[];
  lock: LockIndex;
  deps: DirectDep[];
  limits?: Record<string, string>;
  flat?: Record<string, string>;
}

function inputOf(setup: Setup) {
  const manifests: ManifestInfo[] = [{ dir: "/repo", lockPath: "", deps: setup.deps }];
  return {
    alerts: setup.alerts,
    lock: setup.lock,
    manifests,
    overrides: { flat: setup.flat ?? {}, nested: {} },
    limits: setup.limits ?? {},
    published: new Map<string, string[] | null>(),
    updateWorkspaceMembers: true,
  };
}

const planFor = (setup: Setup, read: ReadPackage): Promise<Plan> => planWithRequirements(inputOf(setup), read);

const exact = (...names: string[]) => (version: string) => Object.fromEntries(names.map((n) => [n, version]));

/** Three packages whose peers name each other at exactly their own version, as Angular's do. */
const coreVersions = (...versions: string[]): Versions => Object.fromEntries(versions.map((v) => [v, {}]));
const familyPublished = (versions: string[]): Record<string, Versions> => ({
  core: coreVersions(...versions),
  common: Object.fromEntries(versions.map((v) => [v, { peers: exact("core")(v) }])),
  forms: Object.fromEntries(versions.map((v) => [v, { peers: exact("core", "common")(v) }])),
});

function family(formsSpec = "^1.1.0"): { lock: LockIndex; deps: DirectDep[] } {
  return {
    lock: makeLock({
      "": { dependencies: { core: "^1.1.0", common: "^1.1.0", forms: formsSpec } },
      "node_modules/core": { version: "1.1.2" },
      "node_modules/common": { version: "1.1.2", peerDependencies: { core: "1.1.2" } },
      "node_modules/forms": { version: "1.1.2", peerDependencies: { core: "1.1.2", common: "1.1.2" } },
    }),
    deps: [
      { name: "core", spec: "^1.1.0", field: "dependencies" },
      { name: "common", spec: "^1.1.0", field: "dependencies" },
      { name: "forms", spec: formsSpec, field: "dependencies" },
    ],
  };
}

const coreAlert = (patch = "1.2.20", number = 1) => alert(number, "core", `>= 1.0.0, < ${patch}`, patch);
const commonAlert = (patch = "1.2.25", number = 2) => alert(number, "common", `>= 1.0.0, < ${patch}`, patch);

const targetsOf = (plan: Plan): Record<string, string> => Object.fromEntries(plan.targets);

function assertNoWrites(plan: Plan): void {
  assert.deepEqual(plan.bumps, []);
  assert.deepEqual(plan.addOverrides, {});
  assert.equal(plan.targets.size, 0);
}

describe("packages whose peers name each other exactly", () => {
  it("moves the whole family to one version, the lowest that clears every alert", async () => {
    const plan = await planFor({ alerts: [coreAlert(), commonAlert()], ...family() }, registry(familyPublished(["1.1.2", "1.2.20", "1.2.25", "1.2.29"])).read);
    assert.deepEqual(targetsOf(plan), { "node_modules/core": "1.2.25", "node_modules/common": "1.2.25", "node_modules/forms": "1.2.25" });
    assert.deepEqual(plan.alerts.map((a) => a.status), ["fixed", "fixed"]);
    assert.deepEqual(plan.addOverrides, {}, "a family moves by its declared ranges, not by overrides");
    assert.deepEqual(plan.bumps.map((b) => `${b.name}@${b.target}`).sort(), ["common@1.2.25", "core@1.2.25", "forms@1.2.25"]);
  });

  it("marks the family to be installed in one go", async () => {
    const plan = await planFor({ alerts: [coreAlert(), commonAlert()], ...family() }, registry(familyPublished(["1.1.2", "1.2.20", "1.2.25"])).read);
    assert.deepEqual([...(plan.batched ?? [])].sort(), ["common", "core", "forms"]);
  });

  it("reports only what moved beyond its own alert, and why", async () => {
    const plan = await planFor({ alerts: [coreAlert(), commonAlert()], ...family() }, registry(familyPublished(["1.1.2", "1.2.20", "1.2.25"])).read);
    const moved = (plan.movedWith ?? []).map((m) => `${m.name} ${m.from}>${m.to}`).sort();
    assert.deepEqual(moved, ["core 1.1.2>1.2.25", "forms 1.1.2>1.2.25"], "common's own alert asks for 1.2.25, so it isn't an extra");
    assert.match(plan.movedWith!.find((m) => m.name === "forms")!.because, /core|common/);
  });

  it("doesn't warn that a fix lands past a range belonging to a package moving with it", async () => {
    const plan = await planFor({ alerts: [coreAlert(), commonAlert()], ...family() }, registry(familyPublished(["1.1.2", "1.2.25"])).read);
    assert.deepEqual(plan.alerts.flatMap((a) => a.copies.flatMap((c) => c.pastDeclared)), []);
  });

  it("stays within a limit when a lower fix fits it", async () => {
    const plan = await planFor(
      { alerts: [coreAlert("1.2.20"), commonAlert("1.2.25")], ...family(), limits: { "*": "<1.2.25" } },
      registry(familyPublished(["1.1.2", "1.2.20", "1.2.25"])).read,
    );
    assert.deepEqual(targetsOf(plan), { "node_modules/core": "1.2.20", "node_modules/common": "1.2.20", "node_modules/forms": "1.2.20" });
    assert.equal(plan.alerts.find((a) => a.packageName === "core")!.status, "fixed");
    const common = plan.alerts.find((a) => a.packageName === "common")!;
    assert.equal(common.status, "blocked");
    assert.equal(common.copies[0].reason, "limit");
  });

  it("moves nothing when a limit rules out every fix", async () => {
    const plan = await planFor(
      { alerts: [coreAlert(), commonAlert()], ...family(), limits: { "*": "<1.2.0" } },
      registry(familyPublished(["1.1.2", "1.2.20", "1.2.25"])).read,
    );
    assertNoWrites(plan);
    assert.deepEqual(plan.alerts.map((a) => a.copies[0].reason), ["limit", "limit"]);
  });

  it("blocks the fix, naming the reason, when a limit stops only a package it would drag along", async () => {
    const plan = await planFor(
      { alerts: [coreAlert()], ...family(), limits: { forms: "<1.2.0" } },
      registry(familyPublished(["1.1.2", "1.2.20"])).read,
    );
    assertNoWrites(plan);
    const copy = plan.alerts[0].copies[0];
    assert.equal(plan.alerts[0].status, "blocked");
    assert.equal(copy.reason, "moves-together");
    assert.match(copy.detail!, /forms/);
    assert.match(copy.detail!, /limit/);
  });

  it("falls back to a lower fix when only the higher one drags a package past its limit", async () => {
    const plan = await planFor(
      { alerts: [coreAlert("1.1.5", 1), coreAlert("1.2.20", 2)], ...family(), limits: { forms: "<1.2.0" } },
      registry(familyPublished(["1.1.2", "1.1.5", "1.2.20"])).read,
    );
    assert.deepEqual(targetsOf(plan), { "node_modules/core": "1.1.5", "node_modules/common": "1.1.5", "node_modules/forms": "1.1.5" });
    const statuses = Object.fromEntries(plan.alerts.map((a) => [a.number, a.status]));
    assert.equal(statuses[1], "fixed");
    assert.equal(statuses[2], "blocked");
  });

  it("treats an exact pin on a family member as don't touch, and blocks the fix", async () => {
    const plan = await planFor({ alerts: [coreAlert()], ...family("1.1.2") }, registry(familyPublished(["1.1.2", "1.2.20"])).read);
    assertNoWrites(plan);
    assert.equal(plan.alerts[0].copies[0].reason, "moves-together");
    assert.match(plan.alerts[0].copies[0].detail!, /Pinned/);
  });

  it("blocks the fix when a member has no release that accepts it", async () => {
    const published = familyPublished(["1.1.2", "1.2.20"]);
    published.forms = { "1.1.2": { peers: exact("core", "common")("1.1.2") } };
    const plan = await planFor({ alerts: [coreAlert()], ...family() }, registry(published).read);
    assertNoWrites(plan);
    assert.equal(plan.alerts[0].copies[0].reason, "moves-together");
    assert.match(plan.alerts[0].copies[0].detail!, /forms/);
  });

  it("leaves a package alone when its peer range already accepts the move", async () => {
    const lock = makeLock({
      "": { dependencies: { core: "^1.1.0", material: "^1.1.0" } },
      "node_modules/core": { version: "1.1.2" },
      "node_modules/material": { version: "1.1.2", peerDependencies: { core: "^1.0.0" } },
    });
    const deps: DirectDep[] = [
      { name: "core", spec: "^1.1.0", field: "dependencies" },
      { name: "material", spec: "^1.1.0", field: "dependencies" },
    ];
    const { read, asked } = registry({ core: coreVersions("1.1.2", "1.2.20") });
    const plan = await planFor({ alerts: [coreAlert()], lock, deps }, read);
    assert.deepEqual(targetsOf(plan), { "node_modules/core": "1.2.20" });
    assert.equal(asked.includes("material"), false, "nothing asks the registry about a package that isn't moving");
    assert.equal(plan.batched?.size ?? 0, 0);
  });

  it("doesn't count a peer problem that was already there as a reason to move", async () => {
    const lock = makeLock({
      "": { dependencies: { core: "^1.1.0", old: "^1.0.0" } },
      "node_modules/core": { version: "1.1.2" },
      "node_modules/old": { version: "1.0.0", peerDependencies: { core: "1.0.0" } },
    });
    const deps: DirectDep[] = [
      { name: "core", spec: "^1.1.0", field: "dependencies" },
      { name: "old", spec: "^1.0.0", field: "dependencies" },
    ];
    const plan = await planFor({ alerts: [coreAlert()], lock, deps }, registry({ core: coreVersions("1.1.2", "1.2.20") }).read);
    assert.equal(plan.targets.has("node_modules/old"), false);
    assert.equal(plan.alerts[0].status, "fixed");
  });

  it("moves a peer the target newly needs a later version of, to the lowest that fits", async () => {
    const lock = makeLock({
      "": { dependencies: { core: "^1.1.0", ssr: "^1.1.0" } },
      "node_modules/core": { version: "1.1.2" },
      "node_modules/ssr": { version: "1.1.2", peerDependencies: { core: "^1.0.0" } },
    });
    const deps: DirectDep[] = [
      { name: "core", spec: "^1.1.0", field: "dependencies" },
      { name: "ssr", spec: "^1.1.0", field: "dependencies" },
    ];
    const published = { core: coreVersions("1.1.2", "1.2.0", "1.2.1", "1.3.0-rc.1"), ssr: { "1.1.2": {}, "1.2.23": { peers: { core: "^1.2.0" } } } };
    const plan = await planFor({ alerts: [alert(1, "ssr", ">= 1.0.0, < 1.2.23", "1.2.23")], lock, deps }, registry(published).read);
    assert.deepEqual(targetsOf(plan), { "node_modules/ssr": "1.2.23", "node_modules/core": "1.2.0" });
    assert.deepEqual([...(plan.batched ?? [])].sort(), ["core", "ssr"]);
  });

  it("gives a family member reached only by its family no override of its own", async () => {
    const lock = makeLock({
      "": { dependencies: { core: "^1.1.0" } },
      "node_modules/core": { version: "1.1.2", peerDependencies: { helper: "1.1.2" } },
      "node_modules/helper": { version: "1.1.2", peer: true },
    });
    const deps: DirectDep[] = [{ name: "core", spec: "^1.1.0", field: "dependencies" }];
    const published = { core: { "1.1.2": { peers: { helper: "1.1.2" } }, "1.2.20": { peers: { helper: "1.2.20" } } }, helper: coreVersions("1.1.2", "1.2.20") };
    const plan = await planFor({ alerts: [coreAlert()], lock, deps }, registry(published).read);
    assert.deepEqual(targetsOf(plan), { "node_modules/core": "1.2.20", "node_modules/helper": "1.2.20" });
    assert.deepEqual(plan.addOverrides, {});
    assert.deepEqual(plan.alerts.map((a) => a.status), ["fixed"]);
  });

  it("gives a family member something else also depends on an override, to carry that dependent", async () => {
    const lock = makeLock({
      "": { dependencies: { core: "^1.1.0", wrapper: "^1.0.0" } },
      "node_modules/core": { version: "1.1.2" },
      "node_modules/wrapper": { version: "1.0.0", dependencies: { helper: "^1.0.0" } },
      "node_modules/helper": { version: "1.1.2", peerDependencies: { core: "1.1.2" } },
    });
    const deps: DirectDep[] = [
      { name: "core", spec: "^1.1.0", field: "dependencies" },
      { name: "wrapper", spec: "^1.0.0", field: "dependencies" },
    ];
    const published = { core: coreVersions("1.1.2", "1.2.20"), helper: { "1.1.2": { peers: { core: "1.1.2" } }, "1.2.20": { peers: { core: "1.2.20" } } } };
    const plan = await planFor({ alerts: [coreAlert()], lock, deps }, registry(published).read);
    assert.deepEqual(targetsOf(plan), { "node_modules/core": "1.2.20", "node_modules/helper": "1.2.20" });
    assert.deepEqual(plan.addOverrides, { "helper@>=1.1.2 <1.2.20": "1.2.20" }, "wrapper declares it, and locked the old copy");
  });

  it("leaves a copy on another major alone", async () => {
    const lock = makeLock({
      "": { dependencies: { core: "^1.1.0", forms: "^1.1.0", legacy: "^1.0.0" } },
      "node_modules/core": { version: "1.1.2" },
      "node_modules/forms": { version: "1.1.2", peerDependencies: { core: "1.1.2" } },
      "node_modules/legacy": { version: "1.0.0", dependencies: { forms: "^0.9.0" } },
      "node_modules/legacy/node_modules/forms": { version: "0.9.0" },
    });
    const deps: DirectDep[] = [
      { name: "core", spec: "^1.1.0", field: "dependencies" },
      { name: "forms", spec: "^1.1.0", field: "dependencies" },
      { name: "legacy", spec: "^1.0.0", field: "dependencies" },
    ];
    const published = { core: coreVersions("1.1.2", "1.2.20"), forms: { "0.9.0": {}, "1.1.2": { peers: { core: "1.1.2" } }, "1.2.20": { peers: { core: "1.2.20" } } } };
    const plan = await planFor({ alerts: [coreAlert()], lock, deps }, registry(published).read);
    assert.equal(plan.targets.has("node_modules/legacy/node_modules/forms"), false);
    assert.equal(plan.targets.get("node_modules/forms"), "1.2.20");
  });
});

describe("a target that needs more of a package also being fixed", () => {
  const lock = () =>
    makeLock({
      "": { dependencies: { vite: "^7.0.0" } },
      "node_modules/vite": { version: "7.0.0", dependencies: { postcss: "^8.5.0" } },
      "node_modules/postcss": { version: "8.5.6", dependencies: { nanoid: "^3.3.11" } },
      "node_modules/nanoid": { version: "3.3.11" },
    });
  const alerts = () => [alert(1, "postcss", ">= 8.0.0, < 8.5.23", "8.5.23"), alert(2, "nanoid", ">= 3.0.0, < 3.3.12", "3.3.12")];
  const published = {
    postcss: { "8.5.6": { deps: { nanoid: "^3.3.11" } }, "8.5.23": { deps: { nanoid: "^3.3.16" } } },
    nanoid: coreVersions("3.3.11", "3.3.12", "3.3.16", "3.3.20"),
  };

  it("raises the fix to the lowest version the target accepts", async () => {
    const plan = await planFor({ alerts: alerts(), lock: lock(), deps: [] }, registry(published).read);
    assert.equal(plan.targets.get("node_modules/nanoid"), "3.3.16");
    assert.deepEqual(plan.addOverrides, { "nanoid@>=3.0.0 <3.3.16": "3.3.16", "postcss@>=8.0.0 <8.5.23": "8.5.23" });
    assert.deepEqual(plan.alerts.map((a) => a.status), ["fixed", "fixed"]);
  });

  it("doesn't call that moving together: only a peer has to be installed in one go", async () => {
    const plan = await planFor({ alerts: alerts(), lock: lock(), deps: [] }, registry(published).read);
    assert.equal(plan.batched?.size ?? 0, 0);
  });

  it("leaves a dependency that isn't being fixed for npm to place", async () => {
    const plan = await planFor({ alerts: [alerts()[0]], lock: lock(), deps: [] }, registry(published).read);
    assert.deepEqual(targetsOf(plan), { "node_modules/postcss": "8.5.23" });
  });
});

describe("planWithRequirements", () => {
  const simple = (): Setup => ({
    alerts: [alert(1, "qs", ">= 6.0.0, < 6.5.3", "6.5.3")],
    lock: makeLock({ "": { dependencies: { parent: "^1.0.0" } }, "node_modules/parent": { version: "1.0.0", dependencies: { qs: "^6.5.0" } }, "node_modules/qs": { version: "6.5.0" } }),
    deps: [],
  });

  it("gives the same plan as before when nothing needs anything", async () => {
    const setup = simple();
    const { read } = registry({ qs: coreVersions("6.5.0", "6.5.3") });
    const plan = await planFor(setup, read);
    const plain = buildPlan({ ...inputOf(setup), published: new Map([["qs", ["6.5.0", "6.5.3"]]]) });
    assert.deepEqual(targetsOf(plan), targetsOf(plain));
    assert.deepEqual(plan.addOverrides, plain.addOverrides);
    assert.deepEqual(plan.alerts, plain.alerts);
  });

  it("reports a package the registry doesn't know as unavailable", async () => {
    const plan = await planFor(simple(), registry({}).read);
    assert.equal(plan.alerts[0].copies[0].reason, "target-unavailable");
  });

  it("carries a registry failure out to the caller instead of guessing", async () => {
    await assert.rejects(
      planFor(simple(), async () => {
        throw new Error("registry down");
      }),
      /registry down/,
    );
  });

  it("honours alerts the caller has already ruled out", async () => {
    const setup = simple();
    const excluded = new Map([[setup.alerts[0], { reason: "failed-verification" as const, detail: "It didn't verify." }]]);
    const plan = await planWithRequirements({ ...inputOf(setup), excluded }, registry({ qs: coreVersions("6.5.0", "6.5.3") }).read);
    assertNoWrites(plan);
    assert.equal(plan.alerts[0].copies[0].reason, "failed-verification");
    assert.equal(plan.alerts[0].copies[0].detail, "It didn't verify.");
  });
});

describe("a target whose plain dependency can't follow a package also being fixed", () => {
  it("raises the target to a release that agrees, rather than block or mismatch them", async () => {
    const lock = makeLock({
      "": { dependencies: { vitest: "^4.0.0" } },
      "node_modules/vitest": { version: "4.0.18", dependencies: { "@vitest/mocker": "4.0.18" } },
      "node_modules/@vitest/mocker": { version: "4.0.18" },
    });
    const deps: DirectDep[] = [{ name: "vitest", spec: "^4.0.0", field: "dependencies" }];
    const published = {
      vitest: {
        "4.0.18": { deps: { "@vitest/mocker": "4.0.18" } },
        "4.1.11": { deps: { "@vitest/mocker": "4.1.11" } },
        "4.1.12": { deps: { "@vitest/mocker": "4.1.12" } },
      },
      "@vitest/mocker": coreVersions("4.0.18", "4.1.11", "4.1.12"),
    };
    const alerts = [alert(1, "vitest", ">= 4.0.0, < 4.1.11", "4.1.11"), alert(2, "@vitest/mocker", ">= 4.0.0, < 4.1.12", "4.1.12")];
    const plan = await planFor({ alerts, lock, deps }, registry(published).read);
    assert.equal(plan.targets.get("node_modules/vitest"), "4.1.12");
    assert.equal(plan.targets.get("node_modules/@vitest/mocker"), "4.1.12");
    assert.deepEqual(plan.alerts.map((a) => a.status), ["fixed", "fixed"]);
    assert.equal(plan.batched?.size ?? 0, 0);
  });

  it("leaves npm to nest a copy when the target needs another line of it", async () => {
    const lock = makeLock({
      "": { dependencies: { minimatch: "^9.0.0", old: "^1.0.0" } },
      "node_modules/minimatch": { version: "9.0.5", dependencies: { "brace-expansion": "^2.0.1" } },
      "node_modules/minimatch/node_modules/brace-expansion": { version: "2.0.2" },
      "node_modules/old": { version: "1.0.0", dependencies: { "brace-expansion": "^1.1.0" } },
      "node_modules/brace-expansion": { version: "1.1.12" },
    });
    const deps: DirectDep[] = [
      { name: "minimatch", spec: "^9.0.0", field: "dependencies" },
      { name: "old", spec: "^1.0.0", field: "dependencies" },
    ];
    const published = {
      minimatch: { "9.0.5": { deps: { "brace-expansion": "^2.0.1" } }, "9.0.7": { deps: { "brace-expansion": "^5.0.2" } } },
      "brace-expansion": coreVersions("1.1.12", "1.1.21", "2.0.2", "2.1.7", "5.0.2"),
    };
    const alerts = [alert(1, "minimatch", ">= 9.0.0, < 9.0.7", "9.0.7"), alert(2, "brace-expansion", ">= 1.0.0, < 1.1.21", "1.1.21")];
    const plan = await planFor({ alerts, lock, deps }, registry(published).read);
    assert.deepEqual(plan.alerts.map((a) => a.status), ["fixed", "fixed"]);
    assert.equal(plan.targets.get("node_modules/brace-expansion"), "1.1.21");
  });

  it("carries on when no release agrees: the plan still fixes both, and reports the mismatch", async () => {
    const lock = makeLock({
      "": { dependencies: { parent: "^1.0.0" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { child: "1.0.0" } },
      "node_modules/child": { version: "1.0.0" },
    });
    const published = {
      parent: { "1.0.0": { deps: { child: "1.0.0" } }, "1.0.1": { deps: { child: "1.0.0" } } },
      child: coreVersions("1.0.0", "1.0.2"),
    };
    const alerts = [alert(1, "parent", ">= 1.0.0, < 1.0.1", "1.0.1"), alert(2, "child", ">= 1.0.0, < 1.0.2", "1.0.2")];
    const deps: DirectDep[] = [{ name: "parent", spec: "^1.0.0", field: "dependencies" }];
    const plan = await planFor({ alerts, lock, deps }, registry(published).read);
    assert.deepEqual(plan.alerts.map((a) => a.status), ["fixed", "fixed"]);
    assert.equal(plan.targets.get("node_modules/parent"), "1.0.1");
  });
});

describe("moveTogether", () => {
  const lock = () =>
    makeLock({
      "": { dependencies: { ssr: "^1.1.0" }, devDependencies: { build: "^1.1.0" } },
      "node_modules/ssr": { version: "1.1.2" },
      "node_modules/build": { version: "1.1.2", peerDependencies: { ssr: "^1.1.2" } },
    });
  const deps = (): DirectDep[] => [
    { name: "ssr", spec: "^1.1.0", field: "dependencies" },
    { name: "build", spec: "^1.1.0", field: "devDependencies" },
  ];
  const published = (): Record<string, Versions> => ({
    ssr: coreVersions("1.1.2", "1.2.23", "1.2.29"),
    build: { "1.1.2": { peers: { ssr: "^1.1.2" } }, "1.2.23": { peers: { ssr: "^1.2.23" } }, "1.2.29": { peers: { ssr: "^1.2.29" } } },
  });
  const ssrAlert = () => alert(1, "ssr", ">= 1.0.0, < 1.2.23", "1.2.23");
  const solve = (over: Partial<ReturnType<typeof inputOf>> & { moveTogether?: string[][] }, read = registry(published()).read) =>
    planWithRequirements({ ...inputOf({ alerts: [ssrAlert()], lock: lock(), deps: deps() }), moveTogether: [["ssr", "build"]], ...over }, read);

  it("moves the rest of a listed group to the version the fix landed on", async () => {
    const plan = await solve({});
    assert.deepEqual(targetsOf(plan), { "node_modules/ssr": "1.2.23", "node_modules/build": "1.2.23" });
    assert.deepEqual([...(plan.batched ?? [])].sort(), ["build", "ssr"]);
  });

  it("says in the report why it moved", async () => {
    const plan = await solve({});
    const moved = plan.movedWith!.find((m) => m.name === "build")!;
    assert.equal(moved.to, "1.2.23");
    assert.match(moved.because, /moveTogether/);
    assert.match(moved.because, /ssr/);
  });

  it("does nothing without the setting: npm's metadata says that pair is fine", async () => {
    const plan = await solve({ moveTogether: undefined });
    assert.deepEqual(targetsOf(plan), { "node_modules/ssr": "1.2.23" });
  });

  it("does nothing when no listed package is moving", async () => {
    const plan = await solve({ alerts: [] });
    assert.equal(plan.targets.size, 0);
  });

  it("takes the lowest version at or above the fix when that exact version wasn't published", async () => {
    const pub = published();
    pub.build = { "1.1.2": { peers: { ssr: "^1.1.2" } }, "1.2.29": { peers: { ssr: "^1.2.23" } } };
    const plan = await solve({}, registry(pub).read);
    assert.equal(plan.targets.get("node_modules/build"), "1.2.29");
  });

  it("blocks the fix when the rest of the group can't follow", async () => {
    const pub = published();
    pub.build = { "1.1.2": { peers: { ssr: "^1.1.2" } } };
    const plan = await solve({}, registry(pub).read);
    assertNoWrites(plan);
    assert.equal(plan.alerts[0].copies[0].reason, "moves-together");
    assert.match(plan.alerts[0].copies[0].detail!, /moveTogether/);
  });

  it("honours a limit on the rest of the group", async () => {
    const plan = await solve({ limits: { build: "<1.2.0" } });
    assertNoWrites(plan);
    assert.equal(plan.alerts[0].copies[0].reason, "moves-together");
    assert.match(plan.alerts[0].copies[0].detail!, /limit/);
  });

  it("ignores a listed package that isn't installed", async () => {
    const plan = await solve({ moveTogether: [["ssr", "build", "absent"]] });
    assert.deepEqual(targetsOf(plan), { "node_modules/ssr": "1.2.23", "node_modules/build": "1.2.23" });
  });

  it("leaves a member on another major alone", async () => {
    const onOtherMajor = makeLock({
      "": { dependencies: { ssr: "^1.1.0" }, devDependencies: { build: "^2.0.0" } },
      "node_modules/ssr": { version: "1.1.2" },
      "node_modules/build": { version: "2.0.0" },
    });
    const plan = await solve({ lock: onOtherMajor, manifests: [{ dir: "/repo", lockPath: "", deps: [{ name: "ssr", spec: "^1.1.0", field: "dependencies" }, { name: "build", spec: "^2.0.0", field: "devDependencies" }] }] });
    assert.deepEqual(targetsOf(plan), { "node_modules/ssr": "1.2.23" });
  });
});

describe("review findings", () => {
  it("still writes an override for a peer-only copy the moving package's new range accepts as it is", async () => {
    // forms makes this a family, so the planner comes round again knowing core is moving.
    const lock = makeLock({
      "": { dependencies: { core: "^1.1.0", forms: "^1.1.0" } },
      "node_modules/core": { version: "1.1.2", peerDependencies: { helper: "^1.1.0" } },
      "node_modules/forms": { version: "1.1.2", peerDependencies: { core: "1.1.2" } },
      "node_modules/helper": { version: "1.1.2", peer: true },
    });
    const deps: DirectDep[] = [
      { name: "core", spec: "^1.1.0", field: "dependencies" },
      { name: "forms", spec: "^1.1.0", field: "dependencies" },
    ];
    const published = {
      core: { "1.1.2": { peers: { helper: "^1.1.0" } }, "1.2.20": { peers: { helper: "^1.1.0" } } },
      forms: { "1.1.2": { peers: { core: "1.1.2" } }, "1.2.20": { peers: { core: "1.2.20" } } },
      helper: coreVersions("1.1.2", "1.1.5"),
    };
    const plan = await planFor({ alerts: [coreAlert(), alert(2, "helper", ">= 1.0.0, < 1.1.5", "1.1.5")], lock, deps }, registry(published).read);
    assert.equal(plan.targets.get("node_modules/helper"), "1.1.5");
    assert.deepEqual(plan.addOverrides, { "helper@>=1.0.0 <1.1.5": "1.1.5" }, "with nothing tying it to core, only an override can move it");
    assert.deepEqual(plan.alerts.map((a) => a.status), ["fixed", "fixed"]);
  });

  it("reports a move no live alert accounts for, though a blocked alert's patch is higher", async () => {
    const plan = await planFor(
      { alerts: [commonAlert("1.2.5"), coreAlert("1.5.0")], ...family(), limits: { core: "<1.4.0" } },
      registry(familyPublished(["1.1.2", "1.2.5", "1.5.0"])).read,
    );
    assert.equal(plan.targets.get("node_modules/core"), "1.2.5");
    assert.equal(plan.alerts.find((a) => a.packageName === "core")!.status, "blocked");
    assert.ok(plan.movedWith?.some((m) => m.name === "core" && m.to === "1.2.5"), JSON.stringify(plan.movedWith));
  });

  it("lists a package once however many copies moved, and not for a copy on another line", async () => {
    const lock = makeLock({
      "": { dependencies: { core: "^1.1.0", forms: "^1.1.0", a: "^1.0.0", old: "^1.0.0" } },
      "node_modules/core": { version: "1.1.2" },
      "node_modules/forms": { version: "1.1.2", peerDependencies: { core: "1.1.2" } },
      "node_modules/a": { version: "1.0.0", dependencies: { forms: "^1.1.0" } },
      "node_modules/a/node_modules/forms": { version: "1.1.2", peerDependencies: { core: "1.1.2" } },
      "node_modules/old": { version: "1.0.0", dependencies: { forms: "^0.9.0" } },
      "node_modules/old/node_modules/forms": { version: "0.9.0" },
    });
    const deps: DirectDep[] = [
      { name: "core", spec: "^1.1.0", field: "dependencies" },
      { name: "forms", spec: "^1.1.0", field: "dependencies" },
      { name: "a", spec: "^1.0.0", field: "dependencies" },
      { name: "old", spec: "^1.0.0", field: "dependencies" },
    ];
    const published = {
      core: coreVersions("1.1.2", "1.2.20"),
      forms: { "0.9.0": {}, "0.9.5": {}, "1.1.2": { peers: { core: "1.1.2" } }, "1.2.20": { peers: { core: "1.2.20" } } },
    };
    const plan = await planFor({ alerts: [coreAlert(), alert(2, "forms", ">= 0.9.0, < 0.9.5", "0.9.5")], lock, deps }, registry(published).read);
    assert.deepEqual(plan.movedWith?.filter((m) => m.name === "forms").map((m) => `${m.from}>${m.to}`), ["1.1.2>1.2.20"]);
  });
});

describe("a fix version that has an advisory of its own", () => {
  const lock = () =>
    makeLock({
      "": { dependencies: { parent: "^1.0.0" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { hono: "^4.0.0" } },
      "node_modules/hono": { version: "4.11.7" },
    });
  const honoAlert = () => alert(1, "hono", ">= 4.0.0, < 4.13.7", "4.13.7");
  const versions = coreVersions("4.11.7", "4.13.7", "4.13.11", "4.13.12", "4.13.16");
  const advised = (...ranges: string[]) =>
    async () => ({ hono: ranges.map((range, i) => ({ url: `https://example.test/advisory-${i}`, vulnerable_versions: range })) });
  const solve = (readAdvisories: ReadAdvisories, over: Partial<ReturnType<typeof inputOf>> = {}, published: Record<string, Versions> = { hono: versions }) =>
    solvePlan({ ...inputOf({ alerts: [honoAlert()], lock: lock(), deps: [] }), ...over }, registry(published).read, readAdvisories);

  it("moves to the lowest later version clear of every advisory", async () => {
    const { plan } = await solve(advised(">=4.12.4 <4.13.11"));
    assert.equal(plan.targets.get("node_modules/hono"), "4.13.11");
    assert.deepEqual(plan.addOverrides, { "hono@>=4.0.0 <4.13.11": "4.13.11" });
    assert.equal(plan.alerts[0].status, "fixed");
  });

  it("clears them all, not only the first it finds", async () => {
    const { plan } = await solve(advised(">=4.12.4 <4.13.11", ">=4.13.11 <4.13.12"));
    assert.equal(plan.targets.get("node_modules/hono"), "4.13.12");
  });

  it("stays on the earliest fix when no advisory touches it", async () => {
    const { plan } = await solve(advised("<4.11.0"));
    assert.equal(plan.targets.get("node_modules/hono"), "4.13.7");
    assert.deepEqual(plan.advised ?? [], []);
  });

  it("says why it went further than the alert asks", async () => {
    const { plan } = await solve(advised(">=4.12.4 <4.13.11"));
    const moved = plan.movedWith!.find((m) => m.name === "hono")!;
    assert.equal(moved.to, "4.13.11");
    assert.match(moved.because, /advisory-0/);
  });

  it("keeps the fix and reports it when nothing later on the line is clear", async () => {
    const { plan } = await solve(advised(">=4.12.4 <5.0.0"));
    assert.equal(plan.targets.get("node_modules/hono"), "4.13.7", "still better than what's installed");
    assert.equal(plan.alerts[0].status, "fixed");
    assert.deepEqual(plan.advised, [{ name: "hono", version: "4.13.7", advisory: "https://example.test/advisory-0" }]);
  });

  it("won't cross a major to get clear", async () => {
    const { plan } = await solve(advised(">=4.12.4 <5.0.0"), {}, { hono: coreVersions("4.11.7", "4.13.7", "5.0.0") });
    assert.equal(plan.targets.get("node_modules/hono"), "4.13.7");
    assert.equal(plan.advised?.length, 1);
  });

  it("won't pass a limit to get clear: the alert's fix still lands", async () => {
    const { plan } = await solve(advised(">=4.12.4 <4.13.11"), { limits: { hono: "<4.13.10" } });
    assert.equal(plan.targets.get("node_modules/hono"), "4.13.7");
    assert.equal(plan.alerts[0].status, "fixed");
    assert.equal(plan.advised?.length, 1);
  });

  it("gives up on going further, not on the fix, when the later version can't be reached", async () => {
    // The root pins 4.13.8. An override reaching 4.13.11 would match that pin, which one reaching 4.13.7 doesn't.
    const withPin = makeLock({
      "": { dependencies: { parent: "^1.0.0", hono: "4.13.8" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { hono: "^4.0.0" } },
      "node_modules/parent/node_modules/hono": { version: "4.11.7" },
      "node_modules/hono": { version: "4.13.8" },
    });
    const manifests: ManifestInfo[] = [
      { dir: "/repo", lockPath: "", deps: [{ name: "parent", spec: "^1.0.0", field: "dependencies" }, { name: "hono", spec: "4.13.8", field: "dependencies" }] },
    ];
    const { plan } = await solve(advised(">=4.12.4 <4.13.11"), { lock: withPin, manifests });
    assert.equal(plan.targets.get("node_modules/parent/node_modules/hono"), "4.13.7");
    assert.equal(plan.targets.has("node_modules/hono"), false, "the pin holds");
    assert.equal(plan.alerts[0].status, "fixed");
    assert.deepEqual(plan.advised, [{ name: "hono", version: "4.13.7", advisory: "https://example.test/advisory-0" }]);
    assert.deepEqual(plan.addOverrides, { "hono@>=4.0.0 <4.13.7": "4.13.7" });
  });

  it("raises a whole family together when the version they'd share is inside an advisory", async () => {
    const readAdvisories: ReadAdvisories = async () => ({ core: [{ url: "https://example.test/a", vulnerable_versions: ">=1.2.0 <1.2.25" }] });
    const { plan } = await solvePlan(
      inputOf({ alerts: [coreAlert()], ...family() }),
      registry(familyPublished(["1.1.2", "1.2.20", "1.2.25"])).read,
      readAdvisories,
    );
    assert.deepEqual(targetsOf(plan), { "node_modules/core": "1.2.25", "node_modules/common": "1.2.25", "node_modules/forms": "1.2.25" });
    assert.ok(plan.batched?.has("forms"));
  });

  it("asks once for each package, about the versions on the fix's line at or above it", async () => {
    const asked: Array<Record<string, string[]>> = [];
    await solve(async (query) => {
      asked.push(query);
      return {};
    });
    assert.deepEqual(asked, [{ hono: ["4.13.7", "4.13.11", "4.13.12", "4.13.16"] }]);
  });

  it("doesn't ask at all when nothing is moving", async () => {
    let asked = false;
    await solve(
      async () => {
        asked = true;
        return {};
      },
      { alerts: [] },
    );
    assert.equal(asked, false);
  });

  it("carries on and says so when the advisories can't be read", async () => {
    const { plan } = await solve(async () => {
      throw new Error("blocked by a proxy");
    });
    assert.equal(plan.targets.get("node_modules/hono"), "4.13.7");
    assert.match(plan.advisoriesUnchecked ?? "", /blocked by a proxy/);
  });

  it("skips the check entirely without a reader", async () => {
    const { plan } = await solvePlan(inputOf({ alerts: [honoAlert()], lock: lock(), deps: [] }), registry({ hono: versions }).read);
    assert.equal(plan.targets.get("node_modules/hono"), "4.13.7");
    assert.equal(plan.advisoriesUnchecked, undefined);
  });
});

describe("going further than a fix never costs the fix", () => {
  const advisoryOn = (name: string, range: string): ReadAdvisories =>
    async () => ({ [name]: [{ url: "https://example.test/a", vulnerable_versions: range }] });

  it("gives up the raise when it would drag a package past its limit, and keeps the fix", async () => {
    const { plan } = await solvePlan(
      { ...inputOf({ alerts: [coreAlert("1.2.4")], ...family() }), limits: { forms: "<1.2.5" } },
      registry(familyPublished(["1.1.2", "1.2.4", "1.2.6"])).read,
      advisoryOn("core", ">=1.2.0 <1.2.5"),
    );
    assert.deepEqual(targetsOf(plan), { "node_modules/core": "1.2.4", "node_modules/common": "1.2.4", "node_modules/forms": "1.2.4" });
    assert.equal(plan.alerts[0].status, "fixed");
    assert.equal(plan.advised?.[0].name, "core");
  });

  it("gives up the raise when a family member has no release at the raised version", async () => {
    const published = familyPublished(["1.1.2", "1.2.4", "1.2.6"]);
    delete published.forms["1.2.6"];
    const { plan } = await solvePlan(inputOf({ alerts: [coreAlert("1.2.4")], ...family() }), registry(published).read, advisoryOn("core", ">=1.2.0 <1.2.5"));
    assert.equal(plan.targets.get("node_modules/core"), "1.2.4");
    assert.equal(plan.targets.get("node_modules/forms"), "1.2.4");
    assert.equal(plan.alerts[0].status, "fixed");
  });

  it("keeps an unrelated package's raise when it gives one up", async () => {
    const lock = makeLock({
      "": { dependencies: { core: "^1.1.0", common: "^1.1.0", forms: "^1.1.0", parent: "^1.0.0" } },
      "node_modules/core": { version: "1.1.2" },
      "node_modules/common": { version: "1.1.2", peerDependencies: { core: "1.1.2" } },
      "node_modules/forms": { version: "1.1.2", peerDependencies: { core: "1.1.2", common: "1.1.2" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { tar: "^7.0.0" } },
      "node_modules/tar": { version: "7.5.7" },
    });
    const deps = family().deps.concat({ name: "parent", spec: "^1.0.0", field: "dependencies" });
    const published = { ...familyPublished(["1.1.2", "1.2.4", "1.2.6"]), tar: coreVersions("7.5.7", "7.5.18", "7.5.21") };
    const readAdvisories: ReadAdvisories = async () => ({
      core: [{ url: "https://example.test/core", vulnerable_versions: ">=1.2.0 <1.2.5" }],
      tar: [{ url: "https://example.test/tar", vulnerable_versions: ">=7.5.0 <7.5.21" }],
    });
    const { plan } = await solvePlan(
      { ...inputOf({ alerts: [coreAlert("1.2.4"), alert(9, "tar", ">= 7.0.0, < 7.5.18", "7.5.18")], lock, deps }), limits: { forms: "<1.2.5" } },
      registry(published).read,
      readAdvisories,
    );
    assert.equal(plan.targets.get("node_modules/core"), "1.2.4");
    assert.equal(plan.targets.get("node_modules/tar"), "7.5.21");
  });

  it("leaves nothing tied to the abandoned raise behind", async () => {
    const deps: DirectDep[] = [
      { name: "core", spec: "^1.1.0", field: "dependencies" },
      { name: "extra", spec: "^1.0.0", field: "dependencies" },
    ];
    // core 1.2.6 needs extra to move, and the only extra that would accept it is out of limits.
    const published = {
      core: coreVersions("1.1.2", "1.2.4", "1.2.6"),
      extra: { "1.0.0": { peers: { core: ">=1.1.0 <1.2.5" } }, "1.1.0": { peers: { core: "^1.2.6" } } },
    };
    const manifestLock = makeLock({
      "": { dependencies: { core: "^1.1.0", extra: "^1.0.0" } },
      "node_modules/core": { version: "1.1.2" },
      "node_modules/extra": { version: "1.0.0", peerDependencies: { core: ">=1.1.0 <1.2.5" } },
    });
    const { plan } = await solvePlan(
      { ...inputOf({ alerts: [coreAlert("1.2.4")], lock: manifestLock, deps }), limits: { extra: "<1.1.0" } },
      registry(published).read,
      advisoryOn("core", ">=1.2.0 <1.2.5"),
    );
    assert.deepEqual(targetsOf(plan), { "node_modules/core": "1.2.4" });
    assert.equal(plan.batched?.size ?? 0, 0);
    assert.deepEqual(plan.movedWith ?? [], []);
  });

  it("honours a raise the caller has already given up on", async () => {
    const { plan } = await solvePlan(
      { ...inputOf({ alerts: [coreAlert("1.2.4")], ...family() }), declinedRaises: new Set(["core"]) },
      registry(familyPublished(["1.1.2", "1.2.4", "1.2.6"])).read,
      advisoryOn("core", ">=1.2.0 <1.2.5"),
    );
    assert.equal(plan.targets.get("node_modules/core"), "1.2.4");
    assert.equal(plan.advised?.length, 1);
  });

  it("says which packages it raised, so a failed run can give those up first", async () => {
    const { raised } = await solvePlan(
      inputOf({ alerts: [coreAlert("1.2.4")], ...family() }),
      registry(familyPublished(["1.1.2", "1.2.4", "1.2.6"])).read,
      advisoryOn("core", ">=1.2.0 <1.2.5"),
    );
    assert.deepEqual([...raised], ["core"]);
  });

  it("checks a lower fix for advisories when a restart falls back to one", async () => {
    const lock = makeLock({
      "": { dependencies: { parent: "^1.0.0", other: "^1.0.0" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { hono: "^4.0.0" } },
      "node_modules/hono": { version: "4.11.7" },
      "node_modules/other": { version: "1.0.0" },
    });
    const deps: DirectDep[] = [
      { name: "parent", spec: "^1.0.0", field: "dependencies" },
      { name: "other", spec: "^1.0.0", field: "dependencies" },
    ];
    // hono 4.14.0 peers another major of `other`, which only shows on the second pass, after advisories were first read.
    const published = {
      hono: { "4.11.7": {}, "4.13.7": {}, "4.13.8": {}, "4.14.0": { peers: { other: "^2.0.0" } } },
      other: coreVersions("1.0.0", "2.0.0"),
    };
    const reader: ReadAdvisories = async (query) => {
      const low = { url: "https://example.test/low", vulnerable_versions: ">=4.13.0 <4.13.8" };
      return { hono: (query.hono ?? []).includes("4.13.7") ? [low] : [] };
    };
    const { plan } = await solvePlan(
      inputOf({ alerts: [alert(1, "hono", ">= 4.0.0, < 4.13.7", "4.13.7"), alert(2, "hono", ">= 4.0.0, < 4.14.0", "4.14.0")], lock, deps }),
      registry(published).read,
      reader,
    );
    assert.equal(plan.targets.get("node_modules/hono"), "4.13.8");
  });
});
