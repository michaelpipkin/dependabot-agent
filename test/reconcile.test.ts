import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeOverrideChanges, findEscapingRanges, overrideFloor } from "../src/reconcile.js";
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

  it("flags escapes on both add and update paths without cross-contamination", () => {
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

describe("overrideFloor", () => {
  it("reads the floor off bounded and unbounded specs alike", () => {
    assert.equal(overrideFloor(">=7.29.6 <8"), "7.29.6");
    assert.equal(overrideFloor(">=11.1.1"), "11.1.1");
    assert.equal(overrideFloor(">=0.7.0 <0.8"), "0.7.0");
    assert.equal(overrideFloor("1.2.3"), "1.2.3");
  });
});

describe("findEscapingRanges", () => {
  // Fixtures are the real overrides from a pip-cost-sharing dry run. Before the
  // orphan path checked for escapes, all six reported identically as routine
  // "still load-bearing" lines.
  it("names the escaped range when an override forces dependents past a major", () => {
    assert.deepEqual(findEscapingRanges(">=11.1.1", ["^7.0.3"]), ["^7.0.3"]);
    assert.deepEqual(findEscapingRanges(">=11.1.1", ["^8.3.2"]), ["^8.3.2"]);
    assert.deepEqual(findEscapingRanges(">=4.2.0", ["^3.13.1"]), ["^3.13.1"]);
  });

  it("stays quiet on overrides that sit inside what dependents ask for", () => {
    // tar: floor 7.5.16 is inside ^7.5.3 / ^7.5.4 / ^7.4.3.
    assert.deepEqual(findEscapingRanges(">=7.5.16", ["^7.5.3", "^7.5.4", "^7.4.3"]), []);
    // @babel/core: floor 7.29.6 is inside ^8.0.0's predecessor ranges and below 8.
    assert.deepEqual(findEscapingRanges(">=7.29.6 <8", ["7.29.0", "7.29.7", "^8.0.0"]), []);
    // esbuild: floor 0.28.1 is inside the 0.28 line.
    assert.deepEqual(findEscapingRanges(">=0.28.1", ["0.28.1"]), []);
  });

  it("skips ranges it cannot parse rather than guessing", () => {
    // Compound ranges yield null from parseSemver; only provable escapes get named.
    assert.deepEqual(findEscapingRanges(">=0.28.1", ["^0.27.0 || ^0.28.0"]), []);
    assert.deepEqual(findEscapingRanges(">=11.1.1", ["*"]), []);
  });

  it("returns only the ranges that actually escape, not the whole set", () => {
    const escaping = findEscapingRanges(">=11.1.1", ["^7.0.3", "^11.0.0", "^12.0.0"]);
    assert.deepEqual(escaping, ["^7.0.3"]);
  });

  it("catches a 0.x escape in the orphan path too", () => {
    // The 0.x boundary applies here identically: ^0.5.0 is >=0.5.0 <0.6.0.
    assert.deepEqual(findEscapingRanges(">=0.7.0 <0.8", ["^0.5.0"]), ["^0.5.0"]);
    assert.deepEqual(findEscapingRanges(">=0.5.2 <0.6", ["^0.5.0"]), []);
  });
});
