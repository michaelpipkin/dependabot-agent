import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DirectDep } from "../src/manifest.js";
import { readNpmOverrides } from "../src/override-source.js";
import { isAgentAuthoredOverride, selectorKeyName } from "../src/targeted/override-keys.js";
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
  manifestPrefix?: string;
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
    manifestPrefix: setup.manifestPrefix,
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

describe("an alert on a package.json whose copy is already safe", () => {
  // Live: alerts keyed to a member's exact pin stayed open for months after the lockfile moved.
  const on = (manifest: string): DependabotAlert => {
    const a = alert(1, "qs", "< 6.7.3", "6.7.3");
    return { ...a, dependency: { ...a.dependency, manifest_path: manifest } };
  };
  const safe = transitive("qs", "6.9.4");

  it("is blocked by the pin while that pin is in the vulnerable range, and nothing is written", () => {
    const p = plan({ alerts: [on("packages/a/package.json")], lock: safe, manifests: [root(), member("packages/a", dep("qs", "6.5.0"))] });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "pin");
    assert.match(p.alerts[0].copies[0].detail ?? "", /Pinned at "6\.5\.0" in packages\/a\/package\.json.*stays open/);
    assert.equal(p.alerts[0].manifest, "packages/a/package.json");
    assertNoWrites(p);
  });

  it("finds the manifest under an isolated package's directory", () => {
    const p = plan({ alerts: [on("functions/packages/a/package.json")], lock: safe, manifests: [root(), member("packages/a", dep("qs", "=6.5.0"))], manifestPrefix: "functions" });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "pin");
  });

  it("is blocked at the root too", () => {
    const p = plan({ alerts: [on("package.json")], lock: safe, manifests: [root(dep("qs", "6.5.0"))] });
    assert.equal(p.alerts[0].status, "blocked");
  });

  const stillAwaiting: Array<[string, () => Plan]> = [
    ["a range", () => plan({ alerts: [on("packages/a/package.json")], lock: safe, manifests: [root(), member("packages/a", dep("qs", "^6.5.0"))] })],
    ["a pin that's out of the range", () => plan({ alerts: [on("packages/a/package.json")], lock: safe, manifests: [root(), member("packages/a", dep("qs", "6.9.4"))] })],
    ["a pin in another manifest", () => plan({ alerts: [on("packages/a/package.json")], lock: safe, manifests: [root(), member("packages/a"), member("packages/b", dep("qs", "6.5.0"))] })],
    ["an alert on the lockfile", () => plan({ alerts: [on("package-lock.json")], lock: safe, manifests: [root(), member("packages/a", dep("qs", "6.5.0"))] })],
  ];
  for (const [label, build] of stillAwaiting) {
    it(`stays awaiting close with ${label}`, () => {
      assert.equal(build().alerts[0].status, "awaiting-close");
    });
  }
});

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
      { flat: { "qs@<6.7.3": "6.7.3" } }, // selectorKeyName leaves this shape whole
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

  describe("a package declared twice in one manifest", () => {
    const twice = (first: DirectDep["field"], second: DirectDep["field"]): Setup => ({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { [first]: { qs: "^6.5.0" }, [second]: { qs: "^6.5.0" } },
        "node_modules/qs": { version: "6.7.0" },
      }),
      manifests: [root(dep("qs", "^6.5.0", first), dep("qs", "^6.5.0", second))],
    });

    it("dependencies and devDependencies → blocked unrewritable-spec, naming both", () => {
      const p = plan(twice("dependencies", "devDependencies"));
      const copy = p.alerts[0].copies[0];
      assert.equal(p.alerts[0].status, "blocked");
      assert.equal(copy.reason, "unrewritable-spec");
      assert.match(copy.detail ?? "", /declared twice in package\.json/);
      assert.match(copy.detail ?? "", /dependencies and devDependencies/);
      assertNoWrites(p);
    });

    it("any other two fields are blocked as well: a bump mishandles those too", () => {
      for (const [first, second] of [
        ["dependencies", "optionalDependencies"],
        ["devDependencies", "optionalDependencies"],
      ] as Array<[DirectDep["field"], DirectDep["field"]]>) {
        const p = plan(twice(first, second));
        assert.equal(p.alerts[0].copies[0].reason, "unrewritable-spec", `${first}+${second}`);
        assertNoWrites(p);
      }
    });

    it("in a member, names the member's manifest", () => {
      const p = plan({
        alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
        lock: makeLock({
          "": {},
          "packages/a": { name: "a", dependencies: { qs: "^6.5.0" }, devDependencies: { qs: "^6.5.0" } },
          "node_modules/a": { link: true, resolved: "packages/a" },
          "node_modules/qs": { version: "6.7.0" },
        }),
        manifests: [root(), member("packages/a", dep("qs", "^6.5.0"), dep("qs", "^6.5.0", "devDependencies"))],
      });
      assert.equal(p.alerts[0].copies[0].reason, "unrewritable-spec");
      assert.match(p.alerts[0].copies[0].detail ?? "", /packages\/a\/package\.json/);
      assertNoWrites(p);
    });

    it("an exact pin in either field still reads as a pin", () => {
      const p = plan({
        alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
        lock: makeLock({
          "": { dependencies: { qs: "^6.5.0" }, devDependencies: { qs: "6.7.0" } },
          "node_modules/qs": { version: "6.7.0" },
        }),
        manifests: [root(dep("qs", "^6.5.0"), dep("qs", "6.7.0", "devDependencies"))],
      });
      assert.equal(p.alerts[0].copies[0].reason, "pin");
    });

    it("writes no override that would catch it for a transitive copy on the same line", () => {
      const p = plan({
        alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
        lock: makeLock({
          "": { dependencies: { qs: "^6.5.0", b: "^1.0.0" }, devDependencies: { qs: "^6.5.0" } },
          "node_modules/qs": { version: "6.7.0" },
          "node_modules/b": { version: "1.0.0", dependencies: { qs: "~6.6.0" } },
          "node_modules/b/node_modules/qs": { version: "6.6.0" },
        }),
        manifests: [root(dep("qs", "^6.5.0"), dep("qs", "^6.5.0", "devDependencies"), dep("b", "^1.0.0"))],
      });
      assertNoWrites(p);
    });
  });

  describe("a copy nested in a workspace member's own node_modules", () => {
    const nested = {
      "": {},
      "packages/b": { name: "b", dependencies: { glob: "^8.0.0" } },
      "node_modules/b": { link: true, resolved: "packages/b" },
      "packages/b/node_modules/glob": { version: "8.1.0", dependencies: { minimatch: "^5.0.1" } },
      "packages/b/node_modules/minimatch": { version: "5.1.6" },
    };
    const manifests = [root(), member("packages/b", dep("glob", "^8.0.0"))];
    const FIVE = alert(1, "minimatch", ">= 5.0.0, < 5.1.7", "5.1.7");

    it("needing an override → blocked selector-conflict, saying npm can't reach it", () => {
      const p = plan({ alerts: [FIVE], lock: makeLock(nested), manifests });
      const copy = p.alerts[0].copies[0];
      assert.equal(p.alerts[0].status, "blocked");
      assert.equal(copy.path, "packages/b/node_modules/minimatch");
      assert.equal(copy.reason, "selector-conflict");
      assert.match(copy.detail ?? "", /nested in a workspace member/);
      assert.match(copy.detail ?? "", /override can't reach/);
      assertNoWrites(p);
    });

    it("deeper under the member, the same", () => {
      const { "packages/b/node_modules/minimatch": _moved, ...rest } = nested;
      const p = plan({
        alerts: [FIVE],
        lock: makeLock({ ...rest, "packages/b/node_modules/glob/node_modules/minimatch": { version: "5.1.6" } }),
        manifests,
      });
      assert.equal(p.alerts[0].copies[0].reason, "selector-conflict");
      assertNoWrites(p);
    });

    it("doesn't stop a copy on another line, under the root, from being fixed", () => {
      const p = plan({
        alerts: [FIVE, alert(2, "minimatch", "< 3.1.3", "3.1.3")],
        lock: makeLock({
          ...nested,
          "packages/a": { name: "a", dependencies: { glob: "^7.1.6" } },
          "node_modules/a": { link: true, resolved: "packages/a" },
          "node_modules/glob": { version: "7.2.3", dependencies: { minimatch: "^3.1.1" } },
          "node_modules/minimatch": { version: "3.1.2" },
        }),
        manifests: [...manifests, member("packages/a", dep("glob", "^7.1.6"))],
      });
      assert.deepEqual(
        p.alerts.map((a) => a.status),
        ["blocked", "fixed"],
      );
      assert.deepEqual(p.addOverrides, { "minimatch@>=3.0.0 <3.1.3": "3.1.3" });
      assert.deepEqual([...p.targets], [["node_modules/minimatch", "3.1.3"]]);
    });

    it("a direct bump needs no override, so it still goes ahead", () => {
      const p = plan({
        alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
        lock: makeLock({
          "": {},
          "packages/a": { name: "a", dependencies: { qs: "^6.5.0" } },
          "node_modules/a": { link: true, resolved: "packages/a" },
          "packages/a/node_modules/qs": { version: "6.7.0" },
        }),
        manifests: [root(), member("packages/a", dep("qs", "^6.5.0"))],
      });
      assert.equal(p.alerts[0].status, "fixed");
      assert.deepEqual(
        p.bumps.map((b) => [b.memberPath, b.name, b.target]),
        [["packages/a", "qs", "6.7.3"]],
      );
      assert.deepEqual(p.addOverrides, {});
    });

    it("a direct bump that would also need an override is blocked", () => {
      const p = plan({
        alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
        lock: makeLock({
          "": {},
          "packages/a": { name: "a", dependencies: { qs: "^6.5.0", b: "^1.0.0" } },
          "node_modules/a": { link: true, resolved: "packages/a" },
          "packages/a/node_modules/qs": { version: "6.7.0" },
          "packages/a/node_modules/b": { version: "1.0.0", dependencies: { qs: "6.7.0" } },
        }),
        manifests: [root(), member("packages/a", dep("qs", "^6.5.0"), dep("b", "^1.0.0"))],
      });
      assert.equal(p.alerts[0].copies[0].reason, "selector-conflict");
      assertNoWrites(p);
    });
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
    assert.equal(selectorKeyName(key), "@babel/core");
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

  /** A plan where dependent `a` declares qs with `spec` and resolves to safe 6.9.4, beside a fixable copy. */
  function withSafeCopyDeclaring(spec: string): Plan {
    return plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { a: "^1.0.0", express: "^4.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { qs: spec } },
        "node_modules/a/node_modules/qs": { version: "6.9.4" },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "6.7.0" } },
        "node_modules/qs": { version: "6.7.0" },
      }),
    });
  }

  function assertConflict(spec: string): void {
    const p = withSafeCopyDeclaring(spec);
    assert.equal(p.alerts[0].status, "blocked", spec);
    assert.equal(p.alerts[0].copies[0].action, "blocked", spec);
    assert.equal(p.alerts[0].copies[0].reason, "selector-conflict", spec);
    assert.ok(p.alerts[0].copies[0].detail?.includes(spec), spec);
    assertNoWrites(p);
  }

  it("a dependent declaring a tag on a safe copy conflicts: npm accepts the override for any tag", () => {
    assertConflict("latest");
  });

  it("an alias on a safe copy conflicts: npm intersects on what the alias points to", () => {
    assertConflict("npm:qs@^6.5.0");
  });

  it("a file: spec on a safe copy conflicts: npm accepts the override for any path", () => {
    assertConflict("file:../qs");
  });

  it("a git spec with no semver range never matches, as npm skips the rule for it", () => {
    for (const spec of ["github:a/b", "a/b#main", "git+https://example.com/a/b.git", "https://github.com/a/b.git"]) {
      const p = withSafeCopyDeclaring(spec);
      assert.equal(p.alerts[0].status, "fixed", spec);
      assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.7.3": "6.7.3" }, spec);
      assert.equal(p.targets.has("node_modules/a/node_modules/qs"), false, spec);
    }
  });

  it("a git spec's #semver: range is intersected like any other", () => {
    assertConflict("github:a/b#semver:^6.5.0");
    assert.equal(withSafeCopyDeclaring("github:a/b#semver:^6.9.0").alerts[0].status, "fixed");
  });

  // Replayed from npm 11.16: real OverrideSet.getEdgeRule on the key "qs@>=6.0.0 <6.7.3".
  it("agrees with arborist on every spec shape", () => {
    const caught = [
      "^6.5.0", ">=6.0.0", "*", "", "6.x",
      "latest", "beta-1",
      "file:../qs", "../qs", "./qs", "/abs/qs", "~/qs", "qs.tgz", "file:qs.tgz", "a/b/c",
      "npm:qs@^6.5.0", "npm:qs@latest", "npm:qs", "NPM:qs@^6.5.0", "npm:@s/qs@^6.5.0", "npm:@s/qs",
      "github:a/b#semver:^6.5.0", "a/b#semver:^6.5.0", "git+https://example.com/a/b.git#semver:^6.5.0",
      "https://github.com/a/b.git#semver:^6.5.0",
      "https://github.com/a/b/archive/x.tgz", "https://codeload.github.com/a/b/tar.gz/x", "https://example.com/qs.tgz",
    ];
    const missed = [
      "^6.9.0", "6.9.4", "^5.0.0",
      "npm:qs@^6.9.0", "npm:qs@6.9.4", "npm:@s/qs@^6.9.0",
      "github:a/b", "github:a/b#main", "github:a/b#semver:^6.9.0", "a/b", "a/b#main", "gitlab:a/b", "bitbucket:a/b",
      "gist:abc123", "git+https://example.com/a/b.git", "git+https://example.com/a/b.git#semver:^6.9.0",
      "git+ssh://git@example.com/a/b.git", "git://example.com/a/b.git", "git+file:///tmp/b",
      "git@github.com:a/b.git", "git@example.com:a/b.git", "ssh://git@github.com/a/b.git",
      "https://github.com/a/b", "https://github.com/a/b.git",
    ];
    for (const spec of caught) assert.equal(withSafeCopyDeclaring(spec).alerts[0].copies[0].reason, "selector-conflict", spec);
    for (const spec of missed) assert.equal(withSafeCopyDeclaring(spec).alerts[0].status, "fixed", spec);
  });

  it("a spec npm can't parse is reported as a conflict, and doesn't throw", () => {
    assertConflict("workspace:*");
  });

  it("blocks when a copy staying put sits inside the selector, even if npm wouldn't match its spec", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { qs: "github:a/qs", express: "^4.0.0" } },
        "node_modules/qs": { version: "6.7.0" },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "6.7.1" } },
        "node_modules/express/node_modules/qs": { version: "6.7.1" },
      }),
      manifests: [root(dep("qs", "github:a/qs"), dep("express", "^4.0.0"))],
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

  it("replaces a lower selector that matches the moving copy's dependent", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.8.0", "6.8.0")],
      lock: makeLock({
        "": { dependencies: { parent: "^1.0.0" } },
        "node_modules/parent": { version: "1.0.0", dependencies: { qs: "^6.5.0" } },
        "node_modules/qs": { version: "6.7.3" },
      }),
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

  it("judges an alias: a fix past `npm:qs@6.7.0` is flagged", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { express: "^4.0.0" } },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "npm:qs@6.7.0" } },
        "node_modules/qs": { version: "6.7.0" },
      }),
    });
    assert.equal(p.alerts[0].copies[0].action, "override");
    assert.deepEqual(p.alerts[0].copies[0].pastDeclared, [{ dependent: "express", range: "npm:qs@6.7.0" }]);
  });

  it("a direct bump writes the selector when an alias parent pins the old version", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { qs: "^6.5.0", express: "^4.0.0" } },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "npm:qs@6.7.0" } },
        "node_modules/qs": { version: "6.7.0" },
      }),
      manifests: [root(dep("qs", "^6.5.0"), dep("express", "^4.0.0"))],
    });
    assert.equal(p.bumps.length, 1);
    assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.7.3": "6.7.3" });
    assert.deepEqual(p.alerts[0].copies[0].pastDeclared, [{ dependent: "express", range: "npm:qs@6.7.0" }]);
  });

  it("judges a git spec's #semver: range, and an alias that admits the target isn't flagged", () => {
    const flagged = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { a: "^1.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { qs: "github:a/qs#semver:6.7.0" } },
        "node_modules/qs": { version: "6.7.0" },
      }),
    });
    assert.deepEqual(flagged.alerts[0].copies[0].pastDeclared, [{ dependent: "a", range: "github:a/qs#semver:6.7.0" }]);

    const admitted = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { a: "^1.0.0" } },
        "node_modules/a": { version: "1.0.0", dependencies: { qs: "npm:qs@^6.7.0" } },
        "node_modules/qs": { version: "6.7.0" },
      }),
    });
    assert.deepEqual(admitted.alerts[0].copies[0].pastDeclared, []);
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

describe("existing keys npm would apply first", () => {
  // npm takes the first rule matching the dependent's declared spec, so a key
  // that matches it wins even when its version range doesn't overlap the new key's.
  it("carries a stale key's lower bound into the new selector, and removes the key", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.1.0, < 3.6.0", "3.6.0")],
      lock: makeLock({
        "": { dependencies: { parent: "^1.0.0" } },
        "node_modules/parent": { version: "1.0.0", dependencies: { a: "^3.0.0" } },
        "node_modules/a": { version: "3.1.0" },
      }),
      flat: { "a@>=3.0.0 <3.1.0": "3.1.0" },
    });
    assert.deepEqual(p.addOverrides, { "a@>=3.0.0 <3.6.0": "3.6.0" });
    assert.deepEqual(p.removeOverrideKeys, ["a@>=3.0.0 <3.1.0"]);
    assert.equal(p.alerts[0].status, "fixed");
  });

  it("clears a pair of keys an earlier run left wedged", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.1.0, < 3.6.0", "3.6.0")],
      // The wedge needs a dependent both keys match: `^3.0.0` does, `^3.1.0` wouldn't.
      lock: makeLock({
        "": { dependencies: { parent: "^1.0.0" } },
        "node_modules/parent": { version: "1.0.0", dependencies: { a: "^3.0.0" } },
        "node_modules/a": { version: "3.1.0" },
      }),
      flat: { "a@>=3.0.0 <3.1.0": "3.1.0", "a@>=3.1.0 <3.6.0": "3.6.0" },
    });
    assert.deepEqual(p.addOverrides, { "a@>=3.0.0 <3.6.0": "3.6.0" });
    assert.deepEqual(p.removeOverrideKeys, ["a@>=3.0.0 <3.1.0", "a@>=3.1.0 <3.6.0"]);
  });

  it("a flat floating key carries no bound: the new key starts at the line", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.5.0, < 3.6.0", "3.6.0")],
      lock: transitive("a", "3.5.1"),
      flat: { a: ">=3.5.0 <4" },
    });
    assert.deepEqual(p.addOverrides, { "a@>=3.0.0 <3.6.0": "3.6.0" });
    assert.deepEqual(p.removeOverrideKeys, ["a"]);
  });

  it("a bump with a stale key on its line also writes the selector, so the key can't win", () => {
    const p = plan({
      alerts: [alert(1, "qs", ">= 6.7.0, < 6.8.0", "6.8.0")],
      lock: makeLock({
        "": { dependencies: { qs: "^6.5.0", express: "^4.0.0" } },
        "node_modules/qs": { version: "6.7.3" },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "^6.5.0" } },
      }),
      manifests: [root(dep("qs", "^6.5.0"), dep("express", "^4.0.0"))],
      flat: { "qs@>=6.0.0 <6.7.3": "6.7.3" },
    });
    assert.equal(p.bumps[0].target, "6.8.0");
    assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.8.0": "6.8.0" });
    assert.deepEqual(p.removeOverrideKeys, ["qs@>=6.0.0 <6.7.3"]);
  });

  it("replaces a key from another line that matches the dependent the new key must reach", () => {
    const p = plan({
      alerts: [alert(1, "minimatch", ">= 5.0.0, < 5.1.7", "5.1.7")],
      lock: makeLock({
        "": { dependencies: { parent: "^1.0.0" } },
        "node_modules/parent": { version: "1.0.0", dependencies: { minimatch: ">=3.0.0 <6" } },
        "node_modules/minimatch": { version: "5.1.0" },
      }),
      flat: { "minimatch@>=3.0.0 <3.1.3": "3.1.3" },
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.deepEqual(p.addOverrides, { "minimatch@>=5.0.0 <5.1.7": "5.1.7" });
    assert.deepEqual(p.removeOverrideKeys, ["minimatch@>=3.0.0 <3.1.3"]);
  });

  it("replaces a key a bump's new range would fall under", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      ...direct("qs", "^6.5.0", "6.7.0"),
      flat: { qs: ">=6.7.3 <7" },
    });
    assert.equal(p.bumps[0].target, "6.7.3");
    assert.deepEqual(p.removeOverrideKeys, ["qs"]);
    assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.7.3": "6.7.3" });
  });
});

describe("keys that don't compete with the new one stay in place", () => {
  /** p1 pins `a` and is held on a nested copy by an earlier key; p2 reaches the hoisted copy with `spec`. */
  function heldAbove(p1Spec: string, heldAt: string, spec: string, hoisted: string): LockIndex {
    return makeLock({
      "": { dependencies: { p1: "^1.0.0", p2: "^1.0.0" } },
      "node_modules/p1": { version: "1.0.0", dependencies: { a: p1Spec } },
      "node_modules/p1/node_modules/a": { version: heldAt },
      "node_modules/p2": { version: "1.0.0", dependencies: { a: spec } },
      "node_modules/a": { version: hoisted },
    });
  }

  it("a key above the target keeps holding a closed alert's fix", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.0.0, < 3.6.0", "3.6.0")],
      lock: heldAbove("3.7.0", "3.9.0", "~3.1.0", "3.1.0"),
      flat: { "a@>=3.7.0 <3.9.0": "3.9.0" },
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.deepEqual(p.addOverrides, { "a@>=3.0.0 <3.6.0": "3.6.0" });
    assert.deepEqual(p.removeOverrideKeys, []);
    assert.deepEqual([...p.targets], [["node_modules/a", "3.6.0"]]);
  });

  it("the same when the fix is a direct ~ bump", () => {
    const p = plan({
      alerts: [alert(1, "a", "< 3.6.0", "3.6.0")],
      lock: makeLock({
        "": { dependencies: { a: "~3.1.0", p1: "^1.0.0" } },
        "node_modules/p1": { version: "1.0.0", dependencies: { a: "3.7.0" } },
        "node_modules/p1/node_modules/a": { version: "3.9.0" },
        "node_modules/a": { version: "3.1.0" },
      }),
      manifests: [root(dep("a", "~3.1.0"), dep("p1", "^1.0.0"))],
      flat: { "a@>=3.7.0 <3.9.0": "3.9.0" },
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.bumps[0].operator, "~");
    assert.equal(p.bumps[0].target, "3.6.0");
    assert.deepEqual(p.addOverrides, {});
    assert.deepEqual(p.removeOverrideKeys, []);
  });

  it("a lower key holding a safe forced pin isn't widened into a conflict", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.4.0, < 3.6.0", "3.6.0")],
      lock: heldAbove("3.0.0", "3.1.3", "~3.4.0", "3.4.0"),
      flat: { "a@>=3.0.0 <3.1.3": "3.1.3" },
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.deepEqual(p.addOverrides, { "a@>=3.4.0 <3.6.0": "3.6.0" });
    assert.deepEqual(p.removeOverrideKeys, []);
  });

  it("a lower key stays when the moving copy's dependent only matches the new one", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.8.0", "6.8.0")],
      lock: transitive("qs", "6.7.3"), // parent declares ^6.7.3, which `<6.7.3` can't match
      flat: { "qs@>=6.0.0 <6.7.3": "6.7.3" },
    });
    assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.8.0": "6.8.0" });
    assert.deepEqual(p.removeOverrideKeys, []);
  });

  it("two keys left in place can compete with each other without touching the new key", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.0.0, < 3.6.0", "3.6.0")],
      lock: heldAbove("~3.8.0", "3.8.5", "~3.1.0", "3.1.0"),
      flat: { "a@>=3.7.0 <3.8.2": "3.8.2", "a@>=3.8.0 <3.8.5": "3.8.5" },
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.deepEqual(p.addOverrides, { "a@>=3.0.0 <3.6.0": "3.6.0" });
    assert.deepEqual(p.removeOverrideKeys, []);
  });

  it("a key left in place that matches the moving copy's dependent blocks the fix", () => {
    // Only an awaiting-close alert's key can stay and still match: any other would be replaced.
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3"), alert(2, "qs", ">= 6.9.0, < 6.9.4", "6.9.4")],
      lock: makeLock({
        "": { dependencies: { qs: "^6.9.0", express: "^4.0.0" } },
        "node_modules/qs": { version: "6.9.0" },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "^6.0.0" } },
      }),
      manifests: [root(dep("qs", "^6.9.0"), dep("express", "^4.0.0"))],
      flat: { "qs@>=6.0.0 <6.7.3": "6.7.3" },
    });
    assert.equal(p.alerts[1].status, "blocked");
    assert.equal(p.alerts[1].copies[0].reason, "selector-conflict");
    assert.match(p.alerts[1].copies[0].detail ?? "", /qs@>=6\.0\.0 <6\.7\.3/);
    assertNoWrites(p);
  });

  it("the same when a bump's new range would fall under that key", () => {
    const held = plan({
      alerts: [alert(1, "qs", "< 6.2.0", "6.2.0"), alert(2, "qs", ">= 6.3.0, < 6.4.0", "6.4.0")],
      lock: makeLock({
        "": { dependencies: { qs: "~6.3.0" } },
        "node_modules/qs": { version: "6.3.1" },
      }),
      manifests: [root(dep("qs", "~6.3.0"))],
      flat: { "qs@>=6.3.5 <6.5.0": "6.5.0" },
    });
    assert.equal(held.alerts[0].status, "awaiting-close");
    assert.equal(held.alerts[1].status, "blocked");
    assert.equal(held.alerts[1].copies[0].reason, "selector-conflict");
    assertNoWrites(held);
  });
});

describe("a replaced key that was holding something else", () => {
  it("blocks: removing it would drop a closed alert's fix the new key doesn't cover", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.0.0, < 3.6.0", "3.6.0")],
      lock: makeLock({
        "": { dependencies: { p1: "^1.0.0", p2: "^1.0.0" } },
        "node_modules/p1": { version: "1.0.0", dependencies: { a: "3.7.0" } },
        "node_modules/p1/node_modules/a": { version: "3.9.0" },
        // p2's range also matches the old key, so the old key has to go.
        "node_modules/p2": { version: "1.0.0", dependencies: { a: "^3.0.0" } },
        "node_modules/a": { version: "3.1.0" },
      }),
      flat: { "a@>=3.7.0 <3.9.0": "3.9.0" },
    });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "selector-conflict");
    assert.match(p.alerts[0].copies[0].detail ?? "", /a@>=3\.7\.0 <3\.9\.0/);
    assert.match(p.alerts[0].copies[0].detail ?? "", /p1/);
    assertNoWrites(p);
  });

  it("goes ahead when that dependent's own range admits what it resolved to: nothing moves", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.0.0, < 3.6.0", "3.6.0")],
      lock: makeLock({
        "": { dependencies: { p1: "^1.0.0", p2: "^1.0.0" } },
        "node_modules/p1": { version: "1.0.0", dependencies: { a: ">=3.7.0 <4" } },
        "node_modules/p1/node_modules/a": { version: "3.9.0" },
        "node_modules/p2": { version: "1.0.0", dependencies: { a: "^3.0.0" } },
        "node_modules/a": { version: "3.1.0" },
      }),
      flat: { "a@>=3.7.0 <3.9.0": "3.9.0" },
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.deepEqual(p.addOverrides, { "a@>=3.0.0 <3.6.0": "3.6.0" });
    assert.deepEqual(p.removeOverrideKeys, ["a@>=3.7.0 <3.9.0"]);
  });

  it("a carried bound that would catch the held dependent is a conflict", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.4.0, < 3.6.0", "3.6.0")],
      lock: makeLock({
        "": { dependencies: { p1: "^1.0.0", p2: "^1.0.0" } },
        "node_modules/p1": { version: "1.0.0", dependencies: { a: "3.0.0" } },
        "node_modules/p1/node_modules/a": { version: "3.1.3" },
        "node_modules/p2": { version: "1.0.0", dependencies: { a: "^3.0.0" } },
        "node_modules/a": { version: "3.4.0" },
      }),
      flat: { "a@>=3.0.0 <3.1.3": "3.1.3" },
    });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "selector-conflict");
    assertNoWrites(p);
  });

  it("a flat key holds a git dependent too: npm applies a flat rule to any spec", () => {
    const p = plan({
      alerts: [alert(1, "a", "< 3.6.0", "3.6.0")],
      lock: makeLock({
        "": { dependencies: { p1: "^1.0.0", p2: "^1.0.0" } },
        "node_modules/p1": { version: "1.0.0", dependencies: { a: "github:x/a" } },
        "node_modules/p1/node_modules/a": { version: "3.7.0" },
        "node_modules/p2": { version: "1.0.0", dependencies: { a: "^3.0.0" } },
        "node_modules/a": { version: "3.1.0" },
      }),
      flat: { a: ">=3.7.0 <4" },
    });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "selector-conflict");
    assert.match(p.alerts[0].copies[0].detail ?? "", /github:x\/a/);
    assertNoWrites(p);
  });
});

describe("copies the selector can't reach", () => {
  /** One copy of `name`, held by one parent declaring it with `spec`. */
  function heldBy(name: string, spec: string, version: string): LockIndex {
    return makeLock({
      "": { dependencies: { parent: "^1.0.0" } },
      "node_modules/parent": { version: "1.0.0", dependencies: { [name]: spec } },
      [`node_modules/${name}`]: { version },
    });
  }

  it("keeps a parent's forced pin caught, by carrying the old key's bound", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.1.2, < 3.6.0", "3.6.0")],
      lock: heldBy("a", "3.0.0", "3.1.3"),
      flat: { "a@>=3.0.0 <3.1.3": "3.1.3" },
    });
    assert.deepEqual(p.addOverrides, { "a@>=3.0.0 <3.6.0": "3.6.0" });
    assert.deepEqual(p.removeOverrideKeys, ["a@>=3.0.0 <3.1.3"]);
    assert.equal(p.alerts[0].copies[0].action, "override");
    assert.deepEqual(p.alerts[0].copies[0].pastDeclared, [{ dependent: "parent", range: "3.0.0" }]);
  });

  it("blocks a forced pin the selector would miss, and leaves the old key in place", () => {
    // No key to carry a bound from, so nothing matches the parent's 3.0.0.
    const p = plan({ alerts: [alert(1, "a", ">= 3.1.2, < 3.6.0", "3.6.0")], lock: heldBy("a", "3.0.0", "3.1.3") });
    const copy = p.alerts[0].copies[0];
    assert.equal(copy.action, "blocked");
    assert.equal(copy.reason, "selector-conflict");
    assert.match(copy.detail ?? "", /parent/);
    assert.match(copy.detail ?? "", /3\.0\.0/);
    assertNoWrites(p);
  });

  it("blocks a pre-release copy: its exact declaration doesn't intersect the selector", () => {
    const p = plan({
      alerts: [alert(1, "a", "< 21.1.0", "21.1.0")],
      lock: heldBy("a", "21.0.0-next.3", "21.0.0-next.3"),
    });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "selector-conflict");
    assertNoWrites(p);
  });

  it("blocks a copy only reachable through a git spec with no semver range", () => {
    const p = plan({ alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")], lock: heldBy("qs", "github:a/qs", "6.7.0") });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].action, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "selector-conflict");
    assert.match(p.alerts[0].copies[0].detail ?? "", /github:a\/qs/);
    assertNoWrites(p);
  });

  it("a git spec's own #semver: range can be caught", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: heldBy("qs", "github:a/qs#semver:^6.7.0", "6.7.0"),
    });
    assert.equal(p.alerts[0].status, "fixed");
  });

  it("blocks a copy nothing declares", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({ "": {}, "node_modules/qs": { version: "6.7.0" } }),
    });
    assert.equal(p.alerts[0].copies[0].reason, "selector-conflict");
    assertNoWrites(p);
  });

  it("one unreachable copy inside the selector blocks the copy that shares it", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { x: "^1.0.0", y: "^1.0.0" } },
        "node_modules/x": { version: "1.0.0", dependencies: { qs: "github:a/qs" } },
        "node_modules/x/node_modules/qs": { version: "6.7.0" },
        "node_modules/y": { version: "1.0.0", dependencies: { qs: "^6.0.0" } },
        "node_modules/qs": { version: "6.7.1" },
      }),
    });
    assert.deepEqual(
      p.alerts[0].copies.map((c) => c.reason),
      ["selector-conflict", "selector-conflict"],
    );
    assertNoWrites(p);
  });

  describe("an awaiting-close alert's key", () => {
    it("is kept, so a fix the key would beat is blocked until that alert closes", () => {
      const p = plan({
        alerts: [alert(1, "qs", "< 6.7.3", "6.7.3"), alert(2, "qs", ">= 6.9.0, < 6.9.4", "6.9.4")],
        lock: heldBy("qs", "^6.0.0", "6.9.0"),
        flat: { qs: ">=6.7.3 <7" },
      });
      assert.equal(p.alerts[0].status, "awaiting-close");
      assert.equal(p.alerts[1].status, "blocked");
      assert.equal(p.alerts[1].copies[0].reason, "selector-conflict");
      assert.match(p.alerts[1].copies[0].detail ?? "", /"qs"/);
      assertNoWrites(p);
    });

    it("is kept beside a new key when no dependent matches both", () => {
      const p = plan({
        alerts: [alert(1, "qs", "< 6.7.3", "6.7.3"), alert(2, "qs", ">= 6.9.0, < 6.9.4", "6.9.4")],
        lock: heldBy("qs", "6.9.0", "6.9.0"),
        flat: { "qs@>=6.0.0 <6.7.3": "6.7.3" },
      });
      assert.equal(p.alerts[0].status, "awaiting-close");
      assert.equal(p.alerts[1].status, "fixed");
      assert.deepEqual(p.addOverrides, { "qs@>=6.9.0 <6.9.4": "6.9.4" });
      assert.deepEqual(p.removeOverrideKeys, []);
    });

    it("is replaced once that alert has closed", () => {
      const p = plan({
        alerts: [alert(2, "qs", ">= 6.9.0, < 6.9.4", "6.9.4")],
        lock: heldBy("qs", "^6.0.0", "6.9.0"),
        flat: { qs: ">=6.7.3 <7" },
      });
      assert.equal(p.alerts[0].status, "fixed");
      assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.9.4": "6.9.4" });
      assert.deepEqual(p.removeOverrideKeys, ["qs"]);
    });

    it("isn't kept for an alert raised into: that alert is being fixed", () => {
      const p = plan({
        alerts: [alert(1, "a", "< 3.1.0", "3.1.0"), alert(2, "a", ">= 3.1.0, < 3.6.0", "3.6.0")],
        lock: transitive("a", "3.0.0"),
        flat: { a: ">=3.0.0 <4" },
      });
      assert.deepEqual(p.addOverrides, { "a@>=3.0.0 <3.6.0": "3.6.0" });
      assert.deepEqual(p.removeOverrideKeys, ["a"]);
    });
  });
});

describe("root declarations (npm's EOVERRIDE)", () => {
  it("a root-only peer declaration the selector catches is a conflict", () => {
    const p = plan({
      alerts: [alert(1, "minimatch", "< 3.1.2", "3.1.2")],
      lock: makeLock({
        "": { peerDependencies: { minimatch: "^3.0.4" } },
        "node_modules/minimatch": { version: "3.0.4", peer: true },
      }),
    });
    const copy = p.alerts[0].copies[0];
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(copy.action, "blocked");
    assert.equal(copy.reason, "selector-conflict");
    assert.match(copy.detail ?? "", /\^3\.0\.4/);
    assertNoWrites(p);
  });

  it("so is a root peer that resolves to nothing: npm checks every root edge", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": {
          dependencies: { express: "^4.0.0" },
          peerDependencies: { qs: "^6.0.0" },
          peerDependenciesMeta: { qs: { optional: true } },
        },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "6.7.0" } },
        "node_modules/express/node_modules/qs": { version: "6.7.0" },
      }),
    });
    assert.equal(p.alerts[0].copies[0].reason, "selector-conflict");
    assertNoWrites(p);
  });

  it("a root peer outside the selector is fine", () => {
    const p = plan({
      alerts: [alert(1, "qs", ">= 6.5.0, < 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { express: "^4.0.0" }, peerDependencies: { qs: "^6.9.0" } },
        "node_modules/qs": { version: "6.9.1" },
        "node_modules/express": { version: "4.0.0", dependencies: { qs: "6.7.0" } },
        "node_modules/express/node_modules/qs": { version: "6.7.0" },
      }),
    });
    assert.equal(p.alerts[0].status, "fixed");
  });

  it("a member's peer on a moving copy isn't a root edge, so it doesn't conflict", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": {},
        "packages/a": { name: "a", peerDependencies: { qs: "^6.5.0" } },
        "node_modules/a": { link: true, resolved: "packages/a" },
        "node_modules/qs": { version: "6.7.0" },
      }),
      manifests: [root(), member("packages/a")],
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.7.3": "6.7.3" });
  });

  it("a root direct dependency the bump rewrites stays out of the check", () => {
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
    assert.equal(p.addOverrides["qs@>=6.0.0 <6.7.3"], "6.7.3");
  });
});

describe("an alert's own range against the target", () => {
  it("a target inside another alert's range can't fix that alert", () => {
    const p = plan({
      alerts: [alert(1, "a", "< 3.6.0", "3.6.0"), alert(2, "a", ">= 3.5.0, < 3.9.0", "3.5.5")],
      lock: transitive("a", "3.0.0"),
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.targets.get("node_modules/a"), "3.6.0");
    assert.equal(p.alerts[1].status, "blocked");
    assert.equal(p.alerts[1].copies[0].reason, "target-unavailable");
    assert.match(p.alerts[1].copies[0].detail ?? "", /still inside/);
  });

  it("the same when the copy is inside both ranges", () => {
    const p = plan({
      alerts: [alert(1, "a", "< 3.6.0", "3.6.0"), alert(2, "a", ">= 3.5.0, < 3.9.0", "3.5.5")],
      lock: transitive("a", "3.5.2"),
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.alerts[1].status, "blocked");
    assert.equal(p.alerts[1].copies[0].reason, "target-unavailable");
  });

  it("a patch below the target never lowers it", () => {
    const p = plan({
      alerts: [alert(1, "a", "< 3.6.0", "3.6.0"), alert(2, "a", ">= 3.5.0, < 3.9.0", "3.4.0")],
      lock: transitive("a", "3.0.0"),
    });
    assert.equal(p.targets.get("node_modules/a"), "3.6.0");
    assert.equal(p.alerts[0].status, "fixed");
    assert.equal(p.alerts[1].status, "blocked");
    assert.equal(p.alerts[1].copies[0].reason, "target-unavailable");
  });

  it("a patch inside its own range isn't a fix, and nothing moves for it", () => {
    const p = plan({ alerts: [alert(1, "a", ">= 3.0.0, <= 3.5.0", "3.5.0")], lock: transitive("a", "3.0.0") });
    assert.equal(p.alerts[0].status, "blocked");
    assert.equal(p.alerts[0].copies[0].reason, "target-unavailable");
    assert.match(p.alerts[0].copies[0].detail ?? "", /still inside/);
    assertNoWrites(p);
  });

  it("every blocked decision has a reason and a detail", () => {
    const p = plan({
      alerts: [alert(1, "a", ">= 3.4.0, <= 3.6.0", "3.6.0"), alert(2, "a", "< 3.1.0", "3.1.0")],
      lock: makeLock({
        "": { dependencies: { p: "^1.0.0", q: "^1.0.0" } },
        "node_modules/p": { version: "1.0.0", dependencies: { a: "3.0.0" } },
        "node_modules/a": { version: "3.0.0" },
        "node_modules/q": { version: "1.0.0", dependencies: { a: "3.4.0" } },
        "node_modules/q/node_modules/a": { version: "3.4.0" },
      }),
    });
    assert.equal(p.alerts[1].status, "fixed");
    assert.equal(p.targets.get("node_modules/a"), "3.1.0");
    assert.equal(p.alerts[0].status, "blocked");
    for (const copy of p.alerts[0].copies) {
      assert.equal(copy.action, "blocked");
      assert.equal(copy.reason, "target-unavailable");
      assert.ok(copy.detail);
    }
  });
});

describe("aliased installs", () => {
  it("a vulnerable copy installed under an alias is blocked, not not-found", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { foo: "npm:qs@6.7.0" } },
        "node_modules/foo": { name: "qs", version: "6.7.0" },
      }),
      manifests: [root(dep("foo", "npm:qs@6.7.0"))],
    });
    assert.equal(p.alerts[0].status, "blocked");
    const copy = p.alerts[0].copies[0];
    assert.equal(copy.path, "node_modules/foo");
    assert.equal(copy.action, "blocked");
    assert.equal(copy.reason, "selector-conflict");
    assert.match(copy.detail ?? "", /alias/);
    assert.match(copy.detail ?? "", /foo/);
    assertNoWrites(p);
  });

  it("a package installed at qs's path that isn't qs has nothing to do with qs's alerts", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { parent: "^1.0.0" } },
        "node_modules/parent": { version: "1.0.0", dependencies: { qs: "npm:other@1.0.0" } },
        "node_modules/qs": { name: "other", version: "1.0.0" },
      }),
    });
    assert.equal(p.alerts[0].status, "not-found");
    assertNoWrites(p);
  });

  it("an aliased copy doesn't stop the real copy being fixed: no selector can reach it", () => {
    const p = plan({
      alerts: [alert(1, "qs", "< 6.7.3", "6.7.3")],
      lock: makeLock({
        "": { dependencies: { foo: "npm:qs@6.7.0", parent: "^1.0.0" } },
        "node_modules/foo": { name: "qs", version: "6.7.0" },
        "node_modules/parent": { version: "1.0.0", dependencies: { qs: "^6.7.0" } },
        "node_modules/qs": { version: "6.7.1" },
      }),
      manifests: [root(dep("foo", "npm:qs@6.7.0"), dep("parent", "^1.0.0"))],
    });
    assert.equal(p.alerts[0].status, "partly-fixed");
    assert.deepEqual(p.addOverrides, { "qs@>=6.0.0 <6.7.3": "6.7.3" });
    assert.deepEqual([...p.targets], [["node_modules/qs", "6.7.3"]]);
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

describe("bundled copies", () => {
  const BUNDLED = "node_modules/npm/node_modules/cli-table3/node_modules/ansi-regex";
  const ansiAlert = (): DependabotAlert => alert(1, "ansi-regex", ">= 5.0.0, < 5.0.1", "5.0.1");
  const npmBundle = {
    "node_modules/npm": { version: "8.0.0", dependencies: { "cli-table3": "^0.6.0" }, bundleDependencies: ["cli-table3"] },
    "node_modules/npm/node_modules/cli-table3": { version: "0.6.0", inBundle: true, dependencies: { "ansi-regex": "^5.0.0" } },
  };
  const rootNpm = { dependencies: { npm: "8.0.0", "strip-ansi": "^6.0.0" } };

  it("a bundled copy is blocked, saying a parent upgrade is what it needs, and the run writes nothing for it", () => {
    const p = plan({
      alerts: [ansiAlert()],
      lock: makeLock({ "": rootNpm, ...npmBundle, [BUNDLED]: { version: "5.0.0", inBundle: true } }),
    });
    assert.equal(p.alerts[0].status, "blocked");
    const [copy] = p.alerts[0].copies;
    assert.equal(copy.path, BUNDLED);
    assert.equal(copy.reason, "bundled");
    assert.match(copy.detail ?? "", /npm@8\.0\.0/);
    assert.match(copy.detail ?? "", /upgrad/i);
    assert.deepEqual(p.addOverrides, {});
    assert.deepEqual(p.bumps, []);
    assert.equal(p.targets.size, 0);
  });

  it("a bundled copy with no patched version says that first", () => {
    const p = plan({
      alerts: [alert(1, "ansi-regex", ">= 5.0.0", null)],
      lock: makeLock({ "": rootNpm, ...npmBundle, [BUNDLED]: { version: "5.0.0", inBundle: true } }),
    });
    assert.equal(p.alerts[0].copies[0].reason, "no-fix");
  });

  it("a safe bundled copy isn't reported at all", () => {
    const p = plan({
      alerts: [ansiAlert()],
      lock: makeLock({ "": rootNpm, ...npmBundle, [BUNDLED]: { version: "5.0.1", inBundle: true } }),
    });
    assert.equal(p.alerts[0].status, "awaiting-close");
  });

  it("a hoisted copy beside a vulnerable bundled one is still fixed: partly fixed, not over-blocked", () => {
    const p = plan({
      alerts: [ansiAlert()],
      lock: makeLock({
        "": rootNpm,
        ...npmBundle,
        [BUNDLED]: { version: "5.0.0", inBundle: true },
        "node_modules/strip-ansi": { version: "6.0.0", dependencies: { "ansi-regex": "^5.0.0" } },
        "node_modules/ansi-regex": { version: "5.0.0" },
      }),
    });
    assert.equal(p.alerts[0].status, "partly-fixed");
    assert.deepEqual(p.addOverrides, { "ansi-regex@>=5.0.0 <5.0.1": "5.0.1" });
    assert.deepEqual([...p.targets.keys()], ["node_modules/ansi-regex"]);
    const byPath = new Map(p.alerts[0].copies.map((c) => [c.path, c]));
    assert.equal(byPath.get("node_modules/ansi-regex")?.action, "override");
    assert.equal(byPath.get(BUNDLED)?.reason, "bundled");
  });

  it("a bundled parent's edge doesn't count as something the selector would catch", () => {
    const p = plan({
      alerts: [ansiAlert()],
      lock: makeLock({
        "": rootNpm,
        ...npmBundle,
        // Safe, but declared by a range the selector matches.
        [BUNDLED]: { version: "5.0.1", inBundle: true },
        "node_modules/strip-ansi": { version: "6.0.0", dependencies: { "ansi-regex": "^5.0.0" } },
        "node_modules/ansi-regex": { version: "5.0.0" },
      }),
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.deepEqual(p.addOverrides, { "ansi-regex@>=5.0.0 <5.0.1": "5.0.1" });
  });

  it("nor does the edge of the package that bundles it", () => {
    const p = plan({
      alerts: [ansiAlert()],
      lock: makeLock({
        "": rootNpm,
        "node_modules/npm": { version: "8.0.0", dependencies: { "ansi-regex": "^5.0.0" }, bundleDependencies: ["ansi-regex"] },
        "node_modules/npm/node_modules/ansi-regex": { version: "5.0.1", inBundle: true },
        "node_modules/strip-ansi": { version: "6.0.0", dependencies: { "ansi-regex": "^5.0.0" } },
        "node_modules/ansi-regex": { version: "5.0.0" },
      }),
    });
    assert.equal(p.alerts[0].status, "fixed");
  });

  it("a bundled parent resolving out to the hoisted copy doesn't block it, and is flagged if the fix lands past its range", () => {
    const p = plan({
      alerts: [ansiAlert()],
      lock: makeLock({
        "": rootNpm,
        "node_modules/npm": { version: "8.0.0", dependencies: { "cli-table3": "^0.6.0" }, bundleDependencies: ["cli-table3"] },
        "node_modules/npm/node_modules/cli-table3": { version: "0.6.0", inBundle: true, dependencies: { "ansi-regex": "5.0.0" } },
        "node_modules/strip-ansi": { version: "6.0.0", dependencies: { "ansi-regex": "^5.0.0" } },
        "node_modules/ansi-regex": { version: "5.0.0" },
      }),
    });
    assert.equal(p.alerts[0].status, "fixed");
    assert.deepEqual(p.alerts[0].copies[0].pastDeclared, [{ dependent: "cli-table3", range: "5.0.0" }]);
  });
});
