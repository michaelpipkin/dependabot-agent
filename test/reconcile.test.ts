import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeOverrideChanges, findEscapingDependents, overrideFloor } from "../src/reconcile.js";
import { DependentRange, VulnerablePackage } from "../src/types.js";

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

describe("findEscapingDependents", () => {
  // Fixtures are the real overrides from a pip-cost-sharing dry run. Before the
  // orphan path checked for escapes, all six reported identically as routine
  // "still load-bearing" lines.
  const dep = (
    dependent: string,
    version: string,
    installedRange: string | null,
    latestRange: string | null = installedRange,
  ): DependentRange => ({ dependent, version, installedRange, latestRange });

  it("names the dependent and range when an override forces past a major", () => {
    const escaping = findEscapingDependents(">=11.1.1", [dep("some-pkg", "1.2.3", "^7.0.3")]);
    assert.deepEqual(escaping, [{ name: "some-pkg", version: "1.2.3", range: "^7.0.3", source: "installed" }]);
  });

  it("judges against the INSTALLED range, not the latest", () => {
    // The whole point of the version-accurate fetch: an old installed dependent
    // asking ^7.0.3 escapes, even though the latest release moved to ^11.0.0
    // and would look clean.
    const escaping = findEscapingDependents(">=11.1.1", [dep("some-pkg", "1.2.3", "^7.0.3", "^11.0.0")]);
    assert.equal(escaping.length, 1);
    assert.equal(escaping[0].range, "^7.0.3");
    assert.equal(escaping[0].source, "installed");
  });

  it("does not flag when the installed range accepts the floor but latest would not", () => {
    // Mirror of the above: latest regressed to ^7, installed is fine. Reading
    // latest here would be a false positive.
    assert.deepEqual(findEscapingDependents(">=11.1.1", [dep("some-pkg", "9.0.0", "^11.0.0", "^7.0.3")]), []);
  });

  it("falls back to the latest range when the installed one is unresolvable", () => {
    const escaping = findEscapingDependents(">=11.1.1", [dep("gone", "1.0.0", null, "^7.0.3")]);
    assert.equal(escaping.length, 1);
    assert.equal(escaping[0].source, "latest");
  });

  it("stays quiet on overrides that sit inside what dependents ask for", () => {
    // tar: floor 7.5.16 is inside ^7.5.3 / ^7.5.4 / ^7.4.3.
    assert.deepEqual(
      findEscapingDependents(">=7.5.16", [dep("a", "1.0.0", "^7.5.3"), dep("b", "2.0.0", "^7.4.3")]),
      [],
    );
    // @babel/core: floor 7.29.6 is below 8 and inside the 7.29 line.
    assert.deepEqual(
      findEscapingDependents(">=7.29.6 <8", [dep("a", "1.0.0", "7.29.0"), dep("b", "1.0.0", "^8.0.0")]),
      [],
    );
  });

  it("skips ranges it cannot parse rather than guessing", () => {
    assert.deepEqual(findEscapingDependents(">=0.28.1", [dep("a", "1.0.0", "^0.27.0 || ^0.28.0")]), []);
    assert.deepEqual(findEscapingDependents(">=11.1.1", [dep("a", "1.0.0", "*")]), []);
    assert.deepEqual(findEscapingDependents(">=11.1.1", [dep("a", "1.0.0", null, null)]), []);
  });

  it("returns only the dependents that actually escape, not the whole set", () => {
    const escaping = findEscapingDependents(">=11.1.1", [
      dep("old", "1.0.0", "^7.0.3"),
      dep("current", "2.0.0", "^11.0.0"),
      dep("newer", "3.0.0", "^12.0.0"),
    ]);
    assert.deepEqual(
      escaping.map((e) => e.name),
      ["old"],
    );
  });

  it("catches a 0.x escape in the orphan path too", () => {
    // The 0.x boundary applies here identically: ^0.5.0 is >=0.5.0 <0.6.0.
    assert.equal(findEscapingDependents(">=0.7.0 <0.8", [dep("a", "1.0.0", "^0.5.0")]).length, 1);
    assert.deepEqual(findEscapingDependents(">=0.5.2 <0.6", [dep("a", "1.0.0", "^0.5.0")]), []);
  });

  it("distinguishes two copies of the same dependent at different versions", () => {
    const escaping = findEscapingDependents(">=11.1.1", [
      dep("dup", "1.0.0", "^7.0.3"),
      dep("dup", "5.0.0", "^11.0.0"),
    ]);
    assert.deepEqual(
      escaping.map((e) => `${e.name}@${e.version}`),
      ["dup@1.0.0"],
    );
  });
});
