import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countChangedVersions,
  indexInstalledTree,
  lockfileName,
  lockfileVersions,
  npmLockVersions,
  pnpmLockVersions,
  type VersionIndex,
} from "../src/baseline/versions.js";
import { findInstalledVersions } from "../src/tree.js";
import type { InstalledTree } from "../src/types.js";

const asObject = (index: VersionIndex): Record<string, string[]> => Object.fromEntries(index);

describe("pnpmLockVersions", () => {
  it("indexes v9 packages and snapshots keys, scoped names and peer suffixes included", () => {
    const text = [
      "lockfileVersion: '9.0'",
      "",
      "packages:",
      "",
      "  zod@4.6.5:",
      "    resolution: {integrity: sha512-aaa}",
      "",
      "  '@angular/router@22.2.5':",
      "    resolution: {integrity: sha512-bbb}",
      "",
      "snapshots:",
      "",
      "  zod@4.6.5: {}",
      "",
      "  '@angular/router@22.2.5(@angular/core@22.2.5)(rxjs@7.8.2)':",
      "    dependencies:",
      "      rxjs: 7.8.2",
      "",
    ].join("\n");
    assert.deepEqual(asObject(pnpmLockVersions(text)), {
      zod: ["4.6.5"],
      "@angular/router": ["22.2.5"],
    });
  });

  it("indexes v6 keys, merging a peer-suffixed key into its plain version and sorting ascending", () => {
    const text = ["lockfileVersion: '6.0'", "", "packages:", "", "  /vite@8.3.5(esbuild@0.28.2):", "    dev: true", "", "  /vite@8.3.0:", "    dev: true", ""].join("\n");
    assert.deepEqual(asObject(pnpmLockVersions(text)), { vite: ["8.3.0", "8.3.5"] });
  });

  it("indexes v5 keys, where the version follows a slash", () => {
    const text = [
      "lockfileVersion: 5.4",
      "",
      "packages:",
      "",
      "  /js-yaml/3.14.1:",
      "    dev: false",
      "",
      "  /@babel/core/7.0.0_react@18.2.0:",
      "    dev: false",
      "",
    ].join("\n");
    assert.deepEqual(asObject(pnpmLockVersions(text)), { "js-yaml": ["3.14.1"], "@babel/core": ["7.0.0"] });
  });

  it("sorts by semver, not as strings", () => {
    const text = ["packages:", "  a@10.0.0:", "    x: 1", "  a@9.1.0:", "    x: 1", "  a@9.10.0:", "    x: 1", ""].join("\n");
    assert.deepEqual(pnpmLockVersions(text).get("a"), ["9.1.0", "9.10.0", "10.0.0"]);
  });

  it("skips keys that aren't a registry name and version", () => {
    const text = [
      "packages:",
      "  'local@file:../local':",
      "    x: 1",
      "  'tarball@https://example.com/t.tgz':",
      "    x: 1",
      "  nover:",
      "    x: 1",
      "  good@1.0.0:",
      "    x: 1",
      "",
    ].join("\n");
    assert.deepEqual(asObject(pnpmLockVersions(text)), { good: ["1.0.0"] });
  });

  it("gives an empty index for a lockfile with no packages", () => {
    assert.equal(pnpmLockVersions("lockfileVersion: '9.0'\n").size, 0);
    assert.equal(pnpmLockVersions("").size, 0);
  });
});

describe("npmLockVersions", () => {
  it("indexes node_modules entries by real name, skipping the root and link entries", () => {
    const text = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "root", version: "9.9.9", dependencies: { a: "^1.0.0" } },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/b": { version: "1.0.0" },
        "node_modules/b/node_modules/a": { version: "2.0.0" },
        "node_modules/ws-link": { resolved: "packages/ws", link: true },
        "packages/ws": { name: "ws", version: "0.0.1" },
        "node_modules/alias": { name: "real", version: "3.0.0" },
      },
    });
    assert.deepEqual(asObject(npmLockVersions(text)), {
      a: ["1.0.0", "2.0.0"],
      b: ["1.0.0"],
      real: ["3.0.0"],
    });
  });

  it("throws a plain Error, rather than exiting, for a v1 lockfile", () => {
    assert.throws(() => npmLockVersions('{"lockfileVersion":1}'), (e: unknown) => e instanceof Error && e.constructor === Error);
  });

  it("throws a plain Error for text that isn't JSON or has no packages block", () => {
    assert.throws(() => npmLockVersions("not json"), Error);
    assert.throws(() => npmLockVersions('{"lockfileVersion":3}'), Error);
    assert.throws(() => npmLockVersions("null"), Error);
  });
});

describe("lockfileVersions and lockfileName", () => {
  it("dispatches on the package manager", () => {
    assert.deepEqual(asObject(lockfileVersions("pnpm", "packages:\n  a@1.0.0:\n    x: 1\n")), { a: ["1.0.0"] });
    const npmText = JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/a": { version: "1.0.0" } } });
    assert.deepEqual(asObject(lockfileVersions("npm", npmText)), { a: ["1.0.0"] });
  });

  it("names each package manager's lockfile", () => {
    assert.equal(lockfileName("pnpm"), "pnpm-lock.yaml");
    assert.equal(lockfileName("npm"), "package-lock.json");
  });
});

describe("indexInstalledTree", () => {
  const tree: InstalledTree[] = [
    {
      name: "ws-a",
      version: "1.0.0",
      path: "/r/a",
      dependencies: {
        lodash: { name: "lodash", version: "4.17.21", dependencies: { minimist: { name: "minimist", version: "1.2.5" } } },
      },
      devDependencies: { vite: { name: "vite", version: "8.3.5" } },
    },
    {
      name: "ws-b",
      version: "1.0.0",
      path: "/r/b",
      dependencies: { minimist: { name: "minimist", version: "1.2.8" }, lodash: { name: "lodash", version: "4.17.21" } },
    },
  ];

  it("gives the same versions per name as findInstalledVersions", () => {
    const index = indexInstalledTree(tree);
    assert.deepEqual([...index.keys()].sort(), ["lodash", "minimist", "vite"]);
    for (const [name, versions] of index) assert.deepEqual(versions, findInstalledVersions(name, tree), name);
    assert.deepEqual(index.get("minimist"), ["1.2.5", "1.2.8"]);
  });
});

describe("countChangedVersions", () => {
  const index = (o: Record<string, string[]>): VersionIndex => new Map(Object.entries(o));

  it("is 0 for identical indexes", () => {
    assert.equal(countChangedVersions(index({ a: ["1.0.0"], b: ["1.0.0", "2.0.0"] }), index({ b: ["1.0.0", "2.0.0"], a: ["1.0.0"] })), 0);
  });

  it("counts a changed version set and an added name", () => {
    assert.equal(countChangedVersions(index({ a: ["1.0.0"], b: ["1.0.0"] }), index({ a: ["1.0.1"], b: ["1.0.0"], c: ["1.0.0"] })), 2);
  });

  it("counts a removed name, and a name once however many copies moved", () => {
    assert.equal(countChangedVersions(index({ a: ["1.0.0", "2.0.0"], b: ["1.0.0"] }), index({ a: ["1.0.1", "2.0.1"] })), 2);
  });
});
