import type {
  ProviderEvent,
  ProviderId,
  Task,
  TaskRequest,
  TaskResult,
} from '../manifest/index.js';
import type { Observation } from '../memory/index.js';
import type { ToolCapability } from './tools.js';

/** Adapter interface (providers.md §Adapter interface). */
export interface ProviderCapabilities {
  /** Ordered preference. The executor uses the first the task supports. */
  promptDelivery: Array<'file' | 'stdin' | 'argv'>;
  structuredOutput: 'schema-file' | 'schema-inline' | 'none';
  events: 'jsonl' | 'json' | 'none';
  sessionId: 'preassign' | 'capture';
  resume: 'session' | 'none';
  /**
   * Whether this provider's own event stream records what its agent *did*
   * (execution.md §Memory). `events` means Baya's `events.jsonl` already holds
   * it, from a documented `--json`-style stream. `none` means the provider
   * contributes no command observations and only consumes memory.
   *
   * Deliberately the only source. Reading a provider's private session log
   * off disk was tried and removed: the path was undocumented, it worked for
   * exactly one provider, and it made memory's quality depend on a file
   * nobody promises to keep. `files_changed` in the protocol result carries
   * the cross-provider half instead.
   */
  observations: 'events' | 'none';
  cwdFlag: boolean;
  modelFlag: boolean;
  /** Conservative by default — these run on consumer subscriptions that throttle. */
  maxConcurrency: number;
}

export interface ResolvedProvider {
  bin: string;
  version: string;
  /** Which link of the resolution chain produced `bin`. */
  source: 'config' | 'path' | 'known-location';
}

export interface BuildRunInput {
  /** Absolute path to the resolved binary. Adapters never guess a name. */
  bin: string;
  task: Task;
  request: TaskRequest;
  /** `null` => the provider's own default. Never hard-code a model id. */
  model: string | null;
  /** Working directory for the spawn; also the value of a `cwd` flag where one exists. */
  cwd: string;
  /** `.baya/schema/task_result.schema.json`, for providers that take a schema **file**. */
  schemaPath: string;
  /**
   * The schema document itself, for providers that take it **inline** (`claude
   * --json-schema` rejects a file path). Same contents as `schemaPath` names.
   */
  schemaContents: string;
  /** Where a `schema-file` provider should leave its conforming JSON. */
  resultFile: string;
  /** The rendered prompt. Delivered by file, stdin, or argv per capabilities. */
  prompt: string;
  /** Pre-assigned session id, for `sessionId: 'preassign'` providers. */
  sessionId?: string;
  dangerouslyAllowAll?: boolean;
  /** Restored on top of the lean set. providers.md §Lean tool sets. */
  tools?: readonly ToolCapability[];
  /** No tool use at all — distinct from empty `tools`, which grants the lean base. */
  noTools?: boolean;
  /** Raw argv, appended after adapter flags and before any prompt positional. */
  extraArgs?: readonly string[];
}

/**
 * A spawn plan: `argv` as an array, never a command string. `shell: true` is
 * banned repo-wide and lint-enforced (conventions.md #1).
 */
export interface SpawnPlan {
  argv: string[];
  cwd: string;
  /** Never `inherit` — an inherited stdin stalls `claude -p` for 3s per task. */
  stdin: 'pipe' | 'ignore';
  /** Written to the child's stdin when `stdin: 'pipe'`. */
  stdinData?: string;
  /** Files the adapter needs on disk before the spawn, e.g. a prompt file. */
  files?: Array<{ path: string; contents: string }>;
  /** ⚠️ Merged over the inherited env, never replacing it — credentials live there. */
  env?: Record<string, string>;
}

export interface ExtractContext {
  /**
   * Every task this process was given, in order (execution.md §Grouping).
   * Length 1 unless the scheduler grouped it, and the whole ladder in
   * `result.ts` keys off that length — one task keeps the single-object wire
   * format exactly as it was.
   */
  taskIds: readonly string[];
  events: ProviderEvent[];
  /** Contents of `resultFile` when the provider wrote one, else null. */
  resultFileContents: string | null;
  exitCode: number | null;
  stderr: string;
}

/**
 * Input tokens come at three prices — fresh, written-to-cache (a premium), and
 * read-from-cache (about a tenth). Collapsing them into one number is what made
 * a run that cost *more* look 52% cheaper, so all three are kept.
 *
 * `input_tokens` stays the gross total, of which `cache_write_input_tokens` and
 * `cached_input_tokens` are parts; fresh input is the remainder.
 */
export interface ProviderUsage {
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  /** Input served from the provider's prompt cache (cheapest). */
  cached_input_tokens?: number;
  /** Input written into the cache (dearer than fresh input on Anthropic). */
  cache_write_input_tokens?: number;
}

export interface ProviderAdapter {
  id: ProviderId;
  capabilities: ProviderCapabilities;
  /** Shown by `doctor` and the wizard when the binary is missing. */
  installHint: string;
  /** Extra directories to search beyond the shared chain, e.g. `~/.opencode/bin`. */
  knownLocations?: string[];
  buildRun(input: BuildRunInput): SpawnPlan;
  buildResume(sessionId: string, answer: string, input: BuildRunInput): SpawnPlan;
  /**
   * What the agent did, normalized. Never self-reported by the model — every
   * observation is read back out of a record the provider already wrote, so
   * this costs no tokens and cannot be hallucinated.
   */
  extractObservations?(ctx: ExtractContext): Observation[];
  /** Fed complete lines by the executor; partial-line buffering is not the adapter's job. */
  parseEvents(chunk: string): ProviderEvent[];
  /**
   * One result per entry in `ctx.taskIds`, in that order. An adapter says
   * where this provider put the answer; `result.ts` settles whether that
   * answer is one `task_result` or a `task_result_batch`.
   */
  extractResults(ctx: ExtractContext): TaskResult[];
  extractUsage?(events: ProviderEvent[]): ProviderUsage;
}

export type { ProviderId, TaskResult, ProviderEvent, Observation };
