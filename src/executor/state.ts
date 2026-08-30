import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { z } from "zod";
import { NoteSchema, ProviderIdSchema, SourceSchema } from "../manifest/index.js";

/**
 * `state.json` (recovery.md). Rewritten atomically after **every** transition
 * and, per conventions.md #14, **before** the action it describes is taken — a
 * crash must never lose a transition, and a run is expensive enough that
 * redoing finished work is a real cost, not a tidiness concern.
 */
export const STATE_VERSION = 1;

export const TASK_STATES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "parked",
] as const;
export const TaskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const FAILURE_KINDS = [
  "quota",
  "rate_limit",
  "auth",
  "network",
  "timeout",
  "permission",
  "schema",
  "crash",
  "interrupted",
] as const;

export const FailureSchema = z
  .object({
    kind: z.enum(FAILURE_KINDS),
    message: z.string(),
    provider_code: z.string().nullable().default(null),
    status_code: z.number().nullable().default(null),
    retry: z.enum(["now", "later", "never"]),
    occurred_at: z.string(),
  })
  .strict();
export type Failure = z.infer<typeof FailureSchema>;

export const TaskStateEntrySchema = z
  .object({
    state: TaskStateSchema,
    provider: ProviderIdSchema.nullable().default(null),
    model: z.string().nullable().default(null),
    session_id: z.string().nullable().default(null),
    attempts: z.number().int().default(0),
    started_at: z.string().nullable().default(null),
    ended_at: z.string().nullable().default(null),
    duration_ms: z.number().nullable().default(null),
    exit_code: z.number().nullable().default(null),
    pid: z.number().nullable().default(null),
    failure: FailureSchema.nullable().default(null),
    artifacts: z.record(z.string(), z.string()).default({}),
    notes: z.array(NoteSchema).default([]),
    files_changed: z.array(z.string()).default([]),
    cost_usd: z.number().default(0),
    input_tokens: z.number().default(0),
    output_tokens: z.number().default(0),
    /**
     * Parts of `input_tokens`, kept separate because they are priced
     * differently — a cache read costs about a tenth of fresh input, a cache
     * write more than it. Fresh input is the remainder.
     */
    cached_input_tokens: z.number().default(0),
    cache_write_input_tokens: z.number().default(0),
    /** Which rung of the degradation ladder produced the result. */
    result_rung: z.string().nullable().default(null),
    /** For `skipped`: the failed ancestor that caused it. */
    blocked_by: z.string().nullable().default(null),
    /**
     * The task group this task ran in — the id of the group's first task
     * (execution.md §Grouping). A group is one provider process serving
     * several tasks, so its cost and its event stream belong to the group,
     * not to any one member: usage is recorded on the first member and every
     * member's `artifacts` point at the same stream. `null` means this task
     * had a process to itself.
     */
    group_id: z.string().nullable().default(null),
  })
  .strict();
export type TaskStateEntry = z.infer<typeof TaskStateEntrySchema>;

export const ConfigSnapshotSchema = z
  .object({
    planner: z.object({
      provider: ProviderIdSchema.nullable(),
      model: z.string().nullable(),
    }),
    defaults: z.object({
      provider: ProviderIdSchema.nullable(),
      model: z.string().nullable(),
    }),
    max_parallel: z.number().int(),
    isolation: z.string(),
    context_strategy: z.string(),
    context_budget: z.number().int(),
    /** Cross-task memory settings, so a run can be compared against `--no-memory`. */
    memory: z.boolean().default(true),
    memory_budget: z.number().int().default(0),
    /** Max tasks per provider process. `1` restores one process per task. */
    group_size: z.number().int().default(1),
  })
  .strict();
export type ConfigSnapshot = z.infer<typeof ConfigSnapshotSchema>;

export const RunStateSchema = z
  .object({
    version: z.literal(STATE_VERSION),
    run_id: z.string(),
    status: z.enum(["running", "completed", "failed", "interrupted"]),
    started_at: z.string(),
    updated_at: z.string(),
    source: SourceSchema,
    manifest_path: z.string(),
    config_snapshot: ConfigSnapshotSchema,
    totals: z
      .object({
        succeeded: z.number().int(),
        failed: z.number().int(),
        skipped: z.number().int(),
        parked: z.number().int(),
        pending: z.number().int(),
        running: z.number().int(),
        cost_usd: z.number(),
        input_tokens: z.number().default(0),
        output_tokens: z.number().default(0),
        cached_input_tokens: z.number().default(0),
        cache_write_input_tokens: z.number().default(0),
      })
      .strict(),
    tasks: z.record(z.string(), TaskStateEntrySchema),
  })
  .strict();
export type RunState = z.infer<typeof RunStateSchema>;

export function emptyTaskEntry(overrides: Partial<TaskStateEntry> = {}): TaskStateEntry {
  return TaskStateEntrySchema.parse({ state: "pending", ...overrides });
}

function recomputeTotals(state: RunState): void {
  const totals = {
    succeeded: 0,
    failed: 0,
    skipped: 0,
    parked: 0,
    pending: 0,
    running: 0,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
  };
  for (const entry of Object.values(state.tasks)) {
    totals.cost_usd += entry.cost_usd;
    totals.input_tokens += entry.input_tokens;
    totals.output_tokens += entry.output_tokens;
    totals.cached_input_tokens += entry.cached_input_tokens;
    totals.cache_write_input_tokens += entry.cache_write_input_tokens;
    if (entry.state in totals) {
      totals[entry.state as keyof typeof totals] += 1;
    }
  }
  // Float accumulation over dozens of tasks otherwise renders as $0.42000000000000004.
  totals.cost_usd = Math.round(totals.cost_usd * 1e6) / 1e6;
  state.totals = totals;
}

/**
 * Owns the only writes to `state.json`. `tmp` + `rename` is atomic on POSIX,
 * so a reader — `baya runs`, or the next process after a crash — sees either
 * the previous checkpoint or the next one, never a half-written file.
 */
export class StateStore {
  private state: RunState;

  constructor(
    private readonly path: string,
    initial: RunState,
    /** Fires after every successful write — the `state.checkpointed` trace event. */
    private readonly onCheckpoint?: (state: Readonly<RunState>) => void,
  ) {
    this.state = initial;
    recomputeTotals(this.state);
  }

  get(): Readonly<RunState> {
    return this.state;
  }

  task(taskId: string): TaskStateEntry | undefined {
    return this.state.tasks[taskId];
  }

  /** Mutate, recompute totals, stamp `updated_at`, then checkpoint. */
  update(mutate: (state: RunState) => void): void {
    mutate(this.state);
    recomputeTotals(this.state);
    this.state.updated_at = new Date().toISOString();
    this.checkpoint();
  }

  transition(taskId: string, patch: Partial<TaskStateEntry>): void {
    this.update((state) => {
      const current = state.tasks[taskId] ?? emptyTaskEntry();
      state.tasks[taskId] = { ...current, ...patch };
    });
  }

  setStatus(status: RunState["status"]): void {
    this.update((state) => {
      state.status = status;
    });
  }

  checkpoint(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    renameSync(tmp, this.path);
    this.onCheckpoint?.(this.state);
  }
}

/**
 * Never silently starts fresh on a malformed file — that would re-spend money
 * already spent. The caller reports the path and stops.
 */
export function readState(path: string): RunState {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return RunStateSchema.parse(parsed);
}

/** Artifact paths are stored relative to the run directory so a run stays movable. */
export function relativeArtifacts(
  runDir: string,
  paths: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(paths).map(([key, value]) => [key, relative(runDir, value)]),
  );
}
