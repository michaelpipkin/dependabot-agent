import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AlertFix } from "../src/report/alert-fixes.js";
import { MAX_BODY_CHARS } from "../src/report/markdown.js";
import {
  assembleStrategyReport,
  deployInputsOf,
  renderStrategyReport,
  writeStrategyReport,
  type StrategyReport,
} from "../src/report/strategy-report.js";
import type { DeploymentRecommendation } from "../src/types.js";

const fix = (over: Partial<AlertFix> & Pick<AlertFix, "number" | "packageName" | "status">): AlertFix => ({
  url: `https://github.com/o/r/security/dependabot/${over.number}`,
  severity: "high",
  manifest: "pnpm-lock.yaml",
  scope: "production",
  from: ["1.0.0"],
  to: "1.0.1",
  ...over,
});

const impact = (over: Partial<DeploymentRecommendation> = {}) => (packageName: string): DeploymentRecommendation => ({
  packageName,
  scope: "unknown",
  productionPaths: ["app-prod"],
  devPaths: ["tool-dev"],
  ...over,
});

const build = (fixes: AlertFix[], over: Partial<Parameters<typeof assembleStrategyReport>[0]> = {}): StrategyReport =>
  assembleStrategyReport({
    strategy: "latest",
    packageManager: "pnpm",
    dryRun: false,
    fixes,
    deployInputs: deployInputsOf(fixes, impact()),
    overridesAddedOrUpdated: 0,
    overridesRemoved: 0,
    removedOverrideKeys: [],
    packagesUpdated: 1,
    ...over,
  });

// 40 distinct packages: the deploy section is never cut, so it must stay small for the table to be what overflows.
const manyFixes = (n: number): AlertFix[] =>
  Array.from({ length: n }, (_, i) =>
    fix({ number: i + 1, packageName: `package-with-a-long-name-${String(i % 40).padStart(2, "0")}`, status: "update" }),
  );

const rowCount = (body: string): number => [...body.matchAll(/^\| \[#\d+\]/gm)].length;

describe("deployInputsOf", () => {
  it("uses impactOf only for the scope of a fix whose scope is unknown", () => {
    const fixes = [
      fix({ number: 1, packageName: "a", status: "update", scope: "dev", manifest: "functions/pnpm-lock.yaml" }),
      fix({ number: 2, packageName: "b", status: "update", scope: "unknown" }),
    ];
    const inputs = deployInputsOf(fixes, impact({ scope: "production" }));
    assert.deepEqual(inputs[0], { packageName: "a", scope: "dev", manifest: "functions/pnpm-lock.yaml", via: ["tool-dev"] });
    assert.deepEqual(inputs[1], { packageName: "b", scope: "production", manifest: "pnpm-lock.yaml", via: ["app-prod"] });
  });

  it("takes via from the production paths, the dev paths, or both", () => {
    const fixes = [
      fix({ number: 1, packageName: "p", status: "update", scope: "production" }),
      fix({ number: 2, packageName: "d", status: "update", scope: "dev" }),
      fix({ number: 3, packageName: "u", status: "update", scope: "unknown" }),
    ];
    const inputs = deployInputsOf(fixes, impact({ scope: "unknown" }));
    assert.deepEqual(inputs.map((i) => i.via), [["app-prod"], ["tool-dev"], ["app-prod", "tool-dev"]]);
    assert.equal(inputs[2].scope, "unknown");
  });
});

describe("deployInputsOf with unfiltered alerts", () => {
  it("leaves out alerts the run did not fix, so an already-patched production alert never recommends a deploy", () => {
    const fixes = [
      fix({ number: 1, packageName: "prod-pkg", status: "awaiting-close", scope: "production", from: [], to: undefined }),
      fix({ number: 2, packageName: "dev-pkg", status: "override", scope: "dev", to: "≥ 2.0.0" }),
    ];
    const inputs = deployInputsOf(fixes, impact());
    assert.deepEqual(inputs.map((i) => i.packageName), ["dev-pkg"]);
    const body = renderStrategyReport(build(fixes, { packagesUpdated: 0, overridesAddedOrUpdated: 1 }));
    assert.match(body, /\[!TIP\]/);
    assert.doesNotMatch(body, /\[!IMPORTANT\]/);
  });
});

describe("assembleStrategyReport", () => {
  it("counts open alerts, addressed ones and the rest", () => {
    const fixes = [
      fix({ number: 1, packageName: "a", status: "update" }),
      fix({ number: 2, packageName: "b", status: "override", to: "≥ 2.0.0" }),
      fix({ number: 3, packageName: "c", status: "no-patch", from: [], to: undefined }),
    ];
    const r = build(fixes, { overridesAddedOrUpdated: 1, packagesUpdated: 4 });
    assert.deepEqual(r.summary, {
      open: 3,
      addressed: 2,
      overridesAddedOrUpdated: 1,
      overridesRemoved: 0,
      packagesUpdated: 4,
      updatePassOnly: true,
    });
    assert.deepEqual(r.notAddressed.map((f) => f.number), [3]);
    assert.equal(r.outcome, "changes");
  });

  it("is clean with no fixes and no changes", () => {
    const r = build([], { packagesUpdated: 0 });
    assert.equal(r.outcome, "clean");
    assert.equal(r.deploy.outcome, "none");
    const body = renderStrategyReport(r);
    assert.match(body, /No alerts were fixed in this run\./);
    assert.doesNotMatch(body, /Deploy recommendation/);
    assert.doesNotMatch(body, /\| Alert \|/);
  });

  it("is changes when only overrides were removed", () => {
    const r = build([], { packagesUpdated: 0, overridesRemoved: 1, removedOverrideKeys: ["x"] });
    assert.equal(r.outcome, "changes");
    assert.equal(r.deploy.outcome, "check");
  });

  it("never recommends a deploy for a production alert that was already patched, and lists it as awaiting close", () => {
    const fixes = [
      fix({ number: 10, packageName: "prod-pkg", status: "awaiting-close", scope: "production", from: [], to: undefined }),
      fix({ number: 11, packageName: "dev-pkg", status: "override", scope: "dev", to: "≥ 2.0.0" }),
    ];
    const r = build(fixes, { overridesAddedOrUpdated: 1, packagesUpdated: 0 });
    assert.equal(r.deploy.outcome, "no-deploy");
    const body = renderStrategyReport(r);
    assert.match(body, /\[!TIP\]/);
    assert.doesNotMatch(body, /\[!IMPORTANT\]/);
    const line = body.split("\n").find((l) => l.startsWith("**Not addressed:**"));
    assert.ok(line);
    assert.match(line, /already patched, awaiting close/);
    assert.match(line, /\[#10\]/);
  });
});

describe("renderStrategyReport", () => {
  it("renders the header, summary line, strategy line, deploy box and table", () => {
    const body = renderStrategyReport(
      build([fix({ number: 7, packageName: "lodash", status: "update", from: ["4.17.0", "4.16.0"], to: "4.17.21" })]),
    );
    const lines = body.split("\n");
    assert.equal(lines[0], "# Dependency overrides reconciled");
    assert.match(body, /\*\*1\*\* of 1 alert addressed/);
    assert.match(body, /\*\*1\*\* package updated by the update pass/);
    assert.match(body, /^Strategy `latest` on pnpm\.$/m);
    assert.ok(body.indexOf("Strategy `latest`") > body.indexOf("addressed"));
    assert.match(body, /\[!IMPORTANT\]/);
    assert.match(body, /\| Alert \| Severity \| Package \| Change \| How \| Scope \| Manifest \|/);
    assert.match(
      body,
      /\| \[#7\]\(https:\/\/github\.com\/o\/r\/security\/dependabot\/7\) \| high \| `lodash` \| 4\.17\.0, 4\.16\.0 → 4\.17\.21 \| update \| production \| `pnpm-lock\.yaml` \|/,
    );
    assert.doesNotMatch(body, /Not addressed/);
  });

  it("renders override rows, a removed package and an empty from", () => {
    const body = renderStrategyReport(
      build([
        fix({ number: 1, packageName: "a", status: "override", scope: "dev", from: ["1.0.0"], to: "≥ 1.2.0" }),
        fix({ number: 2, packageName: "b", status: "update", scope: "dev", from: [], to: "removed" }),
      ]),
    );
    assert.match(body, /\| `a` \| 1\.0\.0 → ≥ 1\.2\.0 \| override \| dev\/test only \|/);
    assert.match(body, /\| `b` \| \? → removed \| update \| dev\/test only \|/);
  });

  it("orders rows production, dev, unknown, then by package name", () => {
    const body = renderStrategyReport(
      build([
        fix({ number: 1, packageName: "z-dev", status: "update", scope: "dev" }),
        fix({ number: 2, packageName: "m-unknown", status: "update", scope: "unknown" }),
        fix({ number: 3, packageName: "z-prod", status: "update", scope: "production" }),
        fix({ number: 4, packageName: "a-prod", status: "update", scope: "production" }),
        fix({ number: 5, packageName: "a-dev", status: "update", scope: "dev" }),
      ]),
    );
    const order = [...body.matchAll(/^\| \[#\d+\].*?`([^`]+)`/gm)].map((m) => m[1]);
    assert.deepEqual(order, ["a-prod", "z-prod", "a-dev", "z-dev", "m-unknown"]);
  });

  it("gives the reason for each kind of alert it did not fix", () => {
    const reasons: Array<[AlertFix["status"], string]> = [
      ["awaiting-close", "already patched, awaiting close"],
      ["covered", "an existing override covers it from the next install"],
      ["no-patch", "no patched version"],
      ["not-installed", "not installed"],
      ["still-vulnerable", "still vulnerable after this run"],
    ];
    const fixes = reasons.map(([status], i) =>
      fix({ number: 100 + i, packageName: `p${i}`, status, from: [], to: undefined }),
    );
    const body = renderStrategyReport(build(fixes, { packagesUpdated: 0 }));
    for (const [, text] of reasons) assert.ok(body.includes(`: ${text}`), text);
    assert.match(
      body,
      /\*\*Not addressed:\*\* \[#100\]\(https:\/\/github\.com\/o\/r\/security\/dependabot\/100\) `p0`: already patched, awaiting close; /,
    );
  });

  it("lists at most 20 not-addressed alerts and counts the rest", () => {
    const fixes = Array.from({ length: 25 }, (_, i) =>
      fix({ number: i + 1, packageName: `p${i}`, status: "no-patch", from: [], to: undefined }),
    );
    const body = renderStrategyReport(build(fixes, { packagesUpdated: 0 }));
    const line = body.split("\n").find((l) => l.startsWith("**Not addressed:**"))!;
    assert.equal(line.split("; ").length, 21);
    assert.ok(line.endsWith("; and 5 more"));
  });

  it("shows zero packages updated by the update pass in a real run", () => {
    const body = renderStrategyReport(build([], { packagesUpdated: 0, overridesAddedOrUpdated: 1 }));
    assert.match(body, /\*\*0\*\* packages updated by the update pass/);
  });

  it("neutralises backticks in package and manifest names", () => {
    const body = renderStrategyReport(build([fix({ number: 1, packageName: "a`b", manifest: "x`y/package-lock.json", status: "update" })]));
    assert.match(body, /\| `a'b` \|/);
    assert.match(body, /\| `x'y\/package-lock\.json` \|/);
  });

  it("renders a dry run as a plan, without the packages-updated count", () => {
    const body = renderStrategyReport(build([fix({ number: 1, packageName: "a", status: "update" })], { dryRun: true }));
    assert.ok(body.startsWith("# Dependency overrides reconciled — plan\n"));
    assert.match(body, /> \*\*Dry run\.\*\* This is the plan of what the tool would do\. Nothing was changed\./);
    assert.match(body, /Planned: /);
    assert.doesNotMatch(body, /packages? updated/);
  });

  it("truncates a huge table but keeps the header, summary and deploy section", () => {
    const report = build(manyFixes(2000));
    const body = renderStrategyReport(report);
    assert.ok(body.length <= MAX_BODY_CHARS, `${body.length} chars`);
    assert.match(body, /\*\*2000\*\* of 2000 alerts addressed/);
    assert.match(body, /\[!IMPORTANT\]/);
    assert.ok(
      body
        .trimEnd()
        .endsWith(
          "_This report was cut to fit GitHub's size limit. Not shown in full: Packages. The complete report is in the workflow run's job summary._",
        ),
    );
    assert.ok(rowCount(body) > 0 && rowCount(body) < 2000);
    const full = renderStrategyReport(report, { full: true });
    assert.ok(full.length > MAX_BODY_CHARS);
    assert.equal(rowCount(full), 2000);
  });
});

describe("a report with thousands of distinct fixed packages", () => {
  it("keeps the body within the limit, with the summary and the deploy box", () => {
    const fixes = Array.from({ length: 5000 }, (_, i) => fix({ number: i + 1, packageName: `distinct-package-${i}`, status: "update", scope: "production" }));
    const body = renderStrategyReport(build(fixes));
    assert.ok(body.length <= MAX_BODY_CHARS, `${body.length} chars`);
    assert.match(body, /\[!IMPORTANT\]/);
    assert.match(body, /\*\*5000\*\* of 5000 alerts addressed/);
    assert.ok(body.includes("- …and 4970 more"));
  });
});

describe("writeStrategyReport", () => {
  it("writes report.md and report.json, and no report-full.md when nothing was cut", () => {
    const dir = mkdtempSync(join(tmpdir(), "strategy-report-"));
    try {
      const small = build([fix({ number: 1, packageName: "a", status: "update" })]);
      writeStrategyReport(dir, small);
      assert.equal(existsSync(join(dir, "report-full.md")), false);
      const json = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as StrategyReport;
      assert.equal(json.outcome, small.outcome);
      assert.deepEqual(json.summary, small.summary);
      assert.equal(json.deploy.outcome, small.deploy.outcome);
      assert.equal(readFileSync(join(dir, "report.md"), "utf8"), renderStrategyReport(small));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes report-full.md holding every row when the body was cut", () => {
    const dir = mkdtempSync(join(tmpdir(), "strategy-report-"));
    try {
      writeStrategyReport(dir, build(manyFixes(2000)));
      assert.ok(readFileSync(join(dir, "report.md"), "utf8").length <= MAX_BODY_CHARS);
      assert.equal(rowCount(readFileSync(join(dir, "report-full.md"), "utf8")), 2000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
