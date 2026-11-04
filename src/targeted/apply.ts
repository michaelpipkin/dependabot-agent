import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isExactPin } from "../manifest.js";
import { readNpmOverrides, selectOverrideSource } from "../override-source.js";
import { log } from "../util.js";
import { copiesOf, LockIndex, memberOwnersOf, readLockfile, resolveDep } from "./lockfile.js";
import { DirectBump, ManifestInfo, Plan } from "./plan.js";
import { verify, VerificationFailure, VerifyInput } from "./verify.js";

export type NpmRunner = (command: string, cwd: string) => void;
export interface Snapshot {
  restore(): void;
}

const NODE_MODULES = "node_modules/";
const FLAGS = "--package-lock-only --ignore-scripts --no-audit --no-fund";

const defaultRunner: NpmRunner = (command, cwd) => {
  execSync(command, { cwd, stdio: "inherit" });
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Holds each file's exact bytes, or that it didn't exist. */
export function snapshotFiles(paths: string[]): Snapshot {
  const saved = paths.map((path) => ({ path, bytes: existsSync(path) ? readFileSync(path) : null }));
  return {
    restore() {
      for (const { path, bytes } of saved) {
        if (bytes === null) rmSync(path, { force: true });
        else writeFileSync(path, bytes);
      }
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

/** A package in both dependencies and devDependencies yields two bumps but needs one command. */
function bumpCommands(bumps: DirectBump[]): string[] {
  return [...new Set(bumps.map(bumpCommand))];
}

function writeOverrides(dir: string, plan: Plan): void {
  const adding = Object.keys(plan.addOverrides).length > 0;
  if (!adding && plan.removeOverrideKeys.length === 0) return;
  // Read now, not earlier: a root bump has just rewritten this file.
  const source = selectOverrideSource("npm", dir, true);
  const overrides = { ...source.overrides };
  for (const key of plan.removeOverrideKeys) delete overrides[key];
  source.write({ ...overrides, ...plan.addOverrides });
}

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
 * own dependencies leading to one, with their declared ranges. Left out are a member's
 * peer and optional edges, a sibling member (its own dependencies are looked at in
 * turn), and anything the root already declares, since a root entry wins.
 */
function temporaryRootEntries(
  lock: LockIndex,
  memberPaths: string[],
  targetNames: string[],
  root: Record<string, unknown>,
): Record<string, string> {
  const entries: Record<string, string> = {};
  const isDeclared = (name: string): boolean =>
    ROOT_FIELDS.some((field) => name in ((root[field] as Record<string, string> | undefined) ?? {}));

  for (const memberPath of memberPaths) {
    const member = lock.entries.get(memberPath);
    if (!member) continue;
    for (const name of Object.keys(memberOwnersOf(lock, [memberPath], targetNames))) {
      if (name in entries || isDeclared(name)) continue;
      const spec = member.dependencies[name] ?? member.devDependencies[name];
      if (spec === undefined) continue;
      if (!resolveDep(lock, memberPath, name)?.path.includes(NODE_MODULES)) continue;
      entries[name] = spec;
    }
  }
  return entries;
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
  const memberPaths = manifests.map((m) => m.lockPath).filter((path) => path !== "");
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
  for (const manifest of manifests) files.set(manifestLabel(manifest.lockPath), join(manifest.dir, "package.json"));
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
  const run = opts.run ?? defaultRunner;
  const lockFile = join(dir, "package-lock.json");
  try {
    const commands = bumpCommands(plan.bumps);
    const before = readLockfile(dir);
    const pins = pinsOf(before, opts.manifests);
    const manifestsBefore = readManifests(dir, opts.manifests);

    for (const command of commands) run(command, dir);
    writeOverrides(dir, plan);
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
    return [{ check: "stable", detail: messageOf(e) }];
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
    const source = selectOverrideSource("npm", dir, true);
    if (!(key in source.overrides)) return false;
    const before = versionsOf(readLockfile(dir));
    const remaining = { ...source.overrides };
    delete remaining[key];
    source.write(remaining);
    run(resolveCommand(), dir);
    if (sameVersions(before, versionsOf(readLockfile(dir)))) return true;
  } catch (e) {
    log(`   Keeping the override "${key}": ${messageOf(e)}`);
  }
  snapshot.restore();
  return false;
}
