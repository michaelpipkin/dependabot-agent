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
