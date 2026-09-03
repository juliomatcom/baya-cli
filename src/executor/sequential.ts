import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import {
  PROTOCOL_VERSION,
  routeProvider,
  type Manifest,
  type ProviderId,
  type Task,
  type TaskRequest,
  type TaskResult,
} from '../manifest/index.js';
import { descendantsOf, readySet, topoOrder, type ReadyState } from '../graph/index.js';
import type { Logger } from '../log/index.js';
import type { Registry } from '../providers/index.js';
import {
  assembleContext,
  budgetFrom,
  type ContextStrategy,
  type Upstream,
} from '../context/index.js';
import {
  DEFAULT_MEMORY_BUDGET,
  deriveMemory,
  renderMemory,
  type Observation,
  type TaskObservations,
} from '../memory/index.js';
import { AdmissionState } from './budget.js';
import { classifyFailure } from './classify.js';
import { DEFAULT_GROUP_SIZE, formGroup, groupKey, type GroupCandidate } from './group.js';
import type { RunPaths } from './paths.js';
import { resumeReset } from './resume.js';
import { StateStore, relativeArtifacts, type Failure, type TaskState } from './state.js';
import { executeGroup, type GroupExecution } from './task.js';

/**
 * The scheduler: several provider processes at once, admitted from the ready
 * set and settled as they land.
 *
 * The unit admitted is a **group**, not a task (`group.ts`): several tasks that
 * share a provider, model, access level and working directory go into one
 * process and are worked through in order. That is the project's main cost
 * lever, and it composes with parallelism rather than fighting it — grouping
 * decides what goes in a process, parallelism decides how many processes run
 * at once.
 *
 * Each pass offers every group the ready set can form to `AdmissionState`
 * (`budget.ts`), which holds the global cap, the per-provider caps and the
 * single-writer semaphore. Whatever it accepts is spawned and kept as a
 * promise; the loop then waits for the first of them to settle, settles that
 * group's members, and offers again — so a slot freed by a short group is
 * refilled without waiting on the long one beside it.
 *
 * Two things the sequential shape hid and this one cannot:
 *
 * - a group is formed from the tasks still `pending` **at admission time**,
 *   because a settle between two offers moves tasks out of that set;
 * - the run ends when the ready set is empty **and** nothing is in flight. On
 *   the ready set alone, a run whose last groups are slow would exit while
 *   they were still out.
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
  maxParallel?: number;
  /** `--retries`: extra attempts after the first, for `retry:"now"` failures only. */
  retries?: number;
  onError?: 'continue' | 'stop';
  /**
   * Results of tasks that succeeded before this call — a resume's kept work
   * (recovery.md §Resume). They are never re-run; their outputs are what a
   * downstream task's context is assembled from.
   */
  priorResults?: ReadonlyMap<string, TaskResult>;
  env?: NodeJS.ProcessEnv;
  /** Fires the moment a task settles, so `warn`/`action_required` notes print immediately. */
  onTaskSettled?: (taskId: string, state: TaskState, result: TaskResult) => void;
  /**
   * Fires just before a group's process is spawned.
   *
   * The terminal's only other signal is the provider's own event stream, and
   * `claude --output-format json` emits a single object at the very end — so
   * between the spawn and the result there is, structurally, nothing to print.
   * A long task on that adapter is indistinguishable from a hung one without
   * this.
   */
  onGroupStarted?: (info: {
    taskIds: string[];
    provider: ProviderId;
    model: string | null;
  }) => void;
  /**
   * Fires with a provider process's pid the moment it is spawned, and
   * `onProcessExit` fires with the same pid when that exact process settles.
   * The CLI keeps `activePids` from the pair, so an interrupt signals every
   * live process group and never a stale or reused pid.
   */
  onProcessSpawn?: (pid: number) => void;
  onProcessExit?: (pid: number) => void;
}

export interface RunOutcome {
  results: Map<string, TaskResult>;
  succeeded: number;
  failed: number;
  skipped: number;
  parked: number;
}

const DEFAULT_MAX_RUNTIME_S = 900;

/** `--max-parallel`'s default, for a caller that resolved none of its own. */
const DEFAULT_MAX_PARALLEL = Math.min(4, cpus().length);

/** `--retries`'s default: one extra attempt, so two in all. */
export const DEFAULT_RETRIES = 1;

const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30_000;

/**
 * Exponential backoff with jitter, between half the ceiling and all of it.
 *
 * Exponential because the transient kinds (`network`, `timeout`, a provider
 * blip) clear on their own timescale, and hammering shortens nothing. Jittered
 * because parallel groups fail together — a rate limit hits every process at
 * once — and a fixed delay would send them all back at the same instant.
 */
function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/** What a failed attempt leaves for the next one. */
interface RetryPlan {
  /** Index of the first member that failed; everything from here re-runs. */
  casualty: number;
  failure: Failure;
  attempt: number;
  delayMs: number;
}

/** A group that has been spawned and is not back yet. */
interface LiveGroup {
  leaderId: string;
  memberIds: string[];
  members: Task[];
  provider: ProviderId;
  model: string | null;
  grouped: boolean;
  inGroup: Set<string>;
  /** The process-group leader's pid, once spawned. */
  pid?: number;
}

/** A finished group: `execution` on a normal return, `error` on a thrown one. */
interface Settlement {
  group: LiveGroup;
  execution: GroupExecution | null;
  error: unknown;
}

/** Each adapter's `capabilities.maxConcurrency`, for the per-provider budgets. */
function providerCaps(registry: Registry): Partial<Record<ProviderId, number>> {
  const caps: Partial<Record<ProviderId, number>> = {};
  for (const id of registry.ids) {
    const adapter = registry.get(id);
    if (adapter) caps[id] = adapter.capabilities.maxConcurrency;
  }
  return caps;
}

/**
 * A group's deadline is its members' budgets summed, then capped. Summed
 * because the tasks run one after another inside the process and each deserves
 * its own allowance; capped because a runaway group must not be able to hold
 * the whole run hostage.
 *
 * Derived from the default group size rather than written as its own number,
 * because the two are not independent: a cap below `size × budget` silently
 * gives every task **less** time than it was budgeted. The cap must never bite
 * at the default size. Above it, the squeeze is the point — `--group-size 12`
 * is a request to pack more into one process, not a request for a three-hour
 * process with no checkpoint granularity inside it.
 */
export const MAX_GROUP_RUNTIME_S = DEFAULT_GROUP_SIZE * DEFAULT_MAX_RUNTIME_S;

function toReadyStates(store: StateStore, tasks: Task[]): Map<string, ReadyState> {
  const states = new Map<string, ReadyState>();
  for (const task of tasks) {
    const entry = store.task(task.id);
    const state = entry?.state ?? 'pending';
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
  const results = new Map<string, TaskResult>(options.priorResults ?? []);
  const strategy = options.contextStrategy ?? 'link-only';
  const budget = budgetFrom(options.contextBudget);
  const maxRuntimeS = options.maxRuntimeS ?? DEFAULT_MAX_RUNTIME_S;
  const memoryEnabled = options.memory ?? true;
  const memoryBudget = options.memoryBudget ?? DEFAULT_MEMORY_BUDGET;
  const groupCap = Math.max(1, options.groupSize ?? DEFAULT_GROUP_SIZE);
  const maxRetries = Math.max(0, options.retries ?? DEFAULT_RETRIES);

  /** Observations from every finished task, in completion order. */
  const observed: TaskObservations[] = [];

  const admission = new AdmissionState({
    maxParallel: options.maxParallel ?? DEFAULT_MAX_PARALLEL,
    perProvider: providerCaps(registry),
  });
  /** Spawned groups not back yet, keyed by group leader id. */
  const inFlight = new Map<string, Promise<Settlement>>();
  /** Writer groups the budgets refused — mirrored from `AdmissionState`. */
  const refusedWriters = new Set<string>();
  /** Tasks waiting out a retry backoff: task id → the ms it may be offered at. */
  const holdUntil = new Map<string, number>();
  /**
   * Id of the first task that failed `quota`, once one has (execution.md
   * §Failure semantics). A quota wall is the session or the billing account,
   * not one provider — so admission stops for the whole run and every task that
   * never started is skipped, blocked by this one.
   */
  let quotaHaltBy: string | null = null;

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

  logger.info('run.started', { tasks: tasks.length });

  for (;;) {
    await admitReady();
    if (inFlight.size === 0) {
      // Nothing in flight means every budget and the semaphore have room, so
      // an offer round that admitted nothing had nothing it *could* admit —
      // either the ready set is empty, or what is left is waiting out a
      // retry backoff, which is the one thing worth sleeping for.
      const wakeAt = earliestHold();
      if (wakeAt === null) break;
      await sleep(wakeAt - Date.now());
      continue;
    }

    const settled = await Promise.race(inFlight.values());
    inFlight.delete(settled.group.leaderId);
    admission.release(settled.group.leaderId);
    if (settled.group.pid !== undefined) options.onProcessExit?.(settled.group.pid);
    if (settled.execution === null) throw settled.error;

    const plan = retryPlan(settled.group, settled.execution);
    if (plan === null) settleGroup(settled.group, settled.execution);
    else retryGroup(settled.group, settled.execution, plan);
  }

  /**
   * Offer groups until the budgets refuse every one of them.
   *
   * The state is re-read per offer rather than per pass: admitting a group
   * moves its members out of `pending`, and a group formed from a stale
   * pending set would put a task in two processes at once.
   */
  async function admitReady(): Promise<void> {
    /** Seeds already refused this round — re-offering one only loops. */
    const refusedSeeds = new Set<string>();
    const offered = new Set<string>();

    for (;;) {
      // A quota failure has halted the run: admit nothing more, but leave
      // whatever is already in flight to finish (execution.md §Failure semantics).
      if (quotaHaltBy !== null) break;
      const states = toReadyStates(store, tasks);
      const offerable = setOf(states, 'pending');
      for (const id of offerable) if (held(id)) offerable.delete(id);
      const ready = readySet(nodes, states).filter(
        (id) => !refusedSeeds.has(id) && offerable.has(id),
      );
      const seedId = ready[0];
      if (seedId === undefined) break;

      const memberIds = formGroup({
        seedId,
        order,
        candidates,
        pending: offerable,
        succeeded: setOf(states, 'succeeded'),
        cap: groupCap,
      });
      const members = memberIds.map((id) => byId.get(id) as Task);
      const leader = members[0] as Task;
      const leaderId = leader.id;
      const grouped = members.length > 1;

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
        logger.error('provider.missing', { task_id: leaderId, provider });
        for (const id of memberIds) settleFailure(id, provider, model, message);
        continue;
      }

      offered.add(leaderId);
      if (!admission.admit({ id: leaderId, provider, access: leader.access })) {
        if (leader.access === 'read-write') refusedWriters.add(leaderId);
        refusedSeeds.add(seedId);
        continue;
      }
      refusedWriters.delete(leaderId);

      logger.debug('group.ready', {
        group_id: leaderId,
        tasks: memberIds,
        ready: ready.length,
      });

      const inGroup = new Set(memberIds);
      const groupRuntimeS = Math.min(maxRuntimeS * members.length, MAX_GROUP_RUNTIME_S);
      const requests = members.map((task) =>
        buildRequest(task, inGroup, grouped, groupRuntimeS),
      );

      const memoryBlock = memoryEnabled
        ? renderMemory(deriveMemory(observed, { cwd: options.cwd }), {
            budget: memoryBudget,
          })
        : '';
      if (memoryBlock !== '') {
        logger.debug('group.memory.rendered', {
          group_id: leaderId,
          chars: memoryBlock.length,
        });
      }

      // Checkpoint before acting (conventions.md #14): a crash between here and
      // the spawn must still show that every one of these tasks was started.
      for (const id of memberIds) {
        store.transition(id, {
          state: 'running',
          provider,
          model,
          attempts: (store.task(id)?.attempts ?? 0) + 1,
          started_at: new Date().toISOString(),
          group_id: grouped ? leaderId : null,
        });
      }

      options.onGroupStarted?.({ taskIds: [...memberIds], provider, model });

      const group: LiveGroup = {
        leaderId,
        memberIds,
        members,
        provider,
        model,
        grouped,
        inGroup,
      };
      inFlight.set(
        leaderId,
        // Settled rather than rejected: a throw here would surface through
        // `Promise.race` as an unhandled rejection on every sibling still out.
        // It is re-thrown below, when this group's turn to settle comes.
        executeGroup({
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
          ...(memoryBlock !== '' ? { memory: memoryBlock } : {}),
          ...(options.env ? { env: options.env } : {}),
          ...(options.dangerouslyAllowAll ? { dangerouslyAllowAll: true } : {}),
          onSpawn: (pid) => {
            group.pid = pid;
            for (const id of memberIds) store.transition(id, { pid });
            options.onProcessSpawn?.(pid);
          },
        }).then(
          (execution) => ({ group, execution, error: null }),
          (error: unknown) => ({ group, execution: null, error }),
        ),
      );
    }

    // A writer that is no longer offered must stop holding readers back. The
    // budgets cannot see that on their own: regrouping retires a leader id
    // when the group re-forms around a task that became ready meanwhile, and
    // the retired id would otherwise block every reader for the rest of the run.
    for (const id of refusedWriters) {
      if (offered.has(id) || inFlight.has(id)) continue;
      admission.release(id);
      refusedWriters.delete(id);
    }
  }

  /**
   * Should this process run again? (execution.md §Failure semantics.)
   *
   * The gate is the **classified failure**, not the exit code: `retry:"now"`
   * kinds (`network`, `timeout`, `schema`, a retryable crash) are the ones a
   * second attempt can clear. `quota`/`rate_limit` are `"later"` and
   * `auth`/`permission` are `"never"` — they consume no attempt at all, which
   * is what stops a run from spending its whole budget on a wall.
   */
  function retryPlan(group: LiveGroup, execution: GroupExecution): RetryPlan | null {
    if (maxRetries <= 0) return null;
    const casualty = group.members.findIndex(
      (_task, index) => (execution.results[index]?.status ?? 'failed') === 'failed',
    );
    if (casualty === -1) return null;

    const result = execution.results[casualty];
    const failure = classifyFailure({
      timedOut: execution.timedOut,
      exitCode: execution.exitCode,
      events: execution.events,
      errorMessage: result?.error?.message ?? 'task failed',
      retryable: result?.error?.retryable ?? true,
    });
    if (failure.retry !== 'now') return null;

    // `attempts` was incremented when this process was admitted, so it already
    // counts the attempt that just failed.
    const attempt = store.task(group.memberIds[casualty] as string)?.attempts ?? 1;
    if (attempt > maxRetries) return null;
    return { casualty, failure, attempt, delayMs: backoffMs(attempt) };
  }

  /**
   * Hand a failed process back to the scheduler.
   *
   * **The retryable unit is the process, and the retry starts at the
   * casualty.** Members the process got through before it are settled here
   * from what it reported and are never re-run — that work is banked. The
   * casualty and everything that was to follow it go back to `pending` and are
   * regrouped from scratch on a later pass, because in-group order is the
   * orchestrator's: a member after a task that is being redone has to be redone
   * with it, whatever the model said about it.
   *
   * The failed attempt's usage is recorded on the group leader and the next
   * attempt adds to it. Neither figure is counted twice — one process, one
   * usage record — and the run total still shows what the run actually cost.
   */
  function retryGroup(
    group: LiveGroup,
    execution: GroupExecution,
    plan: RetryPlan,
  ): void {
    const banked = group.members.slice(0, plan.casualty);
    if (banked.length > 0) {
      settleGroup(
        { ...group, members: banked, memberIds: group.memberIds.slice(0, plan.casualty) },
        // Usage is emptied here and added to the leader below, so a group whose
        // leader is not among the banked members still bills to one place.
        { ...execution, results: execution.results.slice(0, plan.casualty), usage: {} },
      );
    } else if (memoryEnabled) {
      // `settleGroup` folds a settled group into memory; with nothing banked
      // it did not run, and a failed attempt's dead ends are the most valuable
      // thing it leaves behind.
      recordObservations(group.memberIds, execution.observations);
    }
    addUsage(group.leaderId, execution);

    const retried: string[] = [];
    for (const id of group.memberIds.slice(plan.casualty)) {
      // A member the banked half parked or failed under is already `skipped`
      // and stays that way — its dependency did not happen.
      if (store.task(id)?.state !== 'running') continue;
      store.transition(id, resumeReset());
      holdUntil.set(id, Date.now() + plan.delayMs);
      retried.push(id);
    }
    if (retried.length === 0) return;

    logger.warn('task.retried', {
      task_id: retried[0] as string,
      group_id: group.grouped ? group.leaderId : null,
      tasks: retried,
      provider: group.provider,
      attempt: plan.attempt,
      backoff_ms: plan.delayMs,
      kind: plan.failure.kind,
      message: plan.failure.message,
    });
  }

  /** The attempt cost what it cost, whether or not it produced anything. */
  function addUsage(taskId: string, execution: GroupExecution): void {
    const prior = store.task(taskId);
    const usage = execution.usage;
    store.transition(taskId, {
      cost_usd: (prior?.cost_usd ?? 0) + (usage.cost_usd ?? 0),
      input_tokens: (prior?.input_tokens ?? 0) + (usage.input_tokens ?? 0),
      output_tokens: (prior?.output_tokens ?? 0) + (usage.output_tokens ?? 0),
      cached_input_tokens:
        (prior?.cached_input_tokens ?? 0) + (usage.cached_input_tokens ?? 0),
      cache_write_input_tokens:
        (prior?.cache_write_input_tokens ?? 0) + (usage.cache_write_input_tokens ?? 0),
    });
  }

  function held(taskId: string): boolean {
    const until = holdUntil.get(taskId);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    holdUntil.delete(taskId);
    return false;
  }

  /** When the earliest task waiting out a backoff may be offered, if any. */
  function earliestHold(): number | null {
    let earliest: number | null = null;
    for (const [id, until] of holdUntil) {
      if (store.task(id)?.state !== 'pending') continue;
      if (earliest === null || until < earliest) earliest = until;
    }
    return earliest;
  }

  // Deliberately not `unref`ed: a backoff is pending work, and a run that let
  // the event loop drain during one would exit without doing it.
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  function settleGroup(group: LiveGroup, execution: GroupExecution): void {
    const { leaderId, memberIds, members, provider, model, grouped, inGroup } = group;

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
      if (store.task(taskId)?.state === 'skipped') return;

      const result = execution.results[index] ?? missingResult(taskId);
      results.set(taskId, result);
      logger.debug('task.result.parsed', {
        task_id: taskId,
        status: result.status,
        notes: result.notes.length,
      });
      for (const note of result.notes) {
        logger.info('task.note', {
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
      //
      // Added to what the task already spent, never replacing it: a retried or
      // resumed attempt costs money the failed one also cost, and a total that
      // forgot the first attempt would under-report the run.
      const isLeader = index === 0;
      const prior = store.task(taskId);
      const usage = isLeader ? execution.usage : null;
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
        cost_usd: (prior?.cost_usd ?? 0) + (usage?.cost_usd ?? 0),
        input_tokens: (prior?.input_tokens ?? 0) + (usage?.input_tokens ?? 0),
        output_tokens: (prior?.output_tokens ?? 0) + (usage?.output_tokens ?? 0),
        cached_input_tokens:
          (prior?.cached_input_tokens ?? 0) + (usage?.cached_input_tokens ?? 0),
        cache_write_input_tokens:
          (prior?.cache_write_input_tokens ?? 0) + (usage?.cache_write_input_tokens ?? 0),
      };

      if (result.status === 'ok') {
        store.transition(taskId, { ...common, state: 'succeeded', failure: null });
        logger.info('task.succeeded', {
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
        options.onTaskSettled?.(taskId, 'succeeded', result);
        return;
      }

      if (result.status === 'needs_input') {
        // Escalation is M4. In M1 a question parks the task and stops its
        // branch — the question is reported rather than silently guessed at.
        store.transition(taskId, { ...common, state: 'parked' });
        logger.warn('task.parked', {
          task_id: taskId,
          provider,
          question: result.question?.text ?? '',
        });
        options.onTaskSettled?.(taskId, 'parked', result);
        markDescendantsSkipped(taskId, inGroup);
        return;
      }

      if (processFailed && firstFailureId !== null) {
        store.transition(taskId, {
          ...common,
          state: 'skipped',
          blocked_by: firstFailureId,
        });
        logger.warn('task.skipped', { task_id: taskId, blocked_by: firstFailureId });
        options.onTaskSettled?.(taskId, 'skipped', result);
        markDescendantsSkipped(taskId, inGroup);
        return;
      }
      firstFailureId ??= taskId;

      const failure = classifyFailure({
        timedOut: execution.timedOut,
        exitCode: execution.exitCode,
        events: execution.events,
        errorMessage: result.error?.message ?? 'task failed',
        retryable: result.error?.retryable ?? true,
      });
      store.transition(taskId, { ...common, state: 'failed', failure });
      logger.error('task.failed', {
        task_id: taskId,
        provider,
        kind: failure.kind,
        retry: failure.retry,
        exit_code: execution.exitCode,
        message: failure.message,
      });
      options.onTaskSettled?.(taskId, 'failed', result);
      markDescendantsSkipped(taskId, inGroup);
      if (failure.kind === 'quota') haltForQuota(taskId, failure);
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
    logger.debug('task.context.assembled', {
      task_id: task.id,
      upstream: upstreams.map((entry) => entry.taskId),
      strategy,
      inlined: context.filter((entry) => entry.inline !== null).length,
      bytes: context.reduce((sum, entry) => sum + (entry.inline?.length ?? 0), 0),
    });
    return {
      baya: PROTOCOL_VERSION,
      kind: 'task_request',
      run_id: store.get().run_id,
      task: { id: task.id, title: task.title, instruction: task.instruction },
      workspace: {
        cwd: task.cwd ?? options.cwd,
        access: task.access,
        isolation: 'shared',
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
        observations: changed.map((path) => ({ kind: 'write' as const, path })),
      });
      added = true;
    }
    if (added) writeMemorySnapshot();
  }

  /** Memory as it stands, for debugging a run and for measuring the feature. */
  function writeMemorySnapshot(): void {
    try {
      const entries = deriveMemory(observed, { cwd: options.cwd });
      writeFileSync(paths.memory, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    } catch {
      // A snapshot is a convenience. Never fail a run over one.
    }
  }

  function missingResult(taskId: string): TaskResult {
    return {
      baya: PROTOCOL_VERSION,
      kind: 'task_result',
      task_id: taskId,
      status: 'failed',
      summary: '',
      output: '',
      notes: [],
      question: null,
      error: {
        message: 'the provider returned no result for this task',
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
      state: 'failed',
      provider,
      model,
      ended_at: new Date().toISOString(),
      failure: {
        kind: 'crash',
        message,
        provider_code: null,
        status_code: null,
        retry: 'never',
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
        entry.state === 'pending' ||
        (entry.state === 'running' && inGroup.has(descendant));
      if (!settleable) continue;
      store.transition(descendant, { state: 'skipped', blocked_by: failedId });
      logger.warn('task.skipped', { task_id: descendant, blocked_by: failedId });
    }
  }

  /**
   * A `quota` failure halts the whole run (execution.md §Failure semantics):
   * admission stops (`admitReady` bails on `quotaHaltBy`), in-flight work is
   * left to drain, and every task still `pending` — independent branches
   * included — is `skipped` now, `blocked_by` the quota task.
   *
   * The skip carries that task's `failure`, which is what tells it apart from a
   * plain dependency skip (`markDescendantsSkipped` leaves `failure` null): the
   * report and `baya resume --provider` need "we stopped the run early" to read
   * differently from "an upstream of this task broke". The run stays resumable.
   */
  function haltForQuota(failedId: string, failure: Failure): void {
    if (quotaHaltBy !== null) return;
    quotaHaltBy = failedId;
    logger.warn('run.halted', {
      task_id: failedId,
      kind: failure.kind,
      message: failure.message,
    });
    for (const task of tasks) {
      if (store.task(task.id)?.state !== 'pending') continue;
      store.transition(task.id, {
        state: 'skipped',
        blocked_by: failedId,
        failure,
      });
      holdUntil.delete(task.id);
      logger.warn('task.skipped', {
        task_id: task.id,
        blocked_by: failedId,
        reason: 'run-halted-quota',
      });
    }
  }
}

/**
 * A dependency inside the same group has not run yet, so there is no result to
 * summarize — but it still belongs in the context, because the prompt has to
 * tell the agent that the upstream work is its own, a few sections above.
 *
 * ⚠️ This entry is written **before any of the group runs**, so it cannot know
 * how the dependency turned out. It used to claim `status: 'ok'` — "Done
 * earlier in this same conversation." — which was a guess that read as a fact.
 *
 * Run 20260903T080018Z: `scaffold-site` failed on a sandbox with no network,
 * and the two tasks grouped behind it read "(ok)" in their own context and did
 * their work anyway — editing the root tooling and running the root test
 * suite. `markDescendantsSkipped` then discarded both `ok` results, because
 * the DAG says work built on a failed dependency cannot be trusted. Paid for,
 * thrown away, and the files left on disk contradicting a state that said
 * `skipped`.
 *
 * So the status is `pending` and the prompt says what to do if it did not
 * succeed. A group cannot be steered from outside — it is one process, one
 * conversation — so the only lever is telling the truth in the prompt.
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
          status: 'pending',
          summary: 'Earlier task in this same batch — not yet run when this was written.',
          resultPath: paths.result(depId),
          outputPath: paths.output(depId),
          output: '',
        },
      ];
    }
    let output = result.output;
    if (output === '') {
      try {
        output = readFileSync(paths.output(depId), 'utf8');
      } catch {
        output = '';
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
