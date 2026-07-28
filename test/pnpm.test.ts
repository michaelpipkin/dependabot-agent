import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DirectDep } from "../src/manifest.js";
import { pnpmUpdateCommand } from "../src/package-manager/pnpm.js";

function pin(name: string): DirectDep {
  return { name, spec: "1.0.0", field: "dependencies" };
}

describe("pnpmUpdateCommand", () => {
  it("is the bare command when nothing is pinned", () => {
    assert.equal(pnpmUpdateCommand("compatible", []), "pnpm update");
    assert.equal(pnpmUpdateCommand("latest", []), "pnpm update --latest");
  });

  it("appends a quoted negation pattern per pinned package", () => {
    assert.equal(
      pnpmUpdateCommand("latest", [pin("firebase-functions"), pin("@angular/core")]),
      'pnpm update --latest "!firebase-functions" "!@angular/core"',
    );
  });

  it("emits one pattern per name even when a package is pinned in two fields", () => {
    const pinned: DirectDep[] = [
      { name: "typescript", spec: "6.0.3", field: "dependencies" },
      { name: "typescript", spec: "6.0.3", field: "devDependencies" },
    ];
    assert.equal(pnpmUpdateCommand("latest", pinned), 'pnpm update --latest "!typescript"');
  });
});
