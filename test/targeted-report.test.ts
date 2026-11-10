import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AlertOutcome, CopyDecision } from "../src/targeted/plan.js";
import { computeOutcome, inline, MAX_BODY_CHARS, renderMarkdown, targetedDeploy, targetedSummary, writeReport, type RunReport } from "../src/targeted/report.js";

function copy(over: Partial<CopyDecision> = {}): CopyDecision {
  return { path: "node_modules/lodash", version: "4.17.20", action: "bump", target: "4.17.21", pastDeclared: [], ...over };
}

function alert(over: Partial<AlertOutcome> = {}): AlertOutcome {
  return {
    number: 12,
    url: "https://github.com/acme/app/security/dependabot/12",
    packageName: "lodash",
    severity: "high",
    scope: "production",
    status: "fixed",
    manifest: "package-lock.json",
    copies: [copy()],
    ...over,
  };
}

function report(over: Partial<RunReport> = {}): RunReport {
  return {
    outcome: "changes",
    dryRun: false,
    blockedCount: 0,
    alerts: [alert()],
    otherChanges: [],
    keptOverrides: [],
    removedOverrides: [],
    failures: [],
    npmVersion: "11.16.0",
    ...over,
  };
}

const blockedAlert = (over: Partial<AlertOutcome> = {}): AlertOutcome =>
  alert({
    number: 30,
    url: "https://github.com/acme/app/security/dependabot/30",
    packageName: "minimist",
    severity: "critical",
    status: "blocked",
    copies: [
      copy({
        path: "node_modules/minimist",
        version: "0.2.0",
        action: "blocked",
        target: undefined,
        reason: "pin",
        detail: 'Pinned at "0.2.0" in package.json.',
      }),
    ],
    ...over,
  });

// The deploy recommendation sits in the header, so these are the sections below it.
const headings = (md: string): string[] => [...md.matchAll(/^## (?!Deploy recommendation$)(.+)$/gm)].map((m) => m[1]);

describe("computeOutcome", () => {
  it("follows the spec's order", () => {
    assert.equal(computeOutcome({ failed: true, changedFiles: 3, blockedCount: 0 }), "failed");
    assert.equal(computeOutcome({ failed: false, changedFiles: 1, blockedCount: 2 }), "changes");
    assert.equal(computeOutcome({ failed: false, changedFiles: 0, blockedCount: 2 }), "blocked-only");
    assert.equal(computeOutcome({ failed: false, changedFiles: 0, blockedCount: 0 }), "clean");
  });

  it("awaiting-close alone is clean, not blocked-only", () => {
    // Awaiting-close alerts have no blocked copies, so blockedCount stays 0.
    const awaiting = alert({ status: "awaiting-close", copies: [] });
    const blockedCount = [awaiting].flatMap((a) => a.copies).filter((c) => c.action === "blocked").length;
    assert.equal(computeOutcome({ failed: false, changedFiles: 0, blockedCount }), "clean");
  });
});

describe("renderMarkdown", () => {
  it("uses the spec's section headings, omitting empty ones", () => {
    const full = report({
      alerts: [
        alert(),
        alert({
          number: 13,
          status: "partly-fixed",
          copies: [
            copy({ path: "node_modules/a/node_modules/lodash", version: "4.17.15" }),
            copy({ action: "blocked", reason: "limit", detail: 'Outside the limit "lodash": "^4.0.0".', target: undefined }),
          ],
        }),
        alert({
          number: 14,
          packageName: "semver",
          copies: [copy({ pastDeclared: [{ dependent: "old-tool", range: "^6.0.0" }] })],
        }),
        blockedAlert(),
        alert({ number: 40, packageName: "waiting", status: "awaiting-close", copies: [] }),
        alert({ number: 41, packageName: "ghost", status: "not-found", copies: [] }),
      ],
      otherChanges: [{ path: "node_modules/dep", from: "1.0.0", to: "1.1.0" }],
    });
    assert.deepEqual(headings(renderMarkdown(full)), [
      "Fixed",
      "Partly fixed",
      "Applied past a declared range — review these",
      "Blocked",
      "Awaiting close or not found",
      "Other changes",
    ]);

    const small = renderMarkdown(report());
    assert.deepEqual(headings(small), ["Fixed"]);
  });

  it("a fixed entry shows alert link, severity, package, from → to, mechanism and scope", () => {
    const md = renderMarkdown(
      report({
        alerts: [
          alert(),
          alert({ number: 15, packageName: "tar", severity: "low", scope: "dev", copies: [copy({ action: "override", version: "6.1.0", target: "6.2.1" })] }),
        ],
      }),
    );
    const row = md.split("\n").find((l: string) => l.includes("lodash") && l.startsWith("|"))!;
    assert.ok(row.includes("[#12](https://github.com/acme/app/security/dependabot/12)"), row);
    assert.ok(row.includes("high"), row);
    assert.ok(row.includes("4.17.20 → 4.17.21"), row);
    assert.ok(row.includes("range bump"), row);
    assert.ok(row.includes("production"), row);
    const devRow = md.split("\n").find((l: string) => l.includes("tar") && l.startsWith("|"))!;
    assert.ok(devRow.includes("6.1.0 → 6.2.1"), devRow);
    assert.ok(devRow.includes("override"), devRow);
    assert.ok(devRow.includes("dev"), devRow);
  });

  it("escapes pipes in table cells", () => {
    const md = renderMarkdown(report({ alerts: [alert({ packageName: "we|rd" })] }));
    assert.ok(md.includes("we\\|rd"));
  });

  it("a blocked entry names the limit, pin or override", () => {
    const limit = blockedAlert({
      number: 31,
      packageName: "capped",
      copies: [copy({ action: "blocked", reason: "limit", target: undefined, detail: 'capped@2.0.1 is outside the limit "capped": "^1.0.0".' })],
    });
    const override = blockedAlert({
      number: 32,
      packageName: "hand",
      copies: [copy({ action: "blocked", reason: "hand-written-override", target: undefined, detail: "Hand-written override: hand@<2.0.0." })],
    });
    const md = renderMarkdown(report({ outcome: "blocked-only", blockedCount: 3, alerts: [blockedAlert(), limit, override] }));
    assert.ok(md.includes('Pinned at "0.2.0" in package.json.'));
    assert.ok(md.includes('outside the limit "capped": "^1.0.0"'));
    assert.ok(md.includes("Hand-written override: hand@<2.0.0."));
    assert.ok(md.includes("[#30](https://github.com/acme/app/security/dependabot/30)"));
    assert.ok(md.includes("critical"));
  });

  it("shows a partly fixed alert's blocked copies under Blocked as well", () => {
    const partly = alert({
      number: 13,
      status: "partly-fixed",
      copies: [
        copy({ path: "node_modules/a/node_modules/lodash", version: "4.17.15" }),
        copy({ action: "blocked", reason: "pin", detail: 'Pinned at "4.17.20" in package.json.', target: undefined }),
      ],
    });
    const md = renderMarkdown(report({ blockedCount: 1, alerts: [partly] }));
    assert.deepEqual(headings(md), ["Partly fixed", "Blocked"]);
    const blocked = md.slice(md.indexOf("## Blocked"));
    assert.ok(blocked.includes('Pinned at "4.17.20" in package.json.'));
    assert.ok(blocked.includes("#13"));
  });

  it("lists the dependents a past-range fix falls outside of", () => {
    const md = renderMarkdown(
      report({ alerts: [alert({ copies: [copy({ pastDeclared: [{ dependent: "old-tool", range: "^4.0.0" }] })] })] }),
    );
    const section = md.slice(md.indexOf("## Applied past a declared range"));
    assert.ok(section.includes("old-tool"));
    assert.ok(section.includes("^4.0.0"));
    assert.ok(section.includes("4.17.21"));
  });

  it("labels a dry run as a plan", () => {
    const md = renderMarkdown(report({ dryRun: true }));
    assert.match(md, /dry run/i);
    assert.match(md, /plan/i);
    assert.match(md, /nothing was (changed|written)/i);
    assert.doesNotMatch(renderMarkdown(report()), /dry run/i);
  });

  it("a failed report names the check and package", () => {
    const md = renderMarkdown(
      report({
        outcome: "failed",
        alerts: [],
        failures: [{ check: "nothing-else-moved", path: "node_modules/picomatch", detail: "picomatch moved from 4.0.3 to 4.0.4 without being targeted." }],
      }),
    );
    assert.ok(md.includes("nothing-else-moved"));
    assert.ok(md.includes("node_modules/picomatch"));
    assert.ok(md.includes("picomatch moved from 4.0.3 to 4.0.4"));
    assert.match(md, /failed/i);
  });

  it("lists kept overrides and other changes", () => {
    const md = renderMarkdown(
      report({
        otherChanges: [{ path: "node_modules/dep", from: "1.0.0", to: "1.1.0" }, { path: "node_modules/new-dep", to: "2.0.0" }],
        keptOverrides: [{ key: "qs@>=6.0.0 <6.7.3", reason: "still needed by express" }],
      }),
    );
    assert.ok(md.includes("node_modules/dep"));
    assert.ok(md.includes("1.0.0 → 1.1.0"));
    assert.ok(md.includes("qs@>=6.0.0 <6.7.3"));
    assert.ok(md.includes("still needed by express"));
  });

  it("says a package went away, rather than that it was added", () => {
    const md = renderMarkdown(report({ otherChanges: [{ path: "node_modules/gone", from: "3.0.0" }] }));
    assert.ok(md.includes("`node_modules/gone`: removed (was 3.0.0)"), md);
  });

  it("truncates to MAX_BODY_CHARS, keeping Blocked, and says so", () => {
    const many = Array.from({ length: 5000 }, (_, i) => alert({ number: 1000 + i, packageName: `pkg-${i}` }));
    const md = renderMarkdown(
      report({
        blockedCount: 1,
        alerts: [...many, blockedAlert(), alert({ number: 9000, packageName: "late", copies: [copy({ pastDeclared: [{ dependent: "x", range: "^1.0.0" }] })] })],
      }),
    );
    assert.ok(md.length <= MAX_BODY_CHARS, String(md.length));
    assert.match(md.trimEnd().split("\n").pop()!, /job summary/i);
    assert.ok(md.includes("## Blocked"));
    assert.ok(md.includes('Pinned at "0.2.0" in package.json.'));
    assert.ok(md.includes("## Applied past a declared range"));
    // Sections still appear in document order.
    assert.ok(md.indexOf("## Fixed") < md.indexOf("## Applied past"));
    assert.ok(md.indexOf("## Applied past") < md.indexOf("## Blocked"));
  });

  it("lists removed overrides, and the summary says so even with no alerts", () => {
    const md = renderMarkdown(
      report({
        alerts: [],
        removedOverrides: [{ key: "qs@>=6.0.0 <6.5.3", reason: "Its alert is fixed and every dependent now asks for 6.5.3 or later." }],
      }),
    );
    assert.deepEqual(headings(md), ["Overrides removed"]);
    assert.ok(md.includes("- `qs@>=6.0.0 <6.5.3`: Its alert is fixed"));
    assert.ok(md.includes("**1** override removed as no longer needed."));
    assert.ok(md.includes("No open alerts needed attention."));
  });

  it("labels removed overrides as a plan in a dry run", () => {
    const md = renderMarkdown(report({ dryRun: true, alerts: [], removedOverrides: [{ key: "qs", reason: "x" }] }));
    assert.match(md, /would try to remove/);
    assert.ok(md.includes("**1** override would be removed"));
  });

  it("keeps removed overrides when the report is cut down, ahead of the fixed list", () => {
    const many = Array.from({ length: 5000 }, (_, i) => alert({ number: 1000 + i, packageName: `pkg-${i}` }));
    const md = renderMarkdown(report({ alerts: many, removedOverrides: [{ key: "qs@>=6.0.0 <6.5.3", reason: "gone" }] }));
    assert.ok(md.length <= MAX_BODY_CHARS);
    assert.ok(md.includes("- `qs@>=6.0.0 <6.5.3`: gone"));
  });

  it("a failed run that never planned says nothing about alerts", () => {
    const md = renderMarkdown(
      report({ outcome: "failed", alerts: [], failures: [{ check: "run", detail: "GitHub API error 401" }] }),
    );
    assert.doesNotMatch(md, /No open alerts/);
    assert.ok(md.includes("- **run**: GitHub API error 401"));
  });

  it("does not truncate a report that fits", () => {
    const md = renderMarkdown(report());
    assert.doesNotMatch(md, /truncated/i);
  });

  it("full mode ignores the limit", () => {
    const many = Array.from({ length: 5000 }, (_, i) => alert({ number: 1000 + i, packageName: `pkg-${i}` }));
    const md = renderMarkdown(report({ alerts: many }), { full: true });
    assert.ok(md.length > MAX_BODY_CHARS);
    assert.ok(md.includes("pkg-4999"));
    assert.doesNotMatch(md, /truncated/i);
  });
});

describe("writeReport", () => {
  it("report.json round-trips outcome and blockedCount", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-"));
    try {
      const input = report({ outcome: "blocked-only", blockedCount: 2, alerts: [blockedAlert()] });
      writeReport(join(dir, "nested", "out"), input);
      const json = JSON.parse(readFileSync(join(dir, "nested", "out", "report.json"), "utf8"));
      assert.equal(json.outcome, "blocked-only");
      assert.equal(json.blockedCount, 2);
      const { summary, deploy, ...rest } = json; // added on top of the report
      assert.ok(summary && deploy);
      assert.deepEqual(rest, JSON.parse(JSON.stringify(input)));
      assert.equal(readFileSync(join(dir, "nested", "out", "report.md"), "utf8"), renderMarkdown(input));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes report-full.md only when report.md was truncated", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-"));
    try {
      writeReport(dir, report());
      assert.throws(() => readFileSync(join(dir, "report-full.md")));
      const many = Array.from({ length: 5000 }, (_, i) => alert({ number: 1000 + i, packageName: `pkg-${i}` }));
      writeReport(dir, report({ alerts: many }));
      assert.ok(readFileSync(join(dir, "report.md"), "utf8").length <= MAX_BODY_CHARS);
      assert.ok(readFileSync(join(dir, "report-full.md"), "utf8").includes("pkg-4999"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("inline", () => {
  it("wraps a bare @name in backticks so it can't mention anyone", () => {
    assert.equal(inline("@babel/core@7.1.0 isn't published."), "`@babel/core@7.1.0` isn't published.");
    assert.equal(inline("see @types/node, then stop"), "see `@types/node`, then stop");
    assert.equal(inline('the "@scope/pkg" copy.'), 'the "`@scope/pkg`" copy.');
  });

  it("doesn't double-wrap text already in a code span", () => {
    assert.equal(inline("`@types/node` is pinned"), "`@types/node` is pinned");
    assert.equal(inline("`@a/b` and @c/d"), "`@a/b` and `@c/d`");
    assert.equal(inline(inline("@c/d")), "`@c/d`");
  });

  it("leaves an @ inside a word, such as an email address, alone", () => {
    assert.equal(inline("write to a@b.com about qs@6.0.0"), "write to a@b.com about qs@6.0.0");
  });

  it("leaves a real link's destination alone, and cleans its text", () => {
    assert.equal(inline("[#1](https://example.com/@user/x)"), "[#1](https://example.com/@user/x)");
    assert.equal(inline("[text](https://x/@a)"), "[text](https://x/@a)");
    assert.equal(inline("[@a/b](https://x)"), "[`@a/b`](https://x)");
  });

  it("does not protect a destination that has no [text] before it", () => {
    assert.equal(inline("not found](@babel/core)"), "not found](`@babel/core`)");
    assert.equal(inline("see (@babel/core) and [](@x/y)"), "see (`@babel/core`) and [](`@x/y`)");
  });

  it("treats an unpaired backtick as plain text, so the @name after it is still wrapped", () => {
    assert.equal(inline("copy `@babel/core@7.1.0 isn't published"), "copy '`@babel/core@7.1.0` isn't published");
  });

  it("turns a stray backtick into an apostrophe even with no @ near it", () => {
    assert.equal(inline("it`s fine"), "it's fine");
    // Paired backticks are code, even when the pairing looks accidental.
    assert.equal(inline("a `b` c ` d @x/y ` e"), "a `b` c ` d @x/y ` e");
    // Three backticks: the first two pair, the third is stray.
    assert.equal(inline("`a` b ` c @x/y"), "`a` b ' c `@x/y`");
  });

  it("turns line breaks into spaces", () => {
    assert.equal(inline("a\n## evil\r\nb"), "a ## evil b");
  });

  it("is applied to details, reasons, and table cells in the report", () => {
    const md = renderMarkdown(
      report({
        outcome: "blocked-only",
        blockedCount: 1,
        alerts: [
          alert({ packageName: "@types/node", copies: [copy({ version: "1.0.0", target: "1.0.1" })] }),
          blockedAlert({
            copies: [copy({ action: "blocked", reason: "target-unavailable", target: undefined, detail: "@babel/core@7.1.0 isn't published.\n## evil" })],
          }),
        ],
        keptOverrides: [{ key: "qs@>=6.0.0 <6.7.3", reason: "needed by @nestjs/core\n# also evil" }],
        otherChanges: [{ path: "node_modules/@scope/x\n## evil", from: "1.0.0", to: "1.1.0" }],
        failures: [{ check: "fixed", path: "node_modules/@types/node", detail: "@types/node missing\n## evil" }],
      }),
    );
    assert.ok(md.includes("| `@types/node` |"), "table cell");
    assert.ok(md.includes("`@babel/core@7.1.0` isn't published."));
    assert.ok(md.includes("needed by `@nestjs/core`"));
    assert.ok(md.includes("`@types/node` missing"));
    assert.deepEqual(headings(md), ["Failures", "Fixed", "Blocked", "Other changes", "Overrides kept"]);
    const lines = md.split("\n");
    assert.ok(lines.includes("- **fixed** on `@types/node` (`node_modules/@types/node`): `@types/node` missing ## evil"));
    assert.ok(lines.some((l) => l.endsWith("`@babel/core@7.1.0` isn't published. ## evil")));
    assert.ok(lines.includes("- `node_modules/@scope/x ## evil`: 1.0.0 → 1.1.0"));
    assert.ok(lines.includes("- `qs@>=6.0.0 <6.7.3`: needed by `@nestjs/core` # also evil"));
  });
});

describe("the summary and the deploy recommendation", () => {
  const overrideCopy = copy({ path: "node_modules/a/node_modules/qs", version: "6.5.0", action: "override", target: "6.5.3" });
  const bumpCopy = copy();
  const prod = alert({
    number: 1,
    packageName: "qs",
    copies: [overrideCopy, copy({ ...overrideCopy, path: "node_modules/b/node_modules/qs" }), bumpCopy],
  });

  it("a production fix gets an IMPORTANT box and a summary line counting overrides and range bumps", () => {
    const md = renderMarkdown(report({ alerts: [prod] }));
    assert.ok(md.includes("[!IMPORTANT]"), md);
    assert.ok(md.includes("## Deploy recommendation"));
    assert.ok(md.includes("**1** override added or updated · **1** range bump"), md);
    assert.ok(md.includes("**1** of 1 alert addressed"), md);
  });

  it("the summary and the box sit in the header, above the Alerts line and the first section", () => {
    const md = renderMarkdown(report({ alerts: [prod] }));
    const at = (text: string): number => md.indexOf(text);
    assert.ok(at("of 1 alert addressed") > -1 && at("of 1 alert addressed") < at("## Deploy recommendation"));
    assert.ok(at("## Deploy recommendation") < at("Alerts: "));
    assert.ok(at("Alerts: ") < at("## Fixed"));
  });

  it("a dev-only fix gets a TIP box", () => {
    const md = renderMarkdown(report({ alerts: [alert({ scope: "dev" })] }));
    assert.ok(md.includes("[!TIP]"), md);
    assert.doesNotMatch(md, /\[!IMPORTANT\]/);
  });

  it("a failed run has no deploy recommendation", () => {
    const md = renderMarkdown(report({ outcome: "failed", failures: [{ check: "fixed", detail: "x" }] }));
    assert.doesNotMatch(md, /Deploy recommendation/);
  });

  it("a dry run's summary line is a plan", () => {
    const md = renderMarkdown(report({ dryRun: true }));
    assert.ok(md.includes("Planned: **1** of 1 alert addressed"), md);
    assert.doesNotMatch(md, /packages? updated/);
  });

  it("a truncated body still has the summary and the deploy section", () => {
    const many = Array.from({ length: 5000 }, (_, i) => alert({ number: 1000 + i, packageName: `pkg-${i}` }));
    const md = renderMarkdown(report({ alerts: many }));
    assert.ok(md.length <= MAX_BODY_CHARS, String(md.length));
    assert.match(md.trimEnd().split("\n").pop()!, /job summary/i);
    assert.ok(md.includes("## Deploy recommendation"));
    assert.ok(md.includes("[!IMPORTANT]"));
    assert.ok(md.includes("**5000** of 5000 alerts addressed"));
  });

  it("report.json carries the summary and the deploy recommendation, and its other fields unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "report-"));
    try {
      const input = report({ alerts: [prod] });
      writeReport(dir, input);
      const json = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
      assert.equal(json.summary.addressed, 1);
      assert.equal(json.deploy.outcome, "deploy");
      const { summary, deploy, ...rest } = json;
      assert.deepEqual(rest, JSON.parse(JSON.stringify(input)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("targetedSummary counts distinct changes, removed overrides and touched paths", () => {
    const partly = alert({
      number: 2,
      packageName: "tar",
      status: "partly-fixed",
      copies: [copy({ path: "node_modules/tar", version: "6.1.0", target: "6.2.1" }), copy({ path: "node_modules/x/node_modules/tar", action: "blocked", target: undefined, reason: "pin" })],
    });
    const open = alert({ number: 3, packageName: "waiting", status: "awaiting-close", copies: [] });
    const summary = targetedSummary(
      report({
        alerts: [prod, partly, open],
        otherChanges: [{ path: "node_modules/dep", from: "1.0.0", to: "1.1.0" }],
        removedOverrides: [{ key: "qs@<6", reason: "x" }],
      }),
    );
    assert.deepEqual(summary, {
      addressed: 2,
      open: 3,
      overridesAddedOrUpdated: 1, // qs@6.5.3 once, though it sits at two paths
      rangeBumps: 2, // qs@4.17.21 and tar@6.2.1
      overridesRemoved: 1,
      packagesUpdated: 5, // two qs paths, node_modules/lodash, node_modules/tar and node_modules/dep
      updatePassOnly: false,
    });
  });

  it("targetedDeploy has one input per fixed or partly fixed alert, and no via", () => {
    const blocked = blockedAlert();
    const rec = targetedDeploy(report({ alerts: [prod, alert({ number: 5, packageName: "tar", scope: "dev", manifest: "functions/package-lock.json" }), blocked], removedOverrides: [{ key: "qs@<6", reason: "x" }] }));
    assert.equal(rec.outcome, "deploy");
    assert.deepEqual(rec.production.map((e) => e.packageName), ["qs"]);
    assert.deepEqual(rec.development.map((e) => [e.packageName, e.places]), [["tar", ["functions/"]]]);
    assert.deepEqual(rec.production[0].via, []);
    assert.deepEqual(rec.removedOverrides, ["qs@<6"]);
  });
});

describe("a failed report", () => {
  it("presents the fixed sections as planned, not applied", () => {
    const md = renderMarkdown(
      report({
        outcome: "failed",
        alerts: [
          alert(),
          alert({
            number: 13,
            status: "partly-fixed",
            copies: [copy(), copy({ action: "blocked", reason: "pin", detail: "Pinned.", target: undefined })],
          }),
          alert({ number: 14, copies: [copy({ pastDeclared: [{ dependent: "old-tool", range: "^6.0.0" }] })] }),
        ],
        failures: [{ check: "fixed", detail: "lodash is not at 4.17.21." }],
      }),
    );
    assert.doesNotMatch(md, /resolved in the lockfile/);
    assert.doesNotMatch(md, /copies below were fixed/);
    assert.doesNotMatch(md, /Each fix below installs/);
    assert.doesNotMatch(md, /Alerts: /);
    assert.equal((md.match(/Planned, not applied/g) ?? []).length, 2); // Fixed and Partly fixed
    assert.ok(md.includes("Alerts in the plan, not applied:"));
    assert.ok(md.includes("none of these changes were kept"));
    assert.ok(md.includes("would install"));
  });

  it("a dry run is worded as planned too", () => {
    const md = renderMarkdown(report({ dryRun: true }));
    assert.doesNotMatch(md, /resolved in the lockfile/);
    assert.match(md, /Planned, not applied/);
  });

  it("a normal run still says resolved", () => {
    assert.match(renderMarkdown(report()), /resolved in the lockfile/);
  });
});

describe("every alert line names its manifest", () => {
  const MANIFEST = "functions/package-lock.json";
  const lines = (md: string, heading: string): string[] => {
    const section = md.split(`## ${heading}`)[1]?.split(/^## /m)[0] ?? "";
    return section.split("\n").filter((line) => line.includes("#12") || line.includes("#30"));
  };
  const named = (md: string, heading: string): void => {
    const found = lines(md, heading);
    assert.ok(found.length > 0, `no alert lines under ${heading}`);
    for (const line of found) assert.ok(line.includes(MANIFEST), `${heading}: ${line}`);
  };

  it("in Fixed", () => {
    named(renderMarkdown(report({ alerts: [alert({ manifest: MANIFEST })] })), "Fixed");
  });

  it("in Partly fixed and Blocked", () => {
    const partly = alert({
      status: "partly-fixed",
      manifest: MANIFEST,
      copies: [copy(), copy({ path: "node_modules/a/node_modules/lodash", action: "blocked", target: undefined, reason: "pin", detail: "Pinned." })],
    });
    const md = renderMarkdown(report({ alerts: [partly, blockedAlert({ manifest: MANIFEST })] }));
    named(md, "Partly fixed");
    named(md, "Blocked");
  });

  it("in Applied past a declared range", () => {
    const past = alert({ manifest: MANIFEST, copies: [copy({ pastDeclared: [{ dependent: "x", range: "4.17.20" }] })] });
    named(renderMarkdown(report({ alerts: [past] })), "Applied past a declared range — review these");
  });

  it("in Awaiting close or not found", () => {
    for (const status of ["awaiting-close", "not-found"] as const) {
      named(renderMarkdown(report({ alerts: [alert({ status, manifest: MANIFEST, copies: [] })] })), "Awaiting close or not found");
    }
  });

  it("doesn't say the path twice when the blocked copy is the manifest itself", () => {
    const gone = alert({
      status: "blocked",
      manifest: MANIFEST,
      copies: [copy({ path: MANIFEST, version: "", action: "blocked", target: undefined, reason: "manifest-not-processed", detail: "Gone." })],
    });
    const [line] = lines(renderMarkdown(report({ alerts: [gone] })), "Blocked");
    assert.equal(line.split(MANIFEST).length - 1, 1, line);
  });
});

describe("Other changes", () => {
  it("doesn't claim a relocated target moved only because a fixed package needs it", () => {
    const md = renderMarkdown(report({ otherChanges: [{ path: "node_modules/a/node_modules/qs", from: "6.5.0" }, { path: "node_modules/qs", to: "6.5.3" }] }));
    const section = md.split("## Other changes")[1];
    assert.doesNotMatch(section, /only because/);
    assert.match(section, /a fixed package needs/);
    assert.match(section, /relocated/);
    assert.match(section, /`node_modules\/qs`: added at 6\.5\.3/);
  });
});

describe("the npm version", () => {
  it("is in the header", () => {
    assert.match(renderMarkdown(report({ npmVersion: "11.16.0" })).split(/^## (?!Deploy recommendation$)/m)[0], /Run with npm 11\.16\.0\./);
  });

  it("is in a report that failed before it planned anything", () => {
    assert.match(renderMarkdown(report({ outcome: "failed", alerts: [], failures: [{ check: "run", detail: "x" }], npmVersion: "10.9.9" })), /npm 10\.9\.9/);
  });

  it("says so when it couldn't be read", () => {
    assert.match(renderMarkdown(report({ npmVersion: null })), /npm version unknown/);
  });
});
