#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./cli.js";
import { resolveConfig } from "./config.js";
import { run } from "./reconcile.js";

function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const args = parseArgs(process.argv.slice(2), readVersion());
const config = resolveConfig(args, process.env);

try {
  await run(config);
} catch (err) {
  console.error("\n💥 Unexpected error:", err);
  process.exit(1);
}
