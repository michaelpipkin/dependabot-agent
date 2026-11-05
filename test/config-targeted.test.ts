import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
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

describe("resolveConfig — what the workflow's DRY_RUN does", () => {
  it("false beats a repository's \"dryRun\": true", () => {
    assert.equal(resolveConfig({}, baseEnv(workspace({ dryRun: true }), { DRY_RUN: "false" })).dryRun, false);
  });

  it("true beats a repository's \"dryRun\": false", () => {
    assert.equal(resolveConfig({}, baseEnv(workspace({ dryRun: false }), { DRY_RUN: "true" })).dryRun, true);
  });
});

describe("resolveConfig — targeted strategy", () => {
  it("accepts UPDATE_STRATEGY=targeted", () => {
    const cfg = resolveConfig({}, baseEnv(workspace(), { UPDATE_STRATEGY: "targeted" }));
    assert.equal(cfg.updateStrategy, "targeted");
  });
});

describe("resolveConfig — malformed limits stop at startup, naming the key", () => {
  const rejects = (limits: unknown, named: string): void => {
    const dir = workspace({ limits });
    assert.throws(
      () => resolveConfig({}, baseEnv(dir)),
      (e: unknown) => e instanceof AgentError && e.message.includes(`"limits"`) && e.message.includes(named),
      `expected ${JSON.stringify(limits)} to be rejected`,
    );
  };

  it("rejects a blank range", () => {
    rejects({ "@angular/*": "" }, "@angular/*");
    rejects({ "@angular/*": "   " }, "@angular/*");
  });

  it("rejects an empty pattern", () => {
    rejects({ "": "<22" }, `""`);
    rejects({ "  ": "<22" }, `"  "`);
  });

  it("rejects anything that isn't a plain object", () => {
    rejects(true, "true");
    rejects(5, "5");
    rejects(["<22"], `["<22"]`);
    rejects("<22", `"<22"`);
    rejects(null, "null");
  });

  it("rejects a range that isn't a string", () => {
    rejects({ "@angular/*": 22 }, "@angular/*");
  });

  it("still accepts a real one, and an empty object", () => {
    assert.deepEqual(resolveConfig({}, baseEnv(workspace({ limits: { "@angular/*": "<22", lodash: "*" } }))).limits, { "@angular/*": "<22", lodash: "*" });
    assert.deepEqual(resolveConfig({}, baseEnv(workspace({ limits: {} }))).limits, {});
  });
});

describe("resolveConfig — updateStrategy in a config file", () => {
  const stops = (updateStrategy: unknown, args: Parameters<typeof resolveConfig>[0] = {}, env: NodeJS.ProcessEnv = {}): void => {
    assert.throws(
      () => resolveConfig(args, baseEnv(workspace({ updateStrategy }), env)),
      (e: unknown) => e instanceof AgentError && e.message.includes(`"updateStrategy"`) && e.message.includes(JSON.stringify(updateStrategy)),
    );
  };

  it("stops on a typo, which would otherwise run the bulk update", () => {
    stops("targetted");
  });

  it("stops on a value that isn't a string", () => {
    stops(5);
  });

  it("stops even when a flag or the environment would have won", () => {
    stops("targetted", { updateStrategy: "targeted" });
    stops("targetted", {}, { UPDATE_STRATEGY: "targeted" });
  });

  it("accepts each real strategy, and leaving it out", () => {
    for (const updateStrategy of ["compatible", "latest", "targeted"]) {
      assert.equal(resolveConfig({}, baseEnv(workspace({ updateStrategy }))).updateStrategy, updateStrategy);
    }
    assert.equal(resolveConfig({}, baseEnv(workspace({}))).updateStrategy, "compatible");
  });
});

describe("resolveConfig — --report outside targeted mode", () => {
  const warnings = (args: Parameters<typeof resolveConfig>[0], env: NodeJS.ProcessEnv = {}): string[] => {
    const seen: string[] = [];
    const mocked = mock.method(console, "warn", (message: unknown) => seen.push(String(message)));
    try {
      resolveConfig(args, baseEnv(workspace(), env));
    } finally {
      mocked.mock.restore();
    }
    return seen;
  };

  it("warns under compatible and latest, whether it came from the flag or the environment", () => {
    assert.ok(warnings({ reportDir: "out" }).some((w) => w.includes("--report") && w.includes("compatible")));
    assert.ok(warnings({ reportDir: "out", updateStrategy: "latest" }).some((w) => w.includes("--report") && w.includes("latest")));
    assert.ok(warnings({}, { REPORT_DIR: "out" }).some((w) => w.includes("--report")));
  });

  it("stays quiet under targeted, and when no report was asked for", () => {
    assert.ok(!warnings({ reportDir: "out", updateStrategy: "targeted" }).some((w) => w.includes("--report")));
    assert.ok(!warnings({}).some((w) => w.includes("--report")));
  });
});

describe("resolveConfig — moveTogether", () => {
  it("reads groups from the config file", () => {
    const groups = [["@angular/ssr", "@angular/build"]];
    const cfg = resolveConfig({ updateStrategy: "targeted" }, baseEnv(workspace({ moveTogether: groups })));
    assert.deepEqual(cfg.moveTogether, groups);
  });

  it("defaults to no groups", () => {
    assert.deepEqual(resolveConfig({ updateStrategy: "targeted" }, baseEnv(workspace())).moveTogether, []);
  });

  for (const [label, value] of [
    ["not a list", { a: "b" }],
    ["a flat list of names", ["a", "b"]],
    ["a group of one", [["a"]]],
    ["a blank name", [["a", " "]]],
    ["a name that isn't a string", [["a", 1]]],
  ] as Array<[string, unknown]>) {
    it(`stops at startup on ${label}, naming the key`, () => {
      assert.throws(
        () => resolveConfig({ updateStrategy: "targeted" }, baseEnv(workspace({ moveTogether: value }))),
        (e: unknown) => e instanceof AgentError && e.message.includes(`"moveTogether"`),
      );
    });
  }

  it("warns that it's ignored under another strategy", () => {
    const warned = mock.method(console, "warn", () => {});
    resolveConfig({ updateStrategy: "compatible" }, baseEnv(workspace({ moveTogether: [["a", "b"]] })));
    assert.ok(warned.mock.calls.some((call) => String(call.arguments[0]).includes("moveTogether")));
    mock.restoreAll();
  });
});
