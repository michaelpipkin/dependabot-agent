import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, mock } from "node:test";
import { parseArgs } from "../src/cli.js";
import { resolveConfig } from "../src/config.js";
import { readDependabotAlertsFile } from "../src/github.js";
import { runTargeted } from "../src/targeted/run.js";
import { AgentError } from "../src/util.js";

function alert(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const vulnerability = {
    package: { ecosystem: "npm", name },
    vulnerable_version_range: "< 6.5.3",
    first_patched_version: { identifier: "6.5.3" },
  };
  return {
    number: 1,
    state: "open",
    html_url: "https://example.test/alerts/1",
    dependency: { package: vulnerability.package, manifest_path: "package.json", scope: "runtime" },
    security_advisory: { summary: "", severity: "high", vulnerabilities: [vulnerability] },
    security_vulnerability: vulnerability,
    ...over,
  };
}

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "dep-agent-alerts-"));
const fileHolding = (content: unknown): string => {
  const file = path.join(tempDir(), "alerts.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
};

describe("parseArgs — --alerts-file", () => {
  it("takes a path", () => {
    assert.equal(parseArgs(["--alerts-file", "a.json"], "0.0.0").alertsFile, "a.json");
    assert.equal(parseArgs(["--alerts-file=a.json"], "0.0.0").alertsFile, "a.json");
  });

  it("is undefined when absent", () => {
    assert.equal(parseArgs([], "0.0.0").alertsFile, undefined);
  });
});

describe("resolveConfig — --alerts-file", () => {
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ GITHUB_REPO: "o/r", WORKSPACE_ROOT: tempDir(), ...extra });
  const warnings = (run: () => void): string[] => {
    const seen: string[] = [];
    const mocked = mock.method(console, "warn", (message: unknown) => seen.push(String(message)));
    try {
      run();
    } finally {
      mocked.mock.restore();
    }
    return seen;
  };

  it("needs no token with the targeted strategy, since nothing here calls GitHub", () => {
    const cfg = resolveConfig({ alertsFile: "a.json", updateStrategy: "targeted" }, env());
    assert.equal(cfg.alertsFile, "a.json");
    assert.equal(cfg.token, "");
  });

  it("comes from ALERTS_FILE too, with the flag winning", () => {
    assert.equal(resolveConfig({ updateStrategy: "targeted" }, env({ ALERTS_FILE: "e.json" })).alertsFile, "e.json");
    assert.equal(resolveConfig({ alertsFile: "f.json", updateStrategy: "targeted" }, env({ ALERTS_FILE: "e.json" })).alertsFile, "f.json");
  });

  it("still needs a token without one, or under another strategy", () => {
    assert.throws(() => resolveConfig({ updateStrategy: "targeted" }, env()), /token is required/);
    const seen = warnings(() => assert.throws(() => resolveConfig({ alertsFile: "a.json" }, env()), /token is required/));
    assert.ok(seen.some((w) => w.includes("--alerts-file") && w.includes("compatible")));
  });

  it("warns and ignores it under another strategy, when there is a token", () => {
    let alertsFile: string | undefined = "unset";
    const seen = warnings(() => {
      alertsFile = resolveConfig({ alertsFile: "a.json", updateStrategy: "latest" }, env({ GITHUB_TOKEN: "t" })).alertsFile;
    });
    assert.ok(seen.some((w) => w.includes("--alerts-file") && w.includes("latest")));
    assert.equal(alertsFile, undefined);
  });
});

describe("readDependabotAlertsFile", () => {
  it("reads the alerts, across states, as GitHub's API returns them", () => {
    const alerts = readDependabotAlertsFile(fileHolding([alert("qs"), alert("ms", { number: 2, state: "fixed" })]));
    assert.deepEqual(alerts.map((a) => [a.number, a.state, a.security_vulnerability.package.name]), [[1, "open", "qs"], [2, "fixed", "ms"]]);
  });

  it("keeps only npm alerts, as the fetch does", () => {
    const other = alert("requests");
    (other.dependency as { package: { ecosystem: string } }).package = { ecosystem: "pip" } as never;
    assert.deepEqual(readDependabotAlertsFile(fileHolding([other])), []);
  });

  it("accepts an empty list: no alerts is a real answer", () => {
    assert.deepEqual(readDependabotAlertsFile(fileHolding([])), []);
  });

  const refused: Array<[string, () => string, RegExp]> = [
    ["a missing file", () => path.join(tempDir(), "nope.json"), /Could not read/],
    ["a file that isn't JSON", () => fileHolding("{ nope"), /Could not read/],
    ["JSON that isn't a list", () => fileHolding({ message: "Not Found" }), /not a list/],
    ["an entry that isn't an alert", () => fileHolding([alert("qs"), { number: 2 }]), /entry 1/],
    ["an alert with no state", () => fileHolding([alert("qs", { state: undefined })]), /entry 0/],
  ];
  for (const [label, file, message] of refused) {
    it(`refuses ${label}, rather than treating it as no alerts`, () => {
      assert.throws(
        () => readDependabotAlertsFile(file()),
        (e: Error) => e instanceof AgentError && message.test(e.message),
      );
    });
  }
});

describe("runTargeted with an alerts file", () => {
  it("answers from the file, with no token and no call to GitHub", async () => {
    const dir = tempDir();
    const reportDir = tempDir();
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fx", version: "1.0.0" }));
    fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "fx", version: "1.0.0" } } }));
    const fetched = mock.method(globalThis, "fetch", async () => {
      throw new Error("called the network");
    });
    try {
      await runTargeted(
        {
          token: "",
          repo: "o/r",
          owner: "o",
          name: "r",
          workspaceRoot: dir,
          updateStrategy: "targeted",
          allowPrerelease: false,
          dryRun: true,
          skipUpdate: false,
          exitCode: false,
          discoverPackages: true,
          packages: [],
          updateWorkspaceMembers: true,
          limits: {},
          reportDir,
          alertsFile: fileHolding([alert("qs")]),
        },
        { npmVersion: () => "11.16.0" },
      );
    } finally {
      fetched.mock.restore();
    }
    const report = JSON.parse(fs.readFileSync(path.join(reportDir, "report.json"), "utf-8")) as { alerts: Array<{ status: string; packageName: string }> };
    assert.deepEqual(report.alerts.map((a) => [a.packageName, a.status]), [["qs", "not-found"]]);
    assert.equal(fetched.mock.callCount(), 0);
  });
});
