import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { highestStableVersion } from "../src/registry.js";

const realFetch = globalThis.fetch;

function stubPackument(body: unknown, status = 200): void {
  globalThis.fetch = (() =>
    Promise.resolve(new Response(status === 200 ? JSON.stringify(body) : null, { status }))) as typeof globalThis.fetch;
}

describe("highestStableVersion", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("ignores pre-releases even when they are the highest published version", async () => {
    stubPackument({ versions: { "7.2.5": {}, "7.3.0": {}, "7.3.2-rc.0": {}, "7.3.2-rc.1": {} } });
    assert.equal(await highestStableVersion("firebase-functions"), "7.3.0");
  });

  it("orders numerically, not lexically", async () => {
    stubPackument({ versions: { "1.9.0": {}, "1.10.0": {}, "1.2.0": {} } });
    assert.equal(await highestStableVersion("shell-quote"), "1.10.0");
  });

  it("returns null when nothing stable has ever been published", async () => {
    stubPackument({ versions: { "1.0.0-alpha.1": {}, "1.0.0-alpha.2": {} } });
    assert.equal(await highestStableVersion("pkg"), null);
  });

  it("returns null when the package cannot be read", async () => {
    stubPackument(null, 404);
    assert.equal(await highestStableVersion("nope"), null);
  });

  it("returns null when the response carries no version map", async () => {
    stubPackument({ name: "pkg" });
    assert.equal(await highestStableVersion("pkg"), null);
  });

  it("skips version keys that are not plain semver", async () => {
    stubPackument({ versions: { "1.0.0": {}, "not-a-version": {}, "2.0.0": {} } });
    assert.equal(await highestStableVersion("pkg"), "2.0.0");
  });
});
