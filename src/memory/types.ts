/**
 * Cross-task memory (execution.md §Memory). The types here are deliberately
 * poorer than what any single provider reports: an `Observation` is the
 * intersection of what `codex` and `claude` can both be made to say, so
 * everything downstream of the adapters is provider-blind.
 */

/**
 * One thing a task's agent actually did. Derived from a provider's own record
 * — never self-reported by the model, so nothing here costs an output token
 * and nothing here can be hallucinated.
 */
export type Observation =
  | { kind: "command"; command: string; ok: boolean }
  | { kind: "read"; path: string }
  | { kind: "write"; path: string };

/** Everything one finished task observed, tagged with who observed it. */
export interface TaskObservations {
  taskId: string;
  observations: readonly Observation[];
}

export type MemoryKind =
  "command.deadend" | "command.verified" | "file.changed" | "file.hot";

/**
 * A fact, keyed. `key` is what makes this a store rather than an append-only
 * log: a later task's entry **replaces** an earlier one with the same key, so
 * memory cannot accumulate two contradictory answers to the same question.
 */
export interface MemoryEntry {
  kind: MemoryKind;
  key: string;
  value: string;
  /**
   * Tasks that contributed. Used to drop an entry whose every source is
   * already visible in a continued session — re-stating it there is waste.
   */
  sources: string[];
}
