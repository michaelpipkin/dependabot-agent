import semver from "semver";
import type { DependabotAlert } from "../types.js";
import { copiesOf, LockEntry, LockIndex, resolveDep } from "./lockfile.js";
import { Block, buildPlan, declaredRange, lineStart, MovedWith, Plan, PlanInput, Requirement } from "./plan.js";

/** What a published version asks of other packages. */
export interface VersionInfo {
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}
export type PublishedPackage = Map<string, VersionInfo>;
/** A package's published versions, or null if the registry has no such package. Any other failure throws. */
export type ReadPackage = (name: string) => Promise<PublishedPackage | null>;

// npm's own edge validity test: loose parsing, pre-releases allowed.
const NPM_RANGE = { loose: true, includePrerelease: true };
const NODE_MODULES = "node_modules/";
/** A bound on one solve: versions only ever rise, so this is only ever reached by a tree that keeps changing its mind. */
const MAX_PASSES = 50;

interface Need extends Requirement {
  /** The packages whose alerts this comes down to. Blocking those is what releases it. */
  drivers: Set<string>;
  /** Whether a peer is behind it, which ties the two packages to a single install. */
  tiedTo?: string;
}
/** A need nothing published can meet. */
interface Dead {
  detail: string;
  drivers: Set<string>;
}
type Found = { needs: Need[]; dead: null } | { needs: Need[]; dead: Dead };

const accepts = (range: string, version: string): boolean => semver.satisfies(version, range, NPM_RANGE);
const isInstalled = (entry: LockEntry | null | undefined): entry is LockEntry & { version: string } =>
  !!entry && !entry.inBundle && !entry.link && entry.version !== undefined && entry.path.includes(NODE_MODULES);

/** The lowest stable version above `above` that passes `fits`, or null. */
function lowestAbove(versions: Iterable<string>, above: string, fits: (version: string) => boolean): string | null {
  const candidates = [...versions]
    .filter((v) => semver.valid(v) && !semver.prerelease(v) && semver.gt(v, above) && fits(v))
    .sort(semver.compare);
  return candidates[0] ?? null;
}

const nameOfAlert = (alert: DependabotAlert): string => alert.security_vulnerability.package.name;

/** What each moving package comes down to: its own alerts, and whatever is driving it further. */
function driversOf(name: string, plan: Plan, required: Map<string, Need>): Set<string> {
  const own = plan.alerts.some((a) => a.packageName === name && a.copies.some((c) => c.action !== "blocked"));
  return new Set([...(own ? [name] : []), ...(required.get(name)?.drivers ?? [])]);
}

/** Step A: what each target's own manifest asks of the tree. */
async function needsOfTargets(lock: LockIndex, plan: Plan, required: Map<string, Need>, read: ReadPackage): Promise<Found> {
  const needs: Need[] = [];
  for (const [path, version] of plan.targets) {
    const entry = lock.entries.get(path);
    if (!isInstalled(entry)) continue;
    const info = (await read(entry.name))?.get(version);
    if (!info) continue;
    const drivers = driversOf(entry.name, plan, required);
    const asked = [
      ...Object.entries(info.peerDependencies).map(([name, spec]) => ({ name, spec, peer: true })),
      ...Object.entries(info.dependencies).map(([name, spec]) => ({ name, spec, peer: false })),
    ];
    for (const { name, spec, peer } of asked) {
      const range = declaredRange(spec);
      const copy = resolveDep(lock, path, name);
      if (range === null || !isInstalled(copy)) continue;
      const now = plan.targets.get(copy.path) ?? copy.version;
      if (accepts(range, now)) continue;
      // npm can nest a plain dependency of its own, so only one that's moving anyway has to agree.
      if (!peer && !plan.targets.has(copy.path)) continue;

      const because = `${entry.name}@${version} ${peer ? "peers" : "depends on"} ${name} at "${spec}"`;
      const next = lowestAbove((await read(copy.name))?.keys() ?? [], now, (v) => accepts(range, v));
      if (peer) {
        if (!next) return { needs, dead: { detail: `${because}, and no release of ${name} above ${now} fits.`, drivers } };
        needs.push({ name: copy.name, version: next, from: copy.version, because, drivers, tiedTo: entry.name });
      } else if (next && lineStart(next) === lineStart(now)) {
        needs.push({ name: copy.name, version: next, from: copy.version, because, drivers });
      } else {
        // The dependency's fix is past what this release asks for, or on another line of it. A later
        // release may agree; if not, npm can nest a copy or the override carries it, and verification judges that.
        const later = await laterAgreeing(read, entry.name, version, name, now);
        if (later) needs.push({ name: entry.name, version: later, from: entry.version, because: `${because}, and ${name} is moving to ${now}`, drivers });
      }
    }
  }
  return { needs, dead: null };
}

/** The lowest release of `name` on the same line as `version` whose own dependency on `dep` accepts where it's going. */
async function laterAgreeing(read: ReadPackage, name: string, version: string, dep: string, going: string): Promise<string | null> {
  const published = await read(name);
  if (!published) return null;
  const later = lowestAbove(published.keys(), version, (v) => {
    const asks = published.get(v)?.dependencies[dep];
    const range = asks === undefined ? null : declaredRange(asks);
    return range !== null && accepts(range, going);
  });
  return later && lineStart(later) === lineStart(version) ? later : null;
}

/** Step C: the rest of a group someone listed under `moveTogether`, once any of it moves. */
async function needsOfGroups(input: PlanInput, plan: Plan, required: Map<string, Need>, read: ReadPackage): Promise<Found> {
  const needs: Need[] = [];
  for (const group of input.moveTogether ?? []) {
    const moving = [...plan.targets]
      .map(([path, version]) => ({ name: input.lock.entries.get(path)?.name ?? "", version }))
      .filter(({ name }) => group.includes(name))
      .sort((a, b) => semver.compare(a.version, b.version));
    const leader = moving.at(-1);
    if (!leader) continue;
    const drivers = new Set(moving.flatMap(({ name }) => [...driversOf(name, plan, required)]));
    const because = `moveTogether lists ${group.join(", ")}, and ${leader.name} is moving to ${leader.version}`;
    for (const name of group) {
      for (const copy of copiesOf(input.lock, name)) {
        if (!isInstalled(copy) || lineStart(copy.version) !== lineStart(leader.version)) continue;
        const now = plan.targets.get(copy.path) ?? copy.version;
        if (semver.gte(now, leader.version)) continue;
        const next = lowestAbove((await read(name))?.keys() ?? [], now, (v) => semver.gte(v, leader.version));
        if (!next) return { needs, dead: { detail: `${because}, and no release of ${name} at or above that exists.`, drivers } };
        needs.push({ name, version: next, from: copy.version, because, drivers, tiedTo: leader.name });
      }
    }
  }
  return { needs, dead: null };
}

/** Step B: a package staying put whose peer range the move would break has to move too. */
async function needsOfDependents(lock: LockIndex, plan: Plan, required: Map<string, Need>, read: ReadPackage): Promise<Found> {
  const needs: Need[] = [];
  for (const entry of lock.entries.values()) {
    if (!isInstalled(entry) || plan.targets.has(entry.path)) continue;
    for (const [name, spec] of Object.entries(entry.peerDependencies)) {
      const range = declaredRange(spec);
      const copy = resolveDep(lock, entry.path, name);
      const moved = copy && plan.targets.get(copy.path);
      if (range === null || !isInstalled(copy) || !moved) continue;
      // Only what the move itself breaks: a peer that was already out of range isn't this run's to fix.
      if (!accepts(range, copy.version) || accepts(range, moved)) continue;

      const drivers = driversOf(copy.name, plan, required);
      const because = `${entry.name}@${entry.version} peers ${name} at "${spec}", which ${name}@${moved} is outside`;
      const published = await read(entry.name);
      const next = lowestAbove(published?.keys() ?? [], entry.version, (v) => {
        const asks = published?.get(v)?.peerDependencies[name];
        const asked = asks === undefined ? null : declaredRange(asks);
        return asks === undefined || (asked !== null && accepts(asked, moved));
      });
      if (!next) return { needs, dead: { detail: `${because}, and no later release of ${entry.name} accepts it.`, drivers } };
      needs.push({ name: entry.name, version: next, from: entry.version, because, drivers, tiedTo: copy.name });
    }
  }
  return { needs, dead: null };
}

/** Fold what was found into what's required. Returns whether anything changed. */
function merge(required: Map<string, Need>, needs: Need[], batched: Set<string>): boolean {
  let changed = false;
  for (const need of needs) {
    if (need.tiedTo) batched.add(need.name).add(need.tiedTo);
    const held = required.get(need.name);
    if (!held || semver.gt(need.version, held.version)) {
      required.set(need.name, { ...need, from: held && semver.lt(held.from, need.from) ? held.from : need.from });
      changed = true;
      continue;
    }
    if (semver.lt(need.version, held.version)) continue;
    const before = held.drivers.size;
    for (const driver of need.drivers) held.drivers.add(driver);
    if (semver.lt(need.from, held.from)) {
      held.from = need.from;
      changed = true;
    }
    changed ||= held.drivers.size !== before;
  }
  return changed;
}

/**
 * Rule out the alert or alerts that sit highest in each driver: the next pass may find a
 * lower fix that doesn't reach so far. Returns whether anything was ruled out.
 */
export function ruleOut(input: PlanInput, plan: Plan, drivers: Set<string>, block: Block, excluded: Map<DependabotAlert, Block>): boolean {
  let any = false;
  for (const driver of drivers) {
    const live = input.alerts.filter((alert) => {
      if (nameOfAlert(alert) !== driver || excluded.has(alert)) return false;
      return plan.alerts.some((a) => a.number === alert.number && a.packageName === driver && a.copies.some((c) => c.action !== "blocked"));
    });
    const patchOf = (alert: DependabotAlert): string => alert.security_vulnerability.first_patched_version?.identifier ?? "0.0.0";
    const highest = live.map(patchOf).sort(semver.compare).at(-1);
    for (const alert of live) {
      if (patchOf(alert) !== highest) continue;
      excluded.set(alert, block);
      any = true;
    }
  }
  return any;
}

function movedWithOf(plan: Plan, input: PlanInput, required: Map<string, Need>): MovedWith[] {
  const out = new Map<string, MovedWith>();
  for (const need of required.values()) {
    // An alert counts only if it's being fixed: one that's blocked adds no row to the report.
    const ownFix = input.alerts.some((alert) => {
      const patch = alert.security_vulnerability.first_patched_version?.identifier;
      if (alert.state !== "open" || nameOfAlert(alert) !== need.name || semver.valid(patch) === null || semver.lt(patch!, need.version)) return false;
      return plan.alerts.some((a) => a.number === alert.number && a.packageName === need.name && a.copies.some((c) => c.action !== "blocked"));
    });
    if (ownFix) continue;
    for (const [path, target] of plan.targets) {
      const entry = input.lock.entries.get(path);
      if (entry?.name !== need.name || entry.version === undefined || lineStart(target) !== lineStart(need.version)) continue;
      out.set(`${need.name}\0${entry.version}\0${target}`, { name: need.name, from: entry.version, to: target, because: need.because });
    }
  }
  return [...out.values()];
}

const sameTargets = (a: Map<string, string> | undefined, b: Map<string, string>): boolean =>
  a !== undefined && a.size === b.size && [...b].every(([path, version]) => a.get(path) === version);

/** Who a package's alerts come down to, so that the caller can rule out the right ones after a failed run. */
export interface Solved {
  plan: Plan;
  /** For a package moving only because of another, the packages it comes down to. */
  drivers: Map<string, Set<string>>;
}

/**
 * The plan, once every target's own needs are in it. A target can't always be reached on its
 * own: its peers have to agree with it, and so does anything else being fixed that it depends
 * on. Those become requirements, which answer to everything an alert does. One that can't be
 * met rules out the alert behind it, and the plan is made again without it, so nothing here
 * can leave a fix half-planned.
 */
export async function solvePlan(input: PlanInput, readPackage: ReadPackage): Promise<Solved> {
  const cache = new Map<string, Promise<PublishedPackage | null>>();
  const read: ReadPackage = (name) => {
    let found = cache.get(name);
    if (!found) {
      found = readPackage(name).then((pkg) => {
        input.published.set(name, pkg ? [...pkg.keys()] : null);
        return pkg;
      });
      cache.set(name, found);
    }
    return found;
  };
  for (const alert of input.alerts) {
    if (copiesOf(input.lock, nameOfAlert(alert)).length > 0) await read(nameOfAlert(alert));
  }

  const excluded = new Map(input.excluded);
  // Each restart rules out at least one alert, so this ends.
  for (let restart = 0; restart <= input.alerts.length; restart++) {
    const required = new Map<string, Need>();
    const batched = new Set<string>();
    let moving: Map<string, string> | undefined;
    let restarted = false;

    for (let pass = 0; pass < MAX_PASSES && !restarted; pass++) {
      const plan = buildPlan({ ...input, required: [...required.values()], moving, excluded });

      const unmet = [...(plan.unmet ?? [])][0];
      const dead: Dead | null = unmet
        ? {
            detail: `${required.get(unmet[0])!.because}, so ${unmet[0]} has to move to ${required.get(unmet[0])!.version} with this fix, and it can't: ${unmet[1].detail}`,
            drivers: required.get(unmet[0])!.drivers,
          }
        : null;
      const a = dead ? { needs: [], dead } : await needsOfTargets(input.lock, plan, required, read);
      const b = a.dead ? a : await needsOfDependents(input.lock, plan, required, read);
      const c = b.dead ? b : await needsOfGroups(input, plan, required, read);
      const stop = c.dead;
      if (stop) {
        const block: Block = { reason: "moves-together", detail: stop.detail };
        if (!ruleOut(input, plan, stop.drivers, block, excluded)) {
          const fallback = buildPlan({ ...input, excluded });
          return { plan: fallback, drivers: new Map() };
        }
        restarted = true;
        continue;
      }

      const changed = merge(required, [...a.needs, ...b.needs, ...c.needs], batched);
      if (!changed && required.size === 0) return { plan, drivers: new Map() };
      if (!changed && sameTargets(moving, plan.targets)) {
        plan.batched = new Set([...batched].filter((name) => [...plan.targets.keys()].some((path) => input.lock.entries.get(path)?.name === name)));
        plan.movedWith = movedWithOf(plan, input, required);
        return { plan, drivers: new Map([...required].map(([name, need]) => [name, need.drivers])) };
      }
      moving = plan.targets;
    }
    if (!restarted) break;
  }
  return { plan: buildPlan({ ...input, excluded }), drivers: new Map() };
}

/** The plan alone, for a caller with no use for who drove what. */
export async function planWithRequirements(input: PlanInput, readPackage: ReadPackage): Promise<Plan> {
  return (await solvePlan(input, readPackage)).plan;
}
