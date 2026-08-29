#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  binOverrides,
  loadConfig,
  readUserConfig,
  setConfigValue,
  userConfigPath,
  writeConfigFile,
  type ConfigFile,
} from "../config/index.js";
import { PROVIDER_IDS, type ProviderId } from "../manifest/index.js";
import {
  BUILTIN_CATALOG,
  catalogToPersist,
  createDefaultRegistry,
  enumerateModels,
  mergeCatalog,
  withoutBuiltinEntries,
  type Registry,
} from "../providers/index.js";
import { renderBanner } from "../ui/banner.js";
import { createTheme } from "../ui/theme.js";
import { UNIMPLEMENTED_COMMANDS, parseArgs } from "./args.js";
import { doctor } from "./doctor.js";
import { renderHelp } from "./help.js";
import { runCommand, type CliIo } from "./run.js";

/**
 * Command routing and exit codes (cli.md §Exit codes):
 * `0` success · `1` a task failed · `2` validation/setup error · `130` SIGINT.
 *
 * Every path returns a code rather than calling `process.exit`, so the whole
 * CLI is callable from a test without tearing down the runner.
 */
export interface MainOptions {
  argv?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: Partial<CliIo>;
  registry?: Registry;
}

/**
 * The banner is chrome for a person at a terminal. Suppress it whenever the
 * caller has signalled machine or minimal output: `--json`, `--version`,
 * `--quiet`. Everything else — `run`, `plan`, `help`, `doctor`, `config` —
 * gets it.
 */
function shouldShowBanner(args: ReturnType<typeof parseArgs>): boolean {
  return !args.showVersion && !args.flags.json && !args.flags.quiet;
}

function version(): string {
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    );
    return String((pkg as { version?: string }).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export async function main(options: MainOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const registry = options.registry ?? createDefaultRegistry();
  const io: CliIo = {
    stdout: options.io?.stdout ?? process.stdout,
    stderr: options.io?.stderr ?? process.stderr,
    stdinIsTty: options.io?.stdinIsTty ?? process.stdin.isTTY === true,
    stdoutIsTty: options.io?.stdoutIsTty ?? process.stdout.isTTY === true,
  };

  const args = parseArgs(argv);
  const theme = createTheme(args.flags.noColor || env["NO_COLOR"] ? "never" : "auto");

  // The wordmark leads every human-facing run. Kept off stdout (and skipped
  // entirely for `--json` / `--version` / `--quiet`) so scripted callers get a
  // clean stream; see `shouldShowBanner`.
  if (shouldShowBanner(args)) {
    io.stderr.write(renderBanner(theme));
  }

  if (args.errors.length > 0) {
    for (const error of args.errors) {
      io.stderr.write(`${theme.status("fail")} ${theme.fail(error)}\n`);
    }
    return 2;
  }

  if (args.showVersion) {
    io.stdout.write(`${version()}\n`);
    return 0;
  }

  try {
    switch (args.command) {
      case "help": {
        // Probed, not skipped: the version is half of what makes the provider
        // block a first-line sanity check, and `<bin> --version` costs ~20ms
        // per adapter with the probes running concurrently.
        //
        // A broken config must not take help down with it — help is the one
        // command that has to work when everything else is misconfigured, so
        // an unreadable config costs the overrides, not the output.
        let overrides: Partial<Record<ProviderId, string>> = {};
        try {
          overrides = binOverrides(loadConfig({ cwd, env }).config);
        } catch {
          overrides = {};
        }
        const statuses = await registry.resolveAll({ binOverrides: overrides, env });
        io.stdout.write(renderHelp(statuses, theme));
        return 0;
      }

      case "doctor": {
        // The config override is the first link of the resolution chain, so
        // `doctor` must consult it — otherwise it reports "not found" for a
        // provider the very next run would resolve.
        const report = await doctor({
          registry,
          cwd,
          theme,
          env,
          binOverrides: binOverrides(loadConfig({ cwd, env }).config),
        });
        io.stdout.write(`${report.text}\n`);
        return report.exitCode;
      }

      case "config":
        return await configCommand(args, { env, cwd, io, theme, registry });

      case "models":
        return modelsCommand(args, { env, cwd, io, theme });

      case "resume":
      case "runs":
        io.stderr.write(
          `${theme.status("fail")} ${theme.fail(`\`baya ${args.command}\` is not available yet — it lands with run recovery (M2.8).`)}\n`,
        );
        return 2;

      case "run":
      case "plan":
        return await runCommand({ args, cwd, env, io, registry });
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      io.stderr.write(`${theme.status("fail")} ${theme.fail(err.message)}\n`);
      return 2;
    }
    io.stderr.write(`${theme.status("fail")} ${theme.fail((err as Error).message)}\n`);
    return 2;
  }
}

/**
 * `baya models` (cli.md §Commands) — the catalog a run resolves task-named
 * models against: `BUILTIN_CATALOG` with the config's `modelCatalog` merged on
 * top (higher layers win by entry `id`), grouped by provider, optionally
 * narrowed to one. Every row is tagged `built-in` or `user`: an entry that
 * differs from — or has no — shipped definition of the same id is exactly what
 * `withoutBuiltinEntries` keeps, so "why did `luna` resolve to codex?" is
 * answerable without opening the file. Same `theme.note` / padded-column style
 * as `config --show`.
 */
function modelsCommand(
  args: ReturnType<typeof parseArgs>,
  ctx: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    io: CliIo;
    theme: ReturnType<typeof createTheme>;
  },
): number {
  const { io, theme } = ctx;

  const filter = args.modelsProvider;
  if (filter !== undefined && !(PROVIDER_IDS as readonly string[]).includes(filter)) {
    const msg = `unknown provider: ${filter} — expected one of ${PROVIDER_IDS.join(", ")}`;
    io.stderr.write(`${theme.status("fail")} ${theme.fail(msg)}\n`);
    return 2;
  }

  const loaded = loadConfig({ cwd: ctx.cwd, env: ctx.env });
  const effective = mergeCatalog(BUILTIN_CATALOG, loaded.config.modelCatalog);
  if (args.flags.json) {
    const catalog =
      filter === undefined
        ? effective
        : { [filter]: effective[filter as ProviderId] ?? [] };
    io.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
    return 0;
  }

  // Entries that differ from the built-in of the same id, or have no built-in
  // at all — everything a person put in the config, and nothing else.
  const authored = withoutBuiltinEntries(effective);

  const providers = (filter ? [filter as ProviderId] : [...PROVIDER_IDS]).filter(
    (id) => (effective[id] ?? []).length > 0,
  );

  const lines = ["", `  ${theme.taskId("Models")}`];
  if (providers.length === 0) {
    lines.push("", `  ${theme.note("no models in the catalog")}`);
  }
  for (const id of providers) {
    const models = effective[id] ?? [];
    const authoredIds = new Set((authored[id] ?? []).map((model) => model.id));
    const rows = models.map((model) => ({
      id: model.id,
      aliases: model.aliases.join(", "),
      description: model.description,
      tag: authoredIds.has(model.id) ? "user" : "built-in",
    }));
    const idWidth = Math.max(...rows.map((row) => row.id.length));
    const aliasWidth = Math.max(0, ...rows.map((row) => row.aliases.length));
    const descWidth = Math.max(0, ...rows.map((row) => row.description.length));
    lines.push("", `  ${theme.provider(id)}`);
    for (const row of rows) {
      const cells = `${row.id.padEnd(idWidth)}  ${row.aliases.padEnd(aliasWidth)}  ${row.description.padEnd(descWidth)}`;
      lines.push(`    ${cells}  ${theme.note(row.tag)}`);
    }
  }
  lines.push("", `  ${theme.note("user config")}    ${loaded.userPath}`, "");
  io.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function configCommand(
  args: ReturnType<typeof parseArgs>,
  ctx: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    io: CliIo;
    theme: ReturnType<typeof createTheme>;
    registry: Registry;
  },
): Promise<number> {
  const { io, theme } = ctx;

  if (args.configAction === "path") {
    io.stdout.write(`${userConfigPath(ctx.env)}\n`);
    return 0;
  }

  if (args.configAction === "set") {
    const path = setConfigValue(
      args.configKey as string,
      args.configValue as string,
      ctx.env,
    );
    io.stderr.write(`  set ${args.configKey} = ${args.configValue} in ${path}\n`);
    return 0;
  }

  if (args.configAction === "refresh-models") {
    const loaded = loadConfig({ cwd: ctx.cwd, env: ctx.env });
    const oc = await ctx.registry.resolve("opencode", {
      binOverrides: binOverrides(loaded.config),
      env: ctx.env,
      probe: false,
    });
    const ids = oc ? await enumerateModels(oc.bin) : [];

    // Only what the config alone can't reproduce: the live `opencode` list and
    // the user's own entries. `BUILTIN_CATALOG` ships in the binary — writing a
    // copy of it would freeze today's built-in lists into the file, and a stale
    // copy already there is migrated out here (catalog.ts §withoutBuiltinEntries).
    const stored = readUserConfig(ctx.env);
    const persisted = catalogToPersist(stored.modelCatalog, ids);
    const next: ConfigFile = { ...stored };
    if (Object.keys(persisted).length > 0) next.modelCatalog = persisted;
    else delete next.modelCatalog;
    const path = userConfigPath(ctx.env);
    writeConfigFile(path, next);

    // Counts describe the catalog a run will resolve against — built-ins
    // included — not the file's now-smaller subset.
    const counts = Object.entries(mergeCatalog(BUILTIN_CATALOG, persisted))
      .map(([id, models]) => `${id} ${models.length}`)
      .join(" · ");
    let warning = "";
    if (ids.length === 0) {
      warning = theme.warn(
        oc
          ? "  (opencode listed no models — kept the stored entries)"
          : "  (opencode not found — kept the stored entries)",
      );
    }
    io.stderr.write(
      `  refreshed model catalog in ${path}\n  ${theme.note(counts)}${warning}\n`,
    );
    return 0;
  }

  // Default and `--show` both print the resolved config; naming the source
  // layer of every value is the whole point — otherwise "why is it using
  // codex?" has no answer short of reading four files.
  const loaded = loadConfig({ cwd: ctx.cwd, env: ctx.env });
  const rows: Array<[string, string]> = [
    ["defaults.provider", String(loaded.config.defaults.provider)],
    ["defaults.model", String(loaded.config.defaults.model)],
    ["planner.provider", String(loaded.config.planner.provider)],
    ["planner.model", String(loaded.config.planner.model)],
  ];
  const lines = ["", `  ${theme.taskId("Config")}`];
  for (const [key, value] of rows) {
    lines.push(
      `    ${key.padEnd(18)} ${value.padEnd(12)} ${theme.note(`from ${loaded.sources[key] ?? "built-in"}`)}`,
    );
  }
  for (const [id, settings] of Object.entries(loaded.config.providers)) {
    for (const [key, value] of Object.entries(settings)) {
      const dotted = `providers.${id}.${key}`;
      lines.push(
        `    ${dotted.padEnd(18)} ${String(value).padEnd(12)} ${theme.note(`from ${loaded.sources[dotted] ?? "built-in"}`)}`,
      );
    }
  }
  for (const [name, target] of Object.entries(loaded.config.modelAliases)) {
    const dotted = `modelAliases.${name}`;
    lines.push(
      `    ${dotted.padEnd(18)} ${target.padEnd(12)} ${theme.note(`from ${loaded.sources[dotted] ?? "built-in"}`)}`,
    );
  }
  // The catalog a run resolves against — built-in lists plus the config's own
  // entries. Counting only the config layer would read as "3 models" for an
  // install that resolves twenty.
  const resolvable = mergeCatalog(BUILTIN_CATALOG, loaded.config.modelCatalog);
  const catalogCounts = Object.entries(resolvable)
    .map(([id, models]) => `${id}:${models.length}`)
    .join(" ");
  if (catalogCounts) {
    lines.push(
      `    ${"modelCatalog".padEnd(18)} ${theme.note(`${catalogCounts} — \`baya config refresh-models\` to update`)}`,
    );
  }
  lines.push("", `  ${theme.note("user config")}    ${loaded.userPath}`, "");
  io.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

export { UNIMPLEMENTED_COMMANDS };
