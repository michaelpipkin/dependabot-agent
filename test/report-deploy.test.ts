import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  logDeployRecommendation,
  MAX_DEPLOY_ENTRIES,
  manifestLabel,
  recommendDeploy,
  renderDeploySection,
  type DeployInput,
} from "../src/report/deploy.js";

// Based on the pip-cost-sharing run of 2026-11-09.
const inputs: DeployInput[] = [
  { packageName: "@grpc/grpc-js", scope: "production", manifest: "pnpm-lock.yaml", via: ["@firebase/firestore@4.19.1", "google-gax@5.0.8"] },
  { packageName: "glob", scope: "production", manifest: "pnpm-lock.yaml", via: ["rimraf@5.0.10", "replace-in-file@9.0.0", "rimraf@6.1.3"] },
  { packageName: "glob", scope: "production", manifest: "functions/pnpm-lock.yaml", via: ["rimraf@5.0.10"] },
  { packageName: "follow-redirects", scope: "dev", manifest: "pnpm-lock.yaml", via: ["axios@1.20.0"] },
];

const lines = (text: string): string[] => text.split("\n");

describe("manifestLabel", () => {
  it("labels a root manifest, an isolated lockfile directory and a workspace package", () => {
    assert.equal(manifestLabel("package-lock.json"), "root");
    assert.equal(manifestLabel("functions/pnpm-lock.yaml"), "functions/");
    assert.equal(manifestLabel("packages/a/package.json"), "packages/a/");
  });
});

describe("recommendDeploy", () => {
  it("merges one entry per package across manifests", () => {
    const rec = recommendDeploy(inputs, []);
    assert.equal(rec.outcome, "deploy");
    assert.deepEqual(rec.production.map((e) => e.packageName), ["@grpc/grpc-js", "glob"]);
    const glob = rec.production[1];
    assert.deepEqual(glob.places, ["root", "functions/"]);
    assert.deepEqual(glob.via, ["rimraf", "replace-in-file"]);
    assert.deepEqual(rec.development.map((e) => e.packageName), ["follow-redirects"]);
    assert.deepEqual(rec.unknown, []);
  });

  it("puts root first and sorts the other places", () => {
    const rec = recommendDeploy(
      [
        { packageName: "x", scope: "production", manifest: "packages/b/package.json", via: [] },
        { packageName: "x", scope: "production", manifest: "package-lock.json", via: [] },
        { packageName: "x", scope: "production", manifest: "packages/a/package.json", via: [] },
      ],
      [],
    );
    assert.deepEqual(rec.production[0].places, ["root", "packages/a/", "packages/b/"]);
  });

  it("keeps a leading @scope/ when stripping a version from a via name", () => {
    const rec = recommendDeploy([{ packageName: "x", scope: "production", manifest: "package.json", via: ["@a/b@1.0.0", "@a/b@2.0.0", "c@1"] }], []);
    assert.deepEqual(rec.production[0].via, ["@a/b", "c"]);
  });

  it("drops via entries that are empty or name the package itself", () => {
    const rec = recommendDeploy(
      [
        { packageName: "js-yaml", scope: "production", manifest: "pnpm-lock.yaml", via: [""] },
        { packageName: "js-yaml", scope: "production", manifest: "package-lock.json", via: ["  ", "js-yaml@4.1.0", "foo@1.0.0"] },
        { packageName: "bar", scope: "production", manifest: "package.json", via: ["bar"] },
      ],
      [],
    );
    assert.deepEqual(rec.production[0].via, ["foo"]);
    assert.deepEqual(rec.production[1].via, []);
  });

  it("merges a package's scope as production over dev over unknown", () => {
    const rec = recommendDeploy(
      [
        { packageName: "x", scope: "dev", manifest: "package.json", via: [] },
        { packageName: "x", scope: "production", manifest: "functions/package.json", via: [] },
        { packageName: "y", scope: "unknown", manifest: "package.json", via: [] },
        { packageName: "y", scope: "dev", manifest: "functions/package.json", via: [] },
      ],
      [],
    );
    assert.deepEqual(rec.production.map((e) => e.packageName), ["x"]);
    assert.deepEqual(rec.development.map((e) => e.packageName), ["y"]);
    assert.deepEqual(rec.unknown, []);
  });

  it("is no-deploy when every fixed package is development-only", () => {
    assert.equal(recommendDeploy([inputs[3]], []).outcome, "no-deploy");
  });

  it("is check when one package is undetermined and the rest are dev-only", () => {
    const rec = recommendDeploy([{ packageName: "u", scope: "unknown", manifest: "package.json", via: [] }, inputs[3]], []);
    assert.equal(rec.outcome, "check");
  });

  it("lets production win over unknown", () => {
    const rec = recommendDeploy([{ packageName: "u", scope: "unknown", manifest: "package.json", via: [] }, inputs[0]], []);
    assert.equal(rec.outcome, "deploy");
  });

  it("is check when only overrides were removed, and none when nothing happened", () => {
    assert.equal(recommendDeploy([], ["minimist"]).outcome, "check");
    assert.equal(recommendDeploy([], []).outcome, "none");
  });

  it("keeps dev-only fixes ahead of removed overrides", () => {
    assert.equal(recommendDeploy([inputs[3]], ["minimist"]).outcome, "no-deploy");
  });
});

describe("renderDeploySection", () => {
  it("renders a deploy box with one line per package, naming every place", () => {
    const text = renderDeploySection(recommendDeploy(inputs, []));
    const out = lines(text);
    assert.equal(out[0], "## Deploy recommendation");
    assert.equal(out[1], "");
    assert.ok(out.includes("> [!IMPORTANT]"));
    assert.ok(out.includes("> 🚀 **Deploy:** fixed packages are in production code"));
    assert.ok(out.includes("> - `glob` via `rimraf`, `replace-in-file` (root and `functions/`)"));
    assert.ok(out.includes("> - `@grpc/grpc-js` via `@firebase/firestore`, `google-gax`"));
    assert.ok(out.includes("> Development only: `follow-redirects`"));
    assert.equal(out.filter((l) => l.startsWith("> - `glob`")).length, 1);
    assert.ok(!text.includes("CAUTION"));
    assert.ok(out.every((l, i) => i < 2 || l === "" || l === ">" || l.startsWith("> ")));
  });

  it("renders a tip box for dev-only fixes", () => {
    const out = lines(renderDeploySection(recommendDeploy([inputs[3]], [])));
    assert.ok(out.includes("> [!TIP]"));
    assert.ok(out.includes("> ✅ **No deploy needed:** every fixed package is development-only"));
    assert.ok(out.includes("> `follow-redirects`"));
  });

  it("renders a warning box listing the undetermined packages and the dev line", () => {
    const out = lines(
      renderDeploySection(recommendDeploy([{ packageName: "u", scope: "unknown", manifest: "package.json", via: [] }, inputs[3]], [])),
    );
    assert.ok(out.includes("> [!WARNING]"));
    assert.ok(out.includes("> ❓ **Check before deciding:** couldn't tell whether these reach production"));
    assert.ok(out.includes("> - `u`"));
    assert.ok(out.includes("> Development only: `follow-redirects`"));
  });

  // In GFM a line right after a list item is a lazy continuation of it, so without
  // the blank quote line the development names render inside the last bullet.
  it("puts a blank quote line between the bullets and the development line", () => {
    const deploy = lines(renderDeploySection(recommendDeploy(inputs, [])));
    const dev = deploy.indexOf("> Development only: `follow-redirects`");
    assert.equal(deploy[dev - 1], ">");
    assert.ok(deploy[dev - 2].startsWith("> - "));
    const check = lines(
      renderDeploySection(recommendDeploy([{ packageName: "u", scope: "unknown", manifest: "package.json", via: [] }, inputs[3]], [])),
    );
    assert.deepEqual(check.slice(-3), ["> - `u`", ">", "> Development only: `follow-redirects`"]);
    const capped = lines(
      renderDeploySection(
        recommendDeploy([...many(31, "production"), { packageName: "d", scope: "dev", manifest: "package.json", via: [] }], []),
      ),
    );
    assert.deepEqual(capped.slice(-3), ["> - …and 1 more", ">", "> Development only: `d`"]);
  });

  it("leaves the blank quote line out when there is no development line", () => {
    const out = lines(renderDeploySection(recommendDeploy([inputs[0]], [])));
    assert.ok(!out.includes(">"));
  });

  it("explains a check caused only by removed overrides", () => {
    const out = lines(renderDeploySection(recommendDeploy([], ["minimist", "@scope/pkg"])));
    assert.ok(out.includes("> [!WARNING]"));
    assert.ok(out.includes("> ❓ **Check before deciding:** overrides were removed, which can change installed versions at the next install"));
    assert.ok(out.includes("> Overrides removed: `minimist`, `@scope/pkg`"));
  });

  it("renders nothing when there is nothing to recommend", () => {
    assert.equal(renderDeploySection(recommendDeploy([], [])), "");
  });

  const many = (n: number, scope: DeployInput["scope"]): DeployInput[] =>
    Array.from({ length: n }, (_, i) => ({ packageName: `pkg-${i}`, scope, manifest: "package.json", via: [] }));

  it("names at most 30 production packages, then says how many more", () => {
    assert.equal(MAX_DEPLOY_ENTRIES, 30);
    const out = lines(renderDeploySection(recommendDeploy(many(31, "production"), [])));
    assert.equal(out.filter((l) => l.startsWith("> - `pkg-")).length, 30);
    assert.ok(out.includes("> - …and 1 more"));
    assert.ok(!out.includes("> - `pkg-30`"));
  });

  it("names at most 30 undetermined packages, then says how many more", () => {
    const out = lines(renderDeploySection(recommendDeploy(many(33, "unknown"), [])));
    assert.equal(out.filter((l) => l.startsWith("> - `pkg-")).length, 30);
    assert.ok(out.includes("> - …and 3 more"));
  });

  it("names at most 30 development-only packages, then says how many more", () => {
    const tip = lines(renderDeploySection(recommendDeploy(many(32, "dev"), [])));
    const names = tip.find((l) => l.startsWith("> `pkg-0`"))!;
    assert.equal(names.split("`pkg-").length - 1, 30);
    assert.ok(names.endsWith(", and 2 more"), names);
    const withProd = lines(renderDeploySection(recommendDeploy([...many(1, "production"), ...many(32, "dev").map((d) => ({ ...d, packageName: `dev-${d.packageName}` }))], [])));
    const dev = withProd.find((l) => l.startsWith("> Development only: "))!;
    assert.ok(dev.endsWith(", and 2 more"), dev);
  });

  it("names at most 30 removed overrides, then says how many more", () => {
    const keys = Array.from({ length: 31 }, (_, i) => `k${i}`);
    const out = lines(renderDeploySection(recommendDeploy([], keys)));
    assert.ok(out.find((l) => l.startsWith("> Overrides removed: "))!.endsWith(", and 1 more"));
  });

  it("says nothing about 'more' at exactly 30", () => {
    const text = renderDeploySection(recommendDeploy([...many(30, "production"), ...many(30, "dev").map((d) => ({ ...d, packageName: `dev-${d.packageName}` }))], []));
    assert.doesNotMatch(text, /more/);
    assert.equal(lines(text).filter((l) => l.startsWith("> - `pkg-")).length, 30);
  });

  it("shows five via names, then how many more", () => {
    const via = ["a", "b", "c", "d", "e", "f", "g"];
    const out = lines(renderDeploySection(recommendDeploy([{ packageName: "x", scope: "production", manifest: "package.json", via }], [])));
    assert.ok(out.includes("> - `x` via `a`, `b`, `c`, `d`, `e`, and 2 more"));
  });

  it("joins three places as 'a, b and c'", () => {
    const out = lines(
      renderDeploySection(
        recommendDeploy(
          ["package.json", "packages/a/package.json", "packages/b/package.json"].map((manifest) => ({ packageName: "x", scope: "production" as const, manifest, via: [] })),
          [],
        ),
      ),
    );
    assert.ok(out.includes("> - `x` (root, `packages/a/` and `packages/b/`)"));
  });

  it("never renders a bare mention, even for a hostile name", () => {
    const text = renderDeploySection(
      recommendDeploy([{ packageName: "@evil", scope: "production", manifest: "package.json", via: ["@evil", "a`@evil"] }], ["@evil"]),
    );
    for (const line of lines(text)) {
      assert.ok(!line.replace(/`[^`]*`/g, "").includes("@evil"), line);
    }
    assert.ok(text.includes("> - `@evil` via `a'`"));
  });

  it("renders a direct dependency with no via part, and keeps the other names", () => {
    const bare = lines(renderDeploySection(recommendDeploy([{ packageName: "js-yaml", scope: "production", manifest: "pnpm-lock.yaml", via: [""] }], [])));
    assert.ok(bare.includes("> - `js-yaml`"));
    assert.ok(!bare.some((l) => l.includes("via")));
    const some = lines(
      renderDeploySection(recommendDeploy([{ packageName: "js-yaml", scope: "production", manifest: "pnpm-lock.yaml", via: ["js-yaml@4.1.0", "foo@1.0.0"] }], [])),
    );
    assert.ok(some.includes("> - `js-yaml` via `foo`"));
  });
});

describe("logDeployRecommendation", () => {
  afterEach(() => mock.restoreAll());

  const capture = (rec: ReturnType<typeof recommendDeploy>): string[] => {
    const out: string[] = [];
    mock.method(console, "log", (m?: unknown) => out.push(String(m)));
    logDeployRecommendation(rec);
    return out;
  };

  it("prints the heading, plain-text entries and the deploy recommendation", () => {
    const out = capture(recommendDeploy(inputs, []));
    assert.equal(out[0], "\n🚀 Deployment impact analysis:");
    assert.ok(out.some((l) => l.includes("glob") && l.includes("rimraf, replace-in-file") && l.includes("root and functions/")));
    assert.ok(out.some((l) => l.includes("follow-redirects")));
    assert.equal(out.at(-1), "   🚀 Recommendation: DEPLOY — fixed packages are in production code.");
  });

  it("prints the no-deploy and check recommendations", () => {
    assert.equal(capture(recommendDeploy([inputs[3]], [])).at(-1), "   ✅ Recommendation: NO DEPLOY NEEDED — every fixed package is development-only.");
    assert.match(capture(recommendDeploy([], ["minimist"])).at(-1) ?? "", /^ {3}❓ Recommendation: CHECK BEFORE DECIDING — /);
  });

  it("prints no via part for a direct dependency", () => {
    const out = capture(recommendDeploy([{ packageName: "js-yaml", scope: "production", manifest: "pnpm-lock.yaml", via: ["", "js-yaml@4.1.0"] }], []));
    assert.ok(out.includes("      ⚠️  js-yaml"));
    assert.ok(!out.some((l) => l.includes("via")));
  });

  it("prints nothing for none", () => {
    assert.deepEqual(capture(recommendDeploy([], [])), []);
  });
});
