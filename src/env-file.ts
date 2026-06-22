import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./util.js";

/**
 * Minimal .env loader (zero deps). Reads `<dir>/.env` and populates `env` with
 * any KEY that isn't already set — so real shell/CI environment variables always
 * take precedence over the file. Following the common convention of keeping
 * secrets (e.g. GITHUB_TOKEN) in a repo-root .env.
 *
 * Supports `KEY=value`, `export KEY=value`, `#` comments, blank lines, and
 * single/double-quoted values. It does not do variable interpolation.
 */
export function loadEnvFile(dir: string, env: NodeJS.ProcessEnv): void {
  const envPath = path.join(dir, ".env");
  if (!fs.existsSync(envPath)) return;

  let loaded = 0;
  const text = fs.readFileSync(envPath, "utf-8");

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const stripped = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = stripped.indexOf("=");
    if (eq === -1) continue;

    const key = stripped.slice(0, eq).trim();
    if (!key) continue;

    let value = stripped.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    // Don't clobber variables already present in the real environment.
    if (env[key] === undefined) {
      env[key] = value;
      loaded++;
    }
  }

  if (loaded > 0) log(`🔐 Loaded ${loaded} variable(s) from ${envPath}`);
}
