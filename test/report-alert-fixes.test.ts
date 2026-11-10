import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAlerts, isFixed, type AlertFix } from "../src/report/alert-fixes.js";
import { countChangedPackages } from "../src/tree.js";
import type { DependabotAlert, InstalledTree, OverrideChange, TreeNode } from "../src/types.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
const multilineAlerts = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, "alerts-js-yaml-multiline.json"), "utf-8"),
) as DependabotAlert[];

const alert = (
  name: string,
  range: string,
  patched: string | null,
  extra: { number?: number; scope?: "runtime" | "development"; manifest?: string; url?: string } = {},
): DependabotAlert => ({
  number: extra.number ?? 1,
  state: "open",
  dependency: {
    package: { ecosystem: "npm", name },
    manifest_path: extra.manifest ?? "package-lock.json",
    scope: extra.scope ?? "runtime",
  },
  html_url: extra.url,
  security_advisory: { summary: "s", severity: "high", vulnerabilities: [] },
  security_vulnerability: {
    package: { ecosystem: "npm", name },
    vulnerable_version_range: range,
    first_patched_version: patched === null ? null : { identifier: patched },
  },
});

/** A root workspace with the given packages (name -> version) as direct dependencies. */
const tree = (pkgs: Record<string, string>): InstalledTree[] => {
  const dependencies: Record<string, TreeNode> = {};
  for (const [name, version] of Object.entries(pkgs)) dependencies[name] = { name, version };
  return [{ name: "root", version: "1.0.0", path: ".", dependencies }];
};

/** A root workspace where each package (name -> version) is a nested copy under its own host. */
const nested = (versions: Record<string, string>): InstalledTree[] => {
  const dependencies: Record<string, TreeNode> = {};
  for (const [name, version] of Object.entries(versions)) {
    dependencies[`host-${name}`] = { name: `host-${name}`, version: "1.0.0", dependencies: { [name]: { name, version } } };
  }
  return [{ name: "root", version: "1.0.0", path: ".", dependencies }];
};

/** js-yaml 3.14.1 and 4.1.0 installed side by side, each under its own host. */
const jsYamlBothLines = (): InstalledTree[] => [
  {
    name: "root",
    version: "1.0.0",
    path: ".",
    dependencies: {
      "host-3": { name: "host-3", version: "1.0.0", dependencies: { "js-yaml": { name: "js-yaml", version: "3.14.1" } } },
      "host-4": { name: "host-4", version: "1.0.0", dependencies: { "js-yaml": { name: "js-yaml", version: "4.1.0" } } },
    },
  },
];

const add = (packageName: string, newVersion: string): OverrideChange => ({
  packageName,
  action: "add",
  newVersion,
  reason: "r",
});

const classify = (
  alerts: DependabotAlert[],
  before: InstalledTree[],
  after: InstalledTree[],
  changes: OverrideChange[] = [],
  overridesBefore: Record<string, string> = {},
): AlertFix[] => classifyAlerts({ alerts, before, after, changes, overridesBefore });

describe("classifyAlerts", () => {
  it("calls an alert fixed by the update pass when the vulnerable copy is gone afterwards", () => {
    const [fix] = classify(
      [alert("axios", "< 1.19.3", "1.19.3", { number: 7, url: "https://example.test/7", manifest: "pnpm-lock.yaml" })],
      tree({ axios: "1.19.2" }),
      tree({ axios: "1.20.0" }),
    );
    assert.equal(fix.status, "update");
    assert.deepEqual(fix.from, ["1.19.2"]);
    assert.equal(fix.to, "1.20.0");
    assert.equal(fix.number, 7);
    assert.equal(fix.url, "https://example.test/7");
    assert.equal(fix.severity, "high");
    assert.equal(fix.packageName, "axios");
    assert.equal(fix.manifest, "pnpm-lock.yaml");
    assert.equal(fix.scope, "production");
    assert.equal(isFixed(fix), true);
  });

  it("joins every installed version after the update in `to`", () => {
    const [fix] = classify(
      [alert("axios", "< 1.19.3", "1.19.3")],
      nested({ axios: "1.19.2" }),
      [
        {
          name: "root",
          version: "1.0.0",
          path: ".",
          dependencies: {
            "host-a": { name: "host-a", version: "1.0.0", dependencies: { axios: { name: "axios", version: "1.20.0" } } },
            "host-b": { name: "host-b", version: "1.0.0", dependencies: { axios: { name: "axios", version: "1.19.3" } } },
          },
        },
      ],
    );
    assert.equal(fix.status, "update");
    assert.equal(fix.to, "1.19.3, 1.20.0");
  });

  it("calls an alert fixed by an override when the copy is still installed but a change targets it", () => {
    const [fix] = classify(
      [alert("follow-redirects", "< 1.16.2", "1.16.2", { scope: "development" })],
      tree({ "follow-redirects": "1.15.9" }),
      tree({ "follow-redirects": "1.15.9" }),
      [add("follow-redirects", ">=1.16.2 <2")],
    );
    assert.equal(fix.status, "override");
    assert.deepEqual(fix.from, ["1.15.9"]);
    assert.equal(fix.to, "≥ 1.16.2");
    assert.equal(fix.scope, "dev");
    assert.equal(isFixed(fix), true);
  });

  it("treats an update change like an add", () => {
    const [fix] = classify(
      [alert("lodash", "< 4.17.21", "4.17.21")],
      tree({ lodash: "4.17.0" }),
      tree({ lodash: "4.17.0" }),
      [{ packageName: "lodash", action: "update", oldVersion: ">=4.17.5", newVersion: ">=4.17.21 <5", reason: "r" }],
    );
    assert.equal(fix.status, "override");
    assert.equal(fix.to, "≥ 4.17.21");
  });

  it("ignores a remove change", () => {
    const [fix] = classify(
      [alert("lodash", "< 4.17.21", "4.17.21")],
      tree({ lodash: "4.17.0" }),
      tree({ lodash: "4.17.0" }),
      [{ packageName: "lodash", action: "remove", oldVersion: ">=4.17.5", reason: "r" }],
    );
    assert.equal(fix.status, "still-vulnerable");
  });

  it("reports a copy that was already patched before the run as awaiting close", () => {
    const [fix] = classify(
      [alert("follow-redirects", "< 1.16.2", "1.16.2")],
      tree({ "follow-redirects": "1.16.2" }),
      tree({ "follow-redirects": "1.16.2" }),
    );
    assert.equal(fix.status, "awaiting-close");
    assert.deepEqual(fix.from, []);
    assert.equal(isFixed(fix), false);
  });

  it("keeps awaiting-close even when a change exists for the same package", () => {
    const [fix] = classify(
      [alert("follow-redirects", "< 1.16.2", "1.16.2")],
      tree({ "follow-redirects": "1.16.2" }),
      tree({ "follow-redirects": "1.16.2" }),
      [add("follow-redirects", ">=1.16.2 <2")],
    );
    assert.equal(fix.status, "awaiting-close");
  });

  it("calls a still-vulnerable copy under an existing override, with no change, covered", () => {
    const [fix] = classify(
      [alert("glob", "< 10.5.0", "10.5.0")],
      tree({ glob: "10.4.0" }),
      tree({ glob: "10.4.0" }),
      [],
      { glob: ">=10.5.0" },
    );
    assert.equal(fix.status, "covered");
    assert.equal(isFixed(fix), false);
  });

  it("matches an existing scoped override key by its base name", () => {
    const [fix] = classify(
      [alert("js-yaml", "< 3.14.2", "3.14.2")],
      tree({ "js-yaml": "3.14.1" }),
      tree({ "js-yaml": "3.14.1" }),
      [],
      { "js-yaml@3": ">=3.14.2 <4" },
    );
    assert.equal(fix.status, "covered");
  });

  it("reports an alert with no patched version as no-patch, ahead of every other rule", () => {
    const [fix] = classify([alert("left-pad", "<= 1.3.0", null)], tree({ "left-pad": "1.3.0" }), tree({ "left-pad": "1.3.0" }));
    assert.equal(fix.status, "no-patch");
    assert.deepEqual(fix.from, []);
  });

  it("reports a package absent from both trees as not-installed", () => {
    const [fix] = classify([alert("ghost", "< 2.0.0", "2.0.0")], tree({ other: "1.0.0" }), tree({ other: "1.0.0" }));
    assert.equal(fix.status, "not-installed");
  });

  it("never reports awaiting-close for an unparseable range, even with the copy in both trees", () => {
    const [fix] = classify(
      [alert("weird", "something odd", "2.0.0")],
      tree({ weird: "1.0.0" }),
      tree({ weird: "1.0.0" }),
    );
    assert.equal(fix.status, "still-vulnerable");
    assert.deepEqual(fix.from, ["1.0.0"]);
    assert.equal(isFixed(fix), false);
  });

  it("classifies a dry run (before is after) with a change as override", () => {
    const t = tree({ "follow-redirects": "1.15.9" });
    const [fix] = classify([alert("follow-redirects", "< 1.16.2", "1.16.2")], t, t, [add("follow-redirects", ">=1.16.2 <2")]);
    assert.equal(fix.status, "override");
    assert.equal(fix.to, "≥ 1.16.2");
  });

  it("falls to still-vulnerable when nothing was done and no override exists", () => {
    const [fix] = classify([alert("glob", "< 10.5.0", "10.5.0")], tree({ glob: "10.4.0" }), tree({ glob: "10.4.0" }));
    assert.equal(fix.status, "still-vulnerable");
    assert.deepEqual(fix.from, ["10.4.0"]);
  });

  it("gives one fix per alert, in order", () => {
    const fixes = classify(
      [alert("a", "< 2.0.0", "2.0.0", { number: 3 }), alert("b", "< 2.0.0", null, { number: 1 })],
      tree({ a: "1.0.0", b: "1.0.0" }),
      tree({ a: "2.0.0", b: "1.0.0" }),
    );
    assert.deepEqual(fixes.map((f) => [f.number, f.status]), [[3, "update"], [1, "no-patch"]]);
  });

  describe("scoped override lines", () => {
    it("maps every alert to its base name and shows the floor that clears that alert's own range", () => {
      const changes = [add("js-yaml@3", ">=3.15.0 <4"), add("js-yaml@4", ">=4.2.0 <5")];
      const fixes = classify(multilineAlerts, jsYamlBothLines(), jsYamlBothLines(), changes);

      assert.equal(fixes.length, multilineAlerts.length);
      for (const fix of fixes) assert.equal(fix.status, "override", `alert ${fix.number}`);
      for (const fix of fixes) {
        const range = multilineAlerts.find((a) => a.number === fix.number)!.security_vulnerability.vulnerable_version_range;
        assert.equal(fix.to, range.includes("4.0.0") ? "≥ 4.2.0" : "≥ 3.15.0", `alert ${fix.number}`);
      }
      // `from` lists only the copies inside this alert's own range.
      assert.deepEqual(fixes.find((f) => f.number === 1)!.from, ["4.1.0"]);
      assert.deepEqual(fixes.find((f) => f.number === 2)!.from, ["3.14.1"]);
    });

    it("falls back to the lowest floor when every floor is inside the range", () => {
      const [fix] = classify(
        [alert("js-yaml", "< 9.0.0", "9.0.0")],
        jsYamlBothLines(),
        jsYamlBothLines(),
        [add("js-yaml@4", ">=4.2.0 <5"), add("js-yaml@3", ">=3.15.0 <4")],
      );
      assert.equal(fix.status, "override");
      assert.equal(fix.to, "≥ 3.15.0");
    });
  });
});

describe("countChangedPackages", () => {
  it("is zero for identical trees", () => {
    assert.equal(countChangedPackages(tree({ a: "1.0.0", b: "2.0.0" }), tree({ a: "1.0.0", b: "2.0.0" })), 0);
  });

  it("counts a changed nested version and an added package", () => {
    const before = nested({ x: "1.0.0", y: "1.0.0" });
    const after = nested({ x: "1.1.0", y: "1.0.0" });
    after[0].dependencies!["fresh"] = { name: "fresh", version: "1.0.0" };
    assert.equal(countChangedPackages(before, after), 2);
  });

  it("counts a removed package", () => {
    assert.equal(countChangedPackages(tree({ a: "1.0.0", b: "1.0.0" }), tree({ a: "1.0.0" })), 1);
  });

  it("counts a package once even when several of its copies changed", () => {
    const before = nested({ x: "1.0.0" });
    before[0].dependencies!["other"] = { name: "other", version: "1.0.0", dependencies: { x: { name: "x", version: "1.1.0" } } };
    const after = nested({ x: "2.0.0" });
    after[0].dependencies!["other"] = { name: "other", version: "1.0.0", dependencies: { x: { name: "x", version: "2.1.0" } } };
    assert.equal(countChangedPackages(before, after), 1);
  });
});
