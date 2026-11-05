import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fetchPublishedVersions, highestStableVersion, readAdvisories, readPublishedPackage, readPublishedVersions } from "../src/registry.js";
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

describe("reading what published versions ask for", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns each version's dependencies and peers", async () => {
    stubPackument({
      versions: {
        "1.0.0": { dependencies: { a: "^1.0.0" }, optionalDependencies: { b: "^2.0.0" }, peerDependencies: { c: "1.0.0" } },
        "1.0.1": {},
      },
    });
    const pkg = await readPublishedPackage("pkg");
    assert.deepEqual(pkg?.get("1.0.0"), { dependencies: { a: "^1.0.0", b: "^2.0.0" }, peerDependencies: { c: "1.0.0" } });
    assert.deepEqual(pkg?.get("1.0.1"), { dependencies: {}, peerDependencies: {} });
  });

  it("a 404 is null, and anything else throws, the same as reading the versions", async () => {
    stubPackument(null, 404);
    assert.equal(await readPublishedPackage("nope"), null);
    stubPackument(null, 503);
    await assert.rejects(readPublishedPackage("pkg"), (e: unknown) => e instanceof AgentError && e.message.includes("503"));
  });
});

describe("reading advisories", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("posts what it's asked about to the bulk endpoint, and returns the ranges", async () => {
    let sent: { url: string; method?: string; body?: string } | undefined;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      sent = { url: String(url), method: init?.method, body: String(init?.body) };
      return Promise.resolve(new Response(JSON.stringify({ hono: [{ id: 1, url: "https://x.test/a", vulnerable_versions: ">=1.0.0 <2.0.0", title: "t" }] }), { status: 200 }));
    }) as typeof globalThis.fetch;
    const found = await readAdvisories({ hono: ["1.0.0", "1.0.1"] });
    assert.equal(sent?.url, "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk");
    assert.equal(sent?.method, "POST");
    assert.deepEqual(JSON.parse(sent!.body!), { hono: ["1.0.0", "1.0.1"] });
    assert.deepEqual(found, { hono: [{ url: "https://x.test/a", vulnerable_versions: ">=1.0.0 <2.0.0" }] });
  });

  for (const [label, fetchStub] of [
    ["a 503", () => Promise.resolve(new Response("", { status: 503 }))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
    ["a body it can't read", () => Promise.resolve(new Response("<html>", { status: 200 }))],
  ] as Array<[string, () => Promise<Response>]>) {
    it(`${label} throws, so the caller can say the check didn't run`, async () => {
      globalThis.fetch = fetchStub as typeof globalThis.fetch;
      await assert.rejects(readAdvisories({ hono: ["1.0.0"] }), AgentError);
    });
  }
});
