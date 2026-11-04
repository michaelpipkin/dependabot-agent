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
interface Job {
  needs?: string;
  if?: string;
  permissions: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  on: { workflow_call: { inputs: Record<string, Input>; secrets: Record<string, { required?: boolean }> } };
  jobs: { alerts: Job; plan: Job; publish: Job };
}

const text = readFileSync(WORKFLOW, "utf-8");
const wf = yaml.load(text) as Workflow;
const steps = [...wf.jobs.alerts.steps, ...wf.jobs.plan.steps, ...wf.jobs.publish.steps];

const have = (tool: string): boolean => spawnSync("bash", ["-c", `command -v ${tool}`]).status === 0;

const findStep = (needle: string): Step => {
  const step = steps.find((s) => s.uses?.startsWith(needle) || s.id === needle);
  assert.ok(step, `no step matching ${needle}`);
  return step;
};
const condition = (step: Step): string => String(step.if ?? "");

/**
 * A step as text, run scripts included. A whole expression asking only whether a secret
 * was passed hands over true or false, so it's left out, but anything more in it stays.
 */
const withoutPresenceChecks = (value: unknown): string => JSON.stringify(value).replace(/\$\{\{ secrets\.[a-z-]+ != '' \}\}/g, "");

/** The ids of the steps that mention a value anywhere. */
const holdersOf = (value: string): string[] => steps.filter((s) => withoutPresenceChecks(s).includes(value)).map((s) => s.id ?? s.name ?? "?");

describe("targeted workflow: shape", () => {
  it("is a reusable workflow whose credentials are optional, because a step checks that one kind was passed", () => {
    assert.ok(wf.on.workflow_call);
    for (const secret of ["pr-token", "alerts-token", "app-private-key"]) {
      assert.equal(wf.on.workflow_call.secrets[secret].required, false, secret);
    }
    assert.equal(wf.on.workflow_call.inputs["app-client-id"].required, false);
    assert.equal(steps[0].id, "credentials");
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
    // The PR is opened with its own token, so GITHUB_TOKEN only checks out and manages the issue.
    assert.deepEqual(wf.jobs.alerts.permissions, {});
    assert.deepEqual(wf.jobs.plan.permissions, { contents: "read" });
    assert.deepEqual(wf.jobs.publish.permissions, { contents: "read", issues: "write" });
  });

  it("checks out the branch the PR will target, in both jobs, and keeps no credential in .git", () => {
    const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout"));
    assert.equal(checkouts.length, 2);
    for (const checkout of checkouts) {
      assert.equal(checkout.with?.ref, "${{ inputs.base-branch }}");
      assert.equal(String(checkout.with?.["persist-credentials"]), "false");
    }
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
    assert.equal(step.with?.token, "${{ steps.app-pr.outputs.token || secrets.pr-token }}");
    assert.equal(step.with?.["body-path"]?.endsWith("report.md"), true);
    assert.ok(!text.includes("secrets.GITHUB_TOKEN"));
  });

  it("pins the third-party action to a full commit, with the version in a comment", () => {
    assert.match(findStep("peter-evans/create-pull-request").uses ?? "", /^peter-evans\/create-pull-request@[0-9a-f]{40}$/);
    assert.match(text, /uses: peter-evans\/create-pull-request@[0-9a-f]{40} # v\d+\.\d+\.\d+\r?\n/);
  });

  it("gives the alerts token to the step that fetches the alerts and nowhere else", () => {
    assert.deepEqual(holdersOf("secrets.alerts-token"), ["fetch"]);
    assert.equal(findStep("fetch").env?.GH_TOKEN, "${{ steps.app-alerts.outputs.token || secrets.alerts-token }}");
  });

  it("gives the pull request token to the pull request step and nowhere else", () => {
    const pr = findStep("peter-evans/create-pull-request").name ?? "";
    assert.deepEqual(holdersOf("secrets.pr-token"), [pr]);
    assert.deepEqual(holdersOf("steps.app-pr.outputs.token"), [pr]);
  });

  it("gives the App's read token to the step that fetches the alerts and nowhere else", () => {
    assert.deepEqual(holdersOf("steps.app-alerts.outputs.token"), ["fetch"]);
  });

  it("gives the agent step no token at all", () => {
    const agent = findStep("agent");
    assert.deepEqual(Object.keys(agent.env ?? {}).filter((name) => /token/i.test(name)), []);
    assert.ok(!/token|secrets\./i.test(JSON.stringify(agent)));
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

describe("targeted workflow: three jobs, so the agent's job holds no secret", () => {
  const { alerts, plan, publish } = wf.jobs;
  const inJob = (job: Job, action: string): Step => {
    const step = job.steps.find((s) => s.uses?.startsWith(action));
    assert.ok(step, `no ${action}`);
    return step;
  };

  // A job's secrets are in its runner's memory, and hosted runners give steps sudo, so even
  // asking whether a secret was passed would put it there. Nothing is exempt from this.
  it("refers to no secret anywhere in plan, not even to ask whether one was passed", () => {
    // As a whole word, to catch toJSON(secrets) and secrets['x'] too.
    assert.doesNotMatch(JSON.stringify(plan), /\bsecrets\b/);
    assert.doesNotMatch(JSON.stringify(plan), /github\.token|github\[/);
    assert.ok(!JSON.stringify(plan).includes("create-github-app-token"));
    assert.ok(!text.includes("secrets: inherit"));
  });

  it("runs the agent in plan, and none of its code anywhere else", () => {
    assert.ok(plan.steps.some((s) => s.id === "agent"));
    for (const job of [alerts, publish]) assert.ok(!/dependabot-agent@|npx|setup-node/.test(JSON.stringify(job.steps)));
  });

  it("checks the credentials first, and runs plan only if they passed, even when fetching failed", () => {
    assert.equal(alerts.steps[0].id, "credentials");
    assert.equal(plan.needs, "alerts");
    assert.match(plan.if ?? "", /!cancelled\(\)/);
    assert.match(plan.if ?? "", /needs\.alerts\.outputs\.credentials-ok == 'true'/);
  });

  it("turns off the package cache, which could carry a compromised run's code into later runs", () => {
    assert.equal(String(inJob(plan, "actions/setup-node").with?.["package-manager-cache"]), "false");
    assert.ok(!steps.some((s) => s.uses?.startsWith("actions/cache")));
  });

  it("bounds the agent step inside the job, so a hang still reaches the report", () => {
    const { steps: planSteps } = plan as unknown as { steps: Array<Step & { "timeout-minutes"?: number }> };
    const agent = planSteps.find((s) => s.id === "agent");
    assert.equal(agent?.["timeout-minutes"], 45);
  });

  it("reads each artifact by the id the job before it saved, so not an earlier attempt's", () => {
    assert.equal(inJob(plan, "actions/download-artifact").with?.["artifact-ids"], "${{ needs.alerts.outputs.alerts-artifact }}");
    assert.equal(inJob(publish, "actions/download-artifact").with?.["artifact-ids"], "${{ needs.plan.outputs.results-artifact }}");
    assert.equal(inJob(alerts, "actions/upload-artifact").id, "save-alerts");
    assert.equal(inJob(plan, "actions/upload-artifact").id, "save-results");
    assert.ok(text.includes("alerts-artifact: ${{ steps.save-alerts.outputs.artifact-id }}"));
    assert.ok(text.includes("results-artifact: ${{ steps.save-results.outputs.artifact-id }}"));
  });

  it("runs the agent only with alerts to read, and reports it otherwise", () => {
    const fetch = findStep("fetch-alerts");
    assert.equal(fetch["continue-on-error"], true);
    assert.equal(condition(fetch), "${{ needs.alerts.result == 'success' }}");
    assert.equal(condition(findStep("agent")), "${{ steps.fetch-alerts.outcome == 'success' }}");
    assert.equal(condition(findStep("report")), "");
    assert.match(findStep("agent").run ?? "", /--alerts-file "\$AGENT_ALERTS_FILE"/);
  });

  it("carries the alerts from alerts to plan", () => {
    const up = inJob(alerts, "actions/upload-artifact");
    const down = inJob(plan, "actions/download-artifact");
    assert.equal(up.with?.path, "${{ runner.temp }}/agent-alerts/alerts.json");
    assert.equal(down.with?.path, "${{ runner.temp }}/agent-alerts");
    assert.equal(findStep("agent").env?.AGENT_ALERTS_FILE, "${{ runner.temp }}/agent-alerts/alerts.json");
    assert.equal(String(up.with?.["retention-days"]), "1");
  });

  it("runs publish after plan, on a failed plan too, but not on a dry run or when plan never read a report", () => {
    assert.equal(publish.needs, "plan");
    assert.match(publish.if ?? "", /!cancelled\(\)/);
    assert.match(publish.if ?? "", /!inputs\.dry-run/);
    assert.match(publish.if ?? "", /needs\.plan\.outputs\.outcome != ''/);
  });

  it("passes on only the report and the patch from plan", () => {
    const up = inJob(plan, "actions/upload-artifact");
    const paths = String(up.with?.path).split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
    assert.deepEqual(paths, ["${{ runner.temp }}/agent-report/report.md", "${{ runner.temp }}/agent-report/fixes.patch"]);
    assert.equal(String(up.with?.["retention-days"]), "1");
  });

  it("pins the actions that carry the results or a credential", () => {
    for (const action of ["actions/upload-artifact", "actions/download-artifact", "actions/create-github-app-token"]) {
      for (const step of steps.filter((s) => s.uses?.startsWith(action))) assert.match(step.uses ?? "", new RegExp(`^${action}@[0-9a-f]{40}$`));
      assert.match(text, new RegExp(`uses: ${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+\\r?\\n`));
    }
  });
});

describe("targeted workflow: the patch between the jobs", { skip: !(have("git") && have("bash")) && "needs git and bash" }, () => {
  const toBash = (p: string): string => p.replace(/\\/g, "/");
  const FILES = ["package.json", "package-lock.json", "functions/package-lock.json", ".github/actions/x/package.json", "packages/a/package.json", "src/index.js", "docs/package.json.md"];
  const PACKAGE_FILES = FILES.filter((f) => /(^|\/)package(-lock)?\.json$/.test(f)).sort();

  /** A repository with FILES, and a copy of it standing in for publish's fresh checkout. */
  const repos = (): { plan: string; publish: string; report: string; done: () => void } => {
    const root = mkdtempSync(join(tmpdir(), "targeted-patch-"));
    const plan = join(root, "plan");
    const publish = join(root, "publish");
    const report = join(root, "report");
    mkdirSync(plan);
    mkdirSync(report);
    git(plan, "init", "-q");
    git(plan, "config", "core.autocrlf", "false");
    git(plan, "config", "user.email", "test@example.com");
    git(plan, "config", "user.name", "test");
    for (const file of FILES) {
      mkdirSync(join(plan, path.dirname(file)), { recursive: true });
      writeFileSync(join(plan, file), "before\n");
    }
    git(plan, "add", "--", ".");
    git(plan, "commit", "-q", "-m", "initial");
    git(root, "clone", "-q", "-c", "core.autocrlf=false", plan, publish);
    return { plan, publish, report, done: () => rmSync(root, { recursive: true, force: true }) };
  };
  const inRepo = (step: string, cwd: string, report: string, outcome = "changes") =>
    spawnSync("bash", ["-e", "-c", `export AGENT_REPORT_DIR='${toBash(report)}' OUTCOME='${outcome}'\n${findStep(step).run}`], { cwd, encoding: "utf-8" });
  const changed = (cwd: string): string[] => git(cwd, "diff", "--name-only").split("\n").filter(Boolean).sort();

  it("carries every package file, and nothing else, to a fresh checkout", () => {
    const { plan, publish, report, done } = repos();
    try {
      for (const file of FILES) writeFileSync(join(plan, file), "after\n");
      assert.equal(inRepo("patch", plan, report).status, 0);
      assert.equal(inRepo("apply", publish, report).status, 0);
      assert.deepEqual(changed(publish), PACKAGE_FILES);
      for (const file of PACKAGE_FILES) assert.equal(readFileSync(join(publish, file), "utf-8"), "after\n");
    } finally {
      done();
    }
  });

  it("takes only package files from a patch that names others, as a compromised agent could write", () => {
    const { plan, publish, report, done } = repos();
    try {
      writeFileSync(join(plan, "package.json"), "after\n");
      writeFileSync(join(plan, "src/index.js"), "after\n");
      writeFileSync(join(report, "fixes.patch"), git(plan, "diff", "--binary"));
      assert.equal(inRepo("apply", publish, report).status, 0);
      assert.deepEqual(changed(publish), ["package.json"]);
    } finally {
      done();
    }
  });

  it("does nothing when there are no changes, so a stale PR is still closed", () => {
    const { plan, publish, report, done } = repos();
    try {
      assert.equal(inRepo("patch", plan, report).status, 0);
      assert.equal(readFileSync(join(report, "fixes.patch"), "utf-8"), "");
      for (const outcome of ["clean", "blocked-only"]) assert.equal(inRepo("apply", publish, report, outcome).status, 0);
      assert.deepEqual(changed(publish), []);
    } finally {
      done();
    }
  });

  it("refuses a report that claims changes with an empty patch, rather than a green run with no PR", () => {
    const { plan, publish, report, done } = repos();
    try {
      assert.equal(inRepo("patch", plan, report).status, 0);
      const got = inRepo("apply", publish, report);
      assert.equal(got.status, 1);
      assert.match(got.stdout, /::error/);
    } finally {
      done();
    }
  });

  for (const outcome of ["clean", "blocked-only"]) {
    it(`refuses a patch when the report says ${outcome}`, () => {
      const { plan, publish, report, done } = repos();
      try {
        writeFileSync(join(plan, "package.json"), "after\n");
        assert.equal(inRepo("patch", plan, report).status, 0);
        assert.equal(inRepo("apply", publish, report, outcome).status, 1);
        assert.deepEqual(changed(publish), []);
      } finally {
        done();
      }
    });
  }

  it("refuses a patch whose only edits are to other files, which would otherwise apply as nothing", () => {
    const { plan, publish, report, done } = repos();
    try {
      writeFileSync(join(plan, "src/index.js"), "after\n");
      writeFileSync(join(report, "fixes.patch"), git(plan, "diff", "--binary"));
      assert.equal(inRepo("apply", publish, report).status, 1);
      assert.deepEqual(changed(publish), []);
    } finally {
      done();
    }
  });

  const crafted: Array<[string, string]> = [
    ["a rename onto a package file", "diff --git a/src/index.js b/x/package.json\nsimilarity index 100%\nrename from src/index.js\nrename to x/package.json\n"],
    ["a copy onto a package file", "diff --git a/src/index.js b/x/package.json\nsimilarity index 100%\ncopy from src/index.js\ncopy to x/package.json\n"],
    ["a mode change", "diff --git a/package.json b/package.json\nold mode 100644\nnew mode 100755\n"],
    ["a symlink", "diff --git a/package.json b/package.json\ndeleted file mode 100644\n--- a/package.json\n+++ /dev/null\n@@ -1 +0,0 @@\n-before\ndiff --git a/package.json b/package.json\nnew file mode 120000\n--- /dev/null\n+++ b/package.json\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n"],
  ];
  // No git header to give it away: only the result shows what these did.
  const headerless: Array<[string, string]> = [
    ["a new package file", "--- /dev/null\n+++ b/scripts/package.json\n@@ -0,0 +1 @@\n+after\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-before\n+after\n"],
    ["a deleted lockfile", "--- a/package-lock.json\n+++ /dev/null\n@@ -1 +0,0 @@\n-before\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-before\n+after\n"],
  ];
  for (const [label, patch] of headerless) {
    it(`refuses ${label} in a patch with no git headers`, () => {
      const { publish, report, done } = repos();
      try {
        writeFileSync(join(report, "fixes.patch"), patch);
        const got = inRepo("apply", publish, report);
        assert.equal(got.status, 1, got.stdout + got.stderr);
        assert.match(got.stdout, /more than edit/);
      } finally {
        done();
      }
    });
  }

  it("refuses an edit through a package file that's tracked as a symlink", { skip: process.platform === "win32" && "needs symlinks" }, () => {
    const { publish, report, done } = repos();
    try {
      git(publish, "config", "user.email", "test@example.com");
      git(publish, "config", "user.name", "test");
      mkdirSync(join(publish, "linked"));
      spawnSync("ln", ["-s", "../src/index.js", join(publish, "linked", "package.json")]);
      git(publish, "add", "--", "linked/package.json");
      git(publish, "commit", "-q", "-m", "a link");
      writeFileSync(join(report, "fixes.patch"), "--- a/linked/package.json\n+++ b/linked/package.json\n@@ -1 +1 @@\n-../src/index.js\n\\ No newline at end of file\n+/etc/passwd\n\\ No newline at end of file\n");
      const got = inRepo("apply", publish, report);
      assert.equal(got.status, 1, got.stdout + got.stderr);
      assert.match(got.stdout, /more than edit/);
    } finally {
      done();
    }
  });

  for (const [label, patch] of crafted) {
    it(`refuses ${label}, leaving the checkout as it was`, () => {
      const { publish, report, done } = repos();
      try {
        writeFileSync(join(report, "fixes.patch"), patch);
        const got = inRepo("apply", publish, report);
        assert.equal(got.status, 1, got.stdout + got.stderr);
        assert.match(got.stdout, /more than edit/);
        assert.deepEqual(changed(publish), []);
      } finally {
        done();
      }
    });
  }

  it("fails if the patch doesn't apply, rather than opening a PR without it", () => {
    const { plan, publish, report, done } = repos();
    try {
      writeFileSync(join(plan, "package.json"), "after\n");
      assert.equal(inRepo("patch", plan, report).status, 0);
      writeFileSync(join(publish, "package.json"), "moved on\n");
      assert.notEqual(inRepo("apply", publish, report).status, 0);
    } finally {
      done();
    }
  });
});

describe("targeted workflow: a GitHub App", () => {
  const indexOf = (id: string): number => steps.findIndex((s) => s.id === id);

  it("makes a token that can only read alerts, to fetch them", () => {
    const step = findStep("app-alerts");
    assert.match(condition(step), /inputs\.app-client-id != ''/);
    assert.equal(step.with?.["client-id"], "${{ inputs.app-client-id }}");
    assert.equal(step.with?.["private-key"], "${{ secrets.app-private-key }}");
    const permissions = Object.entries(step.with ?? {}).filter(([key]) => key.startsWith("permission-"));
    assert.deepEqual(permissions, [["permission-vulnerability-alerts", "read"]]);
    assert.ok(indexOf("app-alerts") < indexOf("fetch"));
  });

  it("makes the token that can write only for the pull request step, and only when that step will run", () => {
    const step = findStep("app-pr");
    const permissions = Object.entries(step.with ?? {}).filter(([key]) => key.startsWith("permission-")).sort();
    assert.deepEqual(permissions, [["permission-contents", "write"], ["permission-pull-requests", "write"]]);
    assert.match(condition(step), /inputs\.app-client-id != ''/);
    const pr = findStep("peter-evans/create-pull-request");
    const gate = condition(pr).replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    assert.ok(condition(step).includes(gate), `${condition(step)} should include ${gate}`);
    assert.ok(indexOf("report") < indexOf("app-pr"));
    assert.equal(indexOf("app-pr"), steps.indexOf(pr) - 1);
  });

  it("hands the private key to the two token steps and nowhere else", () => {
    assert.deepEqual(holdersOf("secrets.app-private-key"), ["app-alerts", "app-pr"]);
  });
});

describe("targeted workflow: which credentials were passed", { skip: !have("bash") && "needs bash" }, () => {
  const check = (vars: Partial<Record<"HAS_APP_CLIENT_ID" | "HAS_APP_PRIVATE_KEY" | "HAS_ALERTS_TOKEN" | "HAS_PR_TOKEN", boolean>>) => {
    const names = ["HAS_APP_CLIENT_ID", "HAS_APP_PRIVATE_KEY", "HAS_ALERTS_TOKEN", "HAS_PR_TOKEN"] as const;
    const exports = ["export GITHUB_OUTPUT=/dev/null", ...names.map((name) => `export ${name}=${vars[name] === true}`)].join("; ");
    const run = spawnSync("bash", ["-c", `${exports}\n${findStep("credentials").run}`], { encoding: "utf-8" });
    return { status: run.status, out: `${run.stdout}${run.stderr}` };
  };
  const APP = { HAS_APP_CLIENT_ID: true, HAS_APP_PRIVATE_KEY: true };
  const TOKENS = { HAS_ALERTS_TOKEN: true, HAS_PR_TOKEN: true };

  it("asks each credential only whether it was passed, and under its own name", () => {
    assert.deepEqual(findStep("credentials").env, {
      HAS_APP_CLIENT_ID: "${{ inputs.app-client-id != '' }}",
      HAS_APP_PRIVATE_KEY: "${{ secrets.app-private-key != '' }}",
      HAS_ALERTS_TOKEN: "${{ secrets.alerts-token != '' }}",
      HAS_PR_TOKEN: "${{ secrets.pr-token != '' }}",
    });
  });

  it("accepts an App", () => assert.equal(check(APP).status, 0));
  it("accepts both tokens", () => assert.equal(check(TOKENS).status, 0));

  const refused: Array<[string, Parameters<typeof check>[0], RegExp]> = [
    ["nothing", {}, /app-client-id.*alerts-token/],
    ["a client ID with no key", { HAS_APP_CLIENT_ID: true }, /app-private-key/],
    ["a key with no client ID", { HAS_APP_PRIVATE_KEY: true }, /app-client-id/],
    ["only the alerts token", { HAS_ALERTS_TOKEN: true }, /pr-token/],
    ["only the PR token", { HAS_PR_TOKEN: true }, /alerts-token/],
    ["an App and a token", { ...APP, HAS_PR_TOKEN: true }, /not both/],
  ];
  for (const [label, vars, message] of refused) {
    it(`refuses ${label}`, () => {
      const { status, out } = check(vars);
      assert.equal(status, 1);
      assert.match(out, /::error/);
      assert.match(out, message);
    });
  }
});

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
  it("skips the PR step on failure and on a restore error, and its whole job on a dry run", () => {
    const gate = condition(findStep("peter-evans/create-pull-request"));
    assert.match(gate, /outputs\.outcome != 'failed'/);
    assert.match(gate, /outputs\.restore-error != 'true'/);
    assert.equal(condition(findStep("apply")), gate);
    assert.match(wf.jobs.publish.if ?? "", /!inputs\.dry-run/);
  });

  it("runs the PR step for clean and blocked-only too, so a stale PR is closed", () => {
    assert.ok(!/clean|blocked-only|changes/.test(condition(findStep("peter-evans/create-pull-request"))));
  });

  it("fails plan when the outcome is failed, after saving the results, and publish still reports it", () => {
    const { steps: planSteps } = wf.jobs.plan;
    const last = planSteps[planSteps.length - 1];
    assert.match(condition(last), /outputs\.outcome == 'failed'/);
    assert.match(last.run ?? "", /exit 1/);
    const saved = planSteps.findIndex((s) => s.uses?.startsWith("actions/upload-artifact"));
    assert.ok(saved !== -1 && saved < planSteps.length - 1);
    assert.equal(condition(findStep("issue")), "${{ !cancelled() }}");
  });

  it("bounds both jobs, so a hung step can't hold a runner for six hours", () => {
    const { plan, publish } = wf.jobs as unknown as Record<string, { "timeout-minutes"?: number }>;
    assert.equal(plan["timeout-minutes"], 60);
    assert.equal(publish["timeout-minutes"], 15);
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

describe("targeted workflow: fetching the alerts", { skip: !canRun && "needs bash and jq" }, () => {
  const fetchWith = (gh: string): { status: number | null; alerts: unknown } => {
    const box = sandbox();
    try {
      const dir = join(box.dir, "agent-alerts");
      writeFileSync(join(box.dir, "bin", "gh"), `#!/bin/bash\n${gh}\n`);
      chmodSync(join(box.dir, "bin", "gh"), 0o755);
      const got = runStep(findStep("fetch"), box, { AGENT_ALERTS_DIR: dir.replace(/\\/g, "/") });
      const file = join(dir, "alerts.json");
      return { status: got.status, alerts: existsSync(file) && readFileSync(file, "utf-8") ? JSON.parse(readFileSync(file, "utf-8")) : null };
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  };

  it("joins the pages into one list", () => {
    const got = fetchWith(`printf '[{"number":1}]\\n[{"number":2},{"number":3}]\\n'`);
    assert.equal(got.status, 0);
    assert.deepEqual(got.alerts, [{ number: 1 }, { number: 2 }, { number: 3 }]);
  });

  it("writes an empty list when there are no alerts", () => {
    const got = fetchWith(`printf '[]\\n'`);
    assert.equal(got.status, 0);
    assert.deepEqual(got.alerts, []);
  });

  it("fails when GitHub refuses, rather than passing on an empty list", () => {
    assert.notEqual(fetchWith(`echo 'HTTP 403' >&2; exit 1`).status, 0);
  });

  it("fails when a later page does, rather than passing on part of the list", () => {
    assert.notEqual(fetchWith(`printf '[{"number":1}]\\n'; echo 'HTTP 502' >&2; exit 1`).status, 0);
  });
});

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

  it("says the alerts couldn't be fetched when the agent never ran", () => {
    const box = sandbox();
    try {
      const got = read(box, "skipped");
      assert.equal(got.output.outcome, "failed");
      assert.match(got.report, /alerts weren't available/);
      assert.match(got.report, /https:\/\/github\.example\/acme\/app\/actions\/runs\/42/);
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
  const act = (outcome: string, blockedCount: string, open: string, jobStatus = "success") => {
    const box = sandbox();
    try {
      box.write("report.md", "body\n");
      return runStep(step, box, { OUTCOME: outcome, BLOCKED_COUNT: blockedCount, ISSUE_OPEN: open, JOB_STATUS: jobStatus });
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

  it("runs after a failed step, and reports the failure whatever the plan's outcome was", () => {
    assert.equal(condition(step), "${{ !cancelled() }}");
    for (const outcome of ["changes", "clean", "blocked-only"]) {
      const got = act(outcome, "0", "", "failure");
      assert.ok(verbs(got.gh).includes("issue create"), outcome);
      assert.match(got.report, /Publishing these results failed/);
    }
    const got = act("clean", "0", "17", "failure");
    assert.ok(got.gh.some((line) => line.startsWith("issue edit 17")));
    assert.ok(!got.gh.some((line) => line.startsWith("issue close")));
  });

  it("does nothing when clean and no issue is open", () => {
    assert.ok(!act("clean", "0", "").gh.some((line) => /^issue (close|edit|create)/.test(line)));
  });
});
