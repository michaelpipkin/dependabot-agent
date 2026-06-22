import * as fs from "node:fs";
import * as path from "node:path";
import { PackageManagerId } from "../types.js";
import { PackageManager, RunContext } from "./types.js";
import { PnpmPackageManager } from "./pnpm.js";
import { NpmPackageManager } from "./npm.js";

export { PackageManager, RunContext } from "./types.js";

/**
 * Detect the package manager for a project from its lockfile.
 * Returns null if neither a pnpm nor an npm lockfile is present.
 */
export function detectPackageManager(root: string): PackageManagerId | null {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "package-lock.json"))) return "npm";
  return null;
}

export function createPackageManager(id: PackageManagerId, ctx: RunContext): PackageManager {
  return id === "pnpm" ? new PnpmPackageManager(ctx) : new NpmPackageManager(ctx);
}
