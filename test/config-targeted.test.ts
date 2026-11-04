import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveConfig } from "../src/config.js";
import { AgentError } from "../src/util.js";

/** A fresh workspace root holding the given config file (or none). */
function workspace(config?: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-agent-config-"));
  if (config) fs.writeFileSync(path.join(dir, "dependabot-agent.config.json"), JSON.stringify(config), "utf-8");
  return dir;
}

/** Minimum environment resolveConfig needs, rooted at `dir`. */
function baseEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { GITHUB_TOKEN: "t", GITHUB_REPO: "o/r", WORKSPACE_ROOT: dir, ...extra };
}

describe("resolveConfig — limits", () => {
  it("reads limits from the config file", () => {
    const dir = workspace({ limits: { "@angular/*": "<22" } });
    const cfg = resolveConfig({}, baseEnv(dir));
    assert.deepEqual(cfg.limits, { "@angular/*": "<22" });
  });

  it("defaults limits to an empty object", () => {
    const cfg = resolveConfig({}, baseEnv(workspace()));
    assert.deepEqual(cfg.limits, {});
  });

  it("rejects a limit that is not a semver range, naming the key", () => {
    const dir = workspace({ limits: { "@angular/*": "not a range" } });
    assert.throws(
      () => resolveConfig({}, baseEnv(dir)),
      (e: unknown) => e instanceof AgentError && e.message.includes("@angular/*"),
    );
  });
});

describe("resolveConfig — reportDir", () => {
  it("lets --report win over REPORT_DIR", () => {
    const dir = workspace();
    const cfg = resolveConfig({ reportDir: "from-flag" }, baseEnv(dir, { REPORT_DIR: "from-env" }));
    assert.equal(cfg.reportDir, "from-flag");
  });

  it("falls back to REPORT_DIR, and is undefined when neither is set", () => {
    const dir = workspace();
    assert.equal(resolveConfig({}, baseEnv(dir, { REPORT_DIR: "from-env" })).reportDir, "from-env");
    assert.equal(resolveConfig({}, baseEnv(dir)).reportDir, undefined);
  });
});

describe("resolveConfig — targeted strategy", () => {
  it("accepts UPDATE_STRATEGY=targeted", () => {
    const cfg = resolveConfig({}, baseEnv(workspace(), { UPDATE_STRATEGY: "targeted" }));
    assert.equal(cfg.updateStrategy, "targeted");
  });
});
