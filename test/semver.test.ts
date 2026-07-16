import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareSemver,
  compatibleCeiling,
  computeBoundedSpec,
  escapesCompatibleRange,
  formatCeiling,
  lowestPatchClearingAll,
  parseSemver,
  rangeCouldResolveVulnerable,
  satisfiesVulnerableRange,
} from "../src/semver.js";

describe("parseSemver", () => {
  it("parses a plain version", () => {
    assert.deepEqual(parseSemver("1.2.3"), [1, 2, 3]);
  });

  it("strips range operators and surrounding space", () => {
    assert.deepEqual(parseSemver("^1.2.3"), [1, 2, 3]);
    assert.deepEqual(parseSemver("~1.2.3"), [1, 2, 3]);
    assert.deepEqual(parseSemver(">=1.2.3"), [1, 2, 3]);
    assert.deepEqual(parseSemver(">= 1.2.3"), [1, 2, 3]);
  });

  it("drops the pre-release suffix", () => {
    assert.deepEqual(parseSemver("1.2.3-beta.1"), [1, 2, 3]);
  });

  it("drops build metadata, which is ignored for precedence", () => {
    // Build metadata (+…) does not affect ordering, so 1.2.3+build IS 1.2.3.
    // Before this was stripped, the "3+build" segment failed the digit check
    // and the whole version parsed as null → callers went conservative.
    assert.deepEqual(parseSemver("1.2.3+build"), [1, 2, 3]);
    assert.deepEqual(parseSemver("1.2.3+build.5"), [1, 2, 3]);
    // Both suffixes at once, in spec order (pre-release then build).
    assert.deepEqual(parseSemver("1.2.3-rc.1+build"), [1, 2, 3]);
  });

  it("defaults missing positions to zero", () => {
    assert.deepEqual(parseSemver("1"), [1, 0, 0]);
    assert.deepEqual(parseSemver("1.2"), [1, 2, 0]);
  });

  it("returns null for anything it cannot parse, so callers stay conservative", () => {
    assert.equal(parseSemver("garbage"), null);
    assert.equal(parseSemver("1.x"), null);
    assert.equal(parseSemver(""), null);
  });
});

describe("compatibleCeiling", () => {
  // These encode npm's caret rules. The 0.x cases are the ones that matter:
  // getting them wrong classifies a breaking bump as routine.
  it("breaks at the major when major > 0", () => {
    assert.deepEqual(compatibleCeiling([1, 2, 3]), [2, 0, 0]);
    assert.deepEqual(compatibleCeiling([18, 2, 0]), [19, 0, 0]);
  });

  it("breaks at the MINOR for 0.x — ^0.2.3 is >=0.2.3 <0.3.0", () => {
    assert.deepEqual(compatibleCeiling([0, 2, 3]), [0, 3, 0]);
    assert.deepEqual(compatibleCeiling([0, 5, 0]), [0, 6, 0]);
  });

  it("breaks at the PATCH for 0.0.x — ^0.0.3 is >=0.0.3 <0.0.4", () => {
    assert.deepEqual(compatibleCeiling([0, 0, 3]), [0, 0, 4]);
  });
});

describe("formatCeiling", () => {
  it("renders the shortest valid bound", () => {
    assert.equal(formatCeiling([8, 0, 0]), "8");
    assert.equal(formatCeiling([0, 8, 0]), "0.8");
    assert.equal(formatCeiling([0, 0, 4]), "0.0.4");
  });
});

describe("escapesCompatibleRange", () => {
  it("flags a major bump", () => {
    // react-dom@18.2.0 declares peerDependencies react ^18.2.0; the override
    // forces react 19 and installs clean, so nothing else raises this.
    assert.equal(escapesCompatibleRange("19.0.0", "18.2.0"), true);
  });

  it("flags a 0.x MINOR bump — regression guard for CVE-2024-47764", () => {
    // express@4.18.2 pins cookie "0.5.0" exactly; the first patched cookie is
    // 0.7.0. The major never moves, so a major-only check reports this as a
    // routine change. It is not: ^0.5.0 is >=0.5.0 <0.6.0.
    assert.equal(escapesCompatibleRange("0.7.0", "0.5.0"), true);
  });

  it("flags a 0.0.x PATCH bump", () => {
    assert.equal(escapesCompatibleRange("0.0.5", "0.0.3"), true);
  });

  it("does not flag an in-range patch", () => {
    assert.equal(escapesCompatibleRange("4.17.21", "4.17.20"), false);
    assert.equal(escapesCompatibleRange("7.29.6", "7.29.0"), false);
  });

  it("does not flag an in-range 0.x patch", () => {
    // 0.5.0 -> 0.5.2 stays inside ^0.5.0.
    assert.equal(escapesCompatibleRange("0.5.2", "0.5.0"), false);
  });

  it("does not flag when the patch is at or below the installed version", () => {
    assert.equal(escapesCompatibleRange("18.0.0", "19.2.0"), false);
    assert.equal(escapesCompatibleRange("1.0.0", "1.0.0"), false);
  });

  it("does not flag what it cannot prove", () => {
    assert.equal(escapesCompatibleRange("19.0.0", undefined), false);
    assert.equal(escapesCompatibleRange("garbage", "18.2.0"), false);
    assert.equal(escapesCompatibleRange("19.0.0", "garbage"), false);
  });
});

describe("computeBoundedSpec", () => {
  it("bounds at the next major", () => {
    assert.equal(computeBoundedSpec("7.29.6", "7.29.0"), ">=7.29.6 <8");
    assert.equal(computeBoundedSpec("5.2.0", "5.1.4"), ">=5.2.0 <6");
    assert.equal(computeBoundedSpec("11.1.1", "11.1.1"), ">=11.1.1 <12");
  });

  it("bounds at the next MINOR for 0.x rather than spanning to <1", () => {
    // <1 would let 0.5 drift all the way to 0.9 — every hop breaking.
    assert.equal(computeBoundedSpec("0.7.0", "0.5.0"), ">=0.7.0 <0.8");
  });

  it("bounds at the next PATCH for 0.0.x", () => {
    assert.equal(computeBoundedSpec("0.0.5", "0.0.3"), ">=0.0.5 <0.0.6");
  });

  it("clears the floor when the only fix lives above the installed major", () => {
    // The ceiling anchors on the patch, not the install — otherwise this would
    // emit the impossible ">=7.28.0 <7".
    assert.equal(computeBoundedSpec("7.28.0", "6.21.0"), ">=7.28.0 <8");
    assert.equal(computeBoundedSpec("1.0.0", "0.5.0"), ">=1.0.0 <2");
  });

  it("clears the installed version when it already sits above the patch", () => {
    // Must not force a downgrade to satisfy the ceiling.
    assert.equal(computeBoundedSpec("18.0.0", "19.2.0"), ">=18.0.0 <20");
  });

  it("never emits an unsatisfiable range: the floor is always inside the bound", () => {
    const cases: Array<[string, string | undefined]> = [
      ["7.29.6", "7.29.0"],
      ["0.7.0", "0.5.0"],
      ["0.0.5", "0.0.3"],
      ["1.0.0", "0.5.0"],
      ["7.28.0", "6.21.0"],
      ["18.0.0", "19.2.0"],
      ["19.0.0", undefined],
    ];
    for (const [patched, installed] of cases) {
      const spec = computeBoundedSpec(patched, installed);
      const ceiling = spec.split("<")[1];
      if (!ceiling) continue; // unbounded fallback
      const floorParsed = parseSemver(patched)!;
      const ceilParsed = parseSemver(ceiling)!;
      assert.ok(
        compareSemver(floorParsed, ceilParsed) < 0,
        `${spec} excludes its own floor — would fail install with ETARGET`,
      );
    }
  });

  it("falls back to an unbounded floor when nothing is parseable", () => {
    assert.equal(computeBoundedSpec("garbage", undefined), ">=garbage");
  });
});

describe("satisfiesVulnerableRange", () => {
  // The five shapes GitHub actually emits, by frequency across 228 real alerts
  // on two repositories. Nothing else has ever been observed.
  it("handles '>= V, < V' — the most common shape (87 of 228)", () => {
    assert.equal(satisfiesVulnerableRange("4.0.5", ">= 4.0.0, < 4.1.1"), true);
    assert.equal(satisfiesVulnerableRange("4.1.1", ">= 4.0.0, < 4.1.1"), false);
    assert.equal(satisfiesVulnerableRange("3.14.2", ">= 4.0.0, < 4.1.1"), false);
  });

  it("handles '< V' (84 of 228)", () => {
    assert.equal(satisfiesVulnerableRange("3.13.0", "< 3.14.2"), true);
    assert.equal(satisfiesVulnerableRange("3.14.2", "< 3.14.2"), false);
  });

  it("handles '>= V, <= V' — inclusive upper bound, absent from issue #2's sketch (31 of 228)", () => {
    assert.equal(satisfiesVulnerableRange("5.1.4", ">= 5.0.0-alpha.0, <= 5.1.4"), true);
    assert.equal(satisfiesVulnerableRange("5.1.5", ">= 5.0.0-alpha.0, <= 5.1.4"), false);
  });

  it("handles '<= V' (24 of 228) — the real tar shape", () => {
    assert.equal(satisfiesVulnerableRange("7.5.15", "<= 7.5.15"), true);
    assert.equal(satisfiesVulnerableRange("7.5.16", "<= 7.5.15"), false);
  });

  it("handles '= V' (2 of 228) — the real jws shape", () => {
    assert.equal(satisfiesVulnerableRange("4.0.0", "= 4.0.0"), true);
    assert.equal(satisfiesVulnerableRange("4.0.1", "= 4.0.0"), false);
    assert.equal(satisfiesVulnerableRange("3.2.3", "= 4.0.0"), false);
  });

  it("treats a pre-release lower bound as its stable version", () => {
    // Real: ajv ">= 7.0.0-alpha.0, < 8.18.0" and @angular/core ">= 21.0.0-next.0".
    // parseSemver strips the pre-release; for a LOWER bound that admits exactly
    // the same stable versions, which is all these ranges are ever used for.
    assert.equal(satisfiesVulnerableRange("6.14.0", ">= 7.0.0-alpha.0, < 8.18.0"), false);
    assert.equal(satisfiesVulnerableRange("7.0.0", ">= 7.0.0-alpha.0, < 8.18.0"), true);
    assert.equal(satisfiesVulnerableRange("8.18.0", ">= 7.0.0-alpha.0, < 8.18.0"), false);
  });

  it("returns null — not false — when it cannot tell", () => {
    // false would read as "outside the vulnerable range", i.e. safe. An
    // unparseable bound must never manufacture an all-clear.
    assert.equal(satisfiesVulnerableRange("1.0.0", "^1.0.0"), null); // no comparator
    assert.equal(satisfiesVulnerableRange("1.0.0", "< garbage"), null);
    assert.equal(satisfiesVulnerableRange("garbage", "< 1.0.0"), null);
    assert.equal(satisfiesVulnerableRange("1.0.0", ""), null);
  });
});

describe("lowestPatchClearingAll", () => {
  it("finds the patch that clears both lines of a two-line advisory", () => {
    // GHSA-mh29-5h37-fv8m, exactly as it landed on pip-cost-sharing 2025-11-18.
    const patches = ["3.14.2", "4.1.1"];
    const ranges = ["< 3.14.2", ">= 4.0.0, < 4.1.1"];
    assert.equal(lowestPatchClearingAll(patches, ranges), "3.14.2");
  });

  it("returns the max when every range sits on one line — the real tar case", () => {
    // Seven nested advisories, all on 7.x. Only the highest patch clears them
    // all, so there is nothing to report: max IS the minimum here.
    const patches = ["7.5.3", "7.5.4", "7.5.7", "7.5.8", "7.5.10", "7.5.11", "7.5.16"];
    const ranges = ["<= 7.5.2", "<= 7.5.3", "< 7.5.7", "< 7.5.8", "<= 7.5.9", "<= 7.5.10", "<= 7.5.15"];
    assert.equal(lowestPatchClearingAll(patches, ranges), "7.5.16");
  });

  it("spans four lines — the real minimatch case", () => {
    const patches = ["8.0.6", "9.0.6", "9.0.7", "10.2.3"];
    const ranges = [">= 8.0.0, < 8.0.6", ">= 9.0.0, < 9.0.6", ">= 9.0.0, < 9.0.7", ">= 10.0.0, < 10.2.3"];
    assert.equal(lowestPatchClearingAll(patches, ranges), "8.0.6");
  });

  it("returns null when any range is unparseable, rather than guessing", () => {
    assert.equal(lowestPatchClearingAll(["1.0.0", "2.0.0"], ["< 1.0.0", "^2.0.0"]), null);
  });

  it("returns null when nothing clears every range", () => {
    // Contrived: neither patch escapes both windows.
    assert.equal(lowestPatchClearingAll(["1.5.0"], ["< 1.0.0", ">= 1.0.0"]), null);
  });

  it("ignores duplicate ranges — Dependabot raises one alert per vulnerable copy", () => {
    const patches = ["3.14.2", "4.1.1", "4.1.1"];
    const ranges = ["< 3.14.2", ">= 4.0.0, < 4.1.1", ">= 4.0.0, < 4.1.1"];
    assert.equal(lowestPatchClearingAll(patches, ranges), "3.14.2");
  });
});

describe("why mergeAlert keeps the HIGHEST patch — issue #2", () => {
  // Issue #2 proposed replacing max with the LOWEST patch that clears every
  // vulnerable range in the advisory. On GHSA-mh29-5h37-fv8m (js-yaml) with
  // 3.13.0 and 4.0.5 installed, that picks 3.14.2, which does clear "< 3.14.2"
  // and ">= 4.0.0, < 4.1.1" both. These two assertions are why it can't ship:
  // together they show the lower patch failing *silently*. If either flips, the
  // argument for max needs rechecking — that's what these guard.

  it("a patch below the highest copy emits a spec that still admits it", () => {
    // The ceiling anchors on the higher of patch and installed (4.0.5 here), so
    // the emitted range spans right over the vulnerable copy. The override
    // applies, the resolver keeps 4.0.5, and the CVE stays live.
    assert.equal(computeBoundedSpec("3.14.2", "4.0.5"), ">=3.14.2 <5");
    assert.ok(compareSemver(parseSemver("4.0.5")!, parseSemver("3.14.2")!) > 0, "4.0.5 satisfies >=3.14.2");
    assert.ok(compareSemver(parseSemver("4.0.5")!, parseSemver("5")!) < 0, "4.0.5 satisfies <5");
  });

  it("and nothing flags it, because escapes are only ever detected upward", () => {
    // escapesCompatibleRange asks whether the patch sits ABOVE the installed
    // copy's compatible ceiling. A patch below an installed copy is never an
    // escape, so noInRangeFix stays false and the run reports success.
    assert.equal(escapesCompatibleRange("3.14.2", "4.0.5"), false);
    assert.equal(escapesCompatibleRange("3.14.2", "3.13.0"), false);

    // The max, by contrast, is loud: it names the consumer it drags across a major.
    assert.equal(computeBoundedSpec("4.1.1", "4.0.5"), ">=4.1.1 <5");
    assert.equal(escapesCompatibleRange("4.1.1", "3.13.0"), true);
  });
});

describe("rangeCouldResolveVulnerable", () => {
  it("keeps the override when the range's minimum is below the patch", () => {
    assert.equal(rangeCouldResolveVulnerable("^7.5.3", "7.5.16"), true);
    assert.equal(rangeCouldResolveVulnerable("~7.5.3", "7.5.16"), true);
    assert.equal(rangeCouldResolveVulnerable(">=7.5.3", "7.5.16"), true);
  });

  it("drops the override when the range cannot resolve below the patch", () => {
    assert.equal(rangeCouldResolveVulnerable(">=7.5.16", "7.5.16"), false);
    assert.equal(rangeCouldResolveVulnerable("^8.0.0", "7.5.16"), false);
  });

  it("keeps the override when the range is unbounded or unreadable", () => {
    assert.equal(rangeCouldResolveVulnerable("*", "7.5.16"), true);
    assert.equal(rangeCouldResolveVulnerable("", "7.5.16"), true);
    assert.equal(rangeCouldResolveVulnerable("^7.5.3 || ^8.0.0", "7.5.16"), true);
    assert.equal(rangeCouldResolveVulnerable("^1.0.0", "garbage"), true);
  });
});
