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
} from "../config/index.js";
import type { ProviderId } from "../manifest/index.js";
import {
  BUILTIN_CATALOG,
  createDefaultRegistry,
  enumerateModels,
  mergeCatalog,
  opencodeCatalog,
  type Registry,
} from "../providers/index.js";
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
    const catalog = mergeCatalog(
      BUILTIN_CATALOG,
      ids.length > 0 ? { opencode: opencodeCatalog(ids) } : undefined,
    );
    const path = userConfigPath(ctx.env);
    writeConfigFile(path, { ...readUserConfig(ctx.env), modelCatalog: catalog });
    const counts = Object.entries(catalog)
      .map(([id, models]) => `${id} ${models.length}`)
      .join(" · ");
    io.stderr.write(
      `  refreshed model catalog in ${path}\n  ${theme.note(counts)}${oc ? "" : theme.warn("  (opencode not found — built-in lists only)")}\n`,
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
  const catalogCounts = Object.entries(loaded.config.modelCatalog)
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
