import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  EMPTY_CATALOGS,
  catalogPins,
  listWorkspaceMemberDirs,
  localDeclaredRange,
  readPnpmCatalogs,
  readPnpmIgnoredDependencies,
  resolveCatalogSpec,
  workspaceMemberDependents,
} from "../src/workspace.js";
import { judgeOrphanedOverride } from "../src/reconcile.js";
import { DependentRange } from "../src/types.js";

/** A throwaway workspace dir seeded with the given files (path → contents). */
function scratchWorkspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-"));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf-8");
  }
  return root;
}

const pkg = (obj: unknown): string => JSON.stringify(obj);

describe("listWorkspaceMemberDirs", () => {
  it("resolves pnpm `packages:` with a trailing /* glob", () => {
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/a/package.json": pkg({ name: "a" }),
      "packages/b/package.json": pkg({ name: "b" }),
      "packages/not-a-pkg/readme.md": "no package.json here",
    });
    const dirs = listWorkspaceMemberDirs(root, "pnpm").map((d) => path.basename(d)).sort();
    assert.deepEqual(dirs, ["a", "b"]); // not-a-pkg has no package.json → excluded
  });

  it("resolves npm `workspaces` as an array and as { packages: [] }", () => {
    const arrayForm = scratchWorkspace({
      "package.json": pkg({ name: "root", workspaces: ["packages/*"] }),
      "packages/a/package.json": pkg({ name: "a" }),
    });
    assert.deepEqual(listWorkspaceMemberDirs(arrayForm, "npm").map((d) => path.basename(d)), ["a"]);

    const objectForm = scratchWorkspace({
      "package.json": pkg({ name: "root", workspaces: { packages: ["libs/*"] } }),
      "libs/x/package.json": pkg({ name: "x" }),
    });
    assert.deepEqual(listWorkspaceMemberDirs(objectForm, "npm").map((d) => path.basename(d)), ["x"]);
  });

  it("resolves a literal member path", () => {
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - 'app'\n",
      "app/package.json": pkg({ name: "app" }),
    });
    assert.deepEqual(listWorkspaceMemberDirs(root, "pnpm").map((d) => path.basename(d)), ["app"]);
  });

  it("skips glob shapes it can't confidently resolve rather than guessing", () => {
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/**'\n  - '!packages/excluded'\n  - 'packages/{a,b}'\n",
      "packages/a/package.json": pkg({ name: "a" }),
    });
    // None of **, !, or {} are resolved — better to keep an override than remove
    // one based on a misread pattern.
    assert.deepEqual(listWorkspaceMemberDirs(root, "pnpm"), []);
  });

  it("returns nothing when there is no workspace config", () => {
    const root = scratchWorkspace({ "package.json": pkg({ name: "solo" }) });
    assert.deepEqual(listWorkspaceMemberDirs(root, "npm"), []);
    assert.deepEqual(listWorkspaceMemberDirs(root, "pnpm"), []);
  });
});

describe("localDeclaredRange", () => {
  const member = (deps: Record<string, unknown>): string => {
    const root = scratchWorkspace({ "m/package.json": pkg({ name: "m", ...deps }) });
    return path.join(root, "m");
  };

  it("reads the declared range across every dependency type", () => {
    assert.equal(localDeclaredRange(member({ dependencies: { ms: "^2.1.0" } }), "ms"), "^2.1.0");
    assert.equal(localDeclaredRange(member({ devDependencies: { ms: "2.0.0" } }), "ms"), "2.0.0");
    assert.equal(localDeclaredRange(member({ peerDependencies: { ms: ">=2" } }), "ms"), ">=2");
    assert.equal(localDeclaredRange(member({ optionalDependencies: { ms: "~2.1.0" } }), "ms"), "~2.1.0");
  });

  it("returns null when the member declares nothing for the target", () => {
    assert.equal(localDeclaredRange(member({ dependencies: { other: "^1" } }), "ms"), null);
  });

  it("treats an unusable wildcard as no information", () => {
    assert.equal(localDeclaredRange(member({ dependencies: { ms: "*" } }), "ms"), null);
  });
});

describe("workspaceMemberDependents", () => {
  it("returns only members that declare the target, with their local ranges", () => {
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/old/package.json": pkg({ name: "old", version: "1.0.0", dependencies: { ms: "^2.1.3" } }),
      "packages/unrelated/package.json": pkg({ name: "unrelated", version: "1.0.0", dependencies: { debug: "^4" } }),
    });
    const members = workspaceMemberDependents(root, "pnpm", "ms");
    assert.deepEqual(members, [{ name: "old", version: "1.0.0", range: "^2.1.3" }]);
  });
});

describe("orphan removal uses workspace members' local ranges — issue #14", () => {
  // Mirrors the enrichment in reconcileOrphanedOverride: a workspace member the
  // registry can't see contributes its own declared range as an authoritative
  // "latest", so judgeOrphanedOverride can age out an override once every member
  // has moved on. Deterministic — reads local manifests, no registry.
  const asDependents = (root: string, target: string): DependentRange[] =>
    workspaceMemberDependents(root, "pnpm", target).map((m) => ({
      dependent: m.name,
      version: m.version,
      installedRange: m.range,
      latestRange: m.range,
      latestKnown: true,
    }));

  it("ages out an override once the only (workspace) dependent declares a safe range", () => {
    // The #14 case: was kept forever because a member has no registry entry.
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/old/package.json": pkg({ name: "old", version: "1.0.0", dependencies: { ms: "^2.1.3" } }),
    });
    assert.equal(judgeOrphanedOverride(asDependents(root, "ms"), "2.0.0", "2.1.3").action, "remove");
  });

  it("keeps the override while a workspace dependent still declares a vulnerable range", () => {
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/stale/package.json": pkg({ name: "stale", version: "1.0.0", dependencies: { ms: "^1.0.0" } }),
    });
    assert.notEqual(judgeOrphanedOverride(asDependents(root, "ms"), "2.0.0", "2.1.3").action, "remove");
  });

  it("keeps conservatively when no workspace member declares the target", () => {
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/unrelated/package.json": pkg({ name: "unrelated", version: "1.0.0", dependencies: { debug: "^4" } }),
    });
    assert.equal(judgeOrphanedOverride(asDependents(root, "ms"), "2.0.0", undefined).action, "keep-no-data");
  });
});

describe("readPnpmIgnoredDependencies", () => {
  it("reads the list pnpm would apply", () => {
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - .\nupdateConfig:\n  ignoreDependencies:\n    - typescript\n    - '@babel/*'\n",
    });
    assert.deepEqual(readPnpmIgnoredDependencies(root), ["typescript", "@babel/*"]);
  });

  it("prefers a sub-package's own config over the root's", () => {
    // functions/ in a real repo: its own workspace file wins outright, exactly
    // as pnpm resolves it — the root's list does not merge in.
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - .\nupdateConfig:\n  ignoreDependencies:\n    - root-only\n",
      "functions/pnpm-workspace.yaml": "updateConfig:\n  ignoreDependencies:\n    - typescript\n",
    });
    assert.deepEqual(readPnpmIgnoredDependencies(path.join(root, "functions")), ["typescript"]);
  });

  it("inherits the nearest config above a directory that has none", () => {
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - .\nupdateConfig:\n  ignoreDependencies:\n    - typescript\n",
      "sub/package.json": pkg({ name: "sub" }),
    });
    assert.deepEqual(readPnpmIgnoredDependencies(path.join(root, "sub")), ["typescript"]);
  });

  it("returns nothing when there is no config, no updateConfig, or an empty list", () => {
    assert.deepEqual(readPnpmIgnoredDependencies(scratchWorkspace({ "package.json": pkg({ name: "solo" }) })), []);
    assert.deepEqual(readPnpmIgnoredDependencies(scratchWorkspace({ "pnpm-workspace.yaml": "packages:\n  - .\n" })), []);
    assert.deepEqual(
      readPnpmIgnoredDependencies(scratchWorkspace({ "pnpm-workspace.yaml": "updateConfig: {}\n" })),
      [],
    );
  });

  it("survives a malformed workspace file rather than failing the run", () => {
    const root = scratchWorkspace({ "pnpm-workspace.yaml": "updateConfig:\n  ignoreDependencies: not-a-list\n" });
    assert.deepEqual(readPnpmIgnoredDependencies(root), []);
  });
});

describe("readPnpmCatalogs", () => {
  it("reads the default catalog and every named one", () => {
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\ncatalog:\n  ms: ^2.1.3\ncatalogs:\n  legacy:\n    ms: ^1.0.0\n",
    });
    const catalogs = readPnpmCatalogs(root);
    assert.deepEqual(catalogs.default, { ms: "^2.1.3" });
    assert.deepEqual(catalogs.named, { legacy: { ms: "^1.0.0" } });
  });

  it("accepts the default catalog under `catalogs.default`, with the top-level key winning", () => {
    // pnpm allows both spellings, and both are reachable as `catalog:`. A
    // package named in each has to resolve to exactly one range.
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "catalog:\n  ms: ^2.1.3\ncatalogs:\n  default:\n    ms: ^1.0.0\n    debug: ^4.3.0\n",
    });
    const catalogs = readPnpmCatalogs(root);
    assert.deepEqual(catalogs.default, { ms: "^2.1.3", debug: "^4.3.0" });
    assert.deepEqual(catalogs.named, {}); // folded in, not left as a second source
  });

  it("returns empty catalogs for a missing or malformed workspace file", () => {
    assert.deepEqual(readPnpmCatalogs(scratchWorkspace({})), EMPTY_CATALOGS);
    const broken = scratchWorkspace({ "pnpm-workspace.yaml": "catalog:\n  - [unbalanced\n" });
    assert.deepEqual(readPnpmCatalogs(broken), EMPTY_CATALOGS);
  });
});

describe("resolveCatalogSpec", () => {
  const catalogs = { default: { ms: "^2.1.3" }, named: { legacy: { ms: "^1.0.0" } } };

  it("passes ordinary specifiers straight through", () => {
    assert.deepEqual(resolveCatalogSpec("^2.1.3", catalogs, "ms"), { kind: "not-catalog" });
    assert.deepEqual(resolveCatalogSpec("workspace:*", catalogs, "ms"), { kind: "not-catalog" });
  });

  it("resolves `catalog:` and `catalog:default` against the default catalog", () => {
    assert.deepEqual(resolveCatalogSpec("catalog:", catalogs, "ms"), { kind: "resolved", range: "^2.1.3" });
    assert.deepEqual(resolveCatalogSpec("catalog:default", catalogs, "ms"), { kind: "resolved", range: "^2.1.3" });
  });

  it("resolves a named catalog", () => {
    assert.deepEqual(resolveCatalogSpec("catalog:legacy", catalogs, "ms"), { kind: "resolved", range: "^1.0.0" });
  });

  it("reports an unbacked reference as unresolved, not as an ordinary range", () => {
    assert.deepEqual(resolveCatalogSpec("catalog:", catalogs, "debug"), { kind: "unresolved", catalog: "default" });
    assert.deepEqual(resolveCatalogSpec("catalog:nope", catalogs, "ms"), { kind: "unresolved", catalog: "nope" });
  });
});

describe("catalogPins", () => {
  it("selects only the exactly-pinned entries, labelled by the catalog holding them", () => {
    const root = scratchWorkspace({
      "pnpm-workspace.yaml":
        "catalog:\n  rimraf: 3.0.2\n  ms: ^2.1.3\ncatalogs:\n  legacy:\n    semver: 6.3.0\n    debug: ~4.3.0\n",
    });
    assert.deepEqual(catalogPins(root), [
      { name: "rimraf", spec: "3.0.2", origin: "pnpm-workspace.yaml (catalog)" },
      { name: "semver", spec: "6.3.0", origin: "pnpm-workspace.yaml (catalogs.legacy)" },
    ]);
  });

  it("finds nothing when no catalog entry is pinned", () => {
    assert.deepEqual(catalogPins(scratchWorkspace({ "pnpm-workspace.yaml": "catalog:\n  ms: ^2.1.3\n" })), []);
  });
});

describe("localDeclaredRange — catalog references", () => {
  const workspace = (spec: string, workspaceYaml: string): string =>
    scratchWorkspace({
      "pnpm-workspace.yaml": workspaceYaml,
      "packages/app/package.json": pkg({ name: "app", version: "1.0.0", dependencies: { ms: spec } }),
    });

  it("resolves a catalog reference to the range the catalog declares", () => {
    const root = workspace("catalog:", "packages:\n  - 'packages/*'\ncatalog:\n  ms: ^2.1.3\n");
    assert.equal(localDeclaredRange(path.join(root, "packages/app"), "ms", readPnpmCatalogs(root)), "^2.1.3");
  });

  it("resolves a named catalog reference", () => {
    const root = workspace("catalog:legacy", "packages:\n  - 'packages/*'\ncatalogs:\n  legacy:\n    ms: ^1.0.0\n");
    assert.equal(localDeclaredRange(path.join(root, "packages/app"), "ms", readPnpmCatalogs(root)), "^1.0.0");
  });

  it("keeps an unbacked reference as its raw token rather than reporting no requirement", () => {
    // The safety property. `catalog:` is unparseable downstream, so it reads as
    // "could still resolve vulnerable" and the override is held. Returning null
    // would drop the member from the dependent set — silence, which the removal
    // check must never be allowed to read as "safe to remove".
    const root = workspace("catalog:", "packages:\n  - 'packages/*'\ncatalog:\n  debug: ^4\n");
    assert.equal(localDeclaredRange(path.join(root, "packages/app"), "ms", readPnpmCatalogs(root)), "catalog:");
  });

  it("leaves a catalog reference raw when no catalogs are supplied (the npm case)", () => {
    const root = workspace("catalog:", "packages:\n  - 'packages/*'\n");
    assert.equal(localDeclaredRange(path.join(root, "packages/app"), "ms"), "catalog:");
  });
});

describe("orphan removal sees through catalogs", () => {
  const asDependents = (root: string, target: string): DependentRange[] =>
    workspaceMemberDependents(root, "pnpm", target).map((m) => ({
      dependent: m.name,
      version: m.version,
      installedRange: m.range,
      latestRange: m.range,
      latestKnown: true,
    }));

  const catalogWorkspace = (catalogEntry: string): string =>
    scratchWorkspace({
      "pnpm-workspace.yaml": `packages:\n  - 'packages/*'\ncatalog:\n${catalogEntry}`,
      "packages/app/package.json": pkg({ name: "app", version: "1.0.0", dependencies: { ms: "catalog:" } }),
    });

  it("ages out an override once the catalog entry the member points at is safe", () => {
    // The regression this change exists for: before catalogs were resolved,
    // `catalog:` was unparseable, so the override was held forever and the
    // report gave "catalog:" as the stated reason for holding it.
    const root = catalogWorkspace("  ms: ^2.1.3\n");
    assert.deepEqual(asDependents(root, "ms"), [
      { dependent: "app", version: "1.0.0", installedRange: "^2.1.3", latestRange: "^2.1.3", latestKnown: true },
    ]);
    assert.equal(judgeOrphanedOverride(asDependents(root, "ms"), "2.0.0", "2.1.3").action, "remove");
  });

  it("still holds the override while the catalog entry itself is vulnerable — and names the escape", () => {
    // A resolved catalog range is a real range, so the escape check can finally
    // read it: forcing 2.1.3 on a member that declares ^1.0.0 pushes it past its
    // compatible range. Under the raw `catalog:` token that was unknowable, and
    // the override was held with no explanation anyone could act on.
    const verdict = judgeOrphanedOverride(asDependents(catalogWorkspace("  ms: ^1.0.0\n"), "ms"), "2.0.0", "2.1.3");
    assert.equal(verdict.action, "escape"); // held either way — never "remove"
    assert.deepEqual(
      verdict.action === "escape" ? verdict.escaping.map((e) => ({ name: e.name, range: e.range })) : [],
      [{ name: "app", range: "^1.0.0" }],
    );
  });

  it("holds the override when the reference is unbacked — a broken catalog is never read as safe", () => {
    const root = catalogWorkspace("  debug: ^4\n");
    assert.notEqual(judgeOrphanedOverride(asDependents(root, "ms"), "2.0.0", "2.1.3").action, "remove");
  });
});
