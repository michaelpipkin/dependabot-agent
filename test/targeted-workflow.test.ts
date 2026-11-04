import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

// The reusable workflow is the one piece of this mode that can't be exercised by
// running the tool, so these tests read the YAML for the rules that matter (which
// token goes where, what gates the PR step) and run the two shell steps that
// decide an outcome against stand-in files.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "targeted-reconcile.yml");

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  if?: string | boolean;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  "continue-on-error"?: boolean;
}
interface Input {
  required?: boolean;
  default?: unknown;
  type?: string;
}
interface Workflow {
  on: { workflow_call: { inputs: Record<string, Input>; secrets: Record<string, { required?: boolean }> } };
  permissions: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
}

const text = readFileSync(WORKFLOW, "utf-8");
const wf = yaml.load(text) as Workflow;
const steps = Object.values(wf.jobs)[0].steps;

const have = (tool: string): boolean => spawnSync("bash", ["-c", `command -v ${tool}`]).status === 0;

const findStep = (needle: string): Step => {
  const step = steps.find((s) => s.uses?.startsWith(needle) || s.id === needle);
  assert.ok(step, `no step matching ${needle}`);
  return step;
};
const condition = (step: Step): string => String(step.if ?? "");

describe("targeted workflow: shape", () => {
  it("is a reusable workflow with required tokens", () => {
    assert.ok(wf.on.workflow_call);
    assert.equal(wf.on.workflow_call.secrets["pr-token"].required, true);
    assert.equal(wf.on.workflow_call.secrets["alerts-token"].required, true);
  });

  it("takes the base branch and the agent version as required inputs, so callers pin both", () => {
    const { inputs } = wf.on.workflow_call;
    assert.equal(inputs["base-branch"].required, true);
    assert.equal(inputs["agent-version"].required, true);
    assert.equal(inputs["node-version"].default, "24");
    assert.equal(inputs["dry-run"].type, "boolean");
    assert.equal(inputs["dry-run"].default, false);
  });

  it("asks for only the permissions it uses", () => {
    // The PR is opened with pr-token, so GITHUB_TOKEN only checks out and manages the issue.
    assert.deepEqual(wf.permissions, { contents: "read", issues: "write" });
  });

  it("checks out the branch the PR will target", () => {
    const checkout = findStep("actions/checkout");
    assert.equal(checkout.with?.ref, "${{ inputs.base-branch }}");
  });

  it("never interpolates an expression into a shell script", () => {
    for (const step of steps) {
      assert.ok(!step.run?.includes("${{"), `step "${step.name}" interpolates into its script`);
    }
  });
});

describe("targeted workflow: tokens", () => {
  it("never creates the PR with GITHUB_TOKEN", () => {
    const step = findStep("peter-evans/create-pull-request");
    assert.equal(step.with?.token, "${{ secrets.pr-token }}");
    assert.equal(step.with?.["body-path"]?.endsWith("report.md"), true);
    assert.ok(!text.includes("secrets.GITHUB_TOKEN"));
  });

  it("pins the third-party action to a full commit, with the version in a comment", () => {
    assert.match(findStep("peter-evans/create-pull-request").uses ?? "", /^peter-evans\/create-pull-request@[0-9a-f]{40}$/);
    assert.match(text, /uses: peter-evans\/create-pull-request@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/);
  });

  it("gives the alerts token to the agent step and nowhere else", () => {
    assert.equal(text.split("secrets.alerts-token").length - 1, 1);
    assert.equal(findStep("agent").env?.GITHUB_TOKEN, "${{ secrets.alerts-token }}");
  });

  it("names the PR branch and base", () => {
    const step = findStep("peter-evans/create-pull-request");
    assert.equal(step.with?.branch, "dependabot-agent/targeted");
    assert.equal(step.with?.base, "${{ inputs.base-branch }}");
  });
});

// Entries as create-pull-request reads them: comma or newline separated, each handed to `git add -- <entry>`.
const addPaths = (): string[] =>
  String(findStep("peter-evans/create-pull-request").with?.["add-paths"])
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

describe("targeted workflow: what gets committed", { skip: !have("git") && "needs git" }, () => {
  it("stages every package file, at the root and below, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "targeted-addpaths-"));
    try {
      git(dir, "init", "-q");
      git(dir, "config", "user.email", "test@example.com");
      git(dir, "config", "user.name", "test");
      const files = [
        "package.json",
        "package-lock.json",
        "functions/package.json",
        "functions/package-lock.json",
        "packages/app/package.json",
        "src/index.js",
        "README.md",
        "tsconfig.json",
        "docs/package.json.md",
      ];
      const write = (stamp: string): void => {
        for (const file of files) {
          mkdirSync(join(dir, path.dirname(file)), { recursive: true });
          writeFileSync(join(dir, file), stamp);
        }
      };
      write("before\n");
      git(dir, "add", "--", ".");
      git(dir, "commit", "-q", "-m", "initial");
      write("after\n");

      git(dir, "add", "--", ...addPaths());
      const staged = git(dir, "diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();
      assert.deepEqual(staged, [
        "functions/package-lock.json",
        "functions/package.json",
        "package-lock.json",
        "package.json",
        "packages/app/package.json",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("targeted workflow: the agent step", () => {
  it("continues on error so the report is still read", () => {
    assert.equal(findStep("agent")["continue-on-error"], true);
  });

  it("runs the pinned version with the targeted strategy and a report directory", () => {
    const run = findStep("agent").run ?? "";
    assert.match(run, /dependabot-agent@\$\{?AGENT_VERSION/);
    assert.match(run, /--update-strategy targeted/);
    assert.match(run, /--report "\$AGENT_REPORT_DIR"/);
  });

  it("takes dry-run from the input alone, so a repository's \"dryRun\": true can't turn a real run into one that opens no PR", () => {
    const step = findStep("agent");
    assert.equal(step.env?.DRY_RUN, "${{ inputs.dry-run }}");
    assert.doesNotMatch(step.run ?? "", /--dry-run/);
  });

  it("runs no install scripts, and ignores a caller's exitCode setting", () => {
    const env = findStep("agent").env ?? {};
    assert.equal(env.NPM_CONFIG_IGNORE_SCRIPTS, "true");
    assert.equal(env.EXIT_CODE, "false");
  });

  it("keeps the report outside the checkout so it can't be committed", () => {
    const reportDirs = steps.flatMap((s) => [...Object.values(s.env ?? {}), ...Object.values(s.with ?? {})]).map(String).filter((v) => v.includes("agent-report"));
    assert.ok(reportDirs.length >= 3, "expected the agent, report and PR steps to name the directory");
    for (const dir of reportDirs) assert.match(dir, /^\$\{\{ runner\.temp \}\}\/agent-report/);
  });
});

describe("targeted workflow: gates", () => {
  it("skips the PR step on failure, on a restore error, and on a dry run", () => {
    const gate = condition(findStep("peter-evans/create-pull-request"));
    assert.match(gate, /outputs\.outcome != 'failed'/);
    assert.match(gate, /outputs\.restore-error != 'true'/);
    assert.match(gate, /!inputs\.dry-run/);
  });

  it("runs the PR step for clean and blocked-only too, so a stale PR is closed", () => {
    assert.ok(!/clean|blocked-only|changes/.test(condition(findStep("peter-evans/create-pull-request"))));
  });

  it("fails the job when the outcome is failed, even after the other steps", () => {
    const last = steps[steps.length - 1];
    assert.match(condition(last), /outputs\.outcome == 'failed'/);
    assert.match(last.run ?? "", /exit 1/);
  });
});

// ---------------------------------------------------------------------------
// Running the shell steps
// ---------------------------------------------------------------------------

const canRun = have("jq") && have("bash");

interface Sandbox {
  dir: string;
  env: Record<string, string>;
  write: (name: string, body: string) => void;
}

function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "targeted-workflow-"));
  const report = join(dir, "agent-report");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // A stand-in gh: records its arguments, and answers `issue list` from ISSUE_OPEN.
  const gh = [
    "#!/bin/bash",
    'echo "$*" >> "$FAKE_GH_LOG"',
    'if [ "$1 $2" = "issue list" ]; then [ -n "$ISSUE_OPEN" ] && echo "$ISSUE_OPEN"; fi',
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(join(bin, "gh"), gh);
  chmodSync(join(bin, "gh"), 0o755);
  const toBash = (p: string): string => p.replace(/\\/g, "/");
  const out = join(dir, "github-output");
  const summary = join(dir, "summary.md");
  writeFileSync(out, "");
  writeFileSync(summary, "");
  return {
    dir,
    write: (name, body) => {
      mkdirSync(report, { recursive: true });
      writeFileSync(join(report, name), body);
    },
    env: {
      AGENT_REPORT_DIR: toBash(report),
      GITHUB_OUTPUT: toBash(out),
      GITHUB_STEP_SUMMARY: toBash(summary),
      GITHUB_SERVER_URL: "https://github.example",
      GITHUB_REPOSITORY: "acme/app",
      GITHUB_RUN_ID: "42",
      FAKE_GH_LOG: toBash(join(dir, "gh.log")),
      PATH: `${toBash(bin)}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

function runStep(step: Step, box: Sandbox, env: Record<string, string>): { status: number | null; output: Record<string, string>; summary: string; gh: string[]; report: string } {
  const result = spawnSync("bash", ["-e", "-c", step.run ?? ""], { env: { ...process.env, ...box.env, ...env }, encoding: "utf-8" });
  const read = (file: string): string => (existsSync(file) ? readFileSync(file, "utf-8") : "");
  const output: Record<string, string> = {};
  for (const line of read(join(box.dir, "github-output")).split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) output[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return {
    status: result.status,
    output,
    summary: read(join(box.dir, "summary.md")),
    gh: read(join(box.dir, "gh.log")).split("\n").filter(Boolean),
    report: read(join(box.dir, "agent-report", "report.md")),
  };
}

const reportJson = (extra: Record<string, unknown>): string =>
  JSON.stringify({ outcome: "changes", dryRun: false, blockedCount: 0, alerts: [], ...extra });

describe("targeted workflow: reading the report", { skip: !canRun && "needs bash and jq" }, () => {
  const step = findStep("report");
  const read = (box: Sandbox, agent = "success") => runStep(step, box, { AGENT_STEP_OUTCOME: agent });

  it("reads outcome and blockedCount, and summarises report.md", () => {
    const box = sandbox();
    try {
      box.write("report.md", "# the report\n");
      box.write("report.json", reportJson({ outcome: "changes", blockedCount: 3 }));
      const got = read(box);
      assert.equal(got.status, 0);
      assert.equal(got.output.outcome, "changes");
      assert.equal(got.output["blocked-count"], "3");
      assert.equal(got.output["restore-error"], "false");
      assert.equal(got.summary, "# the report\n");
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("summarises report-full.md when the PR body was cut, since the cut note points there", () => {
    const box = sandbox();
    try {
      box.write("report.md", "# cut\n");
      box.write("report-full.md", "# the whole report\n");
      box.write("report.json", reportJson({ outcome: "changes" }));
      assert.equal(read(box).summary, "# the whole report\n");
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  for (const outcome of ["blocked-only", "clean", "failed"]) {
    it(`passes ${outcome} through`, () => {
      const box = sandbox();
      try {
        box.write("report.md", "x\n");
        box.write("report.json", reportJson({ outcome, blockedCount: 1 }));
        assert.equal(read(box, outcome === "failed" ? "failure" : "success").output.outcome, outcome);
      } finally {
        rmSync(box.dir, { recursive: true, force: true });
      }
    });
  }

  it("treats a missing report as failed, with a body that links to the run", () => {
    const box = sandbox();
    try {
      const got = read(box, "failure");
      assert.equal(got.status, 0);
      assert.equal(got.output.outcome, "failed");
      assert.equal(got.output["blocked-count"], "0");
      assert.match(got.report, /no report/i);
      assert.match(got.report, /https:\/\/github\.example\/acme\/app\/actions\/runs\/42/);
      assert.equal(got.summary, got.report);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("treats an unreadable report.json as a missing report", () => {
    const box = sandbox();
    try {
      box.write("report.md", "x\n");
      box.write("report.json", "{ not json");
      assert.equal(read(box).output.outcome, "failed");
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("treats an outcome it doesn't know as failed", () => {
    const box = sandbox();
    try {
      box.write("report.md", "x\n");
      box.write("report.json", reportJson({ outcome: "something-new" }));
      assert.equal(read(box).output.outcome, "failed");
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("flags a restore error, and treats the run as failed", () => {
    const box = sandbox();
    try {
      box.write("report.md", "x\n");
      box.write("report.json", reportJson({ outcome: "failed", restoreError: "could not restore package.json" }));
      const got = read(box, "failure");
      assert.equal(got.output["restore-error"], "true");
      assert.equal(got.output.outcome, "failed");
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  it("doesn't trust a good-looking report from a step that failed", () => {
    const box = sandbox();
    try {
      box.write("report.md", "# looks fine\n");
      box.write("report.json", reportJson({ outcome: "changes" }));
      const got = read(box, "failure");
      assert.equal(got.output.outcome, "failed");
      assert.match(got.report, /exited with an error/);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });
});

describe("targeted workflow: the blocked issue", { skip: !canRun && "needs bash and jq" }, () => {
  const step = findStep("issue");
  const act = (outcome: string, blockedCount: string, open: string) => {
    const box = sandbox();
    try {
      box.write("report.md", "body\n");
      return runStep(step, box, { OUTCOME: outcome, BLOCKED_COUNT: blockedCount, ISSUE_OPEN: open });
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  };
  const verbs = (gh: string[]): string[] => gh.map((line) => line.split(" ").slice(0, 2).join(" "));

  it("creates one labelled issue when everything is blocked", () => {
    const got = act("blocked-only", "2", "");
    assert.equal(got.status, 0);
    assert.ok(verbs(got.gh).includes("issue create"));
    assert.ok(!verbs(got.gh).includes("issue edit"));
    assert.ok(got.gh.some((line) => line.startsWith("issue create") && line.includes("dependabot-agent-blocked")));
  });

  it("updates the open issue instead of making a second", () => {
    const got = act("blocked-only", "2", "17");
    assert.ok(got.gh.some((line) => line.startsWith("issue edit 17")));
    assert.ok(!verbs(got.gh).includes("issue create"));
  });

  it("records a failure the same way", () => {
    assert.ok(verbs(act("failed", "0", "").gh).includes("issue create"));
  });

  it("closes an open issue when clean", () => {
    assert.ok(act("clean", "0", "17").gh.some((line) => line.startsWith("issue close 17")));
  });

  it("closes an open issue when the PR leaves nothing blocked", () => {
    assert.ok(act("changes", "0", "17").gh.some((line) => line.startsWith("issue close 17")));
  });

  it("updates an open issue when a PR was opened and some copies are still blocked, so it can't keep saying the last run failed", () => {
    const got = act("changes", "2", "17");
    assert.ok(got.gh.some((line) => line.startsWith("issue edit 17") && line.includes("report.md")), got.gh.join("\n"));
    assert.ok(!got.gh.some((line) => /^issue (close|create)/.test(line)));
  });

  it("creates no issue when a PR was opened and some copies are still blocked: the PR lists them", () => {
    assert.ok(!act("changes", "2", "").gh.some((line) => /^issue (close|edit|create)/.test(line)));
  });

  it("does nothing when clean and no issue is open", () => {
    assert.ok(!act("clean", "0", "").gh.some((line) => /^issue (close|edit|create)/.test(line)));
  });
});
