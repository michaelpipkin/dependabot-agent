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

describe("parseArgs — --allow-prerelease", () => {
  it("sets allowPrerelease true when the flag is present", () => {
    assert.equal(parseArgs(["--allow-prerelease"], "0.0.0").allowPrerelease, true);
  });

  it("leaves allowPrerelease undefined when absent, so config/env can supply it", () => {
    assert.equal(parseArgs(["--dry-run"], "0.0.0").allowPrerelease, undefined);
  });

  it("combines with the update strategy it modifies", () => {
    const args = parseArgs(["--update-strategy", "latest", "--allow-prerelease"], "0.0.0");
    assert.equal(args.updateStrategy, "latest");
    assert.equal(args.allowPrerelease, true);
  });
});

describe("parseArgs — --update-strategy targeted and --report", () => {
  it("accepts the targeted strategy and --report", () => {
    const args = parseArgs(["--update-strategy", "targeted", "--report", "out"], "0.0.0");
    assert.equal(args.updateStrategy, "targeted");
    assert.equal(args.reportDir, "out");
  });

  it("leaves reportDir undefined when --report is absent", () => {
    assert.equal(parseArgs(["--dry-run"], "0.0.0").reportDir, undefined);
  });
});
