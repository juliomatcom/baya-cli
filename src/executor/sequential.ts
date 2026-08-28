import { readFileSync } from "node:fs";
import {
  PROTOCOL_VERSION,
  type Manifest,
  type ProviderId,
  type Task,
  type TaskRequest,
  type TaskResult,
} from "../manifest/index.js";
import { descendantsOf, readySet, type ReadyState } from "../graph/index.js";
import type { Logger } from "../log/index.js";
import type { Registry } from "../providers/index.js";
import {
  assembleContext,
  budgetFrom,
  type ContextStrategy,
  type Upstream,
} from "../context/index.js";
import type { RunPaths } from "./paths.js";
import { StateStore, relativeArtifacts, type TaskState } from "./state.js";
import { executeTask } from "./task.js";

/**
 * The M1 scheduler: one task at a time, in topological order.
 *
 * Sequential deliberately. The parallel scheduler, its per-provider budgets,
 * and the writer semaphore are M2 — building them before a single task runs
 * end to end would be tuning a machine nobody has started.
 *
 * The shape here is already the parallel one, though: a ready-set loop rather
 * than a fixed order, so M2 changes how many tasks are admitted per pass, not
 * how admission is decided.
 */
export interface RunSequentialOptions {
  manifest: Manifest;
  cwd: string;
  paths: RunPaths;
  registry: Registry;
  logger: Logger;
  store: StateStore;
  schemaPath: string;
  /** Provider for tasks the manifest left unset. */
  defaultProvider: ProviderId;
  defaultModel: string | null;
  binOverrides?: Partial<Record<ProviderId, string>>;
  contextStrategy?: ContextStrategy;
  contextBudget?: number;
  maxRuntimeS?: number;
  dangerouslyAllowAll?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Fires the moment a task settles, so `warn`/`action_required` notes print immediately. */
  onTaskSettled?: (taskId: string, state: TaskState, result: TaskResult) => void;
}

export interface RunOutcome {
  results: Map<string, TaskResult>;
  succeeded: number;
  failed: number;
  skipped: number;
  parked: number;
}

const DEFAULT_MAX_RUNTIME_S = 900;

function toReadyStates(store: StateStore, tasks: Task[]): Map<string, ReadyState> {
  const states = new Map<string, ReadyState>();
  for (const task of tasks) {
    const entry = store.task(task.id);
    const state = entry?.state ?? "pending";
    states.set(task.id, state);
  }
  return states;
}

export async function runSequential(options: RunSequentialOptions): Promise<RunOutcome> {
  const { manifest, store, logger, paths, registry } = options;
  const tasks = manifest.tasks;
  const nodes = tasks.map((task) => ({ id: task.id, depends_on: task.depends_on }));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const results = new Map<string, TaskResult>();
  const strategy = options.contextStrategy ?? "link-only";
  const budget = budgetFrom(options.contextBudget);
  const maxRuntimeS = options.maxRuntimeS ?? DEFAULT_MAX_RUNTIME_S;

  logger.info("run.started", { tasks: tasks.length });

  for (;;) {
    const ready = readySet(nodes, toReadyStates(store, tasks));
    if (ready.length === 0) break;

    const taskId = ready[0] as string;
    const task = byId.get(taskId) as Task;
    logger.debug("task.ready", { task_id: taskId, deps: task.depends_on });

    const provider = task.provider ?? options.defaultProvider;
    const model = task.model ?? options.defaultModel;
    const adapter = registry.get(provider);
    const resolved = adapter
      ? await registry.resolve(provider, {
          ...(options.binOverrides ? { binOverrides: options.binOverrides } : {}),
          ...(options.env ? { env: options.env } : {}),
          probe: false,
        })
      : null;

    if (!adapter || !resolved) {
      // A provider that cannot be resolved is this task's failure, not the
      // run's: independent branches on a working provider still finish.
      const message = `provider "${provider}" is not available — run \`baya doctor\``;
      logger.error("provider.missing", { task_id: taskId, provider });
      settleFailure(taskId, provider, model, message);
      continue;
    }

    const upstreams = collectUpstreams(task, byId, paths, results);
    const context = assembleContext(upstreams, { strategy, budget });
    logger.debug("task.context.assembled", {
      task_id: taskId,
      upstream: upstreams.map((entry) => entry.taskId),
      strategy,
      inlined: context.filter((entry) => entry.inline !== null).length,
      bytes: context.reduce((sum, entry) => sum + (entry.inline?.length ?? 0), 0),
    });

    const request: TaskRequest = {
      baya: PROTOCOL_VERSION,
      kind: "task_request",
      run_id: store.get().run_id,
      task: { id: task.id, title: task.title, instruction: task.instruction },
      workspace: {
        cwd: task.cwd ?? options.cwd,
        writable: task.writes,
        isolation: "shared",
      },
      context,
      response_contract: { schema_path: options.schemaPath },
      constraints: { max_runtime_s: maxRuntimeS },
    };

    // Checkpoint before acting (conventions.md #14): a crash between here and
    // the spawn must still show that this task was started.
    store.transition(taskId, {
      state: "running",
      provider,
      model,
      attempts: (store.task(taskId)?.attempts ?? 0) + 1,
      started_at: new Date().toISOString(),
    });

    const execution = await executeTask({
      task,
      request,
      adapter,
      bin: resolved.bin,
      model,
      cwd: task.cwd ?? options.cwd,
      paths,
      schemaPath: options.schemaPath,
      logger,
      timeoutMs: maxRuntimeS * 1000,
      ...(options.env ? { env: options.env } : {}),
      ...(options.dangerouslyAllowAll ? { dangerouslyAllowAll: true } : {}),
      onSpawn: (pid) => store.transition(taskId, { pid }),
    });

    const result = execution.result;
    results.set(taskId, result);
    logger.debug("task.result.parsed", {
      task_id: taskId,
      status: result.status,
      notes: result.notes.length,
    });
    for (const note of result.notes) {
      logger.info("task.note", {
        task_id: taskId,
        severity: note.severity,
        message: note.message,
      });
    }

    const artifacts = relativeArtifacts(paths.runDir, {
      request: paths.request(taskId),
      result: paths.result(taskId),
      output: paths.output(taskId),
      events: paths.events(taskId),
      stdout: paths.stdout(taskId),
      stderr: paths.stderr(taskId),
    });
    const common = {
      provider,
      model,
      session_id: execution.sessionId,
      ended_at: new Date().toISOString(),
      duration_ms: execution.durationMs,
      exit_code: execution.exitCode,
      artifacts,
      notes: result.notes,
      files_changed: result.files_changed,
      cost_usd: execution.usage.cost_usd ?? 0,
      input_tokens: execution.usage.input_tokens ?? 0,
      output_tokens: execution.usage.output_tokens ?? 0,
    };

    if (result.status === "ok") {
      store.transition(taskId, { ...common, state: "succeeded", failure: null });
      logger.info("task.succeeded", {
        task_id: taskId,
        provider,
        model,
        duration_ms: execution.durationMs,
        summary: result.summary,
        files_changed: result.files_changed.length,
        note_count: result.notes.length,
        input_tokens: execution.usage.input_tokens ?? 0,
        output_tokens: execution.usage.output_tokens ?? 0,
        cost_usd: execution.usage.cost_usd ?? 0,
      });
      options.onTaskSettled?.(taskId, "succeeded", result);
      continue;
    }

    if (result.status === "needs_input") {
      // Escalation is M4. In M1 a question parks the task and stops its
      // branch — the question is reported rather than silently guessed at.
      store.transition(taskId, { ...common, state: "parked" });
      logger.warn("task.parked", {
        task_id: taskId,
        provider,
        question: result.question?.text ?? "",
      });
      options.onTaskSettled?.(taskId, "parked", result);
      markDescendantsSkipped(taskId);
      continue;
    }

    const failure = {
      kind: execution.timedOut ? ("timeout" as const) : ("crash" as const),
      message: result.error?.message ?? "task failed",
      provider_code: null,
      status_code: null,
      retry: ((result.error?.retryable ?? true) ? "now" : "never") as "now" | "never",
      occurred_at: new Date().toISOString(),
    };
    store.transition(taskId, { ...common, state: "failed", failure });
    logger.error("task.failed", {
      task_id: taskId,
      provider,
      kind: failure.kind,
      retry: failure.retry,
      exit_code: execution.exitCode,
      message: failure.message,
    });
    options.onTaskSettled?.(taskId, "failed", result);
    markDescendantsSkipped(taskId);
  }

  const totals = store.get().totals;
  return {
    results,
    succeeded: totals.succeeded,
    failed: totals.failed,
    skipped: totals.skipped,
    parked: totals.parked,
  };

  function settleFailure(
    id: string,
    provider: ProviderId,
    model: string | null,
    message: string,
  ): void {
    store.transition(id, {
      state: "failed",
      provider,
      model,
      ended_at: new Date().toISOString(),
      failure: {
        kind: "crash",
        message,
        provider_code: null,
        status_code: null,
        retry: "never",
        occurred_at: new Date().toISOString(),
      },
    });
    markDescendantsSkipped(id);
  }

  /**
   * Descendants become `skipped`, never `failed` (architecture.md §Task state
   * machine). The distinction is what lets the report say "2 failed, 5 skipped"
   * instead of reporting seven failures the user has to triage one by one.
   */
  function markDescendantsSkipped(failedId: string): void {
    for (const descendant of descendantsOf(nodes, failedId)) {
      const entry = store.task(descendant);
      if (entry && entry.state !== "pending") continue;
      store.transition(descendant, { state: "skipped", blocked_by: failedId });
      logger.warn("task.skipped", { task_id: descendant, blocked_by: failedId });
    }
  }
}

function collectUpstreams(
  task: Task,
  byId: ReadonlyMap<string, Task>,
  paths: RunPaths,
  results: ReadonlyMap<string, TaskResult>,
): Upstream[] {
  return task.depends_on.flatMap((depId) => {
    const dep = byId.get(depId);
    const result = results.get(depId);
    if (!dep || !result) return [];
    let output = result.output;
    if (output === "") {
      try {
        output = readFileSync(paths.output(depId), "utf8");
      } catch {
        output = "";
      }
    }
    return [
      {
        taskId: depId,
        title: dep.title,
        status: result.status,
        summary: result.summary,
        resultPath: paths.result(depId),
        outputPath: paths.output(depId),
        output,
      },
    ];
  });
}
