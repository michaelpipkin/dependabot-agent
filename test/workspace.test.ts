import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listWorkspaceMemberDirs, localDeclaredRange, workspaceMemberDependents } from "../src/workspace.js";
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
    assert.equal(judgeOrphanedOverride(asDependents(root, "ms"), "2.0.0", "2.1.3", "latest").action, "remove");
  });

  it("keeps the override while a workspace dependent still declares a vulnerable range", () => {
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/stale/package.json": pkg({ name: "stale", version: "1.0.0", dependencies: { ms: "^1.0.0" } }),
    });
    assert.notEqual(judgeOrphanedOverride(asDependents(root, "ms"), "2.0.0", "2.1.3", "latest").action, "remove");
  });

  it("keeps conservatively when no workspace member declares the target", () => {
    const root = scratchWorkspace({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/unrelated/package.json": pkg({ name: "unrelated", version: "1.0.0", dependencies: { debug: "^4" } }),
    });
    assert.equal(judgeOrphanedOverride(asDependents(root, "ms"), "2.0.0", undefined, "latest").action, "keep-no-data");
  });
});
