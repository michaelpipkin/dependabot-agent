import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeOverrideChanges } from "../src/reconcile.js";
import { VulnerablePackage } from "../src/types.js";

function vuln(name: string, installedVersion: string, patchedVersion: string): VulnerablePackage {
  return {
    name,
    installedVersion,
    patchedVersion,
    severity: "high",
    foundInParents: [],
    alertNumber: 1,
  };
}

describe("computeOverrideChanges", () => {
  it("adds an override for a package that is still vulnerable", () => {
    const changes = computeOverrideChanges({}, [vuln("lodash", "4.17.20", "4.17.21")], new Set(["lodash"]));
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "add");
    assert.equal(changes[0].newVersion, ">=4.17.21 <5");
    assert.equal(changes[0].noInRangeFix, false);
  });

  it("updates an override whose spec no longer matches", () => {
    const changes = computeOverrideChanges(
      { lodash: ">=4.17.19 <5" },
      [vuln("lodash", "4.17.20", "4.17.21")],
      new Set(["lodash"]),
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "update");
    assert.equal(changes[0].oldVersion, ">=4.17.19 <5");
    assert.equal(changes[0].newVersion, ">=4.17.21 <5");
  });

  it("emits nothing when the existing override is already correct", () => {
    const changes = computeOverrideChanges(
      { lodash: ">=4.17.21 <5" },
      [vuln("lodash", "4.17.20", "4.17.21")],
      new Set(["lodash"]),
    );
    assert.deepEqual(changes, []);
  });

  it("removes an override once its alert is resolved", () => {
    const changes = computeOverrideChanges({ tar: ">=6.2.1 <7" }, [], new Set(["tar"]));
    assert.equal(changes.length, 1);
    assert.equal(changes[0].action, "remove");
    assert.equal(changes[0].oldVersion, ">=6.2.1 <7");
  });

  it("leaves an override alone when it belongs to no alert at all", () => {
    // Assumed intentional — a hand-written pin the agent did not place.
    const changes = computeOverrideChanges({ "some-pin": "1.2.3" }, [], new Set());
    assert.deepEqual(changes, []);
  });

  describe("no-in-range-fix flagging", () => {
    it("flags a major escape and says so in the reason", () => {
      const changes = computeOverrideChanges({}, [vuln("react", "18.2.0", "19.0.0")], new Set(["react"]));
      assert.equal(changes[0].noInRangeFix, true);
      assert.equal(changes[0].installedVersion, "18.2.0");
      assert.match(changes[0].reason, /No in-range fix exists/);
    });

    it("flags a 0.x minor escape — regression guard for CVE-2024-47764", () => {
      // The most common shape of this problem in the npm ecosystem, and the one
      // a major-only check silently reports as routine.
      const changes = computeOverrideChanges({}, [vuln("cookie", "0.5.0", "0.7.0")], new Set(["cookie"]));
      assert.equal(changes[0].noInRangeFix, true);
      assert.equal(changes[0].newVersion, ">=0.7.0 <0.8");
      assert.match(changes[0].reason, /No in-range fix exists/);
    });

    it("does not flag a routine in-range bump", () => {
      const changes = computeOverrideChanges({}, [vuln("lodash", "4.17.20", "4.17.21")], new Set(["lodash"]));
      assert.equal(changes[0].noInRangeFix, false);
      assert.doesNotMatch(changes[0].reason, /No in-range fix/);
    });

    it("flags on update, not just add", () => {
      const changes = computeOverrideChanges(
        { react: ">=18.1.0 <19" },
        [vuln("react", "18.2.0", "19.0.0")],
        new Set(["react"]),
      );
      assert.equal(changes[0].action, "update");
      assert.equal(changes[0].noInRangeFix, true);
    });
  });

  it("handles a mixed batch without cross-contaminating flags", () => {
    const changes = computeOverrideChanges(
      { tar: ">=6.2.1 <7" },
      [vuln("react", "18.2.0", "19.0.0"), vuln("lodash", "4.17.20", "4.17.21")],
      new Set(["react", "lodash", "tar"]),
    );
    const byName = Object.fromEntries(changes.map((c) => [c.packageName, c]));
    assert.equal(byName.react.noInRangeFix, true);
    assert.equal(byName.lodash.noInRangeFix, false);
    assert.equal(byName.tar.action, "remove");
    assert.equal(changes.filter((c) => c.noInRangeFix).length, 1);
  });
});
