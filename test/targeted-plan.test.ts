import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DirectDep } from "../src/manifest.js";
import { readNpmOverrides } from "../src/override-source.js";
import { baseNameOfOverrideKey, isAgentAuthoredOverride } from "../src/reconcile.js";
import { LockIndex } from "../src/targeted/lockfile.js";
import { buildPlan, lineStart, ManifestInfo, matchesLimit, Plan, selectorKey } from "../src/targeted/plan.js";
import { DependabotAlert } from "../src/types.js";
import { AgentError } from "../src/util.js";
import { makeLock } from "./helpers/lock.js";

function alert(number: number, name: string, range: string, patch: string | null): DependabotAlert {
  const vuln = {
    package: { ecosystem: "npm", name },
    vulnerable_version_range: range,
    first_patched_version: patch === null ? null : { identifier: patch },
  };
  return {
    number,
    state: "open",
    html_url: `https://example.test/alerts/${number}`,
    dependency: { package: vuln.package, manifest_path: "package.json", scope: "runtime" },
    security_advisory: { summary: "", severity: "high", vulnerabilities: [vuln] },
    security_vulnerability: vuln,
  };
}

function dep(name: string, spec: string, field: DirectDep["field"] = "dependencies"): DirectDep {
  return { name, spec, field };
}
function root(...deps: DirectDep[]): ManifestInfo {
  return { dir: "/repo", lockPath: "", deps };
}
function member(lockPath: string, ...deps: DirectDep[]): ManifestInfo {
  return { dir: `/repo/${lockPath}`, lockPath, deps };
}

interface Setup {
  alerts: DependabotAlert[];
  lock: LockIndex;
  manifests?: ManifestInfo[];
  flat?: Record<string, string>;
  nested?: Record<string, unknown>;
  limits?: Record<string, string>;
  published?: Map<string, string[] | null>;
  updateWorkspaceMembers?: boolean;
}

/** Every alert's patch counts as published unless the test passes its own map. */
function publishedFrom(alerts: DependabotAlert[]): Map<string, string[] | null> {
  const published = new Map<string, string[] | null>();
  for (const a of alerts) {
    const name = a.security_vulnerability.package.name;
    const patch = a.security_vulnerability.first_patched_version?.identifier;
    published.set(name, [...(published.get(name) ?? []), ...(patch ? [patch] : [])]);
  }
  return published;
}

function plan(setup: Setup): Plan {
  return buildPlan({
    alerts: setup.alerts,
    lock: setup.lock,
    manifests: setup.manifests ?? [root()],
    overrides: { flat: setup.flat ?? {}, nested: setup.nested ?? {} },
    limits: setup.limits ?? {},
    published: setup.published ?? publishedFrom(setup.alerts),
    updateWorkspaceMembers: setup.updateWorkspaceMembers ?? true,
  });
}

/** Nothing written: the blocked and informational outcomes must all leave the repo alone. */
function assertNoWrites(p: Plan): void {
  assert.deepEqual(p.bumps, []);
  assert.deepEqual(p.addOverrides, {});
  assert.deepEqual(p.removeOverrideKeys, []);
  assert.equal(p.targets.size, 0);
}

/** A single vulnerable transitive copy of `name`, pulled in by a package called parent. */
function transitive(name: string, version: string): LockIndex {
  return makeLock({
    "": { dependencies: { parent: "^1.0.0" } },
    "node_modules/parent": { version: "1.0.0", dependencies: { [name]: `^${version}` } },
    [`node_modules/${name}`]: { version },
  });
}

/** A single direct copy of `name`, declared by the root with `spec`. */
function direct(name: string, spec: string, version: string): { lock: LockIndex; manifests: ManifestInfo[] } {
  return {
    lock: makeLock({
      "": { dependencies: { [name]: spec } },
      [`node_modules/${name}`]: { version },
    }),
    manifests: [root(dep(name, spec))],
  };
}

describe("sorting", () => {
  it("not in lockfile → not-found", () => {
    const p = plan({ alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")], lock: transitive("other", "1.0.0") });
    assert.equal(p.alerts[0].status, "not-found");
    assert.deepEqual(p.alerts[0].copies, []);
    assertNoWrites(p);
  });

  it("in lockfile, no copy in range → awaiting-close, and any override is kept", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: transitive("qs", "6.9.4"),
      flat: { qs: ">=6.7.3 <7" },
    });
    assert.equal(p.alerts[0].status, "awaiting-close");
    assert.deepEqual(p.alerts[0].copies, []);
    assertNoWrites(p);
  });

  it("unparseable vulnerable range → blocked unreadable-range, never treated as safe", () => {
    const p = plan({ alerts: [alert(1, "qs", "whenever", "6.7.3")], lock: transitive("qs", "6.7.0") });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].action, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "unreadable-range");
    assertNoWrites(p);
  });

  it("an unreadable alert doesn't stop another alert fixing the same copy", () => {
    const p = plan({
      alerts: [alert(1, "qs", "whenever", "6.9.0"), alert(2, "qs", "< 6.7.3", "6.7.3")],
      lock: transitive("qs", "6.7.0"),
    });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "unreadable-range");
    assert.equal(p.alerts[1].status, "fixed");
    assert.equal(p.targets.get("node_modules/qs"), "6.7.3");
  });

  it("a copy with no readable version is blocked too, never treated as safe", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({ "": {}, "node_modules/qs": {} }),
    });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "unreadable-range");
    assertNoWrites(p);
  });

  it("no first_patched_version → blocked no-fix", () => {
    const p = plan({ alerts: [alert(1, "qs", "< 6.7.3", null)], lock: transitive("qs", "6.7.0") });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].action, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "no-fix");
    assertNoWrites(p);
  });

  it("target not on npm, versions unreadable, or a pre-release → blocked target-unavailable", () => {
    const cases: Array<{ patch: string; published: string[] | null }> = [
      { patch: "6.7.3", published: ["6.7.0", "6.7.4"] },
      { patch: "6.7.3", published: null },
      { patch: "6.7.3-rc.1", published: ["6.7.3-rc.1"] },
    ];
    for (const { patch, published } of cases) {
      const p = plan({
        alerts: [alert(1, "qs", "< 6.7.3", patch)],
        lock: transitive("qs", "6.7.0"),
        published: new Map([["qs", published]]),
      });
      assert.equal(p.alerts[0].status, "blocked");
      assert.equal(p.alerts[0].copies[0].action, "blocked");
      assert.equal(p.alerts[0].copies[0].reason, "target-unavailable");
      assertNoWrites(p);
    }
  });

  it("a package missing from the published map is not assumed published", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: transitive("qs", "6.7.0"),
      published: new Map(),
    });
    assert.equal(p.alerts[0].copies[0].reason, "target-unavailable");
  });

  it("limit wins: @angular/core 21.1.0, patch 22.0.1, limit <22 → blocked limit, detail names the limit", () => {
    const p = plan({
      alerts: [alert(1, "@angular/core", "< 22.0.1", "22.0.1")],
      ...direct("@angular/core", "^21.0.0", "21.1.0"),
      limits: { "@angular/*": "<22" },
    });
    const copy = p.alerts[0].copies[0];
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(copy.action, "blocked");
    assert.equal(copy.reason, "limit");
    assert.match(copy.detail ?? "", /@angular\/\*/);
    assert.match(copy.detail ?? "", /<22/);
    assertNoWrites(p);
  });

  it("every matching limit is checked, and a limit the target satisfies blocks nothing", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: transitive("qs", "6.7.0"),
      limits: { "*": "<7", q: "<1", "q*": "<6.7.3" },
    });
    assert.equal(p.alerts[0].copies[0].reason, "limit");
    assert.match(p.alerts[0].copies[0].detail ?? "", /q\*/);

    const allowed = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: transitive("qs", "6.7.0"),
      limits: { "*": "<7" },
    });
    assert.equal(allowed.alerts[0].status, "fixed");
  });

  it("exact pin → blocked pin, no bump, no override written", () => {
    const p = plan({ alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")], ...direct("qs", "6.7.0", "6.7.0") });
    const copy = p.alerts[0].copies[0];
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(copy.action, "blocked");
    assert.equal(copy.reason, "pin");
    assert.match(copy.detail ?? "", /6\.7\.0/);
    assert.match(copy.detail ?? "", /package\.json/);
    assertNoWrites(p);
  });

  it("a pin in any manifest blocks a copy other manifests declare with a range", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { qs: "^6.5.0" } },
        "packages/a": { name: "a", dependencies: { qs: "6.7.0" } },
        "node_modules/a": { link: true, resolved: "packages/a" },
        "node_modules/qs": { version: "6.7.0" },
      }),
      manifests: [root(dep("qs", "^6.5.0")), member("packages/a", dep("qs", "6.7.0"))],
    });
    assert.equal(p.alerts[0].copies[0].reason, "pin");
    assert.match(p.alerts[0].copies[0].detail ?? "", /packages\/a\/package\.json/);
    assertNoWrites(p);
  });

  it("`>=1.0.0` or `^1 || ^2` declared directly → blocked unrewritable-spec", () => {
    for (const spec of [">=1.0.0", "^1 || ^2", "latest", "github:a/b", "^1.2"]) {
      const p = plan({ alerts: [alert(1, "a", "< 1.2.3", "1.2.3")], ...direct("a", spec, "1.2.0") });
      const copy = p.alerts[0].copies[0];
      assert.equal(p.alerts[0].status, "blocked", spec);
      assert.equal(copy.action, "blocked", spec);
      assert.equal(copy.reason, "unrewritable-spec", spec);
      assert.ok(copy.detail?.includes(spec), spec);
      assertNoWrites(p);
    }
  });

  it("direct 2.4.0, patch 3.0.0, no limit → blocked major-crossing", () => {
    const p = plan({ alerts: [alert(1, "a", "< 3.0.0", "3.0.0")], ...direct("a", "^2.0.0", "2.4.0") });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].action, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "major-crossing");
    assertNoWrites(p);
  });

  it("transitive 0.5.0, patch 0.7.0 → blocked major-crossing", () => {
    const p = plan({ alerts: [alert(1, "a", "< 0.7.0", "0.7.0")], lock: transitive("a", "0.5.0") });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].action, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "major-crossing");
    assertNoWrites(p);
  });

  it("hand-written flat override → blocked; so does one nested under any parent", () => {
    const shapes: Array<Pick<Setup, "flat" | "nested">> = [
      { flat: { qs: "6.7.3" } },
      { flat: { "qs@6": "6.7.3" } },
      { flat: { "qs@5": "5.2.1" } }, // applies to the package, not only to the alerted line
      { flat: { "qs@<6.7.3": "6.7.3" } }, // baseNameOfOverrideKey leaves this shape whole
      { flat: { "qs@>=6.0.0 <6.7.3": "6.8.0" } }, // value isn't the range's upper bound
      { nested: { webpack: { qs: "6.7.3" } } },
      { nested: { "webpack@4": { express: { "qs@6": "6.7.3" } } } },
      { nested: { qs: { ".": "6.7.3", "side-channel": "1.0.0" } } },
    ];
    for (const shape of shapes) {
      const label = JSON.stringify(shape);
      const p = plan({ alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")], lock: transitive("qs", "6.7.0"), ...shape });
      const copy = p.alerts[0].copies[0];
      assert.equal(p.alerts[0].status, "blocked", label);
      assert.equal(copy.action, "blocked", label);
      assert.equal(copy.reason, "hand-written-override", label);
      assert.match(copy.detail ?? "", /qs/, label);
      assertNoWrites(p);
    }
  });

  it("an override naming a different package doesn't block", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: transitive("qs", "6.7.0"),
      flat: { "qs-extra": "1.0.0", "@qs/qs@1": "1.0.0" },
      nested: { webpack: { "loader-utils": "2.0.4" } },
    });
    assert.equal(p.alerts[0].status, "fixed");
  });

  it("direct ^ range → DirectBump with operator ^ and target = patch", () => {
    const p = plan({ alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")], ...direct("qs", "^6.5.0", "6.7.0") });
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.alerts[0].copies[0].action, "bump");
    assert.equal(p.alerts[0].copies[0].target, "6.7.3");
    assert.equal(p.alerts[0].copies[0].reason, undefined);
    assert.deepEqual(p.bumps, [
      {
        manifestDir: "/repo",
        memberPath: null,
        name: "qs",
        field: "dependencies",
        from: "^6.5.0",
        operator: "^",
        target: "6.7.3",
      },
    ]);
    assert.deepEqual(p.addOverrides, {});
    assert.equal(p.targets.get("node_modules/qs"), "6.7.3");
  });

  it("direct ~ range keeps operator ~", () => {
    const p = plan({ alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")], ...direct("qs", "~6.5.0", "6.5.2") });
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.bumps[0].operator, "~");
    assert.equal(p.bumps[0].target, "6.7.3");
    // The manifest's own range is being rewritten, so it isn't left behind.
    assert.deepEqual(p.alerts[0].copies[0].pastDeclared, []);
    assert.deepEqual(p.addOverrides, {});
  });

  it("every manifest resolving to a direct copy gets its own bump, in its own field", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { qs: "^6.5.0" } },
        "packages/a": { name: "a", devDependencies: { qs: "~6.7.0" } },
        "node_modules/a": { link: true, resolved: "packages/a" },
        "node_modules/qs": { version: "6.7.0" },
      }),
      manifests: [root(dep("qs", "^6.5.0")), member("packages/a", dep("qs", "~6.7.0", "devDependencies"))],
    });
    assert.deepEqual(
      p.bumps.map((b) => [b.manifestDir, b.memberPath, b.field, b.operator]),
      [
        ["/repo", null, "dependencies", "^"],
        ["/repo/packages/a", "packages/a", "devDependencies", "~"],
      ],
    );
    assert.deepEqual(p.addOverrides, {});
  });

  it("updateWorkspaceMembers false → member's direct copy blocked unrewritable-spec", () => {
    const setup: Setup = {
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": {},
        "packages/a": { name: "a", dependencies: { qs: "^6.5.0" } },
        "node_modules/a": { link: true, resolved: "packages/a" },
        "node_modules/qs": { version: "6.7.0" },
      }),
      manifests: [root(), member("packages/a", dep("qs", "^6.5.0"))],
    };
    const off = plan({ ...setup, updateWorkspaceMembers: false });
    assert.equal(off.alerts[0].status, "blocked");
    assert.equal(off.alerts[0].copies[0].action, "blocked");
    assert.equal(off.alerts[0].copies[0].reason, "unrewritable-spec");
    assert.match(off.alerts[0].copies[0].detail ?? "", /packages\/a/);
    assertNoWrites(off);

    const on = plan({ ...setup, updateWorkspaceMembers: true });
    assert.equal(on.alerts[0].status, "fixed");
    assert.equal(on.bumps[0].memberPath, "packages/a");
  });

  it("transitive → override keyed to the vulnerable versions", () => {
    const p = plan({ alerts: [alert(7, "qs", "< 6.7.3", "6.7.3")], lock: transitive("qs", "6.7.0") });
    const outcome = p.alerts[0];
    assert.equal(outcome.number, 7);
    assert.equal(outcome.url, "https://example.test/alerts/7");
    assert.equal(outcome.packageName, "qs");
    assert.equal(outcome.severity, "high");
    assert.equal(outcome.scope, "production");
    assert.equal(outcome.status, "fixed");
    assert.deepEqual(outcome.copies, [
      { path: "node_modules/qs", version: "6.7.0", action: "override", target: "6.7.3", pastDeclared: [] },
    ]);
    assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.7.3": "6.7.3" });
    assert.deepEqual(p.bumps, []);
    assert.deepEqual([...p.targets], [["node_modules/qs", "6.7.3"]]);
  });

  it("safe copies are ignored: they neither move nor block", () => {
    const p = plan({
      alerts: [alert(1, "qs", ">= 6.5.0, < 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { qs: "6.9.4" } },
        "node_modules/a/node_modules/qs": { version: "6.9.4" },
        "node_modules/b": { version: "1.0.0", dependencies: { qs: "^6.7.0" } },
        "node_modules/qs": { version: "6.7.0" },
      }),
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.deepEqual(
      p.alerts[0].copies.map((c) => c.path),
      ["node_modules/qs"],
    );
    assert.deepEqual([...p.targets], [["node_modules/qs", "6.7.3"]]);
  });

  it("dismissed and fixed alerts are ignored for fixing", () => {
    const dismissed = { ...alert(1, "qs", "< 6.7.3", "6.7.3"), state: "dismissed" as const };
    const fixed = { ...alert(2, "qs", "< 6.7.3", "6.7.3"), state: "fixed" as const };
    const p = plan({ alerts: [dismissed, fixed], lock: transitive("qs", "6.7.0") });
    assert.deepEqual(p.alerts, []);
    assertNoWrites(p);
  });

  describe("row order", () => {
    it("no-fix comes before a pin", () => {
      const p = plan({ alerts: [alert(1, "qs", "< 6.7.3", null)], ...direct("qs", "6.7.0", "6.7.0") });
      assert.equal(p.alerts[0].copies[0].reason, "no-fix");
    });
    it("a limit comes before a pin", () => {
      const p = plan({
        alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
        ...direct("qs", "6.7.0", "6.7.0"),
        limits: { qs: "<6.7.0" },
      });
      assert.equal(p.alerts[0].copies[0].reason, "limit");
    });
    it("an unrewritable spec comes before a major crossing", () => {
      const p = plan({ alerts: [alert(1, "a", "< 3.0.0", "3.0.0")], ...direct("a", ">=2.0.0", "2.4.0") });
      assert.equal(p.alerts[0].copies[0].reason, "unrewritable-spec");
    });
    it("a major crossing comes before a hand-written override", () => {
      const p = plan({
        alerts: [alert(1, "a", "< 3.0.0", "3.0.0")],
        ...direct("a", "^2.0.0", "2.4.0"),
        flat: { a: "2.5.0" },
      });
      assert.equal(p.alerts[0].copies[0].reason, "major-crossing");
    });
  });
});

describe("override keys", () => {
  it("is never open below", () => {
    assert.equal(selectorKey("qs", null, "6.7.3"), "qs@>=6.0.0 <6.7.3");
    assert.equal(selectorKey("a", "0.5.1", "0.5.3"), "a@>=0.5.1 <0.5.3");
    assert.equal(selectorKey("a", null, "0.5.3"), "a@>=0.5.0 <0.5.3");
    assert.equal(selectorKey("js-yaml", "4.0.0", "4.1.1"), "js-yaml@>=4.0.0 <4.1.1");
  });

  it("takes the higher of the advisory's bound and the line's start", () => {
    assert.equal(selectorKey("qs", "5.0.0", "6.7.3"), "qs@>=6.0.0 <6.7.3");
    assert.equal(selectorKey("qs", "6.5.0", "6.7.3"), "qs@>=6.5.0 <6.7.3");
  });

  it("always writes both bounds in three parts, so the agent recognises its own key", () => {
    assert.equal(selectorKey("a", "21", "21.1.0"), "a@>=21.0.0 <21.1.0");
    assert.equal(selectorKey("a", "21.0.0-next.0", "21.1.0"), "a@>=21.0.0 <21.1.0");
    assert.equal(selectorKey("a", null, "2.1"), "a@>=2.0.0 <2.1.0");
    assert.equal(isAgentAuthoredOverride(selectorKey("a", "21.0.0-next.0", "21.1.0"), "21.1.0"), true);
  });

  it("keeps a partial patch identifier's key and value in step", () => {
    const p = plan({
      alerts: [alert(1, "a", "< 2.1", "2.1")],
      lock: transitive("a", "2.0.0"),
      published: new Map([["a", ["2.0.0", "2.1.0"]]]),
    });
    assert.deepEqual(p.addOverrides, { "a@>=2.0.0 <2.1.0": "2.1.0" });
    assert.equal(p.alerts[0].copies[0].target, "2.1.0");
  });

  it("every key the plan writes reads back as agent-authored and under the package's name", () => {
    const p = plan({ alerts: [alert(1, "@babel/core", ">= 7.0.0, < 7.2.0", "7.2.0")], lock: transitive("@babel/core", "7.1.0") });
    const [[key, value]] = Object.entries(p.addOverrides);
    assert.equal(key, "@babel/core@>=7.0.0 <7.2.0");
    assert.equal(value, "7.2.0");
    assert.equal(isAgentAuthoredOverride(key, value), true);
    assert.equal(baseNameOfOverrideKey(key), "@babel/core");
  });

  it("converts GitHub's range form, including the lower-bound shapes", () => {
    const cases: Array<[string, string, string]> = [
      [">= 4.0.0, < 4.1.1", "4.0.5", "a@>=4.0.0 <4.1.1"],
      ["> 4.0.0, < 4.1.1", "4.0.5", "a@>=4.0.1 <4.1.1"],
      ["= 4.0.5", "4.0.5", "a@>=4.0.5 <4.1.1"],
      ["<= 4.1.0", "4.0.5", "a@>=4.0.0 <4.1.1"],
      [">= 3.0.0, < 4.1.1", "4.0.5", "a@>=4.0.0 <4.1.1"],
    ];
    for (const [range, version, key] of cases) {
      const p = plan({ alerts: [alert(1, "a", range, "4.1.1")], lock: transitive("a", version) });
      assert.deepEqual(p.addOverrides, { [key]: "4.1.1" }, range);
    }
  });

  it("does not catch a 5.x copy when fixing 6.x", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { qs: "^5.0.0" } },
        "node_modules/a/node_modules/qs": { version: "5.2.0" },
        "node_modules/b": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
        "node_modules/qs": { version: "6.1.0" },
      }),
    });
    const byPath = new Map(p.alerts[0].copies.map((c) => [c.path, c]));
    assert.equal(byPath.get("node_modules/a/node_modules/qs")?.action, "blocked");
    assert.equal(byPath.get("node_modules/a/node_modules/qs")?.reason, "major-crossing");
    assert.equal(byPath.get("node_modules/qs")?.action, "override");
    assert.equal(p.alerts[0].status, "partly-fixed");
    assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.7.3": "6.7.3" });
    assert.deepEqual([...p.targets], [["node_modules/qs", "6.7.3"]]);
  });

  it("writes one key per release line for two majors", () => {
    const p = plan({
      alerts: [alert(1, "minimatch", "< 3.1.3", "3.1.3"), alert(2, "minimatch", ">= 5.0.0, < 5.1.7", "5.1.7")],
      lock: makeLock({
        "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { minimatch: "^3.0.0" } },
        "node_modules/minimatch": { version: "3.0.4" },
        "node_modules/b": { version: "1.0.0", dependencies: { minimatch: "^5.0.0" } },
        "node_modules/b/node_modules/minimatch": { version: "5.1.0" },
      }),
    });
    assert.deepEqual(p.addOverrides, {
      "minimatch@>=3.0.0 <3.1.3": "3.1.3",
      "minimatch@>=5.0.0 <5.1.7": "5.1.7",
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.alerts[1].status, "fixed");
    assert.equal(p.targets.get("node_modules/minimatch"), "3.1.3");
    assert.equal(p.targets.get("node_modules/b/node_modules/minimatch"), "5.1.7");
  });

  it("treats 0.x minors as separate release lines", () => {
    const p = plan({
      alerts: [alert(1, "a", "< 0.5.3", "0.5.3"), alert(2, "a", ">= 0.6.0, < 0.6.2", "0.6.2")],
      lock: makeLock({
        "": { dependencies: { x: "^1.0.0", y: "^1.0.0" } },
        "node_modules/x": { version: "1.0.0", dependencies: { a: "^0.5.0" } },
        "node_modules/a": { version: "0.5.0" },
        "node_modules/y": { version: "1.0.0", dependencies: { a: "^0.6.0" } },
        "node_modules/y/node_modules/a": { version: "0.6.1" },
      }),
    });
    assert.deepEqual(p.addOverrides, { "a@>=0.5.0 <0.5.3": "0.5.3", "a@>=0.6.0 <0.6.2": "0.6.2" });
  });

  it("lineStart follows the caret rules", () => {
    assert.equal(lineStart("6.7.3"), "6.0.0");
    assert.equal(lineStart("0.5.3"), "0.5.0");
    assert.equal(lineStart("0.0.3"), "0.0.3");
  });
});

describe("matchesLimit", () => {
  it("matches an exact name", () => {
    assert.equal(matchesLimit("qs", "qs"), true);
    assert.equal(matchesLimit("qs", "q"), false);
    assert.equal(matchesLimit("qs-extra", "qs"), false);
  });
  it("treats * as a wildcard across any characters, including /", () => {
    assert.equal(matchesLimit("@angular/core", "@angular/*"), true);
    assert.equal(matchesLimit("@angular/core", "*"), true);
    assert.equal(matchesLimit("@angular/core", "@*/core"), true);
    assert.equal(matchesLimit("a/b/c", "a*c"), true);
    assert.equal(matchesLimit("@angular-devkit/core", "@angular/*"), false);
  });
  it("treats every other character literally", () => {
    assert.equal(matchesLimit("lodash.merge", "lodash.*"), true);
    assert.equal(matchesLimit("lodashxmerge", "lodash.*"), false);
    assert.equal(matchesLimit("a+b", "a+b"), true);
    assert.equal(matchesLimit("aab", "a+b"), false);
  });
});

describe("partial and mixed outcomes", () => {
  it("fixes the fixable copy and blocks the other → partly-fixed", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { a: "^1.0.0", qs: "5.2.0" } },
        "node_modules/qs": { version: "5.2.0" },
        "node_modules/a": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
        "node_modules/a/node_modules/qs": { version: "6.1.0" },
      }),
      manifests: [root(dep("a", "^1.0.0"), dep("qs", "5.2.0"))],
    });
    const byPath = new Map(p.alerts[0].copies.map((c) => [c.path, c]));
    assert.equal(p.alerts[0].status, "partly-fixed");
    assert.equal(byPath.get("node_modules/qs")?.reason, "pin");
    assert.equal(byPath.get("node_modules/a/node_modules/qs")?.action, "override");
    assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.7.3": "6.7.3" });
    assert.deepEqual([...p.targets], [["node_modules/a/node_modules/qs", "6.7.3"]]);
  });

  it("direct bump also writes a selector when a parent pins the old version exactly", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { qs: "^6.5.0", express: "^4.0.0" } },
        "node_modules/qs": { version: "6.7.0" },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "6.7.0" } },
      }),
      manifests: [root(dep("qs", "^6.5.0"), dep("express", "^4.0.0"))],
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.alerts[0].copies[0].action, "bump");
    assert.equal(p.bumps.length, 1);
    assert.equal(p.bumps[0].target, "6.7.3");
    assert.equal(p.addOverrides["qs@>=6.0.0 <6.7.3"], "6.7.3");
    assert.deepEqual(p.alerts[0].copies[0].pastDeclared, [{ dependent: "express", range: "6.7.0" }]);
  });

  it("a direct bump needs no selector when every other dependent already accepts the target", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { qs: "^6.5.0", express: "^4.0.0" } },
        "node_modules/qs": { version: "6.7.0" },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "^6.5.0" } },
      }),
      manifests: [root(dep("qs", "^6.5.0"), dep("express", "^4.0.0"))],
    });
    assert.equal(p.bumps.length, 1);
    assert.deepEqual(p.addOverrides, {});
  });

  it("uses the highest target within a limit; the higher alert is blocked, the lower fixed", () => {
    const p = plan({
      alerts: [alert(1, "a", "< 3.1.0", "3.1.0"), alert(2, "a", "< 3.6.0", "3.6.0")],
      lock: transitive("a", "3.0.0"),
      limits: { a: "<3.5.0" },
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.alerts[0].copies[0].target, "3.1.0");
    assert.equal(p.alerts[1].status, "blocked");
    assert.equal(p.alerts[1].copies[0].action, "blocked");
    assert.equal(p.alerts[1].copies[0].reason, "limit");
    assert.deepEqual(p.addOverrides, { "a@>=3.0.0 <3.1.0": "3.1.0" });
    assert.equal(p.targets.get("node_modules/a"), "3.1.0");
  });

  it("a blocked alert's open lower bound doesn't widen the selector", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.0.5, < 3.1.0", "3.1.0"), alert(2, "a", "< 3.6.0", "3.6.0")],
      lock: transitive("a", "3.0.7"),
      limits: { a: "<3.5.0" },
    });
    assert.deepEqual(p.addOverrides, { "a@>=3.0.5 <3.1.0": "3.1.0" });
    assert.equal(p.alerts[1].status, "blocked");
  });

  it("takes the highest patch on a line for every copy on it", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.0.0, < 3.2.0", "3.2.0"), alert(2, "a", ">= 3.4.0, < 3.5.0", "3.5.0")],
      lock: makeLock({
        "": { dependencies: { x: "^1.0.0", y: "^1.0.0" } },
        "node_modules/x": { version: "1.0.0", dependencies: { a: "3.1.0" } },
        "node_modules/a": { version: "3.1.0" },
        "node_modules/y": { version: "1.0.0", dependencies: { a: "3.4.0" } },
        "node_modules/y/node_modules/a": { version: "3.4.0" },
      }),
    });
    assert.deepEqual(p.addOverrides, { "a@>=3.0.0 <3.5.0": "3.5.0" });
    assert.equal(p.targets.get("node_modules/a"), "3.5.0");
    assert.equal(p.targets.get("node_modules/y/node_modules/a"), "3.5.0");
    // Each alert lists the copy in its own range, not every copy on the line.
    assert.deepEqual(
      p.alerts[0].copies.map((c) => c.path),
      ["node_modules/a"],
    );
    assert.deepEqual(
      p.alerts[1].copies.map((c) => c.path),
      ["node_modules/y/node_modules/a"],
    );
  });

  it("a copy already at or above its alert's patch is blocked, never moved down", () => {
    const p = plan({ alerts: [alert(1, "a", ">= 3.0.0, <= 3.5.0", "3.5.0")], lock: transitive("a", "3.5.0") });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "target-unavailable");
    assertNoWrites(p);
  });

  it("a copy above a limited line's target keeps its own alert's reason", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.0.0, < 3.1.0", "3.1.0"), alert(2, "a", ">= 3.4.0, < 3.6.0", "3.6.0")],
      lock: makeLock({
        "": { dependencies: { x: "^1.0.0", y: "^1.0.0" } },
        "node_modules/x": { version: "1.0.0", dependencies: { a: "3.0.0" } },
        "node_modules/a": { version: "3.0.0" },
        "node_modules/y": { version: "1.0.0", dependencies: { a: "3.5.0" } },
        "node_modules/y/node_modules/a": { version: "3.5.0" },
      }),
      limits: { a: "<3.6.0" },
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.alerts[1].status, "blocked");
    assert.equal(p.alerts[1].copies[0].reason, "limit");
    assert.deepEqual([...p.targets], [["node_modules/a", "3.1.0"]]);
    assert.deepEqual(p.addOverrides, { "a@>=3.0.0 <3.1.0": "3.1.0" });
  });

  it("keeps each alert's outcome in input order across packages", () => {
    const p = plan({
      alerts: [alert(3, "b", "< 1.0.0", "1.0.0"), alert(1, "a", "< 1.0.0", "1.0.0"), alert(2, "b", "< 2.0.0", "2.0.0")],
      lock: transitive("zzz", "1.0.0"),
    });
    assert.deepEqual(
      p.alerts.map((o) => o.number),
      [3, 1, 2],
    );
  });
});

describe("selector conflicts", () => {
  it("blocks with selector-conflict when a safe copy's declared range overlaps the selector", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": {},
        "packages/a": { name: "a", dependencies: { qs: "^6.5.0", express: "^4.0.0" } },
        "node_modules/a": { link: true, resolved: "packages/a" },
        "node_modules/qs": { version: "6.9.4" },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "6.7.0" } },
        "node_modules/express/node_modules/qs": { version: "6.7.0" },
      }),
      manifests: [root(), member("packages/a", dep("qs", "^6.5.0"), dep("express", "^4.0.0"))],
    });
    const copy = p.alerts[0].copies[0];
    assert.equal(copy.path, "node_modules/express/node_modules/qs");
    assert.equal(copy.action, "blocked");
    assert.equal(copy.reason, "selector-conflict");
    assert.match(copy.detail ?? "", /\^6\.5\.0/);
    assert.match(copy.detail ?? "", /\ba\b/);
    assert.equal(p.alerts[0].status, "blocked");
    assertNoWrites(p);
    assert.equal(p.targets.has("node_modules/qs"), false);
  });

  it("no conflict when the advisory's lower bound keeps the safe copy's range clear", () => {
    const p = plan({
      alerts: [alert(1, "qs", ">= 6.7.0, < 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { a: "^1.0.0", express: "^4.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { qs: "6.5.0" } },
        "node_modules/qs": { version: "6.5.0" },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "6.7.0" } },
        "node_modules/express/node_modules/qs": { version: "6.7.0" },
      }),
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.deepEqual(p.addOverrides, { "qs@>=6.7.0 <6.7.3": "6.7.3" });
  });

  it("blocks with selector-conflict when a pinned direct copy shares the version", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": {},
        "packages/a": { name: "a", dependencies: { qs: "6.7.0", express: "^4.0.0" } },
        "packages/b": { name: "b", dependencies: { express: "^4.0.0" } },
        "node_modules/a": { link: true, resolved: "packages/a" },
        "node_modules/b": { link: true, resolved: "packages/b" },
        "packages/a/node_modules/qs": { version: "6.7.0" },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "^6.0.0" } },
        "node_modules/qs": { version: "6.7.0" },
      }),
      manifests: [
        root(),
        member("packages/a", dep("qs", "6.7.0"), dep("express", "^4.0.0")),
        member("packages/b", dep("express", "^4.0.0")),
      ],
    });
    const byPath = new Map(p.alerts[0].copies.map((c) => [c.path, c]));
    assert.equal(byPath.get("packages/a/node_modules/qs")?.reason, "pin");
    assert.equal(byPath.get("node_modules/qs")?.action, "blocked");
    assert.equal(byPath.get("node_modules/qs")?.reason, "selector-conflict");
    assert.match(byPath.get("node_modules/qs")?.detail ?? "", /6\.7\.0/);
    assert.equal(p.alerts[0].status, "blocked");
    assertNoWrites(p);
  });

  it("a peer edge to a safe copy conflicts too: npm matches on the declared range", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { plugin: "^1.0.0", express: "^4.0.0" } },
        "node_modules/plugin": { version: "1.0.0", peerDependencies: { qs: "^6.0.0" } },
        "node_modules/qs": { version: "6.9.4" },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "6.7.0" } },
        "node_modules/express/node_modules/qs": { version: "6.7.0" },
      }),
    });
    assert.equal(p.alerts[0].copies[0].reason, "selector-conflict");
    assertNoWrites(p);
  });

  it("an edge that resolves to nothing has no copy to catch", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { plugin: "^1.0.0", express: "^4.0.0" } },
        // qs is only nested under express, so the plugin's optional peer resolves to nothing.
        "node_modules/plugin": {
          version: "1.0.0",
          peerDependencies: { qs: "^6.0.0" },
          peerDependenciesMeta: { qs: { optional: true } },
        },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "6.7.0" } },
        "node_modules/express/node_modules/qs": { version: "6.7.0" },
      }),
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.7.3": "6.7.3" });
  });

  it("an edge whose spec isn't a valid semver range doesn't intersect, and doesn't throw", () => {
    for (const spec of ["latest", "file:../qs", "github:a/b", "workspace:*"]) {
      const p = plan({
        alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
        lock: makeLock({
          "": { dependencies: { a: "^1.0.0", express: "^4.0.0" } },
          "node_modules/a": { version: "1.0.0", dependencies: { qs: spec } },
          "node_modules/a/node_modules/qs": { version: "6.9.4" },
          "node_modules/express": { version: "4.0.0", dependencies: { qs: "6.7.0" } },
          "node_modules/qs": { version: "6.7.0" },
        }),
      });
      assert.equal(p.alerts[0].status, "fixed", spec);
      assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.7.3": "6.7.3" }, spec);
      assert.equal(p.targets.has("node_modules/a/node_modules/qs"), false, spec);
    }
  });

  it("blocks when a copy staying put sits inside the selector, even with no readable edge", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { qs: "npm:qs@6.7.0", express: "^4.0.0" } },
        "node_modules/qs": { version: "6.7.0" },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "6.7.1" } },
        "node_modules/express/node_modules/qs": { version: "6.7.1" },
      }),
      manifests: [root(dep("qs", "npm:qs@6.7.0"), dep("express", "^4.0.0"))],
    });
    const byPath = new Map(p.alerts[0].copies.map((c) => [c.path, c]));
    assert.equal(byPath.get("node_modules/qs")?.reason, "unrewritable-spec");
    assert.equal(byPath.get("node_modules/express/node_modules/qs")?.reason, "selector-conflict");
    assertNoWrites(p);
  });

  it("blocks a direct copy whose fix needs the selector, rather than bumping it halfway", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { qs: "^6.5.0", express: "^4.0.0", y: "^1.0.0" } },
        "node_modules/qs": { version: "6.7.0" },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "6.7.0" } },
        "node_modules/y": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
        "node_modules/y/node_modules/qs": { version: "6.9.0" },
      }),
      manifests: [root(dep("qs", "^6.5.0"), dep("express", "^4.0.0"), dep("y", "^1.0.0"))],
    });
    assert.equal(p.alerts[0].copies[0].reason, "selector-conflict");
    assert.equal(p.alerts[0].status, "blocked");
    assertNoWrites(p);
  });

  it("a direct copy that needs no selector still bumps, to its own earliest fix", () => {
    const p = plan({
      alerts: [alert(1, "qs", ">= 6.7.0, < 6.7.3", "6.7.3"), alert(2, "qs", ">= 6.8.0, < 6.8.5", "6.8.5")],
      lock: makeLock({
        "": { dependencies: { qs: "^6.5.0", x: "^1.0.0", y: "^1.0.0" } },
        "node_modules/qs": { version: "6.7.0" },
        "node_modules/x": { version: "1.0.0", dependencies: { qs: "6.8.0" } },
        "node_modules/x/node_modules/qs": { version: "6.8.0" },
        "node_modules/y": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
        "node_modules/y/node_modules/qs": { version: "6.9.0" },
      }),
      manifests: [root(dep("qs", "^6.5.0"), dep("x", "^1.0.0"), dep("y", "^1.0.0"))],
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.alerts[0].copies[0].target, "6.7.3");
    assert.equal(p.alerts[1].status, "blocked");
    assert.equal(p.alerts[1].copies[0].reason, "selector-conflict");
    assert.deepEqual(
      p.bumps.map((b) => b.target),
      ["6.7.3"],
    );
    assert.deepEqual(p.addOverrides, {});
    assert.deepEqual([...p.targets], [["node_modules/qs", "6.7.3"]]);
  });

  it("a conflict on one line doesn't touch another line", () => {
    const p = plan({
      alerts: [alert(1, "qs", ">= 5.0.0, < 5.3.0", "5.3.0"), alert(2, "qs", ">= 6.0.0, < 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { a: "^1.0.0", b: "^1.0.0", c: "^1.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { qs: "^5.0.0" } },
        "node_modules/a/node_modules/qs": { version: "5.2.0" },
        "node_modules/b": { version: "1.0.0", dependencies: { qs: "6.7.0" } },
        "node_modules/b/node_modules/qs": { version: "6.7.0" },
        "node_modules/c": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
        "node_modules/qs": { version: "6.9.0" },
      }),
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.alerts[1].status, "blocked");
    assert.equal(p.alerts[1].copies[0].reason, "selector-conflict");
    assert.deepEqual(p.addOverrides, { "qs@>=5.0.0 <5.3.0": "5.3.0" });
  });
});

describe("raising the target", () => {
  const lowAlert = () => alert(1, "a", "< 3.1.0", "3.1.0");
  const highAlert = () => alert(2, "a", ">= 3.1.0, < 3.6.0", "3.6.0");

  it("raises the target when it falls inside another open alert's range", () => {
    const p = plan({ alerts: [lowAlert(), highAlert()], lock: transitive("a", "3.0.0") });
    assert.equal(p.targets.get("node_modules/a"), "3.6.0");
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.alerts[1].status, "fixed");
    assert.equal(p.alerts[1].copies[0].target, "3.6.0");
    assert.deepEqual(p.addOverrides, { "a@>=3.0.0 <3.6.0": "3.6.0" });
  });

  it("keeps raising until the target is outside every range", () => {
    const p = plan({
      alerts: [lowAlert(), highAlert(), alert(3, "a", ">= 3.6.0, < 3.8.0", "3.8.0")],
      lock: transitive("a", "3.0.0"),
    });
    assert.equal(p.targets.get("node_modules/a"), "3.8.0");
    assert.deepEqual(
      p.alerts.map((o) => o.status),
      ["fixed", "fixed", "fixed"],
    );
  });

  it("reports the second alert blocked if raising the target would break a limit", () => {
    const p = plan({ alerts: [lowAlert(), highAlert()], lock: transitive("a", "3.0.0"), limits: { a: "<3.5.0" } });
    assert.equal(p.targets.get("node_modules/a"), "3.1.0");
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.alerts[1].status, "blocked");
    assert.equal(p.alerts[1].copies[0].path, "node_modules/a");
    assert.equal(p.alerts[1].copies[0].reason, "limit");
    assert.deepEqual(p.addOverrides, { "a@>=3.0.0 <3.1.0": "3.1.0" });
  });

  it("a blocked alert doesn't hide another alert the target falls inside", () => {
    const p = plan({
      alerts: [lowAlert(), highAlert(), alert(3, "a", ">= 3.1.0, < 3.4.0", "3.4.0")],
      lock: transitive("a", "3.0.0"),
      limits: { a: "<3.5.0" },
    });
    assert.equal(p.targets.get("node_modules/a"), "3.4.0");
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.alerts[1].status, "blocked");
    assert.equal(p.alerts[2].status, "fixed");
  });

  it("an alert the target clears is fixed, even with no patch of its own", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.1.0, < 3.4.0", "3.4.0"), alert(2, "a", ">= 3.1.0, < 3.2.0", null)],
      lock: transitive("a", "3.1.5"),
    });
    assert.equal(p.targets.get("node_modules/a"), "3.4.0");
    assert.equal(p.alerts[1].status, "fixed");
    assert.equal(p.alerts[1].copies[0].action, "override");
  });

  it("a raise across a major is blocked, and the lower fix still happens", () => {
    const p = plan({
      alerts: [lowAlert(), alert(2, "a", ">= 3.1.0, < 4.0.0", "4.0.0")],
      lock: transitive("a", "3.0.0"),
    });
    assert.equal(p.targets.get("node_modules/a"), "3.1.0");
    assert.equal(p.alerts[1].status, "blocked");
    assert.equal(p.alerts[1].copies[0].reason, "major-crossing");
  });

  it("an alert raised into falls back to awaiting-close if the copy can't move after all", () => {
    const p = plan({
      alerts: [lowAlert(), highAlert()],
      lock: makeLock({
        "": { dependencies: { x: "^1.0.0", y: "^1.0.0" } },
        "node_modules/x": { version: "1.0.0", dependencies: { a: "3.0.0" } },
        "node_modules/a": { version: "3.0.0" },
        "node_modules/y": { version: "1.0.0", dependencies: { a: "^3.0.0" } },
        "node_modules/y/node_modules/a": { version: "3.7.0" },
      }),
    });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "selector-conflict");
    assert.equal(p.alerts[1].status, "awaiting-close");
    assertNoWrites(p);
  });
});

describe("existing overrides", () => {
  it("replaces an agent floating key on an alerted package", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: transitive("qs", "6.7.0"),
      flat: { qs: ">=6.7.3 <7" },
    });
    assert.deepEqual(p.removeOverrideKeys, ["qs"]);
    assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.7.3": "6.7.3" });
    assert.equal(p.alerts[0].status, "fixed");
  });

  it("leaves an agent floating key alone with no open alert", () => {
    const p = plan({
      alerts: [{ ...alert(1, "qs", "< 6.7.3", "6.7.3"), state: "dismissed" }],
      lock: transitive("qs", "6.7.0"),
      flat: { qs: ">=6.7.3 <7" },
    });
    assertNoWrites(p);
  });

  it("is idempotent: the exact key already present produces no add or remove", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: transitive("qs", "6.7.0"),
      flat: { "qs@>=6.0.0 <6.7.3": "6.7.3" },
    });
    assert.deepEqual(p.addOverrides, {});
    assert.deepEqual(p.removeOverrideKeys, []);
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.targets.get("node_modules/qs"), "6.7.3");
  });

  it("replaces a lower selector on the same line, which would overlap the new one", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.8.0", "6.8.0")],
      lock: transitive("qs", "6.7.3"),
      flat: { "qs@>=6.0.0 <6.7.3": "6.7.3" },
    });
    assert.deepEqual(p.removeOverrideKeys, ["qs@>=6.0.0 <6.7.3"]);
    assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.8.0": "6.8.0" });
  });

  it("keeps a selector from an earlier run on a line this run doesn't touch", () => {
    const p = plan({
      alerts: [alert(1, "minimatch", ">= 5.0.0, < 5.1.7", "5.1.7")],
      lock: transitive("minimatch", "5.1.0"),
      flat: { "minimatch@>=3.0.0 <3.1.3": "3.1.3" },
    });
    assert.deepEqual(p.removeOverrideKeys, []);
    assert.deepEqual(p.addOverrides, { "minimatch@>=5.0.0 <5.1.7": "5.1.7" });
  });

  it("keeps a floating key on a line this run doesn't touch", () => {
    const p = plan({
      alerts: [alert(1, "js-yaml", ">= 4.0.0, < 4.1.1", "4.1.1")],
      lock: transitive("js-yaml", "4.0.5"),
      flat: { "js-yaml@3": ">=3.14.2 <4", "js-yaml@4": ">=4.0.9 <5" },
    });
    assert.deepEqual(p.removeOverrideKeys, ["js-yaml@4"]);
    assert.deepEqual(p.addOverrides, { "js-yaml@>=4.0.0 <4.1.1": "4.1.1" });
  });

  it("removes nothing on a package with no fixed copy", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 7.0.0", "7.0.0")],
      lock: transitive("qs", "6.7.0"),
      flat: { qs: ">=6.5.0 <7" },
    });
    assert.equal(p.alerts[0].status, "blocked");
    assertNoWrites(p);
  });

  it("never touches another package's keys", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: transitive("qs", "6.7.0"),
      flat: { "qs-extra": ">=1.0.0 <2", lodash: "4.17.21" },
    });
    assert.deepEqual(p.removeOverrideKeys, []);
  });
});

describe("past a declared range", () => {
  it("flags a same-major fix past a parent's exact pin", () => {
    const p = plan({
      alerts: [alert(1, "picomatch", "< 4.0.4", "4.0.4")],
      lock: makeLock({
        "": { dependencies: { "@angular/build": "^21.0.0" } },
        "node_modules/@angular/build": { version: "21.0.0", dependencies: { picomatch: "4.0.3" } },
        "node_modules/picomatch": { version: "4.0.3" },
      }),
    });
    const copy = p.alerts[0].copies[0];
    assert.equal(copy.action, "override");
    assert.deepEqual(copy.pastDeclared, [{ dependent: "@angular/build", range: "4.0.3" }]);
    assert.equal(p.alerts[0].status, "fixed");
  });

  it("flags nothing when every dependent's range admits the target", () => {
    const p = plan({ alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")], lock: transitive("qs", "6.7.0") });
    assert.deepEqual(p.alerts[0].copies[0].pastDeclared, []);
  });

  it("names a dependent once when two of its copies declare the same range", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { a: "^1.0.0", b: "^1.0.0" } },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/b": { version: "1.0.0" },
        "node_modules/a/node_modules/p": { version: "1.0.0", dependencies: { qs: "6.7.0" } },
        "node_modules/b/node_modules/p": { version: "1.0.0", dependencies: { qs: "6.7.0" } },
        "node_modules/qs": { version: "6.7.0" },
      }),
    });
    assert.deepEqual(p.alerts[0].copies[0].pastDeclared, [{ dependent: "p", range: "6.7.0" }]);
  });

  it("makes no claim about a spec that isn't a range", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { a: "^1.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { qs: "latest" } },
        "node_modules/qs": { version: "6.7.0" },
      }),
    });
    assert.deepEqual(p.alerts[0].copies[0].pastDeclared, []);
  });

  it("is empty on a blocked copy", () => {
    const p = plan({
      alerts: [alert(1, "picomatch", "< 5.0.0", "5.0.0")],
      lock: makeLock({
        "": { dependencies: { a: "^1.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { picomatch: "4.0.3" } },
        "node_modules/picomatch": { version: "4.0.3" },
      }),
    });
    assert.deepEqual(p.alerts[0].copies[0].pastDeclared, []);
    assert.equal(p.alerts[0].copies[0].target, undefined);
  });
});

describe("readNpmOverrides", () => {
  function withManifest(contents: string | null, check: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "npm-overrides-"));
    try {
      if (contents !== null) writeFileSync(join(dir, "package.json"), contents);
      check(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("splits string overrides from nested ones", () => {
    const manifest = JSON.stringify({
      overrides: { qs: "6.7.3", "a@>=1.0.0 <1.2.0": "1.2.0", webpack: { "loader-utils": "2.0.4" } },
    });
    withManifest(manifest, (dir) => {
      assert.deepEqual(readNpmOverrides(dir), {
        flat: { qs: "6.7.3", "a@>=1.0.0 <1.2.0": "1.2.0" },
        nested: { webpack: { "loader-utils": "2.0.4" } },
      });
    });
  });

  it("returns empty maps with no overrides block", () => {
    withManifest(JSON.stringify({ name: "x" }), (dir) => {
      assert.deepEqual(readNpmOverrides(dir), { flat: {}, nested: {} });
    });
  });

  it("stops with a clear error when there's no package.json", () => {
    withManifest(null, (dir) => {
      assert.throws(() => readNpmOverrides(dir), AgentError);
    });
  });
});
