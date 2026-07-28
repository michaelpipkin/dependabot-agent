import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Reading and editing the direct-dependency specifiers in a package.json.
//
// The update pass hands a package manager a whole manifest and gets one back
// with rewritten specifiers. Two of those rewrites are ones the agent has to
// undo or prevent — an exact pin the author set deliberately, and a pre-release
// adopted because upstream's `latest` dist-tag points at one — and both need the
// manifest read as *specifiers*, not as a resolved tree.
// ---------------------------------------------------------------------------

/**
 * The dependency fields an update pass rewrites. `peerDependencies` is
 * deliberately absent: neither `pnpm update` nor `npm update` touches it, so a
 * specifier there is the author's alone and must not be swept up by the guards.
 */
export const UPDATED_DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

export type DepField = (typeof UPDATED_DEP_FIELDS)[number];

/** One declared dependency, identified by the field it lives in as well as its name. */
export interface DirectDep {
  name: string;
  spec: string;
  field: DepField;
}

/** A specifier of the form `<operator?><version>` — the only shape the guards act on. */
export interface SimpleSpec {
  /** The leading range operator, or "" for a bare version. */
  operator: string;
  /** major.minor.patch, without pre-release or build metadata. */
  version: string;
  /** The pre-release suffix without its leading "-", or null when stable. */
  prerelease: string | null;
}

// Multi-character operators first: `>` would otherwise win the alternation
// against `>=` and leave a stray `=` in the version.
const SIMPLE_SPEC = /^(>=|<=|\^|~|>|<|=|v)?\s*(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parse a specifier that names exactly one version, with at most one leading
 * operator. Returns null for everything else — compound ranges (`>=1 <2`),
 * unions (`1 || 2`), partial versions (`1.2`), wildcards, dist-tags, and the
 * non-registry protocols (`workspace:`, `catalog:`, `npm:`, `file:`, `git+…`).
 *
 * Null means "not a shape this module reasons about", and every caller treats it
 * as leave-alone. That is the safe direction: the guards only ever act on a
 * specifier they can rewrite back into the identical shape.
 */
export function parseSimpleSpec(spec: string): SimpleSpec | null {
  const match = SIMPLE_SPEC.exec(spec.trim());
  if (!match) return null;
  const operator = match[1] ?? "";
  return {
    // A leading `v` is part of the version, not an operator on it.
    operator: operator === "v" ? "" : operator,
    version: match[2],
    prerelease: match[3] ?? null,
  };
}

/**
 * True when a specifier admits exactly one version — `1.2.3`, `=1.2.3`, or
 * `v1.2.3`. This is the shape an author reaches for to hold a dependency still,
 * and the update pass leaves it alone for that reason: a pin can be load-bearing
 * for reasons no manifest records (a broken release, an unmigrated API, a
 * platform build that only works on one version).
 *
 * `~1.2.3` is NOT a pin. It is a range, and narrowing it is a different intent
 * from freezing it — under the `latest` strategy the tilde is meant to move.
 */
export function isExactPin(spec: string): boolean {
  const parsed = parseSimpleSpec(spec);
  // "" and "=" are the same statement — npm treats a bare version as `=version`.
  return parsed !== null && (parsed.operator === "" || parsed.operator === "=");
}

/**
 * True when the specifier names a pre-release version (`^7.3.2-rc.0`,
 * `1.0.0-beta.4`). A specifier this module can't parse is not a pre-release for
 * these purposes — `?.prerelease` is undefined there, and only a string counts.
 */
export function isPrereleaseSpec(spec: string): boolean {
  return parseSimpleSpec(spec)?.prerelease != null;
}

/** Every direct dependency declared in a manifest, across the updatable fields. */
export function readDirectDependencies(cwd: string): DirectDep[] {
  const text = readManifest(cwd);
  if (text === null) return [];

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }

  const deps: DirectDep[] = [];
  for (const field of UPDATED_DEP_FIELDS) {
    const block = pkg[field];
    if (!block || typeof block !== "object") continue;
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      if (typeof spec === "string") deps.push({ name, spec, field });
    }
  }
  return deps;
}

/** One specifier rewrite, keyed the same way readDirectDependencies reports it. */
export interface SpecEdit {
  field: DepField;
  name: string;
  from: string;
  to: string;
}

/**
 * Apply specifier rewrites to a package.json by editing its raw text.
 *
 * Deliberately not a JSON.parse/stringify round-trip. The manifest belongs to
 * the user and lands in a reviewable pull request: reformatting it — key
 * ordering, indent width, whether the file ends in a newline — would bury a
 * one-line correction in a whole-file diff. Each edit is a targeted replacement
 * inside the named field's block, so nothing outside it can be touched.
 *
 * Returns the edits that were actually applied.
 */
export function rewriteSpecs(cwd: string, edits: SpecEdit[]): SpecEdit[] {
  if (edits.length === 0) return [];
  const file = manifestPath(cwd);
  let text = readManifest(cwd);
  if (text === null) return [];

  const applied: SpecEdit[] = [];
  for (const edit of edits) {
    const range = topLevelValueRange(text, edit.field);
    if (!range) continue;

    const [start, end] = range;
    const block = text.slice(start, end);
    const pattern = new RegExp(`("${escapeRegExp(edit.name)}"\\s*:\\s*)"${escapeRegExp(edit.from)}"`);
    if (!pattern.test(block)) continue;

    text = text.slice(0, start) + block.replace(pattern, `$1"${edit.to}"`) + text.slice(end);
    applied.push(edit);
  }

  if (applied.length > 0) fs.writeFileSync(file, text, "utf-8");
  return applied;
}

function manifestPath(cwd: string): string {
  return path.join(cwd, "package.json");
}

function readManifest(cwd: string): string | null {
  const file = manifestPath(cwd);
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The character range of the object or array a TOP-LEVEL key maps to, or null
 * if the key has no such value.
 *
 * Depth-aware on purpose. A plain search for `"dependencies"` also finds the one
 * nested inside an `overrides` or `pnpm` block, and rewriting a specifier there
 * would change a resolution rule rather than a declared dependency. Only a key
 * read at depth 1 whose value opens a block at depth 2 qualifies.
 */
export function topLevelValueRange(text: string, key: string): [number, number] | null {
  let depth = 0;
  let pendingKey: string | null = null;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '"') {
      const end = skipString(text, i);
      // Only depth-1 strings can be the key we want. Values at depth 1 land here
      // too ("name": "pkg" sets pendingKey to "pkg"), which is harmless: the
      // comma that follows clears it before any block opens.
      if (depth === 1) pendingKey = text.slice(i + 1, end - 1);
      i = end;
      continue;
    }

    if (ch === "{" || ch === "[") {
      depth++;
      if (depth === 2 && pendingKey === key) {
        const close = matchBracket(text, i);
        return close === -1 ? null : [i, close + 1];
      }
      i++;
      continue;
    }

    if (ch === "}" || ch === "]") {
      depth--;
      i++;
      continue;
    }

    if (ch === "," && depth === 1) pendingKey = null;
    i++;
  }

  return null;
}

/** Index one past the closing quote of the string starting at `start`. */
function skipString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') return i + 1;
    i++;
  }
  return text.length;
}

/** Index of the bracket closing the one at `open`, or -1 if unbalanced. */
function matchBracket(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      i = skipString(text, i);
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}
