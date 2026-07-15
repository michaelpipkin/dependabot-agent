import { execSync, ExecSyncOptions } from "node:child_process";

/**
 * Run a shell command synchronously and return its stdout as a string.
 * Defaults to utf-8 encoding; callers may override (e.g. larger maxBuffer).
 */
export function shell(cmd: string, opts: ExecSyncOptions = {}): string {
  return (execSync(cmd, { encoding: "utf-8", ...opts }) as unknown as string).toString();
}

export function addUnique<T>(arr: T[], value: T): void {
  if (!arr.includes(value)) arr.push(value);
}

export function sortObjectKeys(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Convert an MSYS/Git-Bash POSIX path to Windows form: "/c/Users/x" → "C:/Users/x".
 * Returns null for anything that isn't one, so callers leave it alone.
 */
export function posixToWindowsPath(value: string): string | null {
  const match = /^\/([a-zA-Z])\/(.*)$/.exec(value);
  return match ? `${match[1].toUpperCase()}:/${match[2]}` : null;
}

/**
 * Repair POSIX-shaped path variables before we shell out to a package manager.
 *
 * Git Bash on Windows can export PNPM_HOME as "/c/Users/you/AppData/Local/pnpm".
 * It converts that to Windows form when *it* launches a native binary, so a
 * hand-typed `pnpm update` works — but a pnpm spawned by this process inherits
 * the raw POSIX value, derives its store as "\c\Users\...\store\v11", finds
 * node_modules recorded against "C:\Users\...\store\v11", and dies with
 * ERR_PNPM_UNEXPECTED_STORE partway through a run. The message names neither
 * the variable nor the cause.
 *
 * Deliberately inert everywhere else: it returns immediately off win32 (so
 * Linux CI runners, including GitHub Actions, never execute it) and only
 * rewrites values that are unambiguously MSYS drive paths. It warns rather than
 * exits — a wrong guess here must never fail a run.
 */
export function normalizeChildEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== "win32") return;

  for (const key of ["PNPM_HOME"]) {
    const raw = env[key];
    if (!raw) continue;
    const windows = posixToWindowsPath(raw);
    if (!windows) continue;

    env[key] = windows;
    warn(
      `${key} was a POSIX path (${raw}) — using ${windows} for child processes.\n` +
        `   Git Bash exports it that way; pnpm would otherwise resolve a different store than\n` +
        `   your node_modules and fail with ERR_PNPM_UNEXPECTED_STORE. Set ${key} to a Windows\n` +
        `   path to silence this.`,
    );
  }
}

export function log(msg: string): void {
  console.log(msg);
}

export function warn(msg: string): void {
  console.warn(`⚠️  ${msg}`);
}

export function exitWithError(msg: string): never {
  console.error(`\n❌ Error: ${msg}`);
  process.exit(1);
}
