import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentError } from "../src/util.js";
import {
  copiesOf,
  edgesOf,
  edgesTo,
  memberOwnersOf,
  reachableFrom,
  readLockfile,
  resolveDep,
} from "../src/targeted/lockfile.js";
import { makeLock } from "./helpers/lock.js";

describe("lockfile index", () => {
  it("resolves through node_modules the way Node does", () => {
    const lock = makeLock({
      "": { dependencies: { a: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { b: "^2.0.0" } },
      "node_modules/a/node_modules/b": { version: "2.0.0" },
      "node_modules/b": { version: "1.0.0" },
    });
    assert.equal(resolveDep(lock, "node_modules/a", "b")?.version, "2.0.0");
    assert.equal(resolveDep(lock, "", "b")?.version, "1.0.0");
    assert.equal(resolveDep(lock, "node_modules/a", "zzz"), null);
  });

  it("walks up through nested node_modules before reaching the root", () => {
    const lock = makeLock({
      "": {},
      "node_modules/a": { version: "1.0.0" },
      "node_modules/a/node_modules/b": { version: "1.0.0" },
      "node_modules/a/node_modules/b/node_modules/c": { version: "1.0.0" },
      "node_modules/a/node_modules/x": { version: "5.0.0" },
      "node_modules/x": { version: "1.0.0" },
    });
    const from = "node_modules/a/node_modules/b/node_modules/c";
    assert.equal(resolveDep(lock, from, "x")?.version, "5.0.0");
    assert.equal(resolveDep(lock, from, "a")?.version, "1.0.0");
  });

  it("resolves a workspace member's dep from its own node_modules, then the root", () => {
    const lock = makeLock({
      "": { workspaces: ["packages/*"] },
      "packages/a": { version: "1.0.0", dependencies: { x: "^1", y: "^1" } },
      "packages/a/node_modules/x": { version: "2.0.0" },
      "node_modules/x": { version: "1.0.0" },
      "node_modules/y": { version: "1.0.0" },
    });
    assert.equal(resolveDep(lock, "packages/a", "x")?.version, "2.0.0");
    assert.equal(resolveDep(lock, "packages/a", "y")?.version, "1.0.0");
  });

  it("returns the member entry when a dep resolves to a workspace link", () => {
    const lock = makeLock({
      "": {},
      "node_modules/@ws/a": { resolved: "packages/a", link: true },
      "packages/a": { name: "@ws/a", version: "1.0.0" },
    });
    const hit = resolveDep(lock, "", "@ws/a");
    assert.equal(hit?.path, "packages/a");
    assert.equal(hit?.version, "1.0.0");
    assert.equal(lock.entries.get("node_modules/@ws/a")?.link, "packages/a");
  });

  it("follows workspace links when walking reachability", () => {
    const lock = makeLock({
      "": { devDependencies: { "@ws/a": "*" } },
      "node_modules/@ws/a": { resolved: "packages/a", link: true },
      "packages/a": { name: "@ws/a", version: "1.0.0", dependencies: { glob: "^7" } },
      "node_modules/glob": { version: "7.2.0", dependencies: { minimatch: "^3" } },
      "node_modules/minimatch": { version: "3.1.2" },
      "node_modules/unrelated": { version: "1.0.0" },
    });
    const reached = reachableFrom(lock, [""]);
    assert.ok(reached.has("packages/a"));
    assert.ok(reached.has("node_modules/glob"));
    assert.ok(reached.has("node_modules/minimatch"));
    assert.ok(!reached.has("node_modules/unrelated"));
  });

  it("terminates on dependency cycles", () => {
    const lock = makeLock({
      "": { dependencies: { a: "1" } },
      "node_modules/a": { version: "1.0.0", dependencies: { b: "1" } },
      "node_modules/b": { version: "1.0.0", dependencies: { a: "1" } },
    });
    assert.deepEqual([...reachableFrom(lock, [""])].sort(), ["", "node_modules/a", "node_modules/b"]);
  });

  it("names an entry from its last node_modules segment, including scopes", () => {
    const lock = makeLock({
      "": {},
      "node_modules/@s/a/node_modules/@t/b": { version: "1.0.0" },
      "node_modules/@s/a": { version: "1.0.0" },
    });
    assert.equal(lock.entries.get("node_modules/@s/a/node_modules/@t/b")?.name, "@t/b");
    assert.equal(lock.entries.get("node_modules/@s/a")?.name, "@s/a");
  });

  describe("aliased installs: npm writes the real name beside the path", () => {
    const lock = makeLock({
      "": { dependencies: { foo: "npm:minimatch@3.1.2", qs: "npm:other@1.0.0", plain: "^1.0.0" } },
      "node_modules/foo": { name: "minimatch", version: "3.1.2" },
      "node_modules/qs": { name: "other", version: "1.0.0" },
      "node_modules/plain": { version: "1.0.0" },
    });

    it("names the entry by what it really is, and keeps the name it's installed under", () => {
      const foo = lock.entries.get("node_modules/foo");
      assert.equal(foo?.name, "minimatch");
      assert.equal(foo?.installedAs, "foo");
      assert.equal(lock.entries.get("node_modules/plain")?.name, "plain");
      assert.equal(lock.entries.get("node_modules/plain")?.installedAs, "plain");
    });

    it("copiesOf finds a copy by its real name, not its path", () => {
      assert.deepEqual(copiesOf(lock, "minimatch").map((e) => e.path), ["node_modules/foo"]);
      assert.deepEqual(copiesOf(lock, "foo"), []);
      assert.deepEqual(copiesOf(lock, "qs"), []);
      assert.deepEqual(copiesOf(lock, "other").map((e) => e.path), ["node_modules/qs"]);
    });

    it("resolveDep stays path-based, as Node's resolution is", () => {
      assert.equal(resolveDep(lock, "", "foo")?.path, "node_modules/foo");
      assert.equal(resolveDep(lock, "", "minimatch"), null);
      assert.equal(resolveDep(lock, "", "qs")?.name, "other");
    });

    it("edges stay keyed by the declared name", () => {
      assert.deepEqual(edgesTo(lock, "foo").map((e) => e.resolved?.path), ["node_modules/foo"]);
      assert.deepEqual(edgesTo(lock, "minimatch"), []);
    });
  });

  it("copiesOf returns every installed copy, not links or workspace members", () => {
    const lock = makeLock({
      "": {},
      "node_modules/@ws/a": { resolved: "packages/a", link: true },
      "packages/a": { name: "@ws/a", version: "1.0.0" },
      "node_modules/b": { version: "1.0.0" },
      "node_modules/c/node_modules/b": { version: "2.0.0" },
      "node_modules/c": { version: "1.0.0" },
    });
    assert.deepEqual(copiesOf(lock, "b").map((e) => e.version).sort(), ["1.0.0", "2.0.0"]);
    assert.deepEqual(copiesOf(lock, "@ws/a"), []);
  });

  it("edgesOf lists every declared dependency with optionality and resolution", () => {
    const lock = makeLock({
      "": { dependencies: { a: "^1" }, devDependencies: { d: "^1" } },
      "node_modules/a": {
        version: "1.0.0",
        dependencies: { b: "^1" },
        optionalDependencies: { o: "^1" },
        peerDependencies: { p: "^1", q: "^1" },
        peerDependenciesMeta: { q: { optional: true } },
      },
      "node_modules/b": { version: "1.0.0" },
      "node_modules/d": { version: "1.0.0" },
    });
    const edges = edgesOf(lock);
    const byKey = new Map(edges.map((e) => [`${e.from}>${e.name}`, e]));
    assert.equal(edges.length, 6);
    assert.equal(byKey.get("node_modules/a>b")?.optional, false);
    assert.equal(byKey.get("node_modules/a>b")?.resolved?.path, "node_modules/b");
    assert.equal(byKey.get("node_modules/a>o")?.optional, true);
    assert.equal(byKey.get("node_modules/a>o")?.resolved, null);
    assert.equal(byKey.get("node_modules/a>p")?.optional, false);
    assert.equal(byKey.get("node_modules/a>q")?.optional, true);
    assert.equal(byKey.get(">d")?.spec, "^1");
  });

  it("edgesTo returns the edges that declare the named package", () => {
    const lock = makeLock({
      "": { dependencies: { a: "^1", b: "^1" } },
      "node_modules/a": { version: "1.0.0", dependencies: { b: "^2" } },
      "node_modules/b": { version: "1.0.0" },
    });
    assert.deepEqual(
      edgesTo(lock, "b")
        .map((e) => `${e.from}:${e.spec}`)
        .sort(),
      [":^1", "node_modules/a:^2"],
    );
  });

  it("memberOwnersOf finds a member's direct deps that lead to the target", () => {
    const lock = makeLock({
      "": { workspaces: ["packages/*"] },
      "packages/a": { version: "1.0.0", dependencies: { glob: "^7.1.6" } },
      "packages/b": { version: "1.0.0", dependencies: { express: "^4.17.1" } },
      "node_modules/glob": { version: "7.2.0", dependencies: { minimatch: "^3.0.4" } },
      "node_modules/minimatch": { version: "3.0.4" },
      "node_modules/express": { version: "4.17.1" },
    });
    assert.deepEqual(memberOwnersOf(lock, ["packages/a", "packages/b"], ["minimatch"]), { glob: "^7.1.6" });
  });

  it("memberOwnersOf excludes the target itself", () => {
    const lock = makeLock({
      "": { workspaces: ["packages/*"] },
      "packages/b": { version: "1.0.0", dependencies: { qs: "^6.0.0", express: "^4.17.1" } },
      "node_modules/express": { version: "4.17.1", dependencies: { qs: "6.7.0" } },
      "node_modules/qs": { version: "6.7.0" },
    });
    assert.deepEqual(memberOwnersOf(lock, ["packages/b"], ["qs"]), { express: "^4.17.1" });
  });

  it("memberOwnersOf includes devDependencies and keeps the first range on disagreement", () => {
    const lock = makeLock({
      "": {},
      "packages/a": { devDependencies: { glob: "^7.1.0" } },
      "packages/b": { dependencies: { glob: "^7.2.0" } },
      "node_modules/glob": { version: "7.2.0", dependencies: { minimatch: "^3" } },
      "node_modules/minimatch": { version: "3.0.4" },
    });
    assert.deepEqual(memberOwnersOf(lock, ["packages/a", "packages/b"], ["minimatch"]), { glob: "^7.1.0" });
  });

  describe("readLockfile", () => {
    function withLockfile(contents: object | null, run: (dir: string) => void): void {
      const dir = mkdtempSync(join(tmpdir(), "targeted-lock-"));
      try {
        if (contents) writeFileSync(join(dir, "package-lock.json"), JSON.stringify(contents));
        run(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("reads a v3 lockfile", () => {
      withLockfile({ lockfileVersion: 3, packages: { "": {}, "node_modules/a": { version: "1.0.0" } } }, (dir) => {
        assert.equal(readLockfile(dir).entries.get("node_modules/a")?.version, "1.0.0");
      });
    });

    it("rejects a lockfileVersion 1 file with a clear message", () => {
      withLockfile({ lockfileVersion: 1, dependencies: {} }, (dir) => {
        assert.throws(
          () => readLockfile(dir),
          (e: unknown) => e instanceof AgentError && /lockfileVersion 1/.test(e.message),
        );
      });
    });

    it("rejects a missing lockfile", () => {
      withLockfile(null, (dir) => {
        assert.throws(
          () => readLockfile(dir),
          (e: unknown) => e instanceof AgentError && /package-lock\.json/.test(e.message),
        );
      });
    });
  });
});
