import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fetchPublishedVersions, highestStableVersion, readPublishedVersions } from "../src/registry.js";
import { AgentError } from "../src/util.js";

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

describe("reading published versions when the answer matters", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns the version list", async () => {
    stubPackument({ versions: { "1.0.0": {}, "1.0.1": {} } });
    assert.deepEqual(await readPublishedVersions("pkg"), ["1.0.0", "1.0.1"]);
  });

  it("a 404 means the registry has no such package: null", async () => {
    stubPackument(null, 404);
    assert.equal(await readPublishedVersions("nope"), null);
  });

  for (const status of [401, 403, 429, 500, 503]) {
    it(`a ${status} isn't an answer about the package: it throws, naming the package and the status`, async () => {
      stubPackument(null, status);
      await assert.rejects(
        readPublishedVersions("pkg"),
        (e: unknown) => e instanceof AgentError && e.message.includes("pkg") && e.message.includes(String(status)),
      );
    });
  }

  it("a network failure throws too, with its cause", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed"))) as typeof globalThis.fetch;
    await assert.rejects(readPublishedVersions("pkg"), (e: unknown) => e instanceof AgentError && e.message.includes("fetch failed"));
  });

  it("a body it can't read throws too", async () => {
    stubPackument({ name: "pkg" });
    await assert.rejects(readPublishedVersions("pkg"), AgentError);
    globalThis.fetch = (() => Promise.resolve(new Response("<html>", { status: 200 }))) as typeof globalThis.fetch;
    await assert.rejects(readPublishedVersions("pkg"), AgentError);
  });

  it("fetchPublishedVersions keeps its contract for its other callers: null for all of these", async () => {
    stubPackument(null, 503);
    assert.equal(await fetchPublishedVersions("pkg"), null);
    stubPackument(null, 404);
    assert.equal(await fetchPublishedVersions("pkg"), null);
    globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed"))) as typeof globalThis.fetch;
    assert.equal(await fetchPublishedVersions("pkg"), null);
  });
});
