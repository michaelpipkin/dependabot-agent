import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { selectOverrideSource } from "../src/override-source.js";

/** A throwaway workspace dir seeded with the given files. */
function scratchDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "override-src-"));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents, "utf-8");
  }
  return dir;
}

const SCOPED = { "js-yaml@3": ">=3.15.0 <4", "js-yaml@4": ">=4.2.0 <5" };

describe("OverrideSource round-trips version-selector (scoped) keys", () => {
  it("npm — package.json overrides", () => {
    const dir = scratchDir({ "package.json": JSON.stringify({ name: "root", private: true }) });

    selectOverrideSource("npm", dir, true).write(SCOPED);

    // On disk: scoped keys land in a plain overrides block npm honors.
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    assert.deepEqual(raw.overrides, SCOPED);

    // Read path: a fresh source sees them back, so a re-run is idempotent.
    assert.deepEqual(selectOverrideSource("npm", dir, true).overrides, SCOPED);
  });

  it("pnpm — pnpm-workspace.yaml overrides", () => {
    const dir = scratchDir({
      "package.json": JSON.stringify({ name: "root", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
    });

    selectOverrideSource("pnpm", dir, true).write(SCOPED);

    const text = fs.readFileSync(path.join(dir, "pnpm-workspace.yaml"), "utf-8");
    assert.match(text, /'js-yaml@3'|"js-yaml@3"|js-yaml@3/);
    assert.deepEqual(selectOverrideSource("pnpm", dir, true).overrides, SCOPED);
  });
});

describe("npm nested (object-valued) overrides are preserved, not clobbered — finding #3", () => {
  it("hides object-valued overrides from the reconciler and merges them back on write", () => {
    const dir = scratchDir({
      "package.json": JSON.stringify({
        name: "root",
        private: true,
        overrides: { webpack: { "loader-utils": "^2.0.4" }, lodash: ">=4.17.19 <5" },
      }),
    });

    // Read path: only the string-valued override is exposed for reconciliation;
    // the nested object is not surfaced (it can't be modeled as a string spec).
    const source = selectOverrideSource("npm", dir, true);
    assert.deepEqual(source.overrides, { lodash: ">=4.17.19 <5" });

    // Write path: the agent rewrites lodash but the nested webpack override
    // survives verbatim — never flattened to a string or dropped.
    source.write({ lodash: ">=4.17.21 <5" });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    assert.deepEqual(raw.overrides, { lodash: ">=4.17.21 <5", webpack: { "loader-utils": "^2.0.4" } });
  });
});
