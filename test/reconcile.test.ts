import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeOverrideChanges,
  findEscapingDependents,
  findVulnerableInstalls,
  overrideFloor,
} from "../src/reconcile.js";
import { DependabotAlert, DependentRange, InstalledTree, VulnerablePackage } from "../src/types.js";

function vuln(name: string, installed: string | string[], patchedVersion: string): VulnerablePackage {
  return {
    name,
    installedVersions: Array.isArray(installed) ? installed : [installed],
    patchedVersion,
    severity: "high",
    scope: "unknown",
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
      assert.deepEqual(changes[0].escapingVersions, ["18.2.0"]);
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

  describe("trees holding several copies of a package", () => {
    // Regression guards for the first real-alert run against pip-cost-sharing.
    // Both tar and esbuild had a vulnerable copy AND a safe copy installed; the
    // old code looked up one version by name, landed on the safe copy, and
    // silently reported no escape.
    it("flags when only the LOWER of two copies escapes — the tar case", () => {
      // tar 6.2.1 (via @capacitor/assets) + tar 7.5.20 (via @capacitor/cli),
      // patched 7.5.16. Looking at 7.5.20 alone says "in range". 6.2.1 escapes.
      const changes = computeOverrideChanges({}, [vuln("tar", ["6.2.1", "7.5.20"], "7.5.16")], new Set(["tar"]));
      assert.equal(changes[0].noInRangeFix, true);
      assert.deepEqual(changes[0].escapingVersions, ["6.2.1"]);
    });

    it("flags a 0.x escape hidden behind a safe copy — the esbuild case", () => {
      // esbuild 0.27.7 (via vite@7.3.5, which declares ^0.27.0) + 0.28.1.
      const changes = computeOverrideChanges({}, [vuln("esbuild", ["0.27.7", "0.28.1"], "0.28.1")], new Set(["esbuild"]));
      assert.equal(changes[0].noInRangeFix, true);
      assert.deepEqual(changes[0].escapingVersions, ["0.27.7"]);
    });

    it("bounds against the HIGHEST copy so the ceiling can't exclude a safe one", () => {
      // Anchoring on 6.2.1 would emit "<7" and exclude the installed 7.5.20.
      const changes = computeOverrideChanges({}, [vuln("tar", ["6.2.1", "7.5.20"], "7.5.16")], new Set(["tar"]));
      assert.equal(changes[0].newVersion, ">=7.5.16 <8");
    });

    it("does not flag when every copy is in range", () => {
      const changes = computeOverrideChanges({}, [vuln("@babel/core", ["7.29.0", "7.29.7"], "7.29.6")], new Set(["@babel/core"]));
      assert.equal(changes[0].noInRangeFix, false);
      assert.deepEqual(changes[0].escapingVersions, []);
    });

    it("reports every escaping copy when they all escape", () => {
      // uuid 7.0.3 + 9.0.1, patched 11.1.1 — both escape.
      const changes = computeOverrideChanges({}, [vuln("uuid", ["7.0.3", "9.0.1"], "11.1.1")], new Set(["uuid"]));
      assert.deepEqual(changes[0].escapingVersions, ["7.0.3", "9.0.1"]);
      assert.equal(changes[0].newVersion, ">=11.1.1 <12");
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

describe("findVulnerableInstalls", () => {
  // The multi-line advisory case from issue #2. GHSA-mh29-5h37-fv8m is ONE
  // js-yaml advisory carrying one vulnerable range per release line, each with
  // its own patch — so "the patched version" is not a single number. GitHub
  // repeats the whole vulnerabilities[] on every alert it raises from the
  // advisory and sets security_vulnerability to the one range that matched.
  const jsYamlVulns = [
    {
      package: { ecosystem: "npm", name: "js-yaml" },
      vulnerable_version_range: "< 3.14.2",
      first_patched_version: { identifier: "3.14.2" },
    },
    {
      package: { ecosystem: "npm", name: "js-yaml" },
      vulnerable_version_range: ">= 4.0.0, < 4.1.1",
      first_patched_version: { identifier: "4.1.1" },
    },
  ];

  /** An alert raised off the 3.x line (matched 0) or the 4.x line (matched 1). */
  const jsYamlAlert = (number: number, matched: 0 | 1): DependabotAlert => ({
    number,
    state: "open",
    dependency: {
      package: { ecosystem: "npm", name: "js-yaml" },
      manifest_path: "package.json",
      scope: "runtime",
    },
    security_advisory: {
      summary: "js-yaml prototype pollution",
      severity: "high",
      vulnerabilities: jsYamlVulns,
    },
    security_vulnerability: jsYamlVulns[matched],
  });

  // Vulnerable on both lines at once: 3.13.0 is inside "< 3.14.2", and 4.0.5 is
  // inside ">= 4.0.0, < 4.1.1". 3.14.2 clears both.
  const jsYamlTree: InstalledTree[] = [
    {
      name: "root",
      version: "1.0.0",
      path: ".",
      dependencies: {
        "old-consumer": {
          name: "old-consumer",
          version: "1.0.0",
          dependencies: { "js-yaml": { name: "js-yaml", version: "3.13.0" } },
        },
        "new-consumer": {
          name: "new-consumer",
          version: "2.0.0",
          dependencies: { "js-yaml": { name: "js-yaml", version: "4.0.5" } },
        },
      },
    },
  ];

  it("takes the highest patch when alerts span two release lines", () => {
    // 3.14.2 would clear both ranges, so the max drags the 3.x consumer across
    // a major no advisory demands. That cost is accepted deliberately: see the
    // mergeAlert comment, and the mechanism pinned in semver.test.ts. The max is
    // the only choice that can't leave a vulnerable copy installed in silence.
    const pkgs = findVulnerableInstalls([jsYamlAlert(1, 0), jsYamlAlert(2, 1)], jsYamlTree);
    assert.equal(pkgs.length, 1);
    assert.equal(pkgs[0].patchedVersion, "4.1.1");
    assert.deepEqual(pkgs[0].installedVersions, ["3.13.0", "4.0.5"]);
  });

  it("takes the highest patch regardless of the order alerts arrive in", () => {
    // mergeAlert only replaces on a strictly-greater patch, so the incumbent
    // wins ties — which makes it worth proving the result isn't order-dependent.
    const pkgs = findVulnerableInstalls([jsYamlAlert(2, 1), jsYamlAlert(1, 0)], jsYamlTree);
    assert.equal(pkgs[0].patchedVersion, "4.1.1");
  });

  it("reports the major bump the two-line case forces rather than applying it silently", () => {
    // The end of the path that matters: the 3.x consumer really is dragged to
    // 4.x, and it is named as a no-in-range fix instead of slipping through.
    const pkgs = findVulnerableInstalls([jsYamlAlert(1, 0), jsYamlAlert(2, 1)], jsYamlTree);
    const changes = computeOverrideChanges({}, pkgs, new Set(["js-yaml"]));
    assert.equal(changes[0].newVersion, ">=4.1.1 <5");
    assert.equal(changes[0].noInRangeFix, true);
    assert.deepEqual(changes[0].escapingVersions, ["3.13.0"]);
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
    latestKnown = true,
  ): DependentRange => ({ dependent, version, installedRange, latestRange, latestKnown });

  it("names the dependent and range when an override forces past a major", () => {
    const escaping = findEscapingDependents("11.1.1", [dep("some-pkg", "1.2.3", "^7.0.3")]);
    assert.deepEqual(escaping, [
      { name: "some-pkg", version: "1.2.3", range: "^7.0.3", source: "installed", fixedByUpdate: false },
    ]);
  });

  it("judges against the INSTALLED range, not the latest", () => {
    // The whole point of the version-accurate fetch: an old installed dependent
    // asking ^7.0.3 escapes, even though the latest release moved to ^11.0.0
    // and would look clean.
    const escaping = findEscapingDependents("11.1.1", [dep("some-pkg", "1.2.3", "^7.0.3", "^11.0.0")]);
    assert.equal(escaping.length, 1);
    assert.equal(escaping[0].range, "^7.0.3");
    assert.equal(escaping[0].source, "installed");
  });

  it("does not flag when the installed range accepts the version but latest would not", () => {
    // Mirror of the above: latest regressed to ^7, installed is fine. Reading
    // latest here would be a false positive.
    assert.deepEqual(findEscapingDependents("11.1.1", [dep("some-pkg", "9.0.0", "^11.0.0", "^7.0.3")]), []);
  });

  it("falls back to the latest range when the installed one is unresolvable", () => {
    const escaping = findEscapingDependents("11.1.1", [dep("gone", "1.0.0", null, "^7.0.3")]);
    assert.equal(escaping.length, 1);
    assert.equal(escaping[0].source, "latest");
  });

  it("stays quiet on overrides that sit inside what dependents ask for", () => {
    assert.deepEqual(findEscapingDependents("7.5.16", [dep("a", "1.0.0", "^7.5.3"), dep("b", "2.0.0", "^7.4.3")]), []);
    assert.deepEqual(findEscapingDependents("7.29.6", [dep("a", "1.0.0", "7.29.0"), dep("b", "1.0.0", "^8.0.0")]), []);
  });

  it("skips ranges it cannot parse rather than guessing", () => {
    assert.deepEqual(findEscapingDependents("0.28.1", [dep("a", "1.0.0", "^0.27.0 || ^0.28.0")]), []);
    assert.deepEqual(findEscapingDependents("11.1.1", [dep("a", "1.0.0", "*")]), []);
    assert.deepEqual(findEscapingDependents("11.1.1", [dep("a", "1.0.0", null, null)]), []);
  });

  it("returns only the dependents that actually escape, not the whole set", () => {
    const escaping = findEscapingDependents("11.1.1", [
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
    assert.equal(findEscapingDependents("0.7.0", [dep("a", "1.0.0", "^0.5.0")]).length, 1);
    assert.deepEqual(findEscapingDependents("0.5.2", [dep("a", "1.0.0", "^0.5.0")]), []);
  });

  it("distinguishes two copies of the same dependent at different versions", () => {
    const escaping = findEscapingDependents("11.1.1", [dep("dup", "1.0.0", "^7.0.3"), dep("dup", "5.0.0", "^11.0.0")]);
    assert.deepEqual(
      escaping.map((e) => `${e.name}@${e.version}`),
      ["dup@1.0.0"],
    );
  });

  describe("judging by the resolved version rather than the spec floor", () => {
    it("catches an escape the floor would miss when an unbounded spec drifts", () => {
      // ">=0.28.1" unbounded, dependent declares ^0.28.0. The floor sits INSIDE
      // that range, so judging by floor reports nothing — but the tree actually
      // resolved 0.29.5, which escapes.
      assert.deepEqual(findEscapingDependents("0.28.1", [dep("vite", "7.3.5", "^0.28.0")]), []);
      const escaping = findEscapingDependents("0.29.5", [dep("vite", "7.3.5", "^0.28.0")]);
      assert.equal(escaping.length, 1);
      assert.equal(escaping[0].range, "^0.28.0");
    });

    it("reports the real severity for a drifted 0.x override", () => {
      // The live pip-cost-sharing case: ">=4.2.0" resolved to 5.0.0.
      assert.equal(findEscapingDependents("5.0.0", [dep("@istanbuljs/load-nyc-config", "1.1.0", "^3.13.1")]).length, 1);
    });
  });

  describe("fixedByUpdate", () => {
    it("marks a stale dependent whose own latest accepts the forced version", () => {
      // vite@7.3.5 asks ^0.27.0; vite@8 asks "^0.27.0 || ^0.28.0" — unparseable,
      // so not provable. Use a clean single range to pin the semantics.
      const escaping = findEscapingDependents("7.5.16", [dep("@capacitor/cli", "5.7.8", "^6.1.11", "^7.5.3")]);
      assert.equal(escaping.length, 1);
      assert.equal(escaping[0].fixedByUpdate, true);
    });

    it("does not mark a dependent that is stuck at its latest", () => {
      // xcode@3.0.1 IS latest and still asks ^7.0.3 — no upstream fix exists.
      const escaping = findEscapingDependents("11.1.1", [dep("xcode", "3.0.1", "^7.0.3", "^7.0.3")]);
      assert.equal(escaping[0].fixedByUpdate, false);
    });

    it("marks a dependent whose latest dropped the dependency entirely", () => {
      // gaxios@6.7.1 declares uuid ^9.0.1; gaxios@7 dropped uuid altogether, so
      // moving off 6.7.1 stops it being a dependent at all. latestKnown true +
      // latestRange null is what that looks like.
      const escaping = findEscapingDependents("11.1.1", [dep("gaxios", "6.7.1", "^9.0.1", null, true)]);
      assert.equal(escaping[0].fixedByUpdate, true);
    });

    it("does not guess when the latest manifest could not be read", () => {
      // Same null latestRange, but latestKnown false — we learned nothing, so
      // claim nothing rather than promising a fix that may not exist.
      const escaping = findEscapingDependents("11.1.1", [dep("private-pkg", "1.0.0", "^9.0.1", null, false)]);
      assert.equal(escaping[0].fixedByUpdate, false);
    });
  });
});
