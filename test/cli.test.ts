import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../src/cli.js";

describe("parseArgs — --exit-code", () => {
  it("sets exitCode true when the flag is present", () => {
    assert.equal(parseArgs(["--exit-code"], "0.0.0").exitCode, true);
  });

  it("leaves exitCode undefined when absent, so config/env can supply it", () => {
    assert.equal(parseArgs(["--dry-run"], "0.0.0").exitCode, undefined);
  });

  it("combines with other flags", () => {
    const args = parseArgs(["--dry-run", "--exit-code", "--repo", "o/r"], "0.0.0");
    assert.equal(args.dryRun, true);
    assert.equal(args.exitCode, true);
    assert.equal(args.repo, "o/r");
  });
});
