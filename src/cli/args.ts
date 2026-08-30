import { LOG_LEVELS, type LogLevel } from "../log/index.js";

/**
 * Arg parsing (cli.md §Invocation). Hand-rolled deliberately: the one subtle
 * rule — a bare path implies `run` — is easier to get right and to test here
 * than to bend a parser library around.
 *
 * **Resolution rule:** if the first positional matches a known subcommand it
 * is dispatched as that subcommand; otherwise it is the task-list path for
 * `run` (any UTF-8 text file — Markdown, `.txt`, YAML, …). A file literally
 * named `doctor` is disambiguated as `./doctor`.
 */
export const COMMANDS = [
  "run",
  "plan",
  "doctor",
  "config",
  "models",
  "resume",
  "runs",
  "help",
] as const;
export type Command = (typeof COMMANDS)[number];

/** Recognized so the error is useful, but not implemented until M2.8. */
export const UNIMPLEMENTED_COMMANDS: ReadonlySet<string> = new Set(["resume", "runs"]);

export interface RunFlags {
  plannerProvider?: string;
  plannerModel?: string;
  defaultProvider?: string;
  defaultModel?: string;
  dryRun: boolean;
  yes: boolean;
  planOut?: string;
  planIn?: string;
  maxTasks?: number;
  contextStrategy?: "link-only" | "truncate";
  contextBudget?: number;
  /** `--no-memory`: start every task blind, as before cross-task memory. */
  noMemory: boolean;
  memoryBudget?: number;
  /** `--group-size <n>`: max tasks per provider process. `1` = one each. */
  groupSize?: number;
  dangerouslyAllowAll: boolean;
  json: boolean;
  verbose: boolean;
  quiet: boolean;
  logLevel?: LogLevel;
  noColor: boolean;
  noProgress: boolean;
}

export interface ParsedArgs {
  command: Command;
  /** The task-list path for `run`/`plan` — any UTF-8 text file. */
  file: string | null;
  /** `--show` | `path` | `set` | wizard (undefined). */
  configAction?: "show" | "path" | "set" | "refresh-models";
  configKey?: string;
  configValue?: string;
  /** Optional provider filter for `models`. */
  modelsProvider?: string;
  flags: RunFlags;
  showVersion: boolean;
  errors: string[];
}

const VALUE_FLAGS = new Map<string, keyof RunFlags>([
  ["--planner-provider", "plannerProvider"],
  ["--planner-model", "plannerModel"],
  ["--default-provider", "defaultProvider"],
  ["--default-model", "defaultModel"],
  ["--plan-out", "planOut"],
  ["--plan-in", "planIn"],
]);

function emptyFlags(): RunFlags {
  return {
    dryRun: false,
    yes: false,
    noMemory: false,
    dangerouslyAllowAll: false,
    json: false,
    verbose: false,
    quiet: false,
    noColor: false,
    noProgress: false,
  };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = emptyFlags();
  const errors: string[] = [];
  const positionals: string[] = [];
  let showVersion = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const takeValue = (): string | undefined => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        errors.push(`${arg} requires a value`);
        return undefined;
      }
      index += 1;
      return next;
    };

    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    const valueFlag = VALUE_FLAGS.get(arg);
    if (valueFlag) {
      const value = takeValue();
      if (value !== undefined) {
        (flags as unknown as Record<string, unknown>)[valueFlag] = value;
      }
      continue;
    }

    switch (arg) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "-v":
      case "-V":
      case "--version":
        showVersion = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "-y":
      case "--yes":
        flags.yes = true;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--verbose":
        flags.verbose = true;
        break;
      case "--quiet":
        flags.quiet = true;
        break;
      case "--no-color":
        flags.noColor = true;
        break;
      case "--no-progress":
        flags.noProgress = true;
        break;
      case "--no-memory":
        flags.noMemory = true;
        break;
      case "--dangerously-allow-all":
        flags.dangerouslyAllowAll = true;
        break;
      case "--show":
        // `baya config --show`; harmless elsewhere, captured below.
        positionals.push("--show");
        break;
      case "--max-tasks": {
        const value = takeValue();
        if (value !== undefined) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isNaN(parsed) || parsed < 1)
            errors.push(`--max-tasks must be a positive integer`);
          else flags.maxTasks = parsed;
        }
        break;
      }
      case "--group-size": {
        const value = takeValue();
        if (value !== undefined) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isNaN(parsed) || parsed < 1)
            errors.push(`--group-size must be a positive integer`);
          else flags.groupSize = parsed;
        }
        break;
      }
      case "--memory-budget": {
        const value = takeValue();
        if (value !== undefined) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isNaN(parsed) || parsed < 0)
            errors.push(`--memory-budget must be a non-negative integer`);
          else flags.memoryBudget = parsed;
        }
        break;
      }
      case "--context-budget": {
        const value = takeValue();
        if (value !== undefined) {
          const parsed = Number.parseInt(value, 10);
          if (Number.isNaN(parsed) || parsed < 0)
            errors.push(`--context-budget must be a non-negative integer`);
          else flags.contextBudget = parsed;
        }
        break;
      }
      case "--context-strategy": {
        const value = takeValue();
        if (value === "link-only" || value === "truncate") flags.contextStrategy = value;
        else if (value !== undefined) {
          errors.push(
            `--context-strategy must be link-only or truncate (summarize is not in v1)`,
          );
        }
        break;
      }
      case "--log-level": {
        const value = takeValue();
        if (value !== undefined) {
          if ((LOG_LEVELS as readonly string[]).includes(value)) {
            flags.logLevel = value as LogLevel;
          } else {
            errors.push(`--log-level must be one of ${LOG_LEVELS.join(", ")}`);
          }
        }
        break;
      }
      default:
        errors.push(`unknown flag: ${arg}`);
    }
  }

  const first = positionals[0];
  const isCommand =
    first !== undefined && (COMMANDS as readonly string[]).includes(first);
  const command: Command = help
    ? "help"
    : isCommand
      ? (first as Command)
      : positionals.length === 0
        ? "help"
        : "run";

  const rest = isCommand ? positionals.slice(1) : positionals;

  const parsed: ParsedArgs = {
    command,
    file: command === "run" || command === "plan" ? (rest[0] ?? null) : null,
    flags,
    showVersion,
    errors,
  };

  if (command === "config") {
    const action = rest[0];
    if (action === "--show" || action === "show") parsed.configAction = "show";
    else if (action === "path") parsed.configAction = "path";
    else if (action === "refresh-models" || action === "refresh") {
      parsed.configAction = "refresh-models";
    } else if (action === "set") {
      parsed.configAction = "set";
      const key = rest[1];
      const value = rest[2];
      if (key === undefined || value === undefined) {
        errors.push("config set requires <key> <value>");
      } else {
        parsed.configKey = key;
        parsed.configValue = value;
      }
    } else if (action !== undefined) {
      errors.push(`unknown config action: ${action}`);
    }
  }

  if (command === "models" && rest[0] !== undefined) parsed.modelsProvider = rest[0];

  // `plan` is exactly `run --dry-run` (cli.md §Commands).
  if (command === "plan") parsed.flags.dryRun = true;

  return parsed;
}
