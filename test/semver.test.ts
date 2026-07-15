import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareSemver,
  compatibleCeiling,
  computeBoundedSpec,
  escapesCompatibleRange,
  formatCeiling,
  parseSemver,
  rangeCouldResolveVulnerable,
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
