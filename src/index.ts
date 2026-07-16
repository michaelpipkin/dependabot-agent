#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./cli.js";
import { resolveConfig } from "./config.js";
import { run } from "./reconcile.js";
import { AgentError, normalizeChildEnv } from "./util.js";

function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

try {
  const args = parseArgs(process.argv.slice(2), readVersion());

  // After parseArgs so --help/--version stay quiet, and before anything shells
  // out to a package manager. No-op off win32.
  normalizeChildEnv();

  const config = resolveConfig(args, process.env);
  const result = await run(config);

  // Opt-in CI signal: exit 2 (distinct from 1 = error) when override changes
  // were found, so `--dry-run --exit-code` fails a build on override drift.
  if (config.exitCode && result.overrideChanges > 0) {
    process.exitCode = 2;
  }
} catch (err) {
  // AgentError carries an already-formatted, user-facing message; anything else
  // is an unexpected crash worth a full dump. Set exitCode rather than calling
  // process.exit() so pending async handles (e.g. a failed fetch's undici
  // sockets) close on their own — process.exit() mid-teardown aborts abnormally.
  if (err instanceof AgentError) {
    console.error(`\n❌ Error: ${err.message}`);
  } else {
    console.error("\n💥 Unexpected error:", err);
  }
  process.exitCode = 1;
}
