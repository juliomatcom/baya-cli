import { checkModelRouting } from './aliases.js';
import {
  ManifestSchema,
  PROVIDER_IDS,
  TASK_ID_PATTERN,
  type Manifest,
  type ProviderId,
  type Task,
} from './schemas.js';

/**
 * Manifest validation (protocol.md §1). Pure — no I/O, no clock, no spawn —
 * which is why it carries the bulk of the test coverage.
 */
export type ValidationCode =
  | 'schema'
  | 'id_format'
  | 'id_duplicate'
  | 'dep_unresolved'
  | 'dep_cycle'
  | 'provider_not_allowed'
  | 'model_routing'
  | 'too_many_tasks';

export interface ValidationError {
  code: ValidationCode;
  message: string;
  taskId?: string;
  /** For `dep_cycle`: the cycle as a closed path, e.g. `a -> b -> a`. */
  path?: string[];
}

export interface ValidateOptions {
  /** Providers this machine will accept. Defaults to the full closed enum. */
  allowlist?: readonly ProviderId[];
  maxTasks?: number;
}

export const DEFAULT_MAX_TASKS = 50;

export type ValidateResult =
  { ok: true; manifest: Manifest } | { ok: false; errors: ValidationError[] };

/**
 * Reports every error within a stage, then stops. Stages are ordered so later
 * checks can assume earlier invariants: cycle detection would be meaningless
 * over unresolved dependencies, and duplicate ids make an adjacency map lie.
 */
export function validateManifest(
  input: unknown,
  options: ValidateOptions = {},
): ValidateResult {
  const allowlist = options.allowlist ?? PROVIDER_IDS;
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;

  const parsed = ManifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: 'schema' as const,
        message: `${issue.path.join('.') || '<root>'}: ${issue.message}`,
      })),
    };
  }
  const manifest = parsed.data;
  const { tasks } = manifest;

  const staged: Array<ValidationError[]> = [
    checkIdFormat(tasks),
    checkIdUniqueness(tasks),
    checkDepsResolve(tasks),
    checkAcyclic(tasks),
    checkProviders(tasks, allowlist),
    checkModelAliases(tasks, allowlist),
    checkTaskCount(tasks, maxTasks),
  ];
  for (const errors of staged) {
    if (errors.length > 0) return { ok: false, errors };
  }

  return { ok: true, manifest };
}

function checkIdFormat(tasks: Task[]): ValidationError[] {
  return tasks
    .filter((task) => !TASK_ID_PATTERN.test(task.id))
    .map((task) => ({
      code: 'id_format' as const,
      taskId: task.id,
      message: `task id "${task.id}" must be kebab-case matching ${TASK_ID_PATTERN.source}`,
    }));
}

function checkIdUniqueness(tasks: Task[]): ValidationError[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) duplicated.add(task.id);
    seen.add(task.id);
  }
  return [...duplicated].map((id) => ({
    code: 'id_duplicate' as const,
    taskId: id,
    message: `duplicate task id "${id}"`,
  }));
}

function checkDepsResolve(tasks: Task[]): ValidationError[] {
  const ids = new Set(tasks.map((task) => task.id));
  const errors: ValidationError[] = [];
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      if (!ids.has(dep)) {
        errors.push({
          code: 'dep_unresolved',
          taskId: task.id,
          message: `task "${task.id}" depends on unknown task "${dep}"`,
        });
      }
    }
  }
  return errors;
}

/**
 * Kahn's algorithm finds *that* a cycle exists; it does not say which nodes
 * form it. The leftover set can be much larger than the cycle, so we walk it
 * once with a DFS to recover a concrete path — an error naming `a -> b -> a`
 * is actionable, "the graph has a cycle" is not.
 */
function checkAcyclic(tasks: Task[]): ValidationError[] {
  const deps = new Map(tasks.map((task) => [task.id, task.depends_on]));
  const indegree = new Map(tasks.map((task) => [task.id, task.depends_on.length]));
  const dependents = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dep of task.depends_on) {
      dependents.get(dep)?.push(task.id);
    }
  }

  const queue = tasks.filter((task) => task.depends_on.length === 0).map((t) => t.id);
  let settled = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    settled += 1;
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (settled === tasks.length) return [];

  const cycle = findCycle(
    tasks.filter((task) => (indegree.get(task.id) ?? 0) > 0).map((t) => t.id),
    deps,
  );
  return [
    {
      code: 'dep_cycle',
      message: `dependency cycle: ${cycle.join(' -> ')}`,
      ...(cycle.length > 0 ? { path: cycle } : {}),
    },
  ];
}

/** Iterative DFS over the unsettled nodes; returns the cycle as a closed path. */
function findCycle(candidates: string[], deps: Map<string, string[]>): string[] {
  const state = new Map<string, 'open' | 'closed'>();
  const stack: string[] = [];

  const visit = (start: string): string[] | null => {
    const frames: Array<{ id: string; queue: string[] }> = [
      { id: start, queue: [...(deps.get(start) ?? [])] },
    ];
    state.set(start, 'open');
    stack.push(start);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as { id: string; queue: string[] };
      const next = frame.queue.shift();
      if (next === undefined) {
        state.set(frame.id, 'closed');
        stack.pop();
        frames.pop();
        continue;
      }
      if (state.get(next) === 'open') {
        const from = stack.indexOf(next);
        return [...stack.slice(from), next];
      }
      if (state.get(next) === 'closed' || !deps.has(next)) continue;
      state.set(next, 'open');
      stack.push(next);
      frames.push({ id: next, queue: [...(deps.get(next) ?? [])] });
    }
    return null;
  };

  for (const id of candidates) {
    if (state.has(id)) continue;
    const found = visit(id);
    if (found) return found;
  }
  return [];
}

function checkProviders(
  tasks: Task[],
  allowlist: readonly ProviderId[],
): ValidationError[] {
  return tasks
    .filter((task) => task.provider !== null && !allowlist.includes(task.provider))
    .map((task) => ({
      code: 'provider_not_allowed' as const,
      taskId: task.id,
      message: `task "${task.id}" names provider "${task.provider as string}", not in the allowlist [${allowlist.join(', ')}]`,
    }));
}

/**
 * Model → provider routing (M3.6). A model that belongs to a different provider
 * than the one named, or to a provider not in this release, is an error with a
 * concrete suggestion — never a silent reassignment.
 */
function checkModelAliases(
  tasks: Task[],
  allowlist: readonly ProviderId[],
): ValidationError[] {
  return checkModelRouting(tasks, allowlist).map((issue) => ({
    code: 'model_routing' as const,
    taskId: issue.taskId,
    message: issue.message,
  }));
}

function checkTaskCount(tasks: Task[], maxTasks: number): ValidationError[] {
  if (tasks.length <= maxTasks) return [];
  return [
    {
      code: 'too_many_tasks',
      message: `plan has ${tasks.length} tasks, above the --max-tasks limit of ${maxTasks}`,
    },
  ];
}
