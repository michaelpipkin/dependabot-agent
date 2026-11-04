import { parseLock, type LockIndex } from "../../src/targeted/lockfile.js";

/** Build a LockIndex from the shape of a package-lock.json `packages` block. */
export function makeLock(packages: Record<string, object>): LockIndex {
  return parseLock({ lockfileVersion: 3, packages });
}
