import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cell, inline, renderSummaryLine } from "../src/report/markdown.js";

const base = { addressed: 12, open: 13, overridesAddedOrUpdated: 8, overridesRemoved: 0, packagesUpdated: 23, updatePassOnly: true };

describe("renderSummaryLine", () => {
  it("renders the approved summary line", () => {
    assert.equal(
      renderSummaryLine(base, false),
      "**12** of 13 alerts addressed · **8** overrides added or updated · **0** removed · **23** packages updated by the update pass",
    );
  });

  it("says 'packages updated' without the update-pass qualifier when the count includes everything", () => {
    assert.match(renderSummaryLine({ ...base, updatePassOnly: false }, false), /· \*\*23\*\* packages updated$/);
  });

  it("puts range bumps after overrides when given", () => {
    assert.match(
      renderSummaryLine({ ...base, rangeBumps: 2, updatePassOnly: false }, false),
      /overrides added or updated · \*\*2\*\* range bumps · \*\*0\*\* removed/,
    );
  });

  it("uses singular forms", () => {
    assert.equal(
      renderSummaryLine({ addressed: 1, open: 1, overridesAddedOrUpdated: 1, overridesRemoved: 1, packagesUpdated: 1, rangeBumps: 1, updatePassOnly: false }, false),
      "**1** of 1 alert addressed · **1** override added or updated · **1** range bump · **1** removed · **1** package updated",
    );
  });

  it("in a plan, prefixes 'Planned:' and leaves out packages updated", () => {
    assert.equal(renderSummaryLine(base, true), "Planned: **12** of 13 alerts addressed · **8** overrides added or updated · **0** removed");
  });
});

describe("shared helpers", () => {
  it("inline and cell still escape mentions and pipes after the move", () => {
    assert.equal(inline("by @someone"), "by `@someone`");
    assert.equal(cell("a|b"), "a\\|b");
  });
});

describe("renderSummaryLine with a baseline", () => {
  it("ends with the packages changed since the baseline", () => {
    assert.equal(
      renderSummaryLine({ ...base, packagesSince: "the last commit" }, false),
      "**12** of 13 alerts addressed · **8** overrides added or updated · **0** removed · **23** packages changed since the last commit",
    );
    assert.match(renderSummaryLine({ ...base, packagesSince: "`release`" }, false), /· \*\*23\*\* packages changed since `release`$/);
  });

  it("uses the singular for one package", () => {
    assert.match(
      renderSummaryLine({ ...base, packagesUpdated: 1, packagesSince: "the last commit" }, false),
      /· \*\*1\*\* package changed since the last commit$/,
    );
  });

  it("leaves the packages part out of a plan", () => {
    assert.equal(
      renderSummaryLine({ ...base, packagesSince: "the last commit" }, true),
      "Planned: **12** of 13 alerts addressed · **8** overrides added or updated · **0** removed",
    );
  });
});
