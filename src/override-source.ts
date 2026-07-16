import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { PackageManagerId } from "./types.js";
import { exitWithError, log, sortObjectKeys } from "./util.js";

/**
 * Abstraction over the possible override locations so the rest of the agent
 * doesn't need to know which file (or which key) it's dealing with.
 */
export interface OverrideSource {
  /** Human-readable label shown in log output */
  label: string;
  /** Absolute path to the file being managed */
  filePath: string;
  /** Current overrides contents */
  overrides: Record<string, string>;
  /** Write the supplied overrides back to the source file */
  write(newOverrides: Record<string, string>): void;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Pick the right override source for a manifest group.
 *
 * - npm  → top-level `overrides` in that directory's package.json.
 * - pnpm + root → pnpm-workspace.yaml if present, else pnpm.overrides in package.json.
 * - pnpm + non-root → a directory-local pnpm-workspace.yaml (pnpm v9+ no longer
 *   reads pnpm.overrides from a non-root package.json).
 */
export function selectOverrideSource(pmId: PackageManagerId, manifestDir: string, isRoot: boolean): OverrideSource {
  if (pmId === "npm") {
    return buildNpmPackageJsonSource(path.join(manifestDir, "package.json"));
  }
  return isRoot ? detectPnpmOverrideSource(manifestDir) : buildPnpmIsolatedSource(manifestDir);
}

// ---------------------------------------------------------------------------
// npm — top-level `overrides` in package.json
// ---------------------------------------------------------------------------

function buildNpmPackageJsonSource(filePath: string): OverrideSource {
  if (!fs.existsSync(filePath)) {
    exitWithError(`No package.json found at ${filePath}`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;

  // npm's `overrides` allows nested object values (`"webpack": { "loader-utils":
  // "^2.0.4" }`), which the reconciliation logic — keyed on string specs — can't
  // model. Split them out: only string-valued overrides are reconciled; nested
  // ones are preserved verbatim and merged back on write, never read or clobbered.
  const rawOverrides = (raw.overrides ?? {}) as Record<string, unknown>;
  const overrides: Record<string, string> = {};
  const nested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawOverrides)) {
    if (typeof value === "string") overrides[key] = value;
    else nested[key] = value;
  }

  log(`   Using top-level "overrides" in package.json (npm).`);
  const nestedKeys = Object.keys(nested);
  if (nestedKeys.length > 0) {
    log(`   ℹ️  Leaving ${nestedKeys.length} nested override(s) untouched (only string-valued specs are managed): ${nestedKeys.join(", ")}`);
  }

  return {
    label: "package.json (npm overrides)",
    filePath,
    overrides,
    write(newOverrides: Record<string, string>): void {
      const merged = { ...nested, ...newOverrides };
      if (Object.keys(merged).length === 0) {
        delete raw.overrides;
      } else {
        raw.overrides = sortObjectKeys(merged);
      }
      fs.writeFileSync(filePath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    },
  };
}

// ---------------------------------------------------------------------------
// pnpm — pnpm-workspace.yaml or pnpm.overrides in package.json
// ---------------------------------------------------------------------------

function detectPnpmOverrideSource(manifestDir: string): OverrideSource {
  const workspaceYamlPath = path.join(manifestDir, "pnpm-workspace.yaml");

  if (fs.existsSync(workspaceYamlPath)) {
    log(`   Detected pnpm-workspace.yaml — overrides will be managed there.`);
    return buildWorkspaceYamlSource(workspaceYamlPath);
  }

  const pkgJsonPath = path.join(manifestDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    exitWithError(`Neither pnpm-workspace.yaml nor package.json found in ${manifestDir}`);
  }

  log(`   No pnpm-workspace.yaml found — overrides will be managed in package.json.`);
  return buildPnpmPackageJsonSource(pkgJsonPath);
}

/**
 * Override source for an isolated package folder that is not the workspace
 * root. Overrides go in a pnpm-workspace.yaml in that folder — pnpm v9+ no
 * longer reads pnpm.overrides from package.json. If no pnpm-workspace.yaml
 * exists yet, one will be created on first write.
 */
function buildPnpmIsolatedSource(folderPath: string): OverrideSource {
  const pkgJsonPath = path.join(folderPath, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    exitWithError(`No package.json found in package folder: ${folderPath}`);
  }
  const workspaceYamlPath = path.join(folderPath, "pnpm-workspace.yaml");
  log(`   Isolated package — overrides will be managed in ${workspaceYamlPath}.`);
  return buildWorkspaceYamlSource(workspaceYamlPath);
}

function buildWorkspaceYamlSource(filePath: string): OverrideSource {
  // File may not exist yet (e.g. first run for an isolated package folder)
  const rawText = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  const doc = (yaml.load(rawText) ?? {}) as Record<string, unknown>;

  // Determine which overrides location this file is already using:
  //   1. Top-level `overrides:` key  (preferred pnpm-workspace.yaml convention)
  //   2. Nested `pnpm.overrides:`    (also valid, used in older configs)
  // If neither exists yet, default to top-level.
  const hasTopLevel = "overrides" in doc;
  const hasPnpmNested =
    typeof doc.pnpm === "object" && doc.pnpm !== null && "overrides" in (doc.pnpm as Record<string, unknown>);

  const useTopLevel = hasTopLevel || !hasPnpmNested;

  const overrides: Record<string, string> = useTopLevel
    ? ((doc.overrides ?? {}) as Record<string, string>)
    : (((doc.pnpm as Record<string, unknown>).overrides ?? {}) as Record<string, string>);

  log(`   Using ${useTopLevel ? "top-level" : "pnpm.overrides"} section in pnpm-workspace.yaml.`);

  return {
    label: "pnpm-workspace.yaml",
    filePath,
    overrides,
    write(newOverrides: Record<string, string>): void {
      if (useTopLevel) {
        if (Object.keys(newOverrides).length === 0) {
          delete doc.overrides;
        } else {
          doc.overrides = sortObjectKeys(newOverrides);
        }
      } else {
        const pnpm = doc.pnpm as Record<string, unknown>;
        if (Object.keys(newOverrides).length === 0) {
          delete pnpm.overrides;
          if (Object.keys(pnpm).length === 0) delete doc.pnpm;
        } else {
          pnpm.overrides = sortObjectKeys(newOverrides);
        }
      }

      fs.writeFileSync(filePath, yaml.dump(doc, { lineWidth: -1, noRefs: true }), "utf-8");
    },
  };
}

function buildPnpmPackageJsonSource(filePath: string): OverrideSource {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  const pnpm = (raw.pnpm ?? {}) as Record<string, unknown>;
  const overrides = (pnpm.overrides ?? {}) as Record<string, string>;

  return {
    label: "package.json (pnpm.overrides)",
    filePath,
    overrides,
    write(newOverrides: Record<string, string>): void {
      const pnpmBlock = (raw.pnpm ?? {}) as Record<string, unknown>;

      if (Object.keys(newOverrides).length === 0) {
        delete pnpmBlock.overrides;
      } else {
        pnpmBlock.overrides = sortObjectKeys(newOverrides);
      }

      if (Object.keys(pnpmBlock).length === 0) {
        delete raw.pnpm;
      } else {
        raw.pnpm = pnpmBlock;
      }

      fs.writeFileSync(filePath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    },
  };
}
