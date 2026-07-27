import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DirectDep, readDirectDependencies } from "../src/manifest.js";
import { exactlyPinnedDeps, rejectAdoptedPrereleases } from "../src/package-manager/update-guards.js";

function dep(name: string, spec: string, field: DirectDep["field"] = "dependencies"): DirectDep {
  return { name, spec, field };
}

const realFetch = globalThis.fetch;

/**
 * Answer packument requests from a fixed version list. Anything not in `byName`
 * 404s, which is how the "registry unreachable" branch is reached.
 */
function stubRegistry(byName: Record<string, string[]>): void {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const name = decodeURIComponent(url.replace("https://registry.npmjs.org/", ""));
    const versions = byName[name];
    if (!versions) return Promise.resolve(new Response(null, { status: 404 }));
    const body = { versions: Object.fromEntries(versions.map((v) => [v, {}])) };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof globalThis.fetch;
}

function manifestDir(pkg: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-agent-guards-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf-8");
  return dir;
}

describe("exactlyPinnedDeps", () => {
  it("selects only the exactly-pinned entries", () => {
    const pinned = exactlyPinnedDeps([
      dep("firebase-functions", "7.3.0"),
      dep("@angular/core", "^22.0.8"),
      dep("typescript", "~6.0.3", "devDependencies"),
      dep("eslint", "=10.8.0", "devDependencies"),
    ]);

    assert.deepEqual(
      pinned.map((p) => p.name),
      ["firebase-functions", "eslint"],
    );
  });

  it("keeps a pin's field, so the same name pinned in two fields is held in both", () => {
    const pinned = exactlyPinnedDeps([dep("a", "1.0.0"), dep("a", "1.0.0", "devDependencies")]);
    assert.deepEqual(
      pinned.map((p) => p.field),
      ["dependencies", "devDependencies"],
    );
  });

  it("returns nothing when every dependency is a range", () => {
    assert.deepEqual(exactlyPinnedDeps([dep("a", "^1.0.0"), dep("b", ">=2.0.0")]), []);
  });
});

describe("rejectAdoptedPrereleases", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("replaces an adopted pre-release with the highest stable release, keeping the operator", async () => {
    // The real firebase-functions case: the `latest` dist-tag pointed at an rc.
    stubRegistry({ "firebase-functions": ["7.2.5", "7.3.0", "7.3.2-rc.0", "7.3.2-rc.1"] });
    const dir = manifestDir({ dependencies: { "firebase-functions": "^7.3.2-rc.0" } });

    const rollback = await rejectAdoptedPrereleases(dir, [dep("firebase-functions", "^7.2.5")]);

    assert.equal(rollback.skipped.length, 0);
    assert.deepEqual(
      rollback.applied.map((f) => [f.name, f.from, f.to, f.source]),
      [["firebase-functions", "^7.3.2-rc.0", "^7.3.0", "highest-stable"]],
    );
    assert.equal(readDirectDependencies(dir)[0].spec, "^7.3.0");
  });

  it("restores the operator the AUTHOR declared, not the one the update wrote", async () => {
    // pnpm drops the caret and pins exactly when the target is a pre-release, so
    // the post-update spec is a bare version. Reading the operator back off that
    // would turn a range into a pin — which the pin guard would then freeze.
    stubRegistry({ "firebase-functions": ["7.2.5", "7.3.0", "7.3.2-rc.0"] });
    const dir = manifestDir({ dependencies: { "firebase-functions": "7.3.2-rc.0" } });

    const rollback = await rejectAdoptedPrereleases(dir, [dep("firebase-functions", "^7.2.5")]);

    assert.equal(rollback.applied[0].to, "^7.3.0");
    assert.equal(readDirectDependencies(dir)[0].spec, "^7.3.0");
  });

  it("carries a tilde through the same way", async () => {
    stubRegistry({ pkg: ["6.0.3", "7.1.0", "7.2.0-rc.0"] });
    const dir = manifestDir({ dependencies: { pkg: "7.2.0-rc.0" } });

    const rollback = await rejectAdoptedPrereleases(dir, [dep("pkg", "~6.0.3")]);

    assert.equal(rollback.applied[0].to, "~7.1.0");
  });

  it("leaves a project that was already tracking a pre-release alone", async () => {
    stubRegistry({ pkg: ["1.0.0", "2.0.0-beta.2"] });
    const dir = manifestDir({ dependencies: { pkg: "^2.0.0-beta.2" } });

    const rollback = await rejectAdoptedPrereleases(dir, [dep("pkg", "^2.0.0-beta.1")]);

    assert.deepEqual(rollback.applied, []);
    assert.equal(readDirectDependencies(dir)[0].spec, "^2.0.0-beta.2");
  });

  it("restores the pre-update spec when the registry cannot be read", async () => {
    stubRegistry({}); // every lookup 404s
    const dir = manifestDir({ devDependencies: { pkg: "^3.0.0-rc.1" } });

    const rollback = await rejectAdoptedPrereleases(dir, [dep("pkg", "^2.9.0", "devDependencies")]);

    assert.deepEqual(
      rollback.applied.map((f) => [f.to, f.source]),
      [["^2.9.0", "restored"]],
    );
    assert.equal(readDirectDependencies(dir)[0].spec, "^2.9.0");
  });

  it("never downgrades: an older highest-stable falls back to what was declared", async () => {
    // Nothing stable has been published since the 4.x line went to pre-release.
    stubRegistry({ pkg: ["1.0.0", "5.0.0-alpha.1"] });
    const dir = manifestDir({ dependencies: { pkg: "^5.0.0-alpha.1" } });

    const rollback = await rejectAdoptedPrereleases(dir, [dep("pkg", "^4.2.0")]);

    assert.deepEqual(
      rollback.applied.map((f) => [f.to, f.source]),
      [["^4.2.0", "restored"]],
    );
  });

  it("ignores a dependency added during the update, having no prior spec to judge", async () => {
    stubRegistry({ pkg: ["1.0.0"] });
    const dir = manifestDir({ dependencies: { pkg: "^2.0.0-rc.0" } });

    const rollback = await rejectAdoptedPrereleases(dir, []);

    assert.deepEqual(rollback.applied, []);
    assert.equal(readDirectDependencies(dir)[0].spec, "^2.0.0-rc.0");
  });

  it("does nothing when the update produced no pre-releases", async () => {
    stubRegistry({ pkg: ["1.0.0", "2.0.0"] });
    const dir = manifestDir({ dependencies: { pkg: "^2.0.0" } });

    const rollback = await rejectAdoptedPrereleases(dir, [dep("pkg", "^1.0.0")]);

    assert.deepEqual(rollback.applied, []);
    assert.deepEqual(rollback.skipped, []);
  });
});
