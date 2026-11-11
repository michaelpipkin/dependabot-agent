import * as fs from "node:fs";
import * as path from "node:path";
import semver from "semver";
import { CliArgs } from "./cli.js";
import { loadEnvFile } from "./env-file.js";
import { PackageManagerId, UpdateStrategy } from "./types.js";
import { exitWithError, log, warn } from "./util.js";

export interface ResolvedConfig {
  token: string;
  repo: string;
  owner: string;
  name: string;
  packageManager?: PackageManagerId; // undefined → auto-detect from lockfile later
  workspaceRoot: string; // absolute
  updateStrategy: UpdateStrategy;
  allowPrerelease: boolean; // let the update pass settle on a pre-release version
  dryRun: boolean;
  skipUpdate: boolean;
  exitCode: boolean; // exit 2 when any override changes are found (CI drift gate)
  discoverPackages: boolean; // auto-discover isolated sub-packages (own lockfile)
  packages: string[]; // extra manifest dirs to always process (relative to root)
  updateWorkspaceMembers: boolean; // let the update pass rewrite workspace members' manifests
  limits: Record<string, string>; // targeted mode: package-name glob → semver range it must stay within
  moveTogether?: string[][]; // targeted mode: groups of package names that must stay on one version
  reportDir?: string; // write a run report here (flag/env only)
  compareTo?: string; // branch, tag or commit the deploy recommendation compares with (default: the last commit)
  alertsFile?: string; // targeted mode: read alerts from this file, with no token (flag/env only)
}

interface ConfigFile {
  repo?: string;
  packageManager?: PackageManagerId;
  workspaceRoot?: string;
  updateStrategy?: UpdateStrategy;
  allowPrerelease?: boolean;
  dryRun?: boolean;
  skipUpdate?: boolean;
  exitCode?: boolean;
  discoverPackages?: boolean;
  packages?: string[];
  updateWorkspaceMembers?: boolean;
  limits?: Record<string, string>;
  moveTogether?: string[][];
  compareTo?: string;
  token?: string; // not allowed — warned and ignored
}

interface LoadedConfig {
  config: ConfigFile;
  dir: string; // directory the config was loaded from (for relative workspaceRoot)
}

/**
 * Locate and parse a config file. Search order (first found wins):
 *   1. --config <path>  (explicit)
 *   2. dependabot-agent.config.json in the preliminary workspace root
 *   3. a "dependabot-agent" key in that root's package.json
 * Returns an empty config (rooted at preliminaryRoot) if none found.
 */
function loadConfigFile(explicitPath: string | undefined, preliminaryRoot: string): LoadedConfig {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!fs.existsSync(resolved)) exitWithError(`Config file not found: ${resolved}`);
    return { config: parseJsonFile(resolved), dir: path.dirname(resolved) };
  }

  const jsonPath = path.join(preliminaryRoot, "dependabot-agent.config.json");
  if (fs.existsSync(jsonPath)) {
    log(`🗂️  Loaded config from ${jsonPath}`);
    return { config: parseJsonFile(jsonPath), dir: preliminaryRoot };
  }

  const pkgJsonPath = path.join(preliminaryRoot, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    const pkg = parseJsonFile(pkgJsonPath) as Record<string, unknown>;
    const section = pkg["dependabot-agent"];
    if (section && typeof section === "object") {
      log(`🗂️  Loaded config from the "dependabot-agent" key in ${pkgJsonPath}`);
      return { config: section, dir: preliminaryRoot };
    }
  }

  return { config: {}, dir: preliminaryRoot };
}

function parseJsonFile(filePath: string): ConfigFile {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ConfigFile;
  } catch (e) {
    exitWithError(`Failed to parse config file ${filePath}: ${(e as Error).message}`);
  }
}

function envBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === "true";
}

/** Resolve the workspace root: flag > env > config (relative to config dir) > cwd. */
function resolveWorkspaceRoot(
  args: CliArgs,
  env: NodeJS.ProcessEnv,
  config: ConfigFile,
  configDir: string,
): string {
  if (args.workspaceRoot) return path.resolve(args.workspaceRoot);
  if (env.WORKSPACE_ROOT) return path.resolve(env.WORKSPACE_ROOT);
  if (config.workspaceRoot) return path.resolve(configDir, config.workspaceRoot);
  return process.cwd();
}

/**
 * Merge CLI args, env vars, config file, and defaults into a validated config.
 * Precedence (highest first): flags > env > config file > defaults.
 */
export function resolveConfig(args: CliArgs, env: NodeJS.ProcessEnv): ResolvedConfig {
  // Determine a preliminary root (flag > env > cwd) to locate the .env / config.
  const preliminaryRoot = path.resolve(args.workspaceRoot ?? env.WORKSPACE_ROOT ?? process.cwd());

  // Load <root>/.env into the environment first (without clobbering real env
  // vars), so secrets like GITHUB_TOKEN are picked up from the repo-root .env.
  loadEnvFile(preliminaryRoot, env);

  const { config, dir: configDir } = loadConfigFile(args.config, preliminaryRoot);

  if (config.token) {
    warn(`Ignoring "token" in config file — the GitHub token is read only from --token or GITHUB_TOKEN.`);
  }

  // Token: flags > env only (never config). `||` not `??` so an empty
  // `--token=` (or empty env) falls through instead of masking a real token.
  const token = args.token || env.GITHUB_TOKEN || "";

  // Repo: flags > env > config. `||` not `??` (matching token) so an empty
  // `--repo=` falls through to env/config instead of masking them.
  const repo = args.repo || env.GITHUB_REPO || config.repo || "";

  const workspaceRoot = resolveWorkspaceRoot(args, env, config, configDir);

  const packageManager = args.packageManager ?? parsePmEnv(env.PACKAGE_MANAGER) ?? config.packageManager;

  // Checked whatever else sets the strategy: an unknown one must never fall through
  // to a package manager's update, which is what the targeted strategy exists to avoid.
  const configStrategy = parseStrategyConfig(config.updateStrategy);
  const updateStrategy: UpdateStrategy =
    args.updateStrategy ?? parseStrategyEnv(env.UPDATE_STRATEGY) ?? configStrategy ?? "compatible";

  // Default false: the update pass follows the `latest` dist-tag, and a
  // maintainer publishing a release candidate without `--tag` moves that tag
  // onto a pre-release. Following it is an accident of how the tag was set, not
  // a choice anyone made, so opting in is the right way round.
  const allowPrerelease = args.allowPrerelease ?? envBool(env.ALLOW_PRERELEASE) ?? config.allowPrerelease ?? false;

  const dryRun = args.dryRun ?? envBool(env.DRY_RUN) ?? config.dryRun ?? false;
  const skipUpdate = args.skipUpdate ?? envBool(env.SKIP_UPDATE) ?? config.skipUpdate ?? false;
  const exitCode = args.exitCode ?? envBool(env.EXIT_CODE) ?? config.exitCode ?? false;

  // Monorepo / isolated-package discovery (config-file only).
  const discoverPackages = config.discoverPackages ?? true;
  const packages = config.packages ?? [];

  // Default true: a workspace member's manifest is a manifest like any other,
  // and leaving it out means a fixable direct dependency there can only ever be
  // patched with an override — the blunter of the two repairs, and one that
  // then contradicts what the member says it wants. Off is for the rare project
  // that wants members' versions moved by hand only.
  const updateWorkspaceMembers = config.updateWorkspaceMembers ?? true;

  // Targeted-mode version ceilings (config-file only). Validated up front so a
  // typo fails the run immediately instead of silently limiting nothing.
  const limits = parseLimits(config.limits);
  const moveTogether = parseMoveTogether(config.moveTogether);

  const reportDir = args.reportDir || env.REPORT_DIR || undefined;
  const compareTo = args.compareTo || env.COMPARE_TO || config.compareTo || undefined;

  if (Object.keys(limits).length > 0 && updateStrategy !== "targeted") {
    warn(`"limits" only applies with --update-strategy targeted — ignoring it under "${updateStrategy}".`);
  }
  if (moveTogether.length > 0 && updateStrategy !== "targeted") {
    warn(`"moveTogether" only applies with --update-strategy targeted — ignoring it under "${updateStrategy}".`);
  }
  const requestedAlertsFile = args.alertsFile || env.ALERTS_FILE || undefined;
  if (requestedAlertsFile && updateStrategy !== "targeted") {
    warn(`"--alerts-file" only applies with --update-strategy targeted — ignoring it under "${updateStrategy}".`);
  }
  const alertsFile = updateStrategy === "targeted" ? requestedAlertsFile : undefined;
  if (updateStrategy === "targeted" && skipUpdate) {
    warn(`"skipUpdate" has no effect with --update-strategy targeted (it never runs the bulk update).`);
  }
  if (updateStrategy === "targeted" && allowPrerelease) {
    warn(`"allowPrerelease" has no effect with --update-strategy targeted.`);
  }

  // Validate required fields with friendly, actionable messages.
  if (!token && !alertsFile) {
    exitWithError("GitHub token is required. Pass --token or set GITHUB_TOKEN.");
  }
  if (!repo.includes("/")) {
    exitWithError('Repository is required in "owner/repo" format. Pass --repo, set GITHUB_REPO, or add "repo" to your config file.');
  }

  const [owner, name] = repo.split("/");

  return {
    token,
    repo,
    owner,
    name,
    packageManager,
    workspaceRoot,
    updateStrategy,
    allowPrerelease,
    dryRun,
    skipUpdate,
    exitCode,
    discoverPackages,
    packages,
    updateWorkspaceMembers,
    limits,
    moveTogether,
    reportDir,
    compareTo,
    alertsFile,
  };
}

function parsePmEnv(value: string | undefined): PackageManagerId | undefined {
  if (value === undefined) return undefined;
  if (value !== "pnpm" && value !== "npm") {
    exitWithError(`Invalid PACKAGE_MANAGER: "${value}" (expected "pnpm" or "npm")`);
  }
  return value;
}

function parseStrategyConfig(value: unknown): UpdateStrategy | undefined {
  if (value === undefined) return undefined;
  if (value !== "compatible" && value !== "latest" && value !== "targeted") {
    exitWithError(`Invalid "updateStrategy" in the config file: ${JSON.stringify(value)} (expected "compatible", "latest" or "targeted")`);
  }
  return value;
}

/**
 * The config file's `limits`, which semver alone wouldn't catch: it reads a blank range
 * as "anything", and a value that isn't an object would otherwise limit nothing at all.
 */
function parseLimits(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    exitWithError(`Invalid "limits" in the config file: ${JSON.stringify(value)} is not an object mapping package names to semver ranges, such as {"@angular/*": "<22"}.`);
  }
  const limits = value as Record<string, unknown>;
  for (const [pattern, range] of Object.entries(limits)) {
    if (pattern.trim() === "") {
      exitWithError(`Invalid "limits" entry ${JSON.stringify(pattern)}: the package name or glob is empty.`);
    }
    if (typeof range !== "string" || range.trim() === "" || semver.validRange(range) === null) {
      exitWithError(`Invalid "limits" entry for "${pattern}": ${JSON.stringify(range)} is not a valid semver range.`);
    }
  }
  return limits as Record<string, string>;
}

/** The config file's `moveTogether`: a typo here would quietly hold nothing together, so it stops the run. */
function parseMoveTogether(value: unknown): string[][] {
  if (value === undefined) return [];
  const example = `such as [["@angular/ssr", "@angular/build"]]`;
  if (!Array.isArray(value)) {
    exitWithError(`Invalid "moveTogether" in the config file: ${JSON.stringify(value)} is not a list of groups of package names, ${example}.`);
  }
  for (const group of value as unknown[]) {
    const names = Array.isArray(group) ? group : [];
    if (names.length < 2 || names.some((name) => typeof name !== "string" || name.trim() === "")) {
      exitWithError(`Invalid "moveTogether" group ${JSON.stringify(group)}: each group needs at least two package names, ${example}.`);
    }
  }
  return value as string[][];
}

function parseStrategyEnv(value: string | undefined): UpdateStrategy | undefined {
  if (value === undefined) return undefined;
  if (value !== "compatible" && value !== "latest" && value !== "targeted") {
    exitWithError(`Invalid UPDATE_STRATEGY: "${value}" (expected "compatible", "latest" or "targeted")`);
  }
  return value;
}
