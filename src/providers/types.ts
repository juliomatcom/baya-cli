import type {
  ProviderEvent,
  ProviderId,
  Task,
  TaskRequest,
  TaskResult,
} from "../manifest/index.js";
import type { Observation } from "../memory/index.js";

/** Adapter interface (providers.md §Adapter interface). */
export interface ProviderCapabilities {
  /** Ordered preference. The executor uses the first the task supports. */
  promptDelivery: Array<"file" | "stdin" | "argv">;
  structuredOutput: "schema-file" | "schema-inline" | "none";
  events: "jsonl" | "json" | "none";
  sessionId: "preassign" | "capture";
  resume: "session" | "none";
  /**
   * Where this provider's record of what its agent *did* can be read from
   * (execution.md §Memory). `events` means Baya's own `events.jsonl` already
   * holds it; `transcript` means the provider keeps its own log and
   * `transcriptPath` names it; `none` means the provider contributes no
   * observations and only consumes memory.
   */
  observations: "events" | "transcript" | "none";
  cwdFlag: boolean;
  modelFlag: boolean;
  /** Conservative by default — these run on consumer subscriptions that throttle. */
  maxConcurrency: number;
}

export interface ResolvedProvider {
  bin: string;
  version: string;
  /** Which link of the resolution chain produced `bin`. */
  source: "config" | "path" | "known-location";
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
}

/**
 * A spawn plan: `argv` as an array, never a command string. `shell: true` is
 * banned repo-wide and lint-enforced (conventions.md #1).
 */
export interface SpawnPlan {
  argv: string[];
  cwd: string;
  /** Never `inherit` — an inherited stdin stalls `claude -p` for 3s per task. */
  stdin: "pipe" | "ignore";
  /** Written to the child's stdin when `stdin: 'pipe'`. */
  stdinData?: string;
  /** Files the adapter needs on disk before the spawn, e.g. a prompt file. */
  files?: Array<{ path: string; contents: string }>;
}

export interface ExtractContext {
  taskId: string;
  events: ProviderEvent[];
  /** Contents of `resultFile` when the provider wrote one, else null. */
  resultFileContents: string | null;
  exitCode: number | null;
  stderr: string;
  /**
   * Contents of the provider's own session log for `observations: 'transcript'`
   * adapters. Absent or null is normal, never an error — a missing transcript
   * thins memory and nothing more, so no adapter may depend on it.
   */
  transcript?: string | null;
}

export interface ProviderUsage {
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
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
   * Run the **next task** as another turn in an existing session
   * (execution.md §Session reuse). Distinct from `buildResume`, which answers
   * an escalation: this one carries a whole new `task_request`, so the prompt
   * has to re-state the response contract.
   *
   * Absent => this provider never joins a chain, and its tasks always start
   * cold. That is the honest default for an adapter whose resume path has not
   * been exercised.
   */
  buildContinue?(sessionId: string, input: BuildRunInput): SpawnPlan;
  /** Absolute path to the provider's own session log, for `observations: 'transcript'`. */
  transcriptPath?(sessionId: string): string | null;
  /**
   * What the agent did, normalized. Never self-reported by the model — every
   * observation is read back out of a record the provider already wrote, so
   * this costs no tokens and cannot be hallucinated.
   */
  extractObservations?(ctx: ExtractContext): Observation[];
  /** Fed complete lines by the executor; partial-line buffering is not the adapter's job. */
  parseEvents(chunk: string): ProviderEvent[];
  extractResult(ctx: ExtractContext): TaskResult;
  extractUsage?(events: ProviderEvent[]): ProviderUsage;
}

export type { ProviderId, TaskResult, ProviderEvent, Observation };
