import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, mock } from "node:test";
import type { ResolvedConfig } from "../src/config.js";
import { run } from "../src/reconcile.js";
import { isAgentAuthoredOverride, overrideKeyName, selectorKeyName } from "../src/targeted/override-keys.js";

describe("targeted override keys", () => {
  it("selectorKeyName understands range selectors", () => {
    assert.equal(selectorKeyName("qs@>=6.0.0 <6.7.3"), "qs");
    assert.equal(selectorKeyName("@babel/core@>=7.0.0 <7.1.0"), "@babel/core");
    assert.equal(selectorKeyName("js-yaml@3"), "js-yaml");
    assert.equal(selectorKeyName("@babel/core"), "@babel/core");
  });

  it("selectorKeyName leaves a hand-written '<' selector whole", () => {
    assert.equal(selectorKeyName("foo@<2.0.0"), "foo@<2.0.0");
  });

  it("overrideKeyName names the package whatever the selector", () => {
    assert.equal(overrideKeyName("foo@<2.0.0"), "foo");
    assert.equal(overrideKeyName("@babel/core"), "@babel/core");
  });

  it("isAgentAuthoredOverride separates agent keys from hand-written pins", () => {
    assert.equal(isAgentAuthoredOverride("qs@>=6.0.0 <6.7.3", "6.7.3"), true);
    assert.equal(isAgentAuthoredOverride("js-yaml@3", ">=3.15.0 <4"), true);
    assert.equal(isAgentAuthoredOverride("foo@2", "2.3.1"), false);
    assert.equal(isAgentAuthoredOverride("foo", "2.3.1"), false);
  });

  it("isAgentAuthoredOverride only trusts the exact shape targeted mode writes", () => {
    assert.equal(isAgentAuthoredOverride("foo@<2.0.0", "2.0.0"), false);
    assert.equal(isAgentAuthoredOverride("foo@>=1.0.0 <2.0.0", "1.5.0"), false);
    assert.equal(isAgentAuthoredOverride("@babel/core@>=7.0.0 <7.1.0", "7.1.0"), true);
  });
});

describe("run() routes by update strategy", () => {
  const cfgFor = (updateStrategy: ResolvedConfig["updateStrategy"]): ResolvedConfig => ({
    token: "t",
    repo: "o/r",
    owner: "o",
    name: "r",
    packageManager: "pnpm",
    workspaceRoot: path.resolve("."),
    updateStrategy,
    allowPrerelease: false,
    dryRun: true,
    skipUpdate: false,
    exitCode: false,
    discoverPackages: false,
    packages: [],
    updateWorkspaceMembers: false,
    limits: {},
  });

  async function runWithFailingGitHub(updateStrategy: ResolvedConfig["updateStrategy"]): Promise<{ error: Error; fetched: number }> {
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("stubbed", { status: 500 }));
    mock.method(console, "log", () => {});
    try {
      const error = await run(cfgFor(updateStrategy)).then(
        () => new Error("run() resolved"),
        (e: Error) => e,
      );
      return { error, fetched: fetchMock.mock.callCount() };
    } finally {
      mock.restoreAll();
    }
  }

  it("compatible still reaches the existing path: it asks GitHub for alerts, even on pnpm", async () => {
    const { error, fetched } = await runWithFailingGitHub("compatible");
    assert.match(error.message, /GitHub API error 500/);
    assert.equal(fetched, 1);
  });

  it("latest still reaches the existing path too", async () => {
    const { error, fetched } = await runWithFailingGitHub("latest");
    assert.match(error.message, /GitHub API error 500/);
    assert.equal(fetched, 1);
  });

  it("targeted goes to its own path, which stops on pnpm before asking GitHub for anything", async () => {
    const { error, fetched } = await runWithFailingGitHub("targeted");
    assert.match(error.message, /npm only/);
    assert.equal(fetched, 0);
  });
});
