import * as fs from "node:fs";
import * as path from "node:path";
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
  dryRun: boolean;
  skipUpdate: boolean;
  discoverPackages: boolean; // auto-discover isolated sub-packages (own lockfile)
  packages: string[]; // extra manifest dirs to always process (relative to root)
}

interface ConfigFile {
  repo?: string;
  packageManager?: PackageManagerId;
  workspaceRoot?: string;
  updateStrategy?: UpdateStrategy;
  dryRun?: boolean;
  skipUpdate?: boolean;
  discoverPackages?: boolean;
  packages?: string[];
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

  // Repo: flags > env > config.
  const repo = args.repo ?? env.GITHUB_REPO ?? config.repo ?? "";

  const workspaceRoot = resolveWorkspaceRoot(args, env, config, configDir);

  const packageManager = args.packageManager ?? parsePmEnv(env.PACKAGE_MANAGER) ?? config.packageManager;

  const updateStrategy: UpdateStrategy =
    args.updateStrategy ?? parseStrategyEnv(env.UPDATE_STRATEGY) ?? config.updateStrategy ?? "compatible";

  const dryRun = args.dryRun ?? envBool(env.DRY_RUN) ?? config.dryRun ?? false;
  const skipUpdate = args.skipUpdate ?? envBool(env.SKIP_UPDATE) ?? config.skipUpdate ?? false;

  // Monorepo / isolated-package discovery (config-file only).
  const discoverPackages = config.discoverPackages ?? true;
  const packages = config.packages ?? [];

  // Validate required fields with friendly, actionable messages.
  if (!token) {
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
    dryRun,
    skipUpdate,
    discoverPackages,
    packages,
  };
}

function parsePmEnv(value: string | undefined): PackageManagerId | undefined {
  if (value === undefined) return undefined;
  if (value !== "pnpm" && value !== "npm") {
    exitWithError(`Invalid PACKAGE_MANAGER: "${value}" (expected "pnpm" or "npm")`);
  }
  return value;
}

function parseStrategyEnv(value: string | undefined): UpdateStrategy | undefined {
  if (value === undefined) return undefined;
  if (value !== "compatible" && value !== "latest") {
    exitWithError(`Invalid UPDATE_STRATEGY: "${value}" (expected "compatible" or "latest")`);
  }
  return value;
}
