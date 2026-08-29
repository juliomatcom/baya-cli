import { readFileSync, writeFileSync } from "node:fs";
import {
  PROTOCOL_VERSION,
  routeProvider,
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
import {
  DEFAULT_MEMORY_BUDGET,
  deriveMemory,
  renderMemory,
  type TaskObservations,
} from "../memory/index.js";
import { classifyFailure } from "./classify.js";
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
  /** Cross-task memory. Default on. */
  memory?: boolean;
  memoryBudget?: number;
  /** Chain-collapse into one provider session. Default on. */
  sessionReuse?: boolean;
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

/**
 * How long a provider session stays worth continuing (execution.md §Session
 * reuse). Anthropic's prompt cache expires 5 minutes after its last hit, and
 * the session file outliving the cache is exactly the trap: past this window a
 * resume re-reads the whole accumulated transcript at full price, which costs
 * **more** than the cold start it replaced.
 */
export const SESSION_WARM_MS = 300_000;

/**
 * Turns per chain. The transcript only grows, and every turn pays ~10% of all
 * of it; past a handful the dilution stops being worth the warmth.
 */
export const MAX_CHAIN_TURNS = 5;

/** A live session an eligible task may continue. */
interface SessionInfo {
  sessionId: string;
  provider: ProviderId;
  model: string | null;
  /** The access level the session was opened with. codex cannot change it later. */
  access: Task["access"];
  endedAtMs: number;
  turns: number;
  /** Task ids whose work is already visible in this session's transcript. */
  chain: string[];
}

interface Continuation {
  sessionId: string;
  parentId: string;
  chain: string[];
}

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
  const memoryEnabled = options.memory ?? true;
  const memoryBudget = options.memoryBudget ?? DEFAULT_MEMORY_BUDGET;
  const sessionReuse = options.sessionReuse ?? true;

  /** Observations from every finished task, in completion order. */
  const observed: TaskObservations[] = [];
  /** Task id -> the session it left open and continuable. */
  const sessions = new Map<string, SessionInfo>();
  /**
   * Tasks whose open session has already been taken over by a dependent.
   *
   * Keyed by the **parent task**, not by the session id. Keying it by session
   * id capped every chain at two turns: `codex exec resume` keeps the same
   * thread id, so turn 2's session id equals turn 1's, and turn 3 saw an id
   * that was already claimed. Measured — a six-task chain collapsed 1→2 and
   * then stopped. What actually needs guarding is two *siblings* both
   * continuing one parent, which forks the conversation; extending a chain
   * one turn at a time never does.
   */
  const claimed = new Set<string>();

  logger.info("run.started", { tasks: tasks.length });

  for (;;) {
    const ready = readySet(nodes, toReadyStates(store, tasks));
    if (ready.length === 0) break;

    // Cache-aware ordering: among tasks that are ALREADY admissible, prefer one
    // that can continue a warm session. This never widens the ready set, so
    // dependency order is untouched — `readySet` has already established that
    // every candidate here may run in any order.
    const picked = selectNext(ready);
    const taskId = picked.taskId;
    const continuation = picked.continuation;
    const task = byId.get(taskId) as Task;
    logger.debug("task.ready", {
      task_id: taskId,
      deps: task.depends_on,
      ready: ready.length,
      continues: continuation?.parentId ?? null,
    });

    // Explicit provider wins, then the model alias (`sonnet` -> claude), then
    // the run default. Validation has already rejected a provider/model clash.
    const provider = routeProvider(task, options.defaultProvider);
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

    const inSession = new Set(continuation?.chain ?? []);
    const upstreams = collectUpstreams(task, byId, paths, results);
    // An upstream the agent produced itself, earlier in this same session, is
    // already in its transcript. Re-inlining it is the one cost a continuation
    // would otherwise add.
    const context = assembleContext(upstreams, { strategy, budget }).map((entry) =>
      inSession.has(entry.task_id) ? { ...entry, inline: null } : entry,
    );
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
        access: task.access,
        isolation: "shared",
      },
      context,
      response_contract: { schema_path: options.schemaPath },
      constraints: { max_runtime_s: maxRuntimeS },
    };

    const memoryBlock = memoryEnabled
      ? renderMemory(deriveMemory(observed, { cwd: options.cwd }), {
          budget: memoryBudget,
          ...(inSession.size > 0 ? { alreadyInSession: inSession } : {}),
        })
      : "";
    if (memoryBlock !== "") {
      logger.debug("task.memory.rendered", {
        task_id: taskId,
        chars: memoryBlock.length,
      });
    }

    // Checkpoint before acting (conventions.md #14): a crash between here and
    // the spawn must still show that this task was started.
    store.transition(taskId, {
      state: "running",
      provider,
      model,
      attempts: (store.task(taskId)?.attempts ?? 0) + 1,
      started_at: new Date().toISOString(),
      continued_from: continuation?.parentId ?? null,
    });
    if (continuation) claimed.add(continuation.parentId);

    const spawn = async (
      continueFrom: Continuation | null,
    ): Promise<Awaited<ReturnType<typeof executeTask>>> =>
      executeTask({
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
        ...(memoryBlock !== "" ? { memory: memoryBlock } : {}),
        ...(continueFrom
          ? {
              continueFrom: {
                sessionId: continueFrom.sessionId,
                inSession: continueFrom.chain,
              },
            }
          : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.dangerouslyAllowAll ? { dangerouslyAllowAll: true } : {}),
        onSpawn: (pid) => store.transition(taskId, { pid }),
      });

    let execution = await spawn(continuation);
    let continued = continuation !== null && execution.continued;

    // A resume that the CLI itself rejected exits non-zero with nothing
    // parseable — structurally distinct from a task that ran and reported
    // failure through the schema (exit 0). codex `exec resume` is UNVERIFIED,
    // so that case buys a cold retry rather than losing the task.
    if (
      continued &&
      execution.result.status === "failed" &&
      execution.exitCode !== 0 &&
      !execution.timedOut
    ) {
      logger.warn("task.continue.failed", {
        task_id: taskId,
        provider,
        session_id: continuation?.sessionId ?? null,
        exit_code: execution.exitCode,
      });
      store.transition(taskId, { continued_from: null });
      execution = await spawn(null);
      continued = false;
    }

    const result = execution.result;
    results.set(taskId, result);
    // Memory is derived from what a task DID, so a failed task contributes too
    // — its dead ends are the single most valuable thing it leaves behind.
    if (memoryEnabled && execution.observations.length > 0) {
      observed.push({ taskId, observations: execution.observations });
      writeMemorySnapshot();
    }
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
      cached_input_tokens: execution.usage.cached_input_tokens ?? 0,
      cache_write_input_tokens: execution.usage.cache_write_input_tokens ?? 0,
    };

    if (result.status === "ok") {
      // Only a succeeded task leaves a session worth continuing: a chain built
      // on a failed turn inherits its confusion along with its cache.
      if (execution.sessionId !== null && adapter.buildContinue !== undefined) {
        const parent =
          continued && continuation ? sessions.get(continuation.parentId) : null;
        sessions.set(taskId, {
          sessionId: execution.sessionId,
          provider,
          model,
          access: task.access,
          endedAtMs: Date.now(),
          turns: (parent?.turns ?? 0) + 1,
          chain: [...(parent?.chain ?? []), taskId],
        });
      }
      store.transition(taskId, { ...common, state: "succeeded", failure: null });
      logger.info("task.succeeded", {
        task_id: taskId,
        provider,
        model,
        continued_from: continued ? (continuation?.parentId ?? null) : null,
        duration_ms: execution.durationMs,
        summary: result.summary,
        files_changed: result.files_changed.length,
        note_count: result.notes.length,
        input_tokens: execution.usage.input_tokens ?? 0,
        output_tokens: execution.usage.output_tokens ?? 0,
        cached_input_tokens: execution.usage.cached_input_tokens ?? 0,
        cache_write_input_tokens: execution.usage.cache_write_input_tokens ?? 0,
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

    const failure = classifyFailure({
      timedOut: execution.timedOut,
      exitCode: execution.exitCode,
      events: execution.events,
      errorMessage: result.error?.message ?? "task failed",
      retryable: result.error?.retryable ?? true,
    });
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

  /**
   * The session `taskId` may continue, or `null`.
   *
   * Deliberately narrow. Only a task whose **single** dependency left a warm
   * session on the **same provider and model** qualifies:
   *
   * - one dependency, because a fan-in has no single conversation to rejoin;
   * - same provider and model, because a session belongs to one model — this
   *   is where per-task model routing and session reuse genuinely conflict,
   *   and routing wins by construction;
   * - same `access`, because `codex exec resume` takes no `-s`: a resumed turn
   *   inherits the sandbox its session was opened with. Collapsing a read-only
   *   turn onto a read-write session would silently widen its permissions, and
   *   the reverse would deny it tools it was granted;
   * - warm, because past the cache window a resume costs more than a cold start;
   * - unclaimed, because two *siblings* continuing one parent would fork the
   *   conversation. Extending a chain turn by turn is not a fork.
   */
  function continuationFor(id: string): Continuation | null {
    if (!sessionReuse) return null;
    const candidate = byId.get(id);
    if (!candidate || candidate.depends_on.length !== 1) return null;
    const parentId = candidate.depends_on[0] as string;
    const info = sessions.get(parentId);
    if (!info) return null;
    if (claimed.has(parentId)) return null;
    if (info.turns >= MAX_CHAIN_TURNS) return null;
    if (Date.now() - info.endedAtMs > SESSION_WARM_MS) return null;
    const provider = routeProvider(candidate, options.defaultProvider);
    if (provider !== info.provider) return null;
    if ((candidate.model ?? options.defaultModel) !== info.model) return null;
    if (candidate.access !== info.access) return null;
    if (registry.get(provider)?.buildContinue === undefined) return null;
    return { sessionId: info.sessionId, parentId, chain: info.chain };
  }

  /**
   * Manifest order, except that a warm continuation jumps the queue. Both
   * halves are safe by construction: every id here came from `readySet`.
   */
  function selectNext(ready: readonly string[]): {
    taskId: string;
    continuation: Continuation | null;
  } {
    for (const id of ready) {
      const continuation = continuationFor(id);
      if (continuation) return { taskId: id, continuation };
    }
    return { taskId: ready[0] as string, continuation: null };
  }

  /** Memory as it stands, for debugging a run and for measuring the feature. */
  function writeMemorySnapshot(): void {
    try {
      const entries = deriveMemory(observed, { cwd: options.cwd });
      writeFileSync(paths.memory, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    } catch {
      // A snapshot is a convenience. Never fail a run over one.
    }
  }

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
