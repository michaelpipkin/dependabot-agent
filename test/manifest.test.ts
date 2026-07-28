import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isExactPin,
  isPrereleaseSpec,
  parseSimpleSpec,
  readDirectDependencies,
  rewriteSpecs,
  topLevelValueRange,
} from "../src/manifest.js";

/** Write a package.json into a fresh temp dir and return the dir. */
function manifestDir(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-agent-manifest-"));
  fs.writeFileSync(path.join(dir, "package.json"), contents, "utf-8");
  return dir;
}

function readBack(dir: string): string {
  return fs.readFileSync(path.join(dir, "package.json"), "utf-8");
}

describe("parseSimpleSpec", () => {
  it("splits an operator from its version", () => {
    assert.deepEqual(parseSimpleSpec("^7.3.0"), { operator: "^", version: "7.3.0", prerelease: null });
    assert.deepEqual(parseSimpleSpec("~1.2.3"), { operator: "~", version: "1.2.3", prerelease: null });
    assert.deepEqual(parseSimpleSpec(">=4.0.0"), { operator: ">=", version: "4.0.0", prerelease: null });
  });

  it("captures a pre-release suffix", () => {
    assert.deepEqual(parseSimpleSpec("7.3.2-rc.0"), { operator: "", version: "7.3.2", prerelease: "rc.0" });
    assert.deepEqual(parseSimpleSpec("^1.0.0-beta.4"), { operator: "^", version: "1.0.0", prerelease: "beta.4" });
  });

  it("prefers the two-character operator so >= does not parse as > plus a stray =", () => {
    assert.deepEqual(parseSimpleSpec(">=7.5.16"), { operator: ">=", version: "7.5.16", prerelease: null });
    assert.deepEqual(parseSimpleSpec("<=2.0.0"), { operator: "<=", version: "2.0.0", prerelease: null });
  });

  it("treats a leading v as part of the version, not an operator", () => {
    assert.deepEqual(parseSimpleSpec("v1.2.3"), { operator: "", version: "1.2.3", prerelease: null });
  });

  it("drops build metadata", () => {
    assert.deepEqual(parseSimpleSpec("1.2.3+build.7"), { operator: "", version: "1.2.3", prerelease: null });
  });

  it("returns null for shapes it cannot rewrite identically", () => {
    for (const spec of [
      ">=1.0.0 <2.0.0", // compound
      "1.x", // partial
      "1.2", // partial
      "*",
      "latest",
      "workspace:*",
      "catalog:default",
      "npm:other-pkg@1.2.3",
      "file:../local",
      "git+https://github.com/o/r.git#v1.0.0",
      "1.0.0 || 2.0.0",
    ]) {
      assert.equal(parseSimpleSpec(spec), null, `expected null for ${spec}`);
    }
  });
});

describe("isExactPin", () => {
  it("recognizes the shapes that admit exactly one version", () => {
    assert.equal(isExactPin("7.3.0"), true);
    assert.equal(isExactPin("=7.3.0"), true);
    assert.equal(isExactPin("v7.3.0"), true);
    assert.equal(isExactPin("1.0.0-beta.4"), true);
  });

  it("does not treat a tilde as a pin — narrowing a range is not freezing it", () => {
    assert.equal(isExactPin("~6.0.3"), false);
    assert.equal(isExactPin("^6.0.3"), false);
    assert.equal(isExactPin(">=6.0.3"), false);
  });

  it("leaves protocol specifiers out of it", () => {
    assert.equal(isExactPin("workspace:1.0.0"), false);
    assert.equal(isExactPin("npm:other@1.0.0"), false);
  });
});

describe("isPrereleaseSpec", () => {
  it("is true only when the named version carries a pre-release suffix", () => {
    assert.equal(isPrereleaseSpec("7.3.2-rc.0"), true);
    assert.equal(isPrereleaseSpec("^7.3.2-rc.0"), true);
    assert.equal(isPrereleaseSpec("^7.3.2"), false);
    assert.equal(isPrereleaseSpec("1.2.3+build-7"), false); // build metadata, not a pre-release
  });

  it("is false for an unparseable spec rather than throwing", () => {
    assert.equal(isPrereleaseSpec("workspace:*"), false);
  });
});

describe("readDirectDependencies", () => {
  it("reads every updatable field and records which one each came from", () => {
    const dir = manifestDir(
      JSON.stringify({
        dependencies: { a: "^1.0.0" },
        devDependencies: { b: "2.0.0" },
        optionalDependencies: { c: "~3.0.0" },
        peerDependencies: { d: "^4.0.0" },
      }),
    );
    const deps = readDirectDependencies(dir);
    assert.deepEqual(
      deps.map((d) => `${d.field}:${d.name}:${d.spec}`).sort(),
      ["dependencies:a:^1.0.0", "devDependencies:b:2.0.0", "optionalDependencies:c:~3.0.0"],
    );
  });

  it("returns nothing for a missing or unparseable manifest", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "dep-agent-manifest-"));
    assert.deepEqual(readDirectDependencies(empty), []);
    assert.deepEqual(readDirectDependencies(manifestDir("{ not json")), []);
  });
});

describe("topLevelValueRange", () => {
  it("finds a top-level block", () => {
    const text = '{\n  "name": "x",\n  "dependencies": { "a": "1.0.0" }\n}';
    const range = topLevelValueRange(text, "dependencies");
    assert.ok(range);
    assert.equal(text.slice(range[0], range[1]), '{ "a": "1.0.0" }');
  });

  it("ignores a same-named block nested inside another key", () => {
    // "dependencies" here belongs to an override entry, not to the project.
    const text = '{\n  "pnpm": { "dependencies": { "a": "9.9.9" } },\n  "dependencies": { "a": "1.0.0" }\n}';
    const range = topLevelValueRange(text, "dependencies");
    assert.ok(range);
    assert.equal(text.slice(range[0], range[1]), '{ "a": "1.0.0" }');
  });

  it("is not fooled by a string VALUE that matches the key name", () => {
    const text = '{\n  "description": "dependencies",\n  "dependencies": { "a": "1.0.0" }\n}';
    const range = topLevelValueRange(text, "dependencies");
    assert.ok(range);
    assert.equal(text.slice(range[0], range[1]), '{ "a": "1.0.0" }');
  });

  it("skips braces and quotes that live inside strings", () => {
    const text = '{\n  "scripts": { "x": "echo \\"{\\" }" },\n  "dependencies": { "a": "1.0.0" }\n}';
    const range = topLevelValueRange(text, "dependencies");
    assert.ok(range);
    assert.equal(text.slice(range[0], range[1]), '{ "a": "1.0.0" }');
  });

  it("returns null when the key has no block value", () => {
    assert.equal(topLevelValueRange('{ "name": "x" }', "dependencies"), null);
  });
});

describe("rewriteSpecs", () => {
  it("changes only the targeted entry and leaves the rest of the file byte-identical", () => {
    // Four-space indent and no trailing newline: both must survive.
    const original = '{\n    "name": "x",\n    "dependencies": {\n        "a": "^7.3.2-rc.0",\n        "b": "^1.0.0"\n    }\n}';
    const dir = manifestDir(original);

    const applied = rewriteSpecs(dir, [{ field: "dependencies", name: "a", from: "^7.3.2-rc.0", to: "^7.3.0" }]);

    assert.equal(applied.length, 1);
    assert.equal(readBack(dir), original.replace("^7.3.2-rc.0", "^7.3.0"));
  });

  it("does not touch a same-named entry outside the targeted field", () => {
    const original = JSON.stringify(
      {
        overrides: { esbuild: "^1.0.0" },
        devDependencies: { esbuild: "^1.0.0" },
      },
      null,
      2,
    );
    const dir = manifestDir(original);

    rewriteSpecs(dir, [{ field: "devDependencies", name: "esbuild", from: "^1.0.0", to: "^2.0.0" }]);

    const result = JSON.parse(readBack(dir)) as Record<string, Record<string, string>>;
    assert.equal(result.overrides.esbuild, "^1.0.0");
    assert.equal(result.devDependencies.esbuild, "^2.0.0");
  });

  it("reports only the edits it could actually apply", () => {
    const dir = manifestDir(JSON.stringify({ dependencies: { a: "^1.0.0" } }, null, 2));

    const applied = rewriteSpecs(dir, [
      { field: "dependencies", name: "a", from: "^1.0.0", to: "^2.0.0" },
      { field: "dependencies", name: "a", from: "^9.9.9", to: "^3.0.0" }, // stale `from`
      { field: "devDependencies", name: "a", from: "^1.0.0", to: "^4.0.0" }, // no such field
    ]);

    assert.equal(applied.length, 1);
    assert.equal(applied[0].to, "^2.0.0");
  });

  it("escapes regex metacharacters in names and specs", () => {
    const dir = manifestDir(JSON.stringify({ dependencies: { "@scope/pkg.js": "^1.0.0" } }, null, 2));

    const applied = rewriteSpecs(dir, [
      { field: "dependencies", name: "@scope/pkg.js", from: "^1.0.0", to: "^2.0.0" },
    ]);

    assert.equal(applied.length, 1);
    assert.match(readBack(dir), /"@scope\/pkg\.js": "\^2\.0\.0"/);
  });

  it("writes nothing when there are no edits", () => {
    const dir = manifestDir('{"dependencies":{"a":"^1.0.0"}}');
    assert.deepEqual(rewriteSpecs(dir, []), []);
  });
});
