import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AlertOutcome, CopyDecision } from "../src/targeted/plan.js";
import { computeOutcome, MAX_BODY_CHARS, renderMarkdown, writeReport, type RunReport } from "../src/targeted/report.js";

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
    failures: [],
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

const headings = (md: string): string[] => [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

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
      assert.deepEqual(json, JSON.parse(JSON.stringify(input)));
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
