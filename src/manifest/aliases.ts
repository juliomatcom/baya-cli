import type { ProviderId, Task } from './schemas.js';

/**
 * Model-name → provider routing (M3.6).
 *
 * A task may name a model without a provider ("use sonnet"); this table says
 * which CLI serves it. Matching is deliberately generous on suffixes and
 * dates — `sonnet`, `claude-sonnet-4`, `sonnet-latest` all route to `claude` —
 * because model ids sprout version and date suffixes constantly and an exact
 * list would be stale within a week.
 *
 * The table never *silently* overrides an explicit `provider`: a task pairing
 * `provider: "codex"` with `model: "sonnet"` is a validation error with a
 * suggestion, not a quiet reassignment to `claude`.
 */

interface AliasRule {
  provider: ProviderId;
  /** Lowercased substrings; a hit on any one routes the model. */
  tokens: string[];
}

const RULES: readonly AliasRule[] = [
  { provider: 'claude', tokens: ['claude', 'sonnet', 'opus', 'haiku'] },
  { provider: 'codex', tokens: ['codex', 'gpt-', 'gpt4', 'gpt5', 'o1-', 'o3-', 'o4-'] },
];

/** Verified but deferred to v1.1 (providers.md) — route to a clear error, not a guess. */
const DEFERRED_TOKENS: readonly string[] = ['gemini', 'bard'];

export function providerForModel(model: string | null): ProviderId | null {
  if (model === null) return null;
  const lower = model.toLowerCase();
  for (const rule of RULES) {
    if (rule.tokens.some((token) => lower.includes(token))) return rule.provider;
  }
  return null;
}

export function isDeferredModel(model: string | null): boolean {
  if (model === null) return false;
  const lower = model.toLowerCase();
  return DEFERRED_TOKENS.some((token) => lower.includes(token));
}

/**
 * The provider a task actually runs on: an explicit `provider` wins, then the
 * model alias, then the run default. Used by the executor after validation has
 * already rejected an explicit provider/model mismatch.
 */
export function routeProvider(task: Task, runDefault: ProviderId): ProviderId {
  return task.provider ?? providerForModel(task.model) ?? runDefault;
}

export interface ModelRoutingIssue {
  taskId: string;
  message: string;
}

/**
 * Validation-time checks (protocol.md §1, M3.6). Returns one issue per task
 * that names a model Baya cannot honor as written.
 */
export function checkModelRouting(
  tasks: readonly Task[],
  allowlist: readonly ProviderId[],
): ModelRoutingIssue[] {
  const issues: ModelRoutingIssue[] = [];
  for (const task of tasks) {
    if (task.model === null) continue;

    if (isDeferredModel(task.model)) {
      issues.push({
        taskId: task.id,
        message: `task "${task.id}" names model "${task.model}", whose provider is not in this release. Choose a codex or claude model.`,
      });
      continue;
    }

    const inferred = providerForModel(task.model);

    if (task.provider !== null && inferred !== null && inferred !== task.provider) {
      issues.push({
        taskId: task.id,
        message: `task "${task.id}" pairs provider "${task.provider}" with model "${task.model}", which is a ${inferred} model. Set provider to "${inferred}", or pick a ${task.provider} model.`,
      });
      continue;
    }

    if (task.provider === null && inferred !== null && !allowlist.includes(inferred)) {
      issues.push({
        taskId: task.id,
        message: `task "${task.id}" names model "${task.model}", which routes to "${inferred}" — not in the allowlist [${allowlist.join(', ')}].`,
      });
    }
  }
  return issues;
}
