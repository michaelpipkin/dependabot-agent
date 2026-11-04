import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isExactPin, topLevelValueRange } from "../manifest.js";
import { readNpmOverrides } from "../override-source.js";
import { log, sortObjectKeys } from "../util.js";
import { copiesOf, LockIndex, memberOwnersOf, readLockfile, resolveDep } from "./lockfile.js";
import { DirectBump, ManifestInfo, Plan } from "./plan.js";
import { verify, VerificationFailure, VerifyInput } from "./verify.js";

export type NpmRunner = (command: string, cwd: string) => void;
export interface Snapshot {
  restore(): void;
}

const NODE_MODULES = "node_modules/";
const FLAGS = "--package-lock-only --ignore-scripts --no-audit --no-fund";

/** Captures npm's output, so a failure can carry its error code, and forwards it to the log. */
const defaultRunner: NpmRunner = (command, cwd) => {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const output of [result.stdout, result.stderr]) {
    if (output?.trim()) log(output.trimEnd());
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw Object.assign(new Error(`Command failed: ${command}`), { stderr: result.stderr });
};

/** What `npm --version` says in this directory, or null if npm can't be run. */
export function npmVersion(cwd: string): string | null {
  const result = spawnSync("npm --version", { cwd, shell: true, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  const version = result.status === 0 ? result.stdout?.trim() : "";
  return version || null;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * What to report for a failed step. A runner may attach npm's stderr to what it throws,
 * as execSync does: keep its error lines (the code and the message), and leave out its
 * warnings and the path to a debug log that won't exist by the time anyone reads this.
 */
function failureDetail(e: unknown): string {
  const message = messageOf(e);
  const stderr = ((e as { stderr?: Buffer | string } | null)?.stderr ?? "").toString().trim();
  const npmError = stderr
    .split(/\r?\n/)
    .filter((line) => /^npm (error|ERR!) ?\S/.test(line) && !/complete log of this run|_logs[\\/]/.test(line));
  const command = message.split("\n")[0];
  if (npmError.length > 0) return [command, ...npmError].join("\n");
  return stderr && !message.includes(stderr) ? `${message}\n${stderr}` : message;
}

/** Holds each file's exact bytes, or that it didn't exist. */
export function snapshotFiles(paths: string[]): Snapshot {
  const saved = paths.map((path) => ({ path, bytes: existsSync(path) ? readFileSync(path) : null }));
  return {
    /** Every file is tried, so one that can't be written doesn't strand the others; all failures come back together. */
    restore() {
      const failed: string[] = [];
      for (const { path, bytes } of saved) {
        try {
          if (bytes === null) rmSync(path, { force: true });
          else writeFileSync(path, bytes);
        } catch (e) {
          failed.push(`${path} (${messageOf(e)})`);
        }
      }
      if (failed.length > 0) throw new Error(`Could not restore ${failed.length} file(s): ${failed.join("; ")}`);
    },
  };
}

/**
 * A value from the repo's own files, made safe to hand to a shell. These commands
 * run through cmd.exe or sh, and a CI job may run them on a branch it doesn't
 * trust, so anything that isn't plainly a name or a path is refused, not escaped.
 */
function shellWord(value: string, what: string): string {
  if (/^[\w@./][\w@./-]*$/.test(value)) return value;
  if (/^[\w@./][\w@./ -]*$/.test(value)) return `"${value}"`;
  throw new Error(`Refusing to put the ${what} ${JSON.stringify(value)} on a shell command line.`);
}

/**
 * The prefix is quoted because cmd.exe otherwise eats `^`, its escape character,
 * and the prefix and exactness are both passed because `.npmrc` can set either:
 * npm would turn `~` into `^`, or either into a pin.
 */
export function bumpCommand(bump: DirectBump): string {
  const where = bump.memberPath ? ` -w ${shellWord(bump.memberPath, "workspace path")}` : "";
  const spec = `${shellWord(bump.name, "package name")}@${shellWord(bump.target, "version")}`;
  return `npm install ${spec}${where} "--save-prefix=${bump.operator}" --save-exact=false ${FLAGS}`;
}

export function resolveCommand(): string {
  return `npm install ${FLAGS}`;
}

/** `overrides` rendered at the top level of a manifest with this indent and line ending. */
function renderOverrides(overrides: Record<string, unknown>, indent: string, eol: string): string {
  return JSON.stringify(overrides, null, indent)
    .split("\n")
    .map((line, i) => (i === 0 ? line : indent + line))
    .join(eol);
}

/**
 * The manifest's text with its top-level `overrides` replaced, added or removed, and
 * nothing else touched: indentation, line endings and any trailing newline all stay,
 * so a PR's diff shows only what changed. (override-source.ts reformats the whole
 * file, which the other strategies keep.) No overrides left means no block, unless
 * asked to `keepEmpty`, which holds its place in the file for keys still to come.
 */
function withOverridesBlock(text: string, overrides: Record<string, unknown>, keepEmpty = false): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
  const isEmpty = Object.keys(overrides).length === 0;
  const range = topLevelValueRange(text, "overrides");

  if (range) {
    const [start, end] = range;
    if (!isEmpty || keepEmpty) return text.slice(0, start) + renderOverrides(overrides, indent, eol) + text.slice(end);
    const before = text.slice(0, text.lastIndexOf('"overrides"', start));
    const after = text.slice(end);
    const commaBefore = /,\s*$/.exec(before);
    if (commaBefore) return before.slice(0, commaBefore.index) + after;
    const commaAfter = /^\s*,\s*/.exec(after);
    return commaAfter ? before + after.slice(commaAfter[0].length) : before.trimEnd() + after;
  }
  if (isEmpty) return text;

  const close = text.lastIndexOf("}");
  const head = text.slice(0, close).trimEnd();
  const comma = head.endsWith("{") ? "" : ",";
  return `${head}${comma}${eol}${indent}"overrides": ${renderOverrides(overrides, indent, eol)}${eol}${text.slice(close)}`;
}

/** Write the root's flat overrides, sorted, with its nested ones preserved. */
function writeRootOverrides(
  dir: string,
  flat: Record<string, string>,
  nested: Record<string, unknown>,
  keepEmpty = false,
): void {
  const file = join(dir, "package.json");
  writeFileSync(file, withOverridesBlock(readFileSync(file, "utf-8"), sortObjectKeys({ ...nested, ...flat }), keepEmpty));
}

/**
 * Before the bumps: npm resolves a bump through any override still live, so a
 * floating key being replaced would carry the bump past its target.
 */
function removeReplacedOverrides(dir: string, plan: Plan): void {
  if (plan.removeOverrideKeys.length === 0) return;
  const { flat, nested } = readNpmOverrides(dir);
  for (const key of plan.removeOverrideKeys) delete flat[key];
  writeRootOverrides(dir, flat, nested, Object.keys(plan.addOverrides).length > 0);
}

/** After the bumps: npm refuses (EOVERRIDE) a key matching a root edge the bump hasn't rewritten yet. */
function addOverrides(dir: string, plan: Plan): void {
  if (Object.keys(plan.addOverrides).length === 0) return;
  // Read now, not earlier: a root bump has just rewritten this file.
  const { flat, nested } = readNpmOverrides(dir);
  writeRootOverrides(dir, { ...flat, ...plan.addOverrides }, nested);
}

const hasNoChanges = (plan: Plan): boolean =>
  plan.bumps.length === 0 &&
  Object.keys(plan.addOverrides).length === 0 &&
  plan.removeOverrideKeys.length === 0 &&
  plan.targets.size === 0;

/** The packages with a planned copy still not at its target: at its path, or reappeared at another. */
function namesNotMoved(before: LockIndex, now: LockIndex, plan: Plan): string[] {
  const names = new Set<string>();
  for (const [path, target] of plan.targets) {
    const entry = now.entries.get(path);
    if (entry) {
      if (entry.version !== target) names.add(entry.name);
      continue;
    }
    const old = before.entries.get(path);
    if (old && copiesOf(now, old.name).some((copy) => copy.version === old.version)) names.add(old.name);
  }
  return [...names];
}

const ROOT_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/**
 * What the root must temporarily declare for npm to reach the targets: each member's
 * own dependencies leading to one, with their declared ranges. That includes peer and
 * optional edges, which npm reaches the same way, though a range a member really
 * depends on is preferred over one it only peers on. Left out are a sibling member
 * (its own dependencies are looked at in turn) and anything the root already declares,
 * since a root entry wins.
 */
function temporaryRootEntries(
  lock: LockIndex,
  memberPaths: string[],
  targetNames: string[],
  root: Record<string, unknown>,
): Record<string, string> {
  const required: Record<string, string> = {};
  const weaker: Record<string, string> = {};
  const isDeclared = (name: string): boolean =>
    ROOT_FIELDS.some((field) => name in ((root[field] as Record<string, string> | undefined) ?? {}));

  for (const memberPath of memberPaths) {
    const member = lock.entries.get(memberPath);
    if (!member) continue;
    for (const [name, spec] of Object.entries(memberOwnersOf(lock, [memberPath], targetNames))) {
      if (isDeclared(name) || !resolveDep(lock, memberPath, name)?.path.includes(NODE_MODULES)) continue;
      const real = member.dependencies[name] ?? member.devDependencies[name];
      if (real !== undefined) required[name] ??= real;
      else weaker[name] ??= spec;
    }
  }
  return { ...weaker, ...required };
}

/**
 * npm only re-applies an override to a package reachable from the root manifest,
 * so make the members' dependencies reachable, resolve, then take them away and
 * resolve again. Skipped when nothing could be added: verification reports the copy.
 */
function resolveThroughRoot(dir: string, lock: LockIndex, targetNames: string[], manifests: ManifestInfo[], run: NpmRunner): void {
  const rootFile = join(dir, "package.json");
  const saved = readFileSync(rootFile, "utf-8");
  const root = JSON.parse(saved) as Record<string, unknown>;
  const memberPaths = manifests.filter((m) => !m.notWorkspace).map((m) => m.lockPath).filter((path) => path !== "");
  const entries = temporaryRootEntries(lock, memberPaths, targetNames, root);
  if (Object.keys(entries).length === 0) return;

  log(`   Resolving ${targetNames.join(", ")} through temporary root entries: ${Object.keys(entries).join(", ")}.`);
  const devDependencies = { ...(root.devDependencies as Record<string, string> | undefined), ...entries };
  writeFileSync(rootFile, JSON.stringify({ ...root, devDependencies }, null, 2) + "\n");
  try {
    run(resolveCommand(), dir);
  } finally {
    writeFileSync(rootFile, saved);
  }
  run(resolveCommand(), dir);
}

const manifestLabel = (lockPath: string): string => (lockPath ? `${lockPath}/package.json` : "package.json");

/** The text of the root's and every listed member's manifest, by the label verification uses. */
function readManifests(dir: string, manifests: ManifestInfo[]): Map<string, string | null> {
  const files = new Map<string, string>([["package.json", join(dir, "package.json")]]);
  for (const manifest of manifests) {
    if (!manifest.external) files.set(manifestLabel(manifest.lockPath), join(manifest.dir, "package.json"));
  }
  const texts = new Map<string, string | null>();
  for (const [label, file] of files) texts.set(label, existsSync(file) ? readFileSync(file, "utf-8") : null);
  return texts;
}

function pinsOf(lock: LockIndex, manifests: ManifestInfo[]): VerifyInput["pins"] {
  return manifests.flatMap((manifest) =>
    manifest.deps
      .filter((dep) => isExactPin(dep.spec))
      .map((dep) => ({
        lockPath: manifest.lockPath,
        name: dep.name,
        version: resolveDep(lock, manifest.lockPath, dep.name)?.version ?? dep.spec,
      })),
  );
}

function expectedManifests(plan: Plan): string[] {
  const writesOverrides = Object.keys(plan.addOverrides).length > 0 || plan.removeOverrideKeys.length > 0;
  return [...(writesOverrides ? [""] : []), ...plan.bumps.map((bump) => bump.memberPath ?? "")].map(manifestLabel);
}

/** A throw here must not escape: the caller's snapshots still have to be restored. */
function safeVerify(input: VerifyInput): VerificationFailure[] {
  try {
    return verify(input);
  } catch (e) {
    return [{ check: "stable", detail: `Verification could not finish: ${messageOf(e)}` }];
  }
}

/**
 * Apply a plan to the lockfile, without deleting it, and verify the result. Returns
 * an empty array on success. On failure the files are left as they are: restoring is
 * up to the caller's run-wide snapshot.
 */
export function applyPlan(
  dir: string,
  plan: Plan,
  opts: { limits: Record<string, string>; manifests: ManifestInfo[]; run?: NpmRunner },
): VerificationFailure[] {
  // Nothing to do needs neither the registry nor a resolve that could fail.
  if (hasNoChanges(plan)) return [];
  const run = opts.run ?? defaultRunner;
  const lockFile = join(dir, "package-lock.json");
  try {
    const commands = plan.bumps.map(bumpCommand);
    const before = readLockfile(dir);
    const pins = pinsOf(before, opts.manifests);
    const manifestsBefore = readManifests(dir, opts.manifests);

    removeReplacedOverrides(dir, plan);
    for (const command of commands) run(command, dir);
    addOverrides(dir, plan);
    run(resolveCommand(), dir);

    const resolved = readLockfile(dir);
    const notMoved = namesNotMoved(before, resolved, plan);
    if (notMoved.length > 0) resolveThroughRoot(dir, resolved, notMoved, opts.manifests, run);

    const settled = readFileSync(lockFile, "utf-8");
    run(resolveCommand(), dir);
    const stable = readFileSync(lockFile, "utf-8") === settled;

    const manifestsAfter = readManifests(dir, opts.manifests);
    return safeVerify({
      before,
      after: readLockfile(dir),
      plan,
      limits: opts.limits,
      overrides: readNpmOverrides(dir).flat,
      pins,
      changedManifests: [...manifestsAfter.keys()].filter((label) => manifestsAfter.get(label) !== manifestsBefore.get(label)),
      expectedManifests: expectedManifests(plan),
      stable,
    });
  } catch (e) {
    return [{ check: "stable", detail: failureDetail(e) }];
  }
}

function versionsOf(lock: LockIndex): Map<string, string | undefined> {
  return new Map([...lock.entries].map(([path, entry]) => [path, entry.version]));
}

function sameVersions(a: Map<string, string | undefined>, b: Map<string, string | undefined>): boolean {
  return a.size === b.size && [...a].every(([path, version]) => b.has(path) && b.get(path) === version);
}

/**
 * Remove one flat override, keeping the removal only if no lockfile version moved.
 * Returns false, with the files as they were, if something did, if npm failed, or
 * if there's no such key to remove.
 */
export function tryRemoveOverride(dir: string, key: string, run: NpmRunner = defaultRunner): boolean {
  const snapshot = snapshotFiles([join(dir, "package.json"), join(dir, "package-lock.json")]);
  try {
    const { flat, nested } = readNpmOverrides(dir);
    if (!(key in flat)) return false;
    const before = versionsOf(readLockfile(dir));
    delete flat[key];
    writeRootOverrides(dir, flat, nested);
    run(resolveCommand(), dir);
    if (sameVersions(before, versionsOf(readLockfile(dir)))) return true;
  } catch (e) {
    log(`   Keeping the override "${key}": ${failureDetail(e)}`);
  }
  snapshot.restore();
  return false;
}
