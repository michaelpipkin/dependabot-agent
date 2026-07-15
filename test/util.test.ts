import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeChildEnv, posixToWindowsPath } from "../src/util.js";

describe("posixToWindowsPath", () => {
  it("converts an MSYS drive path", () => {
    // The real value Git Bash exports, which broke a run with ERR_PNPM_UNEXPECTED_STORE.
    assert.equal(posixToWindowsPath("/c/Users/mpipk/AppData/Local/pnpm"), "C:/Users/mpipk/AppData/Local/pnpm");
  });

  it("upper-cases the drive letter", () => {
    assert.equal(posixToWindowsPath("/d/tmp"), "D:/tmp");
  });

  it("handles a bare drive root", () => {
    assert.equal(posixToWindowsPath("/c/"), "C:/");
  });

  it("returns null for anything that isn't an MSYS drive path", () => {
    assert.equal(posixToWindowsPath("C:/Users/mpipk/AppData/Local/pnpm"), null); // already Windows
    assert.equal(posixToWindowsPath("C:\\Users\\mpipk"), null);
    assert.equal(posixToWindowsPath("/usr/local/share/pnpm"), null); // real POSIX, multi-char segment
    assert.equal(posixToWindowsPath("/home/runner/setup-pnpm"), null); // a GitHub Actions runner path
    assert.equal(posixToWindowsPath(""), null);
    assert.equal(posixToWindowsPath("relative/path"), null);
  });
});

describe("normalizeChildEnv", () => {
  it("leaves the environment alone off win32", () => {
    // The guard that keeps this inert on GitHub Actions' Linux runners. Skip on
    // Windows, where the function is supposed to act.
    if (process.platform === "win32") return;
    const env = { PNPM_HOME: "/c/Users/mpipk/AppData/Local/pnpm" };
    normalizeChildEnv(env);
    assert.equal(env.PNPM_HOME, "/c/Users/mpipk/AppData/Local/pnpm", "must not rewrite anything off win32");
  });

  it("rewrites a POSIX PNPM_HOME on win32", () => {
    if (process.platform !== "win32") return;
    const env = { PNPM_HOME: "/c/Users/mpipk/AppData/Local/pnpm" };
    normalizeChildEnv(env);
    assert.equal(env.PNPM_HOME, "C:/Users/mpipk/AppData/Local/pnpm");
  });

  it("leaves an already-correct PNPM_HOME untouched on win32", () => {
    if (process.platform !== "win32") return;
    const env = { PNPM_HOME: "C:\\Users\\mpipk\\AppData\\Local\\pnpm" };
    normalizeChildEnv(env);
    assert.equal(env.PNPM_HOME, "C:\\Users\\mpipk\\AppData\\Local\\pnpm");
  });

  it("tolerates PNPM_HOME being unset", () => {
    const env: NodeJS.ProcessEnv = {};
    normalizeChildEnv(env);
    assert.equal(env.PNPM_HOME, undefined);
  });
});
