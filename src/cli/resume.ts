import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  TaskResultSchema,
  validateManifest,
  writeTaskResultBatchSchema,
  writeTaskResultSchema,
  type Manifest,
  type ProviderId,
  type TaskResult,
} from '../manifest/index.js';
import {
  createLogger,
  resolveStderrLevel,
  type LogLine,
  type Logger,
} from '../log/index.js';
import { FileLock } from '../lock/index.js';
import {
  binOverrides as binOverridesFrom,
  loadConfig,
  providerToolSettings,
} from '../config/index.js';
import type { Registry } from '../providers/index.js';
import {
  StateStore,
  killGroup,
  readState,
  resumeReset,
  resumeTargets,
  runPaths,
  runSequential,
  type RunPaths,
  type RunState,
} from '../executor/index.js';
import {
  buildReport,
  createEventRenderer,
  createProgress,
  exitCodeFor,
  pickRun,
  renderReport,
  type Progress,
} from '../ui/index.js';
import { createTheme } from '../ui/theme.js';
import type { ParsedArgs } from './args.js';
import { installInterruptHandlers } from './interrupt.js';
import type { CliIo } from './run.js';
import { readRunRows } from './runs.js';
import { createGroupSpinner } from './spinner.js';

/**
 * `baya resume` (recovery.md §Resume) — finish a run that failed, parked, or
 * was interrupted.
 *
 * **A resume continues the original run in its own directory.** It reopens
 * `.baya/runs/<runId>/state.json`, puts the unfinished tasks back to `pending`
 * and executes them; the run id, the log and the artifacts of everything that
 * already succeeded stay exactly where they are.
 *
 * The alternative — a fresh run directory linked back to the old one — was
 * rejected because a succeeded task's `result.json` and `output.md` *are* the
 * upstream context a re-run task is given, and they are addressed relative to
 * the run directory. A second directory would mean copying them forward or
 * teaching every reader about a chain of runs, and it would split one logical
 * run's cost across two rows of `baya runs`. Continuing in place keeps
 * "one run, one directory, one cost total" true, and `attempts` plus the
 * appended log carry the retry history.
 *
 * The plan is never re-made. A resume executes the manifest the run was
 * planned from, so nothing already done can be invalidated by a task list that
 * moved on — a changed source is reported, not acted on.
 */
export interface ResumeCommandOptions {
  args: ParsedArgs;
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  registry: Registry;
}

export async function resumeCommand(options: ResumeCommandOptions): Promise<number> {
  const { args, cwd, env, io, registry } = options;
  const { flags } = args;
  const theme = createTheme(flags.noColor || env['NO_COLOR'] ? 'never' : 'auto');
  const fail = (message: string): number => {
    io.stderr.write(`${theme.status('fail')} ${theme.fail(message)}\n`);
    return 2;
  };

  const override = flags.provider;
  if (override !== undefined && !registry.has(override)) {
    return fail(
      `unknown provider: ${override} — expected one of ${registry.ids.join(', ')}`,
    );
  }

  let runId = args.runId ?? null;
  if (runId === null) {
    const picked = await pickRun({
      rows: readRunRows(cwd).filter((row) => row.resumable),
      stdinIsTty: io.stdinIsTty,
    });
    if (picked.decision === 'blocked') return fail(picked.message);
    runId = picked.runId;
  }

  const paths = runPaths(cwd, runId);
  let state: RunState;
  try {
    state = readState(paths.state);
  } catch (err) {
    // Never silently start fresh on a malformed checkpoint: that would re-spend
    // money already spent (recovery.md §Guards).
    return fail(
      `cannot resume ${runId} — ${paths.state} is unreadable: ${niceError(err)}`,
    );
  }

  let manifest: Manifest;
  try {
    const parsed: unknown = JSON.parse(readFileSync(state.manifest_path, 'utf8'));
    const validated = validateManifest(parsed, { allowlist: registry.ids });
    if (!validated.ok) {
      return fail(
        `cannot resume ${runId} — ${state.manifest_path}: ${validated.errors[0]?.message ?? 'invalid manifest'}`,
      );
    }
    manifest = validated.manifest;
  } catch (err) {
    return fail(
      `cannot resume ${runId} — ${state.manifest_path} is unreadable: ${niceError(err)}`,
    );
  }

  const targets = resumeTargets(
    state,
    manifest.tasks.map((task) => task.id),
  );
  if (targets.rerun.length === 0) {
    io.stderr.write(
      `  ${theme.note(`${runId} has nothing left to run — ${targets.keep.length} tasks succeeded`)}\n`,
    );
    return 0;
  }

  const snapshot = state.config_snapshot;
  const defaultProvider = (override ??
    snapshot.defaults.provider ??
    loadConfig({ cwd, env }).config.defaults.provider) as ProviderId | null;
  if (defaultProvider === null) {
    return fail(`no provider to resume with — pass \`--provider <id>\``);
  }

  const progress: Progress = createProgress({
    stream: io.stderr,
    disabled: flags.noProgress,
    json: flags.json,
    env,
  });
  const stderrSink = {
    write(chunk: string | Uint8Array): boolean {
      progress.write(String(chunk).replace(/\n$/, ''));
      return true;
    },
  } as unknown as NodeJS.WritableStream;

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

  const lock = new FileLock(paths.lockFile, { owner: runId, logger });
  const acquired = lock.acquire();
  if (!acquired.ok) {
    progress.dispose();
    const holder = acquired.holder;
    logger.error('lock.refused', {
      path: paths.lockFile,
      holder_pid: holder?.pid ?? null,
      holder_run: holder?.owner ?? null,
      verdict: acquired.verdict,
    });
    io.stderr.write(
      holder
        ? `${theme.status('fail')} ${theme.fail('another baya is already running in this directory')}\n    pid ${holder.pid} · run ${holder.owner} · started ${Math.round((Date.now() - holder.acquiredAt) / 1000)}s ago\n`
        : `${theme.status('fail')} ${theme.fail(`unreadable lock file at ${paths.lockFile} — delete it by hand (see \`baya doctor\`)`)}\n`,
    );
    return 2;
  }

  const activePids = new Set<number>();
  let interrupted = false;
  let store: StateStore | null = null;
  const spinner = createGroupSpinner({ progress, theme });
  const removeInterruptHandlers = installInterruptHandlers({
    progress,
    logger,
    activePids: () => activePids,
    killGroup,
    checkpointInterrupted: () => {
      interrupted = true;
      store?.setStatus('interrupted');
    },
    releaseLock: () => lock.release(),
    exit: (code) => process.exit(code),
  });

  try {
    logger.info('cli.invoked', { argv: process.argv.slice(2), cwd, run_id: runId });
    logger.info('run.resumed', {
      run_id: runId,
      source: state.source.path,
      rerun: targets.rerun.length,
      kept: targets.keep.length,
      provider: defaultProvider,
    });

    const drift = sourceDrift(state);
    if (drift !== null) {
      logger.warn('resume.source.changed', { path: state.source.path, reason: drift });
      io.stderr.write(`  ${theme.warn(drift)}\n`);
    }

    // Schemas live outside the run directory and may predate a Baya upgrade.
    const schemaPath = writeTaskResultSchema(paths.schemaDir);
    const batchSchemaPath = writeTaskResultBatchSchema(paths.schemaDir);

    store = new StateStore(paths.state, state, () =>
      logger.trace('state.checkpointed', { path: paths.state }),
    );
    const rerunning = new Set(targets.rerun);
    for (const id of targets.rerun) {
      store.transition(id, {
        ...resumeReset(),
        // A task moving to another provider loses the model that was resolved
        // for the old one; `null` is the new provider's own default.
        ...(override ? { provider: override as ProviderId, model: null } : {}),
      });
    }
    store.setStatus('running');

    const priorResults = readPriorResults(targets.keep, paths);
    const summaries = new Map<string, string>(
      [...priorResults].map(([id, result]) => [id, result.summary]),
    );

    io.stderr.write(
      `\n  ${theme.taskId('baya resume')} · ${runId} · ${targets.rerun.length} to run · ${theme.note(`${targets.keep.length} kept`)}\n\n`,
    );

    const resumeConfig = loadConfig({ cwd, env }).config;
    await runSequential({
      manifest: override ? withProvider(manifest, rerunning, override) : manifest,
      cwd,
      paths,
      registry,
      logger,
      store,
      schemaPath,
      batchSchemaPath,
      defaultProvider,
      defaultModel: override ? null : snapshot.defaults.model,
      binOverrides: binOverridesFrom(resumeConfig),
      // Read fresh, not from the snapshot: how a provider is driven, not what
      // the run decided.
      ...providerToolSettings(resumeConfig),
      ...(flags.tools ? { tools: flags.tools } : {}),
      // The run's own settings, not whatever the config says today — except
      // where this invocation names one explicitly.
      contextStrategy:
        flags.contextStrategy ??
        (snapshot.context_strategy === 'truncate' ? 'truncate' : 'link-only'),
      contextBudget: flags.contextBudget ?? snapshot.context_budget,
      memory: flags.noMemory ? false : snapshot.memory,
      memoryBudget: flags.memoryBudget ?? snapshot.memory_budget,
      groupSize: flags.groupSize ?? snapshot.group_size,
      retries: flags.retries ?? snapshot.retries,
      maxParallel: flags.maxParallel ?? snapshot.max_parallel,
      onError: flags.onError,
      env,
      priorResults,
      ...(flags.dangerouslyAllowAll ? { dangerouslyAllowAll: true } : {}),
      onGroupStarted: spinner.onGroupStarted,
      onProcessSpawn: (pid) => activePids.add(pid),
      onProcessExit: (pid) => activePids.delete(pid),
      onTaskSettled: (taskId, _state, result) => {
        summaries.set(taskId, result.summary);
        if (flags.verbose && !flags.quiet && result.output.trim() !== '') {
          progress.write(`\n${result.output.trim()}\n`);
        }
      },
    });

    const totals = store.get().totals;
    store.setStatus(
      totals.failed > 0 ? 'failed' : totals.parked > 0 ? 'paused' : 'completed',
    );
    const finished = store.get() as RunState;
    const report = buildReport(finished, manifest, { runDir: paths.runDir, summaries });
    writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    spinner.dispose();
    logger.info(
      finished.status === 'failed'
        ? 'run.failed'
        : finished.status === 'paused'
          ? 'run.paused'
          : 'run.completed',
      {
        succeeded: finished.totals.succeeded,
        failed: finished.totals.failed,
        skipped: finished.totals.skipped,
        parked: finished.totals.parked,
        cost_usd: finished.totals.cost_usd,
      },
    );

    progress.stop();
    if (flags.json) {
      io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      io.stderr.write(`${renderReport(report, theme)}\n`);
    }
    return interrupted ? 130 : exitCodeFor(finished);
  } finally {
    removeInterruptHandlers();
    spinner.dispose();
    progress.dispose();
    lock.release();
  }
}

/**
 * The task list the run was planned from, as it is now. A mismatch is reported
 * and the stored plan runs anyway: re-planning would invalidate work already
 * paid for, and a half-finished run is not the place to swap the plan out.
 */
function sourceDrift(state: RunState): string | null {
  let text: string;
  try {
    text = readFileSync(state.source.path, 'utf8');
  } catch {
    return `${state.source.path} is no longer readable — resuming the plan stored with the run`;
  }
  const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  if (sha256 === state.source.sha256) return null;
  return `${state.source.path} changed since this run was planned — resuming the stored plan, not the new text`;
}

/**
 * The kept work, as upstream context. Read off disk because the previous
 * process's in-memory results died with it, and a re-run task downstream of a
 * succeeded one must still be told what that task produced.
 */
function readPriorResults(
  keep: readonly string[],
  paths: RunPaths,
): Map<string, TaskResult> {
  const results = new Map<string, TaskResult>();
  for (const id of keep) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(paths.result(id), 'utf8'));
      results.set(id, TaskResultSchema.parse(parsed));
    } catch {
      // The task succeeded — the checkpoint says so — but its result file is
      // gone or unreadable. Keep it as an upstream with no summary rather than
      // dropping it: `output.md` beside it is still read, and losing the edge
      // entirely would leave the downstream task with no idea the work exists.
      results.set(id, placeholderResult(id));
    }
  }
  return results;
}

function placeholderResult(taskId: string): TaskResult {
  return {
    baya: '1',
    kind: 'task_result',
    task_id: taskId,
    status: 'ok',
    summary: '',
    output: '',
    notes: [],
    question: null,
    error: null,
    artifacts: [],
    files_changed: [],
  };
}

/** `--provider` moves the unfinished tasks only; kept work is never re-routed. */
function withProvider(
  manifest: Manifest,
  rerunning: ReadonlySet<string>,
  provider: string,
): Manifest {
  return {
    ...manifest,
    tasks: manifest.tasks.map((task) =>
      rerunning.has(task.id)
        ? { ...task, provider: provider as ProviderId, model: null }
        : task,
    ),
  };
}

function niceError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nullStream(): NodeJS.WritableStream {
  return { write: () => true } as unknown as NodeJS.WritableStream;
}
