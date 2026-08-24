import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// The README documents the config file twice: a worked example in the
// config-driven walkthrough, and the full schema in the reference section. They
// drifted apart once already — the walkthrough silently went two releases
// without `allowPrerelease` or `exitCode` — and nothing in the build would have
// caught it. These tests pin the relationship between the two blocks so the next
// config key can't be added to one and forgotten in the other.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every fenced ```jsonc block in the README that declares a config file, parsed.
 * Identified by the `repo` placeholder, which every config example carries and
 * no other jsonc block in the document does.
 */
function configBlocks(): Array<Record<string, unknown>> {
  // The file is committed CRLF; normalize so the fence and comment patterns
  // don't have to carry \r? everywhere.
  const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf-8").replace(/\r\n/g, "\n");
  const blocks = [...readme.matchAll(/```jsonc\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks
    .filter((b) => b.includes('"repo": "owner/repo"'))
    .map((b) => JSON.parse(b.replace(/\s*\/\/.*$/gm, "")) as Record<string, unknown>);
}

// The walkthrough omits exactly one key, and says so in the prose beneath it:
// a committed `dryRun` would fight the --dry-run flag the preview script passes.
const WALKTHROUGH_OMITS = ["dryRun"];

describe("README config examples", () => {
  it("finds both blocks", () => {
    assert.equal(configBlocks().length, 2, "expected a walkthrough example and a reference example");
  });

  it("documents every key in the reference block", () => {
    // Mirrors the ConfigFile interface in src/config.ts, minus `token` (which is
    // rejected from config files and documented in prose instead). Update both
    // together when adding an option.
    const expected = [
      "repo",
      "packageManager",
      "workspaceRoot",
      "updateStrategy",
      "allowPrerelease",
      "dryRun",
      "skipUpdate",
      "exitCode",
      "discoverPackages",
      "packages",
      "updateWorkspaceMembers",
    ];
    const [, reference] = configBlocks();
    assert.deepEqual(Object.keys(reference), expected);
  });

  it("keeps the walkthrough block in step with the reference", () => {
    const [walkthrough, reference] = configBlocks();
    assert.deepEqual(
      Object.keys(walkthrough),
      Object.keys(reference).filter((k) => !WALKTHROUGH_OMITS.includes(k)),
      "the walkthrough must show every documented key except the ones it deliberately omits",
    );
  });

  it("gives the shared keys the same values in both blocks", () => {
    const [walkthrough, reference] = configBlocks();
    for (const key of Object.keys(walkthrough)) {
      assert.deepEqual(walkthrough[key], reference[key], `"${key}" differs between the two examples`);
    }
  });

  it("never suggests putting the token in a config file", () => {
    for (const block of configBlocks()) {
      assert.equal(Object.hasOwn(block, "token"), false);
    }
  });
});
