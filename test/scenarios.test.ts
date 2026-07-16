import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { computeOverrideChanges, findVulnerableInstalls, judgeOrphanedOverride } from "../src/reconcile.js";
import { parsePnpmListOutput } from "../src/package-manager/pnpm.js";
import { parseNpmLsOutput } from "../src/package-manager/npm.js";
import { DependabotAlert, DependentRange } from "../src/types.js";

// End-to-end coverage of the four scenarios the agent exists for — add and
// remove an override, on pnpm and npm — replaying REAL data captured from the
// live fixtures into the real code paths. Deterministic and offline: no
// Dependabot, no registry, no install. The captured JSON also pins the PM output
// shapes, so a future pnpm/npm change that breaks parsing surfaces here rather
// than only in a live run. See RUNBOOK.md for the live end-to-end procedure.

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
const load = (name: string): string => fs.readFileSync(path.join(fixturesDir, name), "utf-8");
const loadJson = <T>(name: string): T => JSON.parse(load(name)) as T;

// The real js-yaml multi-line alerts (two advisories, four lines) from
// dependabot-agent-fixture-npm.
const alerts = loadJson<DependabotAlert[]>("alerts-js-yaml-multiline.json");

describe("scenario: ADD per-line scoped overrides for a multi-line advisory", () => {
  // The expected fix, identical for both managers: each release line gets its
  // own bounded override so no consumer crosses a major.
  const assertScoped = (currentOverrides: Record<string, string>, tree: ReturnType<typeof parsePnpmListOutput>) => {
    const vulnerable = findVulnerableInstalls(alerts, tree);
    assert.equal(vulnerable.length, 1);
    assert.equal(vulnerable[0].name, "js-yaml");
    assert.deepEqual(vulnerable[0].installedVersions, ["3.14.1", "4.1.0"]);

    const changes = computeOverrideChanges(currentOverrides, vulnerable, new Set(["js-yaml"]));
    const byKey = Object.fromEntries(changes.map((c) => [c.packageName, c]));
    assert.equal(byKey["js-yaml@3"].newVersion, ">=3.15.0 <4");
    assert.equal(byKey["js-yaml@4"].newVersion, ">=4.2.0 <5");
    return byKey;
  };

  it("pnpm — captured `pnpm list -r` + real alerts → js-yaml@3 / js-yaml@4", () => {
    const tree = parsePnpmListOutput(load("pnpm-list-vulnerable.json"));
    const byKey = assertScoped({}, tree);
    assert.equal(byKey["js-yaml@3"].action, "add");
    assert.equal(byKey["js-yaml@4"].action, "add");
  });

  it("npm — captured `npm ls --all` + real alerts → js-yaml@3 / js-yaml@4", () => {
    const tree = parseNpmLsOutput(load("npm-ls-vulnerable.json"), "/repo");
    assertScoped({}, tree);
  });

  it("is idempotent on a re-run — the scoped keys already present yield no changes", () => {
    // The tree here still holds the vulnerable copies, but even once patched the
    // result must hold: the lines come from the advisory, not the installed tree.
    const tree = parsePnpmListOutput(load("pnpm-list-vulnerable.json"));
    const vulnerable = findVulnerableInstalls(alerts, tree);
    const changes = computeOverrideChanges(
      { "js-yaml@3": ">=3.15.0 <4", "js-yaml@4": ">=4.2.0 <5" },
      vulnerable,
      new Set(["js-yaml"]),
    );
    assert.deepEqual(changes, []);
  });
});

describe("scenario: REMOVE an override once upstream has moved on", () => {
  // The decision is package-manager-agnostic — it runs on the dependents'
  // registry ranges, however pnpm or npm discovered them. Captured from the live
  // debug@2.0.0 → ms case: latest debug requests ms ^2.1.3, above a >=2.0.0
  // override, so the override is dead.
  const dependents = loadJson<DependentRange[]>("dependents-debug-ms.json");

  it("removes when every latest upstream range is safe", () => {
    const verdict = judgeOrphanedOverride(dependents, "2.0.0", "2.1.3");
    assert.equal(verdict.action, "remove");
  });

  it("keeps (does not remove) when a latest range could still resolve below the floor", () => {
    // Same dependents, but the floor is above what latest requests (^2.1.3 could
    // resolve below 3.0.0) — still load-bearing, so it is NOT removed. Here it
    // surfaces as an escape: debug@2.0.0 declares ms 0.6.2, and the resolved 2.1.3
    // is past that range. The point for this scenario is the negative — never
    // "remove".
    const verdict = judgeOrphanedOverride(dependents, "3.0.0", "2.1.3");
    assert.notEqual(verdict.action, "remove");
    assert.equal(verdict.action, "escape");
  });
});

describe("PM tree parsers replay real output (shape guards)", () => {
  it("parsePnpmListOutput surfaces every workspace member's copy", () => {
    const tree = parsePnpmListOutput(load("pnpm-list-vulnerable.json"));
    // Three projects; js-yaml appears under two of them at different majors.
    assert.equal(tree.length, 3);
  });

  it("parseNpmLsOutput surfaces the nested copies", () => {
    const tree = parseNpmLsOutput(load("npm-ls-vulnerable.json"), "/repo");
    assert.equal(tree.length, 1);
    assert.ok(tree[0].dependencies, "root has dependencies");
  });
});
