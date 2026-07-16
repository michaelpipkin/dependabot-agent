import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeOverrideChanges,
  findEscapingDependents,
  findMultiLineAdvisories,
  findVulnerableInstalls,
  groupAlertsByManifestDir,
  highestOverrideFloor,
  judgeOrphanedOverride,
  overrideFloor,
} from "../src/reconcile.js";
import * as path from "node:path";
import {
  AlertRange,
  DependabotAlert,
  DependentRange,
  InstalledTree,
  VulnerablePackage,
} from "../src/types.js";

function vuln(
  name: string,
  installed: string | string[],
  patchedVersion: string,
  alertRanges: AlertRange[] = [],
): VulnerablePackage {
  return {
    name,
    installedVersions: Array.isArray(installed) ? installed : [installed],
    patchedVersion,
    severity: "high",
    scope: "unknown",
    foundInParents: [],
    alertNumber: 1,
    alertRanges,
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
    // patchedVersion is the flat max — the detection threshold and the fallback
    // when scoping doesn't apply. The override actually written is now per-line
    // scoped (see the scoped-override test below); this pins the merged max that
    // still drives detection.
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

  it("records every alert's range, so the multi-line case is detectable downstream", () => {
    // Closes the loop from raw payload to finding: mergeAlert used to discard
    // vulnerable_version_range, which is why the condition was undetectable.
    const pkgs = findVulnerableInstalls([jsYamlAlert(1, 0), jsYamlAlert(2, 1)], jsYamlTree);
    assert.deepEqual(pkgs[0].alertRanges, [
      { range: "< 3.14.2", patch: "3.14.2" },
      { range: ">= 4.0.0, < 4.1.1", patch: "4.1.1" },
    ]);

    const found = findMultiLineAdvisories(pkgs);
    assert.equal(found.length, 1);
    assert.equal(found[0].chosenPatch, "4.1.1");
    assert.equal(found[0].lowestClearing, "3.14.2");
  });

  it("keeps every range even when the losing alert arrives second", () => {
    // The 4.1.1 alert wins the max; the 3.14.2 range must survive the merge
    // regardless of order, or the detector sees only one line.
    const pkgs = findVulnerableInstalls([jsYamlAlert(2, 1), jsYamlAlert(1, 0)], jsYamlTree);
    assert.equal(pkgs[0].alertRanges.length, 2);
    assert.equal(findMultiLineAdvisories(pkgs)[0].lowestClearing, "3.14.2");
  });

  it("splits the two-line case into scoped overrides — each consumer stays on its own line", () => {
    // The whole point of issue #2: instead of forcing the 3.x consumer to 4.1.1,
    // write one bounded override per release line. 3.13.0 stays on 3.x (>=3.14.2),
    // 4.0.5 on 4.x (>=4.1.1) — neither crosses a major, neither is a no-in-range
    // fix. Proven end-to-end against the fixture repo.
    const pkgs = findVulnerableInstalls([jsYamlAlert(1, 0), jsYamlAlert(2, 1)], jsYamlTree);
    const changes = computeOverrideChanges({}, pkgs, new Set(["js-yaml"]));
    const byKey = Object.fromEntries(changes.map((c) => [c.packageName, c]));
    assert.deepEqual(Object.keys(byKey).sort(), ["js-yaml@3", "js-yaml@4"]);
    assert.equal(byKey["js-yaml@3"].newVersion, ">=3.14.2 <4");
    assert.equal(byKey["js-yaml@4"].newVersion, ">=4.1.1 <5");
    assert.equal(byKey["js-yaml@3"].noInRangeFix, false);
    assert.equal(byKey["js-yaml@4"].noInRangeFix, false);
    // No flat js-yaml override is written.
    assert.equal(byKey["js-yaml"], undefined);
  });
});

describe("findMultiLineAdvisories", () => {
  // Every fixture below is a REAL alert group from michaelpipkin/pip-cost-sharing,
  // retrieved with `gh api .../dependabot/alerts` with `state` unfiltered. The
  // agent fetches ?state=open, which is the only reason this condition looked
  // hypothetical: it fired five times across ten months and reported nothing.
  const line = (range: string, patch: string): AlertRange => ({ range, patch });

  it("catches the two-line js-yaml case — GHSA-mh29-5h37-fv8m, 2025-11-18", () => {
    // functions/pnpm-lock.yaml, alerts #10 and #14. One advisory, one range per
    // release line. 3.14.2 clears both; the agent wrote 4.1.1.
    const found = findMultiLineAdvisories([
      vuln("js-yaml", ["3.13.0", "4.0.5"], "4.1.1", [
        line("< 3.14.2", "3.14.2"),
        line(">= 4.0.0, < 4.1.1", "4.1.1"),
      ]),
    ]);
    assert.equal(found.length, 1);
    assert.equal(found[0].packageName, "js-yaml");
    assert.equal(found[0].chosenPatch, "4.1.1");
    assert.equal(found[0].lowestClearing, "3.14.2");
    assert.deepEqual(
      found[0].lines.map((l) => l.patch),
      ["3.14.2", "4.1.1"],
    );
  });

  it("catches the '= V' shape — the real jws case, 2025-12-04", () => {
    const found = findMultiLineAdvisories([
      vuln("jws", ["3.2.2", "4.0.0"], "4.0.1", [line("< 3.2.3", "3.2.3"), line("= 4.0.0", "4.0.1")]),
    ]);
    assert.equal(found[0].lowestClearing, "3.2.3");
    assert.equal(found[0].chosenPatch, "4.0.1");
  });

  it("catches a pre-release lower bound — the real ajv case, 2026-02-20", () => {
    const found = findMultiLineAdvisories([
      vuln("ajv", ["6.12.0", "8.0.0"], "8.18.0", [
        line("< 6.14.0", "6.14.0"),
        line(">= 7.0.0-alpha.0, < 8.18.0", "8.18.0"),
      ]),
    ]);
    assert.equal(found[0].lowestClearing, "6.14.0");
  });

  it("catches the worst real case — minimatch spanning seven majors, 2026-02-27", () => {
    // functions/pnpm-lock.yaml. 3.1.4 clears all three ranges; the agent forced
    // the 3.x consumer to 10.2.3.
    const found = findMultiLineAdvisories([
      vuln("minimatch", ["3.0.4", "9.0.5", "10.0.1"], "10.2.3", [
        line("< 3.1.4", "3.1.4"),
        line(">= 9.0.0, < 9.0.7", "9.0.7"),
        line(">= 10.0.0, < 10.2.3", "10.2.3"),
      ]),
    ]);
    assert.equal(found[0].lowestClearing, "3.1.4");
    assert.equal(found[0].chosenPatch, "10.2.3");
    assert.equal(found[0].lines.length, 3);
  });

  it("stays silent when every range sits on one line — the real tar case", () => {
    // Seven nested advisories on 7.x, the shape that makes up most of the noise
    // in real data. Only 7.5.16 clears them all, so max IS the minimum and there
    // is nothing to say. This is the false-positive guard.
    const found = findMultiLineAdvisories([
      vuln("tar", ["6.2.1", "7.5.20"], "7.5.16", [
        line("<= 7.5.2", "7.5.3"),
        line("<= 7.5.3", "7.5.4"),
        line("< 7.5.7", "7.5.7"),
        line("< 7.5.8", "7.5.8"),
        line("<= 7.5.9", "7.5.10"),
        line("<= 7.5.10", "7.5.11"),
        line("<= 7.5.15", "7.5.16"),
      ]),
    ]);
    assert.deepEqual(found, []);
  });

  it("stays silent for a single alert — the real @babel/core case", () => {
    const found = findMultiLineAdvisories([
      vuln("@babel/core", ["7.29.0"], "7.29.6", [line("<= 7.29.0", "7.29.6")]),
    ]);
    assert.deepEqual(found, []);
  });

  it("collapses duplicate ranges — one alert per vulnerable copy, one line", () => {
    // The real minimatch group carried 7 alerts over 4 distinct ranges; repeating
    // a range in the report would say nothing.
    const found = findMultiLineAdvisories([
      vuln("js-yaml", ["3.13.0", "4.0.5"], "4.1.1", [
        line("< 3.14.2", "3.14.2"),
        line(">= 4.0.0, < 4.1.1", "4.1.1"),
        line(">= 4.0.0, < 4.1.1", "4.1.1"),
      ]),
    ]);
    assert.equal(found[0].lines.length, 2);
  });

  it("stays silent rather than guessing when a range is unparseable", () => {
    const found = findMultiLineAdvisories([
      vuln("mystery", ["1.0.0"], "2.0.0", [line("< 1.5.0", "1.5.0"), line("^2.0.0", "2.0.0")]),
    ]);
    assert.deepEqual(found, []);
  });

  it("reports nothing for a package with no alert ranges recorded", () => {
    assert.deepEqual(findMultiLineAdvisories([vuln("lodash", "4.17.20", "4.17.21")]), []);
  });
});

describe("computeOverrideChanges — scoped overrides for multi-line advisories", () => {
  const line = (range: string, patch: string): AlertRange => ({ range, patch });

  // The fixture's real state: js-yaml carries TWO multi-line advisories at once —
  // GHSA-mh29 (< 3.14.2 → 3.14.2, >= 4.0.0, < 4.1.1 → 4.1.1) and GHSA-h67p
  // (< 3.15.0 → 3.15.0, >= 4.0.0, <= 4.1.1 → 4.2.0). Copies 3.14.1 and 4.1.0 are
  // installed; the flat max is 4.2.0. Proven end-to-end against the fixture repo.
  const jsYamlTwoAdvisories = (): VulnerablePackage =>
    vuln("js-yaml", ["3.14.1", "4.1.0"], "4.2.0", [
      line("< 3.14.2", "3.14.2"),
      line("< 3.15.0", "3.15.0"),
      line(">= 4.0.0, < 4.1.1", "4.1.1"),
      line(">= 4.0.0, <= 4.1.1", "4.2.0"),
    ]);

  it("falls back to flat when a vulnerable copy sits below the lowest scoped major — issue #4", () => {
    // Installed copies span 2.x/3.x/4.x; the "< 3.14.2" line covers the 2.5.0 copy,
    // but a js-yaml@3 selector wouldn't match it. Scoping would leave 2.5.0
    // unpatched and unflagged, so the agent uses the flat override (which covers
    // every copy) and reports the escape.
    const pkg = vuln("js-yaml", ["2.5.0", "3.13.0", "4.0.5"], "4.1.1", [
      line("< 3.14.2", "3.14.2"),
      line(">= 4.0.0, < 4.1.1", "4.1.1"),
    ]);
    const changes = computeOverrideChanges({}, [pkg], new Set(["js-yaml"]));
    assert.deepEqual(
      changes.map((c) => c.packageName),
      ["js-yaml"],
    ); // flat, not js-yaml@3 / js-yaml@4
    assert.equal(changes[0].noInRangeFix, true);
    assert.ok(changes[0].escapingVersions?.includes("2.5.0"));
  });

  it("still scopes when the same advisory has no sub-major copy", () => {
    // Same lines, but only 3.x/4.x installed → scoped as normal (the #4 guard is
    // specific to a copy below the lowest scoped major).
    const pkg = vuln("js-yaml", ["3.13.0", "4.0.5"], "4.1.1", [
      line("< 3.14.2", "3.14.2"),
      line(">= 4.0.0, < 4.1.1", "4.1.1"),
    ]);
    const keys = computeOverrideChanges({}, [pkg], new Set(["js-yaml"])).map((c) => c.packageName);
    assert.deepEqual(keys.sort(), ["js-yaml@3", "js-yaml@4"]);
  });

  it("writes one bounded override per major, collapsing two advisories on each line", () => {
    const changes = computeOverrideChanges({}, [jsYamlTwoAdvisories()], new Set(["js-yaml"]));
    const byKey = Object.fromEntries(changes.map((c) => [c.packageName, c]));
    assert.deepEqual(Object.keys(byKey).sort(), ["js-yaml@3", "js-yaml@4"]);
    // 3.x needs the higher of 3.14.2/3.15.0; 4.x the higher of 4.1.1/4.2.0.
    assert.equal(byKey["js-yaml@3"].newVersion, ">=3.15.0 <4");
    assert.equal(byKey["js-yaml@4"].newVersion, ">=4.2.0 <5");
    assert.equal(byKey["js-yaml@3"].noInRangeFix, false);
    assert.equal(byKey["js-yaml@4"].noInRangeFix, false);
  });

  it("replaces a pre-existing flat override with the scoped set", () => {
    const changes = computeOverrideChanges({ "js-yaml": ">=4.2.0 <5" }, [jsYamlTwoAdvisories()], new Set(["js-yaml"]));
    const byKey = Object.fromEntries(changes.map((c) => [c.packageName, c]));
    assert.equal(byKey["js-yaml@3"].action, "add");
    assert.equal(byKey["js-yaml@4"].action, "add");
    assert.equal(byKey["js-yaml"].action, "remove");
  });

  it("is idempotent — no changes when the scoped keys are already correct", () => {
    const changes = computeOverrideChanges(
      { "js-yaml@3": ">=3.15.0 <4", "js-yaml@4": ">=4.2.0 <5" },
      [jsYamlTwoAdvisories()],
      new Set(["js-yaml"]),
    );
    assert.deepEqual(changes, []);
  });

  it("stays scoped when the installed copies are already patched — the re-run case", () => {
    // Regression guard: on a second run the overrides are applied, so the tree
    // holds the PATCHED copies (3.15.0, 4.3.0), not the vulnerable ones. Keying
    // the line detection off installed versions made scoping find nothing and
    // revert to the flat max — un-writing its own fix. The lines come from the
    // advisory ranges, which persist, so the scoped specs are unchanged.
    const patchedTree = vuln("js-yaml", ["3.15.0", "4.3.0"], "4.2.0", [
      line("< 3.14.2", "3.14.2"),
      line("< 3.15.0", "3.15.0"),
      line(">= 4.0.0, < 4.1.1", "4.1.1"),
      line(">= 4.0.0, <= 4.1.1", "4.2.0"),
    ]);
    const changes = computeOverrideChanges(
      { "js-yaml@3": ">=3.15.0 <4", "js-yaml@4": ">=4.2.0 <5" },
      [patchedTree],
      new Set(["js-yaml"]),
    );
    // Already correct → no churn. And crucially, no flat "js-yaml" add/remove.
    assert.deepEqual(changes, []);
  });

  it("removes scoped keys once the vulnerability resolves", () => {
    // js-yaml no longer vulnerable (absent from stillVulnerable) but resolved in
    // this group — its scoped keys must be cleaned up, matched by base name.
    const changes = computeOverrideChanges(
      { "js-yaml@3": ">=3.15.0 <4", "js-yaml@4": ">=4.2.0 <5" },
      [],
      new Set(["js-yaml"]),
    );
    assert.deepEqual(
      changes.map((c) => [c.packageName, c.action]).sort(),
      [
        ["js-yaml@3", "remove"],
        ["js-yaml@4", "remove"],
      ],
    );
  });

  it("stays flat when copies sit on one major (same-major advisories) — the real tar case", () => {
    // tar's seven advisories are all on the 7.x line; 7.5.16 clears them all, so
    // it is NOT multi-line. The 6.2.1 copy still escapes (6.x → 7.x), flagged flat
    // as no-in-range-fix. Must not be scoped.
    const tar = vuln("tar", ["6.2.1", "7.5.20"], "7.5.16", [
      line("<= 7.5.2", "7.5.3"),
      line("<= 7.5.15", "7.5.16"),
    ]);
    const changes = computeOverrideChanges({}, [tar], new Set(["tar"]));
    assert.equal(changes.length, 1);
    assert.equal(changes[0].packageName, "tar");
    assert.equal(changes[0].newVersion, ">=7.5.16 <8");
    assert.deepEqual(changes[0].escapingVersions, ["6.2.1"]);
  });

  it("stays flat for a single-line package", () => {
    const changes = computeOverrideChanges({}, [vuln("lodash", "4.17.20", "4.17.21", [line("< 4.17.21", "4.17.21")])], new Set(["lodash"]));
    assert.equal(changes.length, 1);
    assert.equal(changes[0].packageName, "lodash");
    assert.equal(changes[0].newVersion, ">=4.17.21 <5");
  });

  it("stays flat for a 0.x package — name@0 would be too broad", () => {
    // Disjoint 0.x lines exist, but a "pkg@0" selector matches all of 0.x. Bail to
    // flat + keep the report warning rather than emit a wrong selector.
    const changes = computeOverrideChanges(
      {},
      [vuln("zero-pkg", ["0.5.1", "0.7.2"], "0.8.0", [line("< 0.6.0", "0.6.0"), line(">= 0.7.0, < 0.8.0", "0.8.0")])],
      new Set(["zero-pkg"]),
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].packageName, "zero-pkg");
  });
});

describe("groupAlertsByManifestDir", () => {
  const root = path.resolve("/repo");
  const alertAt = (manifestPath: string): DependabotAlert =>
    ({ dependency: { manifest_path: manifestPath } }) as DependabotAlert;

  it("folds shared-lockfile workspace members into the root group", () => {
    // GitHub keys a member's direct-dep alert to packages/x/package.json, but a
    // member with no own lockfile isn't its own override target — overrides go in
    // the root pnpm-workspace.yaml. The whole workspace resolves as one group.
    const groups = groupAlertsByManifestDir(
      [
        alertAt("pnpm-lock.yaml"),
        alertAt("packages/consumer-old/package.json"),
        alertAt("packages/consumer-new/package.json"),
      ],
      root,
      [],
    );
    assert.deepEqual([...groups.keys()], [root]);
    assert.equal(groups.get(root)!.length, 3);
  });

  it("keeps a genuinely isolated package (own lockfile) as its own group", () => {
    // functions/ has its own lockfile, so it is passed in extraDirs and owns its
    // overrides — its alerts must NOT fold into the root.
    const functionsDir = path.join(root, "functions");
    const groups = groupAlertsByManifestDir(
      [alertAt("pnpm-lock.yaml"), alertAt("functions/pnpm-lock.yaml")],
      root,
      [functionsDir],
    );
    assert.equal(groups.get(root)!.length, 1);
    assert.equal(groups.get(functionsDir)!.length, 1);
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

describe("judgeOrphanedOverride", () => {
  const dep = (
    dependent: string,
    version: string,
    installedRange: string | null,
    latestRange: string | null = installedRange,
    latestKnown = true,
  ): DependentRange => ({ dependent, version, installedRange, latestRange, latestKnown });

  it("removes when every latest upstream range now requests a safe version — the debug/ms case", () => {
    // Proven live: debug@2.0.0 pulls ms 0.6.2, an override forces ms >=2.0.0, and
    // debug@latest declares ms ^2.1.3 — upstream moved on, so the override is dead.
    const verdict = judgeOrphanedOverride([dep("debug", "2.0.0", "0.6.2", "^2.1.3")], "2.0.0", "2.1.3", "latest");
    assert.equal(verdict.action, "remove");
  });

  it("keeps (load-bearing) when a latest range could still resolve below the floor", () => {
    // debug@latest still asks ^1.0.0 for ms; without the >=2.0.0 override a stale
    // consumer could resolve 1.x. The forced 2.1.3 is inside ^2.0.0, so no escape.
    const verdict = judgeOrphanedOverride([dep("debug", "2.0.0", "^2.0.0", "^1.0.0")], "2.0.0", "2.1.3", "latest");
    assert.equal(verdict.action, "keep-load-bearing");
  });

  it("keeps conservatively when the registry yields no latest range (dropped or unpublished)", () => {
    // A dependent whose latest dropped the dep (or is unpublished) gives no data —
    // never infer 'safe to remove' from silence.
    const verdict = judgeOrphanedOverride([dep("local-pkg", "1.0.0", "^1.0.0", null)], "2.0.0", "2.1.3", "latest");
    assert.equal(verdict.action, "keep-no-data");
  });

  it("flags an escape when load-bearing and the resolved version forces a dependent past its range", () => {
    // Latest still asks ^1.0.0 (load-bearing), and the override resolved 3.0.0 —
    // outside ^1.0.0, no in-range fix.
    const verdict = judgeOrphanedOverride([dep("debug", "2.0.0", "^1.0.0", "^1.0.0")], "2.0.0", "3.0.0", "latest");
    assert.equal(verdict.action, "escape");
    if (verdict.action === "escape") assert.equal(verdict.escaping.length, 1);
  });

  it("under `compatible`, keeps when the INSTALLED range could resolve vulnerable even if latest is safe", () => {
    // Review finding #2: a dependent pinned at an old version can't reach its safe
    // latest under `compatible` (no major crossing), so removing on latest alone
    // reintroduces the CVE. debug@2.0.0 declares ms 0.6.2 (vulnerable), latest wants
    // ^2.1.3 (safe). Under `latest` → remove; under `compatible` → keep.
    const dependents = [dep("debug", "2.0.0", "0.6.2", "^2.1.3")];
    assert.equal(judgeOrphanedOverride(dependents, "2.0.0", "2.1.3", "latest").action, "remove");
    assert.notEqual(judgeOrphanedOverride(dependents, "2.0.0", "2.1.3", "compatible").action, "remove");
  });

  it("under `compatible`, still removes when installed and latest are both safe", () => {
    // No regression: aging-out still works when nothing lags.
    const dependents = [dep("debug", "3.0.0", "^2.1.3", "^2.1.3")];
    assert.equal(judgeOrphanedOverride(dependents, "2.0.0", "2.1.3", "compatible").action, "remove");
  });
});

describe("highestOverrideFloor — issue #1 (scoped-key removal threshold)", () => {
  const dep = (
    dependent: string,
    version: string,
    installedRange: string | null,
    latestRange: string | null = installedRange,
    latestKnown = true,
  ): DependentRange => ({ dependent, version, installedRange, latestRange, latestKnown });

  it("returns the highest floor across a package's scoped specs", () => {
    // The bug: collapsing to the LOWEST floor removed a scoped set while a higher
    // line was still load-bearing. The highest floor is the conservative choice.
    assert.equal(highestOverrideFloor([">=3.14.2 <4", ">=4.1.1 <5"]), "4.1.1");
    assert.equal(highestOverrideFloor([">=4.1.1 <5", ">=3.14.2 <4"]), "4.1.1");
    assert.equal(highestOverrideFloor([">=11.1.1"]), "11.1.1");
  });

  it("keeps a scoped set when a higher line's dependent is still load-bearing", () => {
    // The end-to-end #1 guard: js-yaml@3 (>=3.14.2) + js-yaml@4 (>=4.1.1) as an
    // orphan, a dependent's latest is ^4.0.0 → could resolve 4.0.x < 4.1.1. Judged
    // against the highest floor (4.1.1) it is KEPT; against the old lowest (3.14.2)
    // it was wrongly removed, reintroducing the 4.x CVE.
    const floor = highestOverrideFloor([">=3.14.2 <4", ">=4.1.1 <5"]);
    const dependents = [dep("some-dep", "1.0.0", "^4.0.0", "^4.0.0")];
    assert.notEqual(judgeOrphanedOverride(dependents, floor, "4.3.0", "latest").action, "remove");
    // Discrimination: the old lowest-floor behaviour DID remove it (the CVE bug).
    assert.equal(judgeOrphanedOverride(dependents, "3.14.2", "4.3.0", "latest").action, "remove");
  });
});
