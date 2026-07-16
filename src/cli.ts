import { PackageManagerId, UpdateStrategy } from "./types.js";
import { exitWithError } from "./util.js";

/**
 * Parsed CLI args. Every field is optional so the config layer can distinguish
 * "not passed" from "explicitly false" when merging with env/config/defaults.
 */
export interface CliArgs {
  token?: string;
  repo?: string;
  packageManager?: PackageManagerId;
  workspaceRoot?: string;
  updateStrategy?: UpdateStrategy;
  dryRun?: boolean;
  skipUpdate?: boolean;
  exitCode?: boolean;
  config?: string;
}

const USAGE = `dependabot-agent — reconcile package-manager overrides with GitHub Dependabot alerts

Usage:
  dependabot-agent [options]

Options:
  --token <token>                  GitHub token (or env GITHUB_TOKEN). Required.
  --repo <owner/repo>              Target repository (or env GITHUB_REPO). Required.
  --package-manager <pnpm|npm>     Override auto-detection (or env PACKAGE_MANAGER).
  --workspace-root <path>          Project root (or env WORKSPACE_ROOT). Default: cwd.
  --update-strategy <compatible|latest>
                                   Pre-check update mode (or env UPDATE_STRATEGY).
                                   Default: compatible (does not cross majors).
  --dry-run                        Print planned changes without writing (or DRY_RUN=true).
  --skip-update                    Skip the dependency update step (or SKIP_UPDATE=true).
  --exit-code                      Exit 2 if any override changes are found (or EXIT_CODE=true).
                                   Pair with --dry-run in CI to fail on override drift.
  --config <path>                  Path to a config file (JSON).
  -h, --help                       Show this help and exit.
  -v, --version                    Show version and exit.

The GitHub token is read only from --token or GITHUB_TOKEN — never from a config file.`;

function expectValue(flag: string, value: string | undefined): string {
  if (value === undefined) exitWithError(`Missing value for ${flag}\n\n${USAGE}`);
  return value;
}

function parsePackageManager(flag: string, value: string): PackageManagerId {
  if (value !== "pnpm" && value !== "npm") {
    exitWithError(`Invalid value for ${flag}: "${value}" (expected "pnpm" or "npm")`);
  }
  return value;
}

function parseUpdateStrategy(flag: string, value: string): UpdateStrategy {
  if (value !== "compatible" && value !== "latest") {
    exitWithError(`Invalid value for ${flag}: "${value}" (expected "compatible" or "latest")`);
  }
  return value;
}

/**
 * Hand-rolled arg parser (zero deps). Supports `--flag value`, `--flag=value`,
 * and bare booleans. Handles --help/--version directly (exits). Errors on
 * unknown flags.
 */
export function parseArgs(argv: string[], version: string): CliArgs {
  const args: CliArgs = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    // Split `--flag=value` into flag + inline value.
    let flag = arg;
    let inlineValue: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq !== -1) {
      flag = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }

    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      return expectValue(flag, argv[++i]);
    };

    switch (flag) {
      case "--token":
        args.token = takeValue();
        break;
      case "--repo":
        args.repo = takeValue();
        break;
      case "--package-manager":
        args.packageManager = parsePackageManager(flag, takeValue());
        break;
      case "--workspace-root":
        args.workspaceRoot = takeValue();
        break;
      case "--update-strategy":
        args.updateStrategy = parseUpdateStrategy(flag, takeValue());
        break;
      case "--config":
        args.config = takeValue();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--skip-update":
        args.skipUpdate = true;
        break;
      case "--exit-code":
        args.exitCode = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      case "-v":
      case "--version":
        console.log(version);
        process.exit(0);
        break;
      default:
        exitWithError(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  return args;
}
