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
import { descendantsOf, readySet, topoOrder, type ReadyState } from "../graph/index.js";
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
  type Observation,
  type TaskObservations,
} from "../memory/index.js";
import { classifyFailure } from "./classify.js";
import { DEFAULT_GROUP_SIZE, formGroup, groupKey, type GroupCandidate } from "./group.js";
import type { RunPaths } from "./paths.js";
import { StateStore, relativeArtifacts, type TaskState } from "./state.js";
import { executeGroup } from "./task.js";

/**
 * The M1 scheduler: one provider process at a time, in topological order.
 *
 * Sequential deliberately. The parallel scheduler, its per-provider budgets,
 * and the writer semaphore are M2 — building them before a single task runs
 * end to end would be tuning a machine nobody has started.
 *
 * The unit admitted is a **group**, not a task (`group.ts`): several tasks that
 * share a provider, model, access level and working directory go into one
 * process and are worked through in order. That is the project's main cost
 * lever, and it composes with M2 rather than fighting it — grouping decides
 * what goes in a process, parallelism decides how many processes run at once.
 *
 * The shape here is already the parallel one: a ready-set loop rather than a
 * fixed order, so M2 changes how many groups are admitted per pass, not how
 * admission is decided.
 */
export interface RunSequentialOptions {
  manifest: Manifest;
  cwd: string;
  paths: RunPaths;
  registry: Registry;
  logger: Logger;
  store: StateStore;
  /** The `task_result` schema, for a process running one task. */
  schemaPath: string;
  /** The `task_result_batch` schema, for a process running a group. */
  batchSchemaPath: string;
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
  /** Max tasks per provider process. `1` restores one process per task. */
  groupSize?: number;
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
 * A group's deadline is its members' budgets summed, then capped. Summed
 * because the tasks run one after another inside the process and each deserves
 * its own allowance; capped because a runaway group must not be able to hold
 * the whole run hostage.
 */
export const MAX_GROUP_RUNTIME_S = 3600;

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
  const order = topoOrder(nodes);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const results = new Map<string, TaskResult>();
  const strategy = options.contextStrategy ?? "link-only";
  const budget = budgetFrom(options.contextBudget);
  const maxRuntimeS = options.maxRuntimeS ?? DEFAULT_MAX_RUNTIME_S;
  const memoryEnabled = options.memory ?? true;
  const memoryBudget = options.memoryBudget ?? DEFAULT_MEMORY_BUDGET;
  const groupCap = Math.max(1, options.groupSize ?? DEFAULT_GROUP_SIZE);

  /** Observations from every finished task, in completion order. */
  const observed: TaskObservations[] = [];

  // Routing is static — provider, model, access and cwd all come from the
  // manifest — so the grouping keys are computed once rather than per pass.
  const candidates = new Map<string, GroupCandidate>(
    tasks.map((task) => [
      task.id,
      {
        id: task.id,
        depends_on: task.depends_on,
        key: groupKey({
          provider: routeProvider(task, options.defaultProvider),
          model: task.model ?? options.defaultModel,
          access: task.access,
          cwd: task.cwd ?? options.cwd,
        }),
      },
    ]),
  );

  logger.info("run.started", { tasks: tasks.length });

  for (;;) {
    const states = toReadyStates(store, tasks);
    const ready = readySet(nodes, states);
    if (ready.length === 0) break;

    const seedId = ready[0] as string;
    const memberIds = formGroup({
      seedId,
      order,
      candidates,
      pending: setOf(states, "pending"),
      succeeded: setOf(states, "succeeded"),
      cap: groupCap,
    });
    const members = memberIds.map((id) => byId.get(id) as Task);
    const leader = members[0] as Task;
    const leaderId = leader.id;
    const grouped = members.length > 1;
    logger.debug("group.ready", {
      group_id: leaderId,
      tasks: memberIds,
      ready: ready.length,
    });

    // Every member shares these by construction — that is what the grouping
    // key is for — so they are read off the leader.
    const provider = routeProvider(leader, options.defaultProvider);
    const model = leader.model ?? options.defaultModel;
    const cwd = leader.cwd ?? options.cwd;
    const adapter = registry.get(provider);
    const resolved = adapter
      ? await registry.resolve(provider, {
          ...(options.binOverrides ? { binOverrides: options.binOverrides } : {}),
          ...(options.env ? { env: options.env } : {}),
          probe: false,
        })
      : null;

    if (!adapter || !resolved) {
      // A provider that cannot be resolved is this group's failure, not the
      // run's: independent branches on a working provider still finish.
      const message = `provider "${provider}" is not available — run \`baya doctor\``;
      logger.error("provider.missing", { task_id: leaderId, provider });
      for (const id of memberIds) settleFailure(id, provider, model, message);
      continue;
    }

    const inGroup = new Set(memberIds);
    const groupRuntimeS = Math.min(maxRuntimeS * members.length, MAX_GROUP_RUNTIME_S);
    const requests = members.map((task) =>
      buildRequest(task, inGroup, grouped, groupRuntimeS),
    );

    const memoryBlock = memoryEnabled
      ? renderMemory(deriveMemory(observed, { cwd: options.cwd }), {
          budget: memoryBudget,
        })
      : "";
    if (memoryBlock !== "") {
      logger.debug("group.memory.rendered", {
        group_id: leaderId,
        chars: memoryBlock.length,
      });
    }

    // Checkpoint before acting (conventions.md #14): a crash between here and
    // the spawn must still show that every one of these tasks was started.
    for (const id of memberIds) {
      store.transition(id, {
        state: "running",
        provider,
        model,
        attempts: (store.task(id)?.attempts ?? 0) + 1,
        started_at: new Date().toISOString(),
        group_id: grouped ? leaderId : null,
      });
    }

    const execution = await executeGroup({
      tasks: members,
      requests,
      adapter,
      bin: resolved.bin,
      model,
      cwd,
      paths,
      schemaPath: grouped ? options.batchSchemaPath : options.schemaPath,
      logger,
      timeoutMs: groupRuntimeS * 1000,
      ...(memoryBlock !== "" ? { memory: memoryBlock } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.dangerouslyAllowAll ? { dangerouslyAllowAll: true } : {}),
      onSpawn: (pid) => {
        for (const id of memberIds) store.transition(id, { pid });
      },
    });

    // The process's own artifacts are shared: one spawn produced one event
    // stream and one pair of stdio logs, and they live in the leader's
    // directory. Only the request/result/output are genuinely per task.
    const shared = {
      events: paths.events(leaderId),
      stdout: paths.stdout(leaderId),
      stderr: paths.stderr(leaderId),
    };

    // Non-zero exit or a timeout means the **process** died, not that a task
    // reported failure through the schema (which exits 0). Everything after
    // the first casualty in a dead process never ran, so it is `skipped` —
    // the distinction architecture.md §Task state machine exists for, and
    // what keeps a group of four from reporting four failures to triage.
    const processFailed = execution.exitCode !== 0 || execution.timedOut;
    let firstFailureId: string | null = null;

    members.forEach((task, index) => {
      const taskId = task.id;
      // An earlier member of this same group failed and this task is
      // downstream of it. Whatever the model reported for it, it was built on
      // work that did not happen — the DAG, not the model's account of itself,
      // decides that. Already settled as `skipped`; nothing more to do.
      if (store.task(taskId)?.state === "skipped") return;

      const result = execution.results[index] ?? missingResult(taskId);
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
        ...shared,
      });
      // Usage belongs to the process. Recording it on the leader and zero on
      // the rest is what keeps the run total honest — a group shares one
      // context window and one bill, and splitting that per task would be
      // inventing numbers. `group_id` is how the report puts them back together.
      const isLeader = index === 0;
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
        cost_usd: isLeader ? (execution.usage.cost_usd ?? 0) : 0,
        input_tokens: isLeader ? (execution.usage.input_tokens ?? 0) : 0,
        output_tokens: isLeader ? (execution.usage.output_tokens ?? 0) : 0,
        cached_input_tokens: isLeader ? (execution.usage.cached_input_tokens ?? 0) : 0,
        cache_write_input_tokens: isLeader
          ? (execution.usage.cache_write_input_tokens ?? 0)
          : 0,
      };

      if (result.status === "ok") {
        store.transition(taskId, { ...common, state: "succeeded", failure: null });
        logger.info("task.succeeded", {
          task_id: taskId,
          provider,
          model,
          group_id: grouped ? leaderId : null,
          duration_ms: execution.durationMs,
          summary: result.summary,
          files_changed: result.files_changed.length,
          note_count: result.notes.length,
          input_tokens: common.input_tokens,
          output_tokens: common.output_tokens,
          cached_input_tokens: common.cached_input_tokens,
          cache_write_input_tokens: common.cache_write_input_tokens,
          cost_usd: common.cost_usd,
        });
        options.onTaskSettled?.(taskId, "succeeded", result);
        return;
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
        markDescendantsSkipped(taskId, inGroup);
        return;
      }

      if (processFailed && firstFailureId !== null) {
        store.transition(taskId, {
          ...common,
          state: "skipped",
          blocked_by: firstFailureId,
        });
        logger.warn("task.skipped", { task_id: taskId, blocked_by: firstFailureId });
        options.onTaskSettled?.(taskId, "skipped", result);
        markDescendantsSkipped(taskId, inGroup);
        return;
      }
      firstFailureId ??= taskId;

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
      markDescendantsSkipped(taskId, inGroup);
    });

    // Memory is derived from what a task DID, so a failed task contributes too
    // — its dead ends are the single most valuable thing it leaves behind.
    if (memoryEnabled) recordObservations(memberIds, execution.observations);
  }

  const totals = store.get().totals;
  return {
    results,
    succeeded: totals.succeeded,
    failed: totals.failed,
    skipped: totals.skipped,
    parked: totals.parked,
  };

  function setOf(
    states: ReadonlyMap<string, ReadyState>,
    state: ReadyState,
  ): Set<string> {
    const out = new Set<string>();
    for (const [id, value] of states) if (value === state) out.add(id);
    return out;
  }

  function buildRequest(
    task: Task,
    inGroup: ReadonlySet<string>,
    grouped: boolean,
    runtimeS: number,
  ): TaskRequest {
    const upstreams = collectUpstreams(task, byId, paths, results, inGroup);
    // An upstream produced earlier in this same process is already in the
    // conversation. Re-inlining it is the one cost grouping would add back.
    const context = assembleContext(upstreams, { strategy, budget }).map((entry) =>
      inGroup.has(entry.task_id) ? { ...entry, inline: null } : entry,
    );
    logger.debug("task.context.assembled", {
      task_id: task.id,
      upstream: upstreams.map((entry) => entry.taskId),
      strategy,
      inlined: context.filter((entry) => entry.inline !== null).length,
      bytes: context.reduce((sum, entry) => sum + (entry.inline?.length ?? 0), 0),
    });
    return {
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
      response_contract: {
        schema_path: grouped ? options.batchSchemaPath : options.schemaPath,
      },
      constraints: { max_runtime_s: runtimeS },
    };
  }

  /**
   * Fold a finished group into memory.
   *
   * Two sources, both of them records a provider already produced:
   *
   * - the adapter's own event stream, for providers whose documented `--json`
   *   output names the commands it ran. That is process-wide, so it is filed
   *   under the group leader;
   * - `files_changed` from each task's `task_result`, which is protocol-level
   *   and therefore works on **every** provider, including the two that report
   *   no commands at all.
   *
   * Nothing here is self-reported prose and nothing is scraped out of a file
   * the provider does not document, so a fact costs no output tokens and
   * cannot be hallucinated into existence.
   */
  function recordObservations(
    memberIds: readonly string[],
    processObservations: readonly Observation[],
  ): void {
    let added = false;
    const leaderId = memberIds[0] as string;
    if (processObservations.length > 0) {
      observed.push({ taskId: leaderId, observations: [...processObservations] });
      added = true;
    }
    for (const id of memberIds) {
      const changed = results.get(id)?.files_changed ?? [];
      if (changed.length === 0) continue;
      observed.push({
        taskId: id,
        observations: changed.map((path) => ({ kind: "write" as const, path })),
      });
      added = true;
    }
    if (added) writeMemorySnapshot();
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

  function missingResult(taskId: string): TaskResult {
    return {
      baya: PROTOCOL_VERSION,
      kind: "task_result",
      task_id: taskId,
      status: "failed",
      summary: "",
      output: "",
      notes: [],
      question: null,
      error: {
        message: "the provider returned no result for this task",
        retryable: true,
      },
      artifacts: [],
      files_changed: [],
    };
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
   *
   * `inGroup` is what makes this work inside a group. A member of the failed
   * task's own process is already `running`, so the `pending`-only guard would
   * pass over it — and it would then be settled from whatever the model said
   * about it, which is how a task downstream of a failure got to report
   * success. Dependency order is the orchestrator's to enforce, not the
   * model's to respect.
   */
  function markDescendantsSkipped(
    failedId: string,
    inGroup: ReadonlySet<string> = new Set(),
  ): void {
    for (const descendant of descendantsOf(nodes, failedId)) {
      const entry = store.task(descendant);
      const settleable =
        !entry ||
        entry.state === "pending" ||
        (entry.state === "running" && inGroup.has(descendant));
      if (!settleable) continue;
      store.transition(descendant, { state: "skipped", blocked_by: failedId });
      logger.warn("task.skipped", { task_id: descendant, blocked_by: failedId });
    }
  }
}

/**
 * A dependency inside the same group has not run yet, so there is no result to
 * summarize — but it still belongs in the context, because the prompt has to
 * tell the agent that the upstream work is its own, a few sections above.
 */
function collectUpstreams(
  task: Task,
  byId: ReadonlyMap<string, Task>,
  paths: RunPaths,
  results: ReadonlyMap<string, TaskResult>,
  inGroup: ReadonlySet<string>,
): Upstream[] {
  return task.depends_on.flatMap((depId) => {
    const dep = byId.get(depId);
    if (!dep) return [];
    const result = results.get(depId);
    if (!result) {
      if (!inGroup.has(depId)) return [];
      return [
        {
          taskId: depId,
          title: dep.title,
          status: "ok",
          summary: "Done earlier in this same conversation.",
          resultPath: paths.result(depId),
          outputPath: paths.output(depId),
          output: "",
        },
      ];
    }
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
