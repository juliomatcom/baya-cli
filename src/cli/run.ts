import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { resolve as resolvePath } from "node:path";
import {
  validateManifest,
  writePlanDraftSchema,
  writeTaskResultBatchSchema,
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
import { DEFAULT_MEMORY_BUDGET } from "../memory/index.js";
import {
  checkTaskText,
  plan as planTaskList,
  readSource,
  runPlannerProvider,
} from "../planner/index.js";
import {
  BUILTIN_CATALOG,
  enumerateModels,
  mergeCatalog,
  opencodeCatalog,
  type Registry,
} from "../providers/index.js";
import {
  DEFAULT_GROUP_SIZE,
  DEFAULT_RETRIES,
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
  resolveRunModel,
  runModelGate,
  type Progress,
} from "../ui/index.js";
import { createTheme } from "../ui/theme.js";
import {
  binOverrides as binOverridesFrom,
  loadConfig,
  nonInteractiveDefault,
  runWizard,
  wizardDecision,
} from "../config/index.js";
import type { ParsedArgs } from "./args.js";
import { createInterruptHandler } from "./interrupt.js";
import { createGroupSpinner } from "./spinner.js";

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
const MEMORY_BUDGET_DEFAULT = DEFAULT_MEMORY_BUDGET;

export async function runCommand(options: RunCommandOptions): Promise<number> {
  const { args, cwd, env, io, registry } = options;
  const { flags } = args;
  const maxParallel = flags.maxParallel ?? Math.min(4, cpus().length);
  const theme = createTheme(flags.noColor || env["NO_COLOR"] ? "never" : "auto");

  const progress: Progress = createProgress({
    stream: io.stderr,
    disabled: flags.noProgress,
    json: flags.json,
    env,
  });
  const spinner = createGroupSpinner({ progress, theme });
  const stopTicker = spinner.dispose;

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

  const binOverrides = binOverridesFrom(loaded.config);

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
      // Build the catalog once: hardcoded lists + whatever `opencode models`
      // returns. The wizard shows it and caches it into the user config so
      // later runs resolve model names without any probe.
      const opencodeBin = statuses.find((s) => s.id === "opencode")?.resolved?.bin;
      const opencodeIds = opencodeBin ? await enumerateModels(opencodeBin) : [];
      const wizardCatalog = mergeCatalog(
        BUILTIN_CATALOG,
        opencodeIds.length > 0 ? { opencode: opencodeCatalog(opencodeIds) } : undefined,
      );
      const result = await runWizard({
        statuses,
        configPath: loaded.userPath,
        catalog: wizardCatalog,
      });
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

  // Resolve the run-level models before anything spawns. `--default-model` and
  // `--planner-model` used to reach the provider verbatim, so a catalog alias
  // like `luna` was handed to codex as `-m luna` and the planner failed on a
  // name `baya models` lists (model-gate.ts §resolveRunModel). The catalog is
  // built here rather than at the task gate because the planner needs it first.
  const catalog = mergeCatalog(BUILTIN_CATALOG, loaded.config.modelCatalog);
  const modelNotes: string[] = [];
  for (const [label, provider, current, apply] of [
    [
      "--default-model",
      defaultProvider,
      defaultModel,
      (m: string | null) => {
        defaultModel = m;
      },
    ],
    [
      "--planner-model",
      plannerProvider,
      plannerModel,
      (m: string | null) => {
        plannerModel = m;
      },
    ],
  ] as const) {
    if (provider === null) continue;
    const resolved = resolveRunModel(current, {
      catalog,
      userAliases: loaded.config.modelAliases,
      provider,
      label,
    });
    apply(resolved.model);
    if (resolved.note !== null) modelNotes.push(resolved.note);
  }

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
  // The one line that answers "which agent, which model?" without --verbose.
  logger.info("run.agent", {
    provider: defaultProvider,
    model: defaultModel,
    planner_provider: plannerProvider,
    planner_model: plannerModel,
  });
  logger.debug("config.loaded", {
    sources: loaded.sources,
    user_config: loaded.userPath,
  });
  for (const note of modelNotes) logger.info("run.model.resolved", { detail: note });
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
    const batchSchemaPath = writeTaskResultBatchSchema(paths.schemaDir);
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
      const contentProblem = checkTaskText(read.taskText, sourcePath);
      if (contentProblem !== null) {
        logger.error("source.unusable", { path: sourcePath, reason: contentProblem });
        io.stderr.write(`${theme.status("fail")} ${theme.fail(contentProblem)}\n`);
        return 2;
      }
      logger.info("source.read", {
        path: sourcePath,
        bytes: Buffer.byteLength(read.taskText, "utf8"),
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
      const planned = await planTaskList({
        taskText: read.taskText,
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
        // Inlined only for a planner that enforces nothing. Naming a schema by
        // path sends the agent to read it, which costs a whole context re-send.
        ...(plannerAdapter.capabilities.structuredOutput === "none"
          ? { schema: readFileSync(planSchemaPath, "utf8") }
          : {}),
        providers: registry.ids,
        defaultProvider: defaultProvider as ProviderId,
        schemaPath: planSchemaPath,
        ...(flags.maxTasks !== undefined ? { maxTasks: flags.maxTasks } : {}),
      });
      progress.stop();
      manifest = planned.manifest;
      planOrigin = planned.origin;

      // Skipping is silent otherwise, and silence here reads as a planner bug:
      // the user wrote N tasks and sees fewer.
      if (planned.doneMarkers.length > 0 && !flags.quiet) {
        const shown = planned.doneMarkers.slice(0, 5);
        progress.write(
          `\n  ${theme.note(`already done — not planned (${planned.doneMarkers.length})`)}\n` +
            shown
              .map(
                (marker) =>
                  `    ${theme.note(`L${marker.line}`)} ${theme.note(marker.text.slice(0, 90))}`,
              )
              .join("\n") +
            (planned.doneMarkers.length > shown.length
              ? `\n    ${theme.note(`+${planned.doneMarkers.length - shown.length} more`)}`
              : "") +
            "\n",
        );
      }
    }

    // ---- model gate: resolve every task-named model against the catalog
    //      before anything is written or run. A named model is never silently
    //      swapped for the default (M3.6).
    const modelGate = await runModelGate({
      manifest,
      catalog,
      userAliases: loaded.config.modelAliases,
      defaultProvider: defaultProvider as ProviderId,
      yes: flags.yes,
      stdinIsTty: io.stdinIsTty,
      theme,
      beforePrompt: () => progress.stop(),
    });
    if (modelGate.decision === "aborted") {
      progress.stop();
      logger.warn("plan.model.unresolved", { message: modelGate.message });
      io.stderr.write(`${theme.status("fail")} ${theme.fail(modelGate.message)}\n`);
      return 2;
    }
    manifest = modelGate.manifest;
    for (const note of modelGate.notes) {
      logger.info("plan.model.resolved", { detail: note });
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
      `\n  ${theme.taskId("baya")} · ${manifest.source.path} · ${manifest.tasks.length} tasks · ${theme.provider(String(defaultProvider))}${defaultModel ? theme.note(` ${defaultModel}`) : ""}${planOrigin === "fallback" ? theme.warn(" · linear fallback") : ""}\n\n`,
    );
    io.stderr.write(
      `${renderDag(manifest, theme, defaultProvider as ProviderId, {
        defaultModel,
        cwd,
        groupSize: flags.groupSize ?? DEFAULT_GROUP_SIZE,
      })}\n\n`,
    );

    for (const note of modelGate.notes) {
      io.stderr.write(`  ${theme.note("resolved")} ${note}\n`);
    }
    if (modelGate.notes.length > 0) io.stderr.write("\n");

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
        max_parallel: maxParallel,
        isolation: "shared",
        context_strategy: flags.contextStrategy ?? "link-only",
        context_budget: flags.contextBudget ?? CONTEXT_BUDGET_DEFAULT,
        memory: !flags.noMemory,
        memory_budget: flags.memoryBudget ?? MEMORY_BUDGET_DEFAULT,
        group_size: flags.groupSize ?? DEFAULT_GROUP_SIZE,
        retries: flags.retries ?? DEFAULT_RETRIES,
      },
      totals: {
        succeeded: 0,
        failed: 0,
        skipped: 0,
        parked: 0,
        pending: manifest.tasks.length,
        running: 0,
        cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
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
      batchSchemaPath,
      defaultProvider: defaultProvider as ProviderId,
      defaultModel,
      binOverrides,
      contextStrategy: flags.contextStrategy ?? "link-only",
      contextBudget: flags.contextBudget ?? CONTEXT_BUDGET_DEFAULT,
      memory: !flags.noMemory,
      memoryBudget: flags.memoryBudget ?? MEMORY_BUDGET_DEFAULT,
      groupSize: flags.groupSize ?? DEFAULT_GROUP_SIZE,
      maxParallel,
      retries: flags.retries ?? DEFAULT_RETRIES,
      onError: flags.onError,
      env,
      ...(flags.dangerouslyAllowAll ? { dangerouslyAllowAll: true } : {}),
      onGroupStarted: spinner.onGroupStarted,
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

    const finalTotals = store.get().totals;
    store.setStatus(
      finalTotals.failed > 0 ? "failed" : finalTotals.parked > 0 ? "paused" : "completed",
    );
    const state = store.get() as RunState;
    const report = buildReport(state, manifest, {
      runDir: paths.runDir,
      summaries,
    });
    writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    stopTicker();

    logger.info(
      state.status === "failed"
        ? "run.failed"
        : state.status === "paused"
          ? "run.paused"
          : "run.completed",
      {
        succeeded: state.totals.succeeded,
        failed: state.totals.failed,
        skipped: state.totals.skipped,
        parked: state.totals.parked,
        cost_usd: state.totals.cost_usd,
      },
    );

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
    stopTicker();
    progress.dispose();
    lock.release();
  }
}

function nullStream(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
}
