import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  validateManifest,
  writePlanDraftSchema,
  writeTaskResultSchema,
  type Manifest,
  type ProviderId,
} from "../manifest/index.js";
import {
  createLogger,
  resolveStderrLevel,
  type LogLine,
  type Logger,
} from "../log/index.js";
import { FileLock } from "../lock/index.js";
import {
  plan as planMarkdown,
  readSource,
  runPlannerProvider,
} from "../planner/index.js";
import type { Registry } from "../providers/index.js";
import {
  StateStore,
  emptyTaskEntry,
  killGroup,
  makeRunId,
  runPaths,
  runSequential,
  type RunState,
} from "../executor/index.js";
import {
  buildReport,
  confirmPlan,
  createEventRenderer,
  createProgress,
  exitCodeFor,
  renderDag,
  renderReport,
  type Progress,
} from "../ui/index.js";
import { createTheme } from "../ui/theme.js";
import {
  loadConfig,
  nonInteractiveDefault,
  runWizard,
  wizardDecision,
} from "../config/index.js";
import type { ParsedArgs } from "./args.js";
import { createInterruptHandler } from "./interrupt.js";

/**
 * `baya run` — the walking skeleton's spine.
 *
 * Order matters and is not arbitrary: config, then the directory lock, then
 * planning. The lock comes **before** planning because planning spends real
 * credits, and two Bayas in one tree must not both pay for it.
 */
export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}

export interface RunCommandOptions {
  args: ParsedArgs;
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  registry: Registry;
}

const CONTEXT_BUDGET_DEFAULT = 12_000;

export async function runCommand(options: RunCommandOptions): Promise<number> {
  const { args, cwd, env, io, registry } = options;
  const { flags } = args;
  const theme = createTheme(flags.noColor || env["NO_COLOR"] ? "never" : "auto");

  const progress: Progress = createProgress({
    stream: io.stderr,
    disabled: flags.noProgress,
    json: flags.json,
    env,
  });
  // Every persistent write funnels through progress so the spinner line is
  // cleared and repainted around it (conventions.md #16b).
  const stderrSink = {
    write(chunk: string | Uint8Array): boolean {
      progress.write(String(chunk).replace(/\n$/, ""));
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  const loaded = loadConfig({
    cwd,
    env,
    flags: {
      defaultProvider: flags.defaultProvider,
      defaultModel: flags.defaultModel,
      plannerProvider: flags.plannerProvider,
      plannerModel: flags.plannerModel,
    },
  });

  const binOverrides: Partial<Record<ProviderId, string>> = Object.fromEntries(
    Object.entries(loaded.config.providers)
      .filter(([, settings]) => settings.bin !== undefined)
      .map(([id, settings]) => [id, settings.bin as string]),
  );

  const statuses = await registry.resolveAll({ binOverrides, env, probe: false });

  // ---- provider selection: wizard, or an explicit non-interactive fallback
  let defaultProvider = loaded.config.defaults.provider;
  let defaultModel = loaded.config.defaults.model;
  let plannerProvider = loaded.config.planner.provider;
  let plannerModel = loaded.config.planner.model;
  const startupWarnings: string[] = [];

  if (defaultProvider === null) {
    const decision = wizardDecision({
      command: flags.dryRun ? "plan" : "run",
      userConfigExists: loaded.userConfigExists,
      stdinIsTty: io.stdinIsTty,
      stdoutIsTty: io.stdoutIsTty,
      providerFlagGiven: flags.defaultProvider !== undefined,
      yes: flags.yes,
      env,
    });

    if (decision.run) {
      progress.stop();
      const result = await runWizard({ statuses, configPath: loaded.userPath });
      defaultProvider = result.provider;
      defaultModel = result.model;
      plannerProvider = result.provider;
      plannerModel = result.model;
      io.stderr.write(`  saved defaults to ${result.configPath}\n`);
    } else {
      const outcome = nonInteractiveDefault(statuses);
      if (outcome.kind === "error") {
        io.stderr.write(`${theme.status("fail")} ${outcome.message}\n`);
        return 2;
      }
      defaultProvider = outcome.provider;
      startupWarnings.push(outcome.warning);
    }
  }
  plannerProvider ??= defaultProvider;

  // ---- run identity and the directory lock
  const runId = makeRunId();
  const paths = runPaths(cwd, runId);
  mkdirSync(paths.runDir, { recursive: true });

  const renderLine = createEventRenderer({ theme, quiet: flags.quiet });
  const logger: Logger = createLogger({
    runId,
    traceFile: paths.log,
    stderrLevel: resolveStderrLevel({
      ...(flags.logLevel ? { logLevel: flags.logLevel } : {}),
      verbose: flags.verbose,
      quiet: flags.quiet,
    }),
    stderrStream: flags.json ? nullStream() : stderrSink,
    render: (line: LogLine) => {
      const rendered = renderLine(line);
      return rendered === null ? null : `${rendered}\n`;
    },
  });

  logger.info("cli.invoked", { argv: process.argv.slice(2), cwd, run_id: runId });
  logger.debug("config.loaded", {
    sources: loaded.sources,
    user_config: loaded.userPath,
  });
  for (const warning of startupWarnings)
    logger.warn("config.default.inferred", { message: warning });
  for (const status of statuses) {
    if (status.resolved) {
      logger.debug("provider.resolved", {
        provider: status.id,
        bin: status.resolved.bin,
        source: status.resolved.source,
      });
    } else {
      logger.debug("provider.missing", { provider: status.id });
    }
  }

  const lock = new FileLock(paths.lockFile, { owner: runId, logger });
  const acquired = lock.acquire();
  if (!acquired.ok) {
    progress.dispose();
    const holder = acquired.holder;
    logger.error("lock.refused", {
      path: paths.lockFile,
      holder_pid: holder?.pid ?? null,
      holder_run: holder?.owner ?? null,
      verdict: acquired.verdict,
    });
    io.stderr.write(
      holder
        ? `${theme.status("fail")} ${theme.fail("another baya is already running in this directory")}\n    pid ${holder.pid} · run ${holder.owner} · started ${Math.round((Date.now() - holder.acquiredAt) / 1000)}s ago\n`
        : `${theme.status("fail")} ${theme.fail(`unreadable lock file at ${paths.lockFile} — delete it by hand (see \`baya doctor\`)`)}\n`,
    );
    return 2;
  }
  logger.debug("lock.acquired", { path: paths.lockFile });

  const activePids = new Set<number>();
  let interrupted = false;
  let store: StateStore | null = null;

  const onSigint = createInterruptHandler({
    progress,
    logger,
    activePids: () => activePids,
    killGroup,
    checkpointInterrupted: () => {
      interrupted = true;
      store?.setStatus("interrupted");
    },
    releaseLock: () => lock.release(),
    exit: (code) => process.exit(code),
  });
  process.on("SIGINT", onSigint);

  try {
    const schemaPath = writeTaskResultSchema(paths.schemaDir);
    const planSchemaPath = writePlanDraftSchema(paths.schemaDir);

    // ---- plan
    let manifest: Manifest;
    let planOrigin: "planner" | "fallback" | "file" = "planner";

    if (flags.planIn) {
      const parsed: unknown = JSON.parse(
        readFileSync(resolvePath(cwd, flags.planIn), "utf8"),
      );
      const validated = validateManifest(parsed, {
        allowlist: registry.ids,
        ...(flags.maxTasks !== undefined ? { maxTasks: flags.maxTasks } : {}),
      });
      if (!validated.ok) {
        for (const error of validated.errors) {
          logger.error("plan.validation.failed", { message: error.message });
          io.stderr.write(`${theme.status("fail")} ${theme.fail(error.message)}\n`);
        }
        return 2;
      }
      manifest = validated.manifest;
      planOrigin = "file";
      logger.info("plan.validated", { tasks: manifest.tasks.length, origin: "plan-in" });
    } else {
      if (args.file === null) {
        io.stderr.write(
          `${theme.status("fail")} ${theme.fail("no task list given. Try `baya ./tasks.md`.")}\n`,
        );
        return 2;
      }
      const sourcePath = resolvePath(cwd, args.file);
      let read: ReturnType<typeof readSource>;
      try {
        read = readSource(sourcePath);
      } catch {
        io.stderr.write(
          `${theme.status("fail")} ${theme.fail(`cannot read ${sourcePath}`)}\n`,
        );
        return 2;
      }
      logger.info("source.read", {
        path: sourcePath,
        bytes: Buffer.byteLength(read.markdown, "utf8"),
        sha256: read.source.sha256,
      });

      const plannerAdapter = registry.get(plannerProvider as ProviderId);
      const plannerResolved = plannerAdapter
        ? await registry.resolve(plannerProvider as ProviderId, {
            binOverrides,
            env,
            probe: false,
          })
        : null;
      if (!plannerAdapter || !plannerResolved) {
        io.stderr.write(
          `${theme.status("fail")} ${theme.fail(`planner provider "${String(plannerProvider)}" is not available — run \`baya doctor\``)}\n`,
        );
        return 2;
      }

      progress.start(`planning with ${plannerProvider}…`);
      const planned = await planMarkdown({
        markdown: read.markdown,
        source: read.source,
        runner: runPlannerProvider({
          adapter: plannerAdapter,
          bin: plannerResolved.bin,
          cwd,
          model: plannerModel,
          schemaPath: planSchemaPath,
          resultFile: `${paths.runDir}/plan-draft.json`,
          runId,
          logger,
          env,
        }),
        logger,
        providers: registry.ids,
        defaultProvider: defaultProvider as ProviderId,
        schemaPath: planSchemaPath,
        ...(flags.maxTasks !== undefined ? { maxTasks: flags.maxTasks } : {}),
      });
      progress.stop();
      manifest = planned.manifest;
      planOrigin = planned.origin;
    }

    writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    if (flags.planOut) {
      const target = resolvePath(cwd, flags.planOut);
      writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      io.stderr.write(`  wrote ${target}\n`);
      return 0;
    }

    // ---- the gate
    progress.stop();
    io.stderr.write(
      `\n  ${theme.taskId("baya")} · ${manifest.source.path} · ${manifest.tasks.length} tasks · ${theme.provider(String(defaultProvider))}${planOrigin === "fallback" ? theme.warn(" · linear fallback") : ""}\n\n`,
    );
    io.stderr.write(`${renderDag(manifest, theme)}\n\n`);

    if (flags.dryRun) {
      logger.info("run.completed", { dry_run: true, tasks: manifest.tasks.length });
      return 0;
    }

    const gate = await confirmPlan({
      yes: flags.yes,
      stdinIsTty: io.stdinIsTty,
      beforePrompt: () => progress.stop(),
    });
    if (gate.decision === "blocked") {
      logger.warn("plan.rejected", { reason: "non-tty" });
      io.stderr.write(`${theme.status("fail")} ${theme.fail(gate.message)}\n`);
      return 2;
    }
    if (gate.decision === "rejected") {
      logger.info("plan.rejected", { reason: "declined" });
      return 0;
    }
    logger.info("plan.confirmed", { tasks: manifest.tasks.length });

    // ---- execute
    const initialState: RunState = {
      version: 1,
      run_id: runId,
      status: "running",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source: manifest.source,
      manifest_path: paths.manifest,
      config_snapshot: {
        planner: { provider: plannerProvider, model: plannerModel },
        defaults: { provider: defaultProvider, model: defaultModel },
        max_parallel: 1,
        isolation: "shared",
        context_strategy: flags.contextStrategy ?? "link-only",
        context_budget: flags.contextBudget ?? CONTEXT_BUDGET_DEFAULT,
      },
      totals: {
        succeeded: 0,
        failed: 0,
        skipped: 0,
        parked: 0,
        pending: manifest.tasks.length,
        running: 0,
        cost_usd: 0,
      },
      tasks: Object.fromEntries(
        manifest.tasks.map((task) => [
          task.id,
          emptyTaskEntry({ provider: task.provider, model: task.model }),
        ]),
      ),
    };
    store = new StateStore(paths.state, initialState, () =>
      logger.trace("state.checkpointed", { path: paths.state }),
    );
    logger.info("run.created", { run_id: runId, source: manifest.source.path });

    const summaries = new Map<string, string>();
    const singleTask = manifest.tasks.length === 1;

    await runSequential({
      manifest,
      cwd,
      paths,
      registry,
      logger,
      store,
      schemaPath,
      defaultProvider: defaultProvider as ProviderId,
      defaultModel,
      binOverrides,
      contextStrategy: flags.contextStrategy ?? "link-only",
      contextBudget: flags.contextBudget ?? CONTEXT_BUDGET_DEFAULT,
      env,
      ...(flags.dangerouslyAllowAll ? { dangerouslyAllowAll: true } : {}),
      onTaskSettled: (taskId, _state, result) => {
        summaries.set(taskId, result.summary);
        // Full output would bury everything in a multi-task run; it is printed
        // only when there is one task, or the user asked for --verbose.
        if (
          (singleTask || flags.verbose) &&
          !flags.quiet &&
          result.output.trim() !== ""
        ) {
          progress.write(`\n${result.output.trim()}\n`);
        }
      },
    });

    store.setStatus(store.get().totals.failed > 0 ? "failed" : "completed");
    const state = store.get() as RunState;
    const report = buildReport(state, manifest, {
      outputsPath: `${paths.runDir}/tasks/<id>/output.md`,
      summaries,
    });
    writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    logger.info(state.totals.failed > 0 ? "run.failed" : "run.completed", {
      succeeded: state.totals.succeeded,
      failed: state.totals.failed,
      skipped: state.totals.skipped,
      parked: state.totals.parked,
      cost_usd: state.totals.cost_usd,
    });

    progress.stop();
    if (flags.json) {
      // Forced ANSI-free: `baya x.md --json | jq` must work from inside a TTY.
      io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      io.stderr.write(`${renderReport(report, theme)}\n`);
    }

    return interrupted ? 130 : exitCodeFor(state);
  } finally {
    process.removeListener("SIGINT", onSigint);
    progress.dispose();
    lock.release();
  }
}

function nullStream(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
}
