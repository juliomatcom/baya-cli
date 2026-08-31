import {
  routeProvider,
  type Manifest,
  type ProviderId,
  type Task,
} from '../manifest/index.js';
import { topoLayers } from '../graph/index.js';
import {
  DEFAULT_GROUP_SIZE,
  groupKey,
  projectGroups,
  type GroupCandidate,
} from '../executor/group.js';
import type { Theme } from './theme.js';

/** What the gate needs to key tasks the way the scheduler will. */
export interface DagOptions {
  /** The run default, applied to every task that pins no model of its own. */
  defaultModel?: string | null;
  /** The run's working directory, applied to every task that pins no `cwd`. */
  cwd?: string;
  /** `--group-size`. */
  groupSize?: number;
}

/**
 * The plan preview shown at the confirmation gate: the task DAG drawn as a
 * tree, each parent above its children, so "what waits for what" is the shape
 * of the thing rather than a column of `← dep` notes. A task with more than one
 * parent is drawn in full under the first and marked `(shown above)` under the
 * rest — the repeat is the point, it shows a dependency two branches share.
 *
 * The provider column shows the *resolved* provider — after model-alias
 * routing — so `model: "sonnet"` reads as `claude sonnet`, not `default`. A
 * pinned model is always shown: it is the thing most likely to be wrong, and
 * the gate is the last place to catch it before a request is spent.
 *
 * ## Grouping
 *
 * The tree answers "what waits for what"; it does not answer "what shares a
 * process", which is the other half of what the user is agreeing to and the
 * half that costs money and bounds blast radius. So each task also carries the
 * group it is projected into, and the header counts processes against tasks.
 *
 * The projection replays the scheduler (`projectGroups`) rather than
 * reimplementing the rule, so the preview cannot drift from execution. It is
 * still a projection: only the first group is guaranteed, because a failed or
 * parked task skips its descendants and re-forms every group after it.
 */
export function renderDag(
  manifest: Manifest,
  theme: Theme,
  defaultProvider?: ProviderId,
  options: DagOptions = {},
): string {
  const nodes = manifest.tasks.map((task) => ({
    id: task.id,
    depends_on: task.depends_on,
  }));
  const layers = topoLayers(nodes);
  const byId = new Map(manifest.tasks.map((task) => [task.id, task]));

  // The resolved provider, shown in the provider column and keyed on for
  // grouping — one function so the two can never disagree.
  const providerOf = (task: Task): string =>
    defaultProvider ? routeProvider(task, defaultProvider) : (task.provider ?? 'default');

  // The scheduler's key, built from the same defaults it will use: a task that
  // pins the run's own model or cwd groups with one that pins nothing.
  const cap = Math.max(1, options.groupSize ?? DEFAULT_GROUP_SIZE);
  const candidates = new Map<string, GroupCandidate>(
    manifest.tasks.map((task) => [
      task.id,
      {
        id: task.id,
        depends_on: task.depends_on,
        key: groupKey({
          provider: providerOf(task),
          model: task.model ?? options.defaultModel ?? null,
          access: task.access,
          cwd: task.cwd ?? options.cwd ?? '',
        }),
      },
    ]),
  );
  const groups = projectGroups(nodes, candidates, cap);
  const groupOf = new Map<string, number>();
  for (const group of groups) {
    for (const id of group.members) groupOf.set(id, group.index);
  }
  // With nothing packed, every task is its own process: the numbers would
  // repeat what the task list already says, so they are not printed at all.
  const packed = groups.some((group) => group.members.length > 1);
  const full = groups.filter((group) => group.members.length >= cap && cap > 1);

  // Children in manifest order, so the plan renders and runs identically each time.
  const childrenOf = new Map<string, string[]>(manifest.tasks.map((t) => [t.id, []]));
  for (const task of manifest.tasks) {
    for (const dep of task.depends_on) childrenOf.get(dep)?.push(task.id);
  }
  const roots = manifest.tasks
    .filter((task) => task.depends_on.length === 0)
    .map((task) => task.id);

  interface Row {
    /** The tree scaffold: prefix + connector + id, measured for column alignment. */
    scaffold: string;
    task: Task;
    /** A second-or-later appearance of a task with more than one parent. */
    ref: boolean;
  }
  const rows: Row[] = [];
  const visited = new Set<string>();

  const walk = (id: string, prefix: string, last: boolean): void => {
    const task = byId.get(id);
    if (!task) return;
    const connector = last ? '└─ ' : '├─ ';
    const seen = visited.has(id);
    rows.push({ scaffold: `${prefix}${connector}${id}`, task, ref: seen });
    if (seen) return;
    visited.add(id);
    const kids = childrenOf.get(id) ?? [];
    const childPrefix = prefix + (last ? '   ' : '│  ');
    kids.forEach((kid, index) => walk(kid, childPrefix, index === kids.length - 1));
  };
  roots.forEach((root, index) => walk(root, '  ', index === roots.length - 1));

  const width = Math.max(0, ...rows.map((row) => row.scaffold.length));
  const lines: string[] = [];

  const taskCount = `${manifest.tasks.length} ${manifest.tasks.length === 1 ? 'task' : 'tasks'}`;
  const stageCount = `${layers.length} ${layers.length === 1 ? 'stage' : 'stages'}`;
  lines.push(
    `  ${theme.taskId('Run order')} ${theme.note(
      `· ${taskCount} · ${stageCount}${
        packed
          ? ` · ${groups.length} ${groups.length === 1 ? 'process' : 'processes'}`
          : ''
      }`,
    )}`,
    '',
  );

  for (const row of rows) {
    const pad = ' '.repeat(width - row.scaffold.length + 2);
    const tree = row.scaffold.slice(0, row.scaffold.length - row.task.id.length);
    const scaffold = `${theme.note(tree)}${theme.taskId(row.task.id)}${pad}`;
    if (row.ref) {
      lines.push(`${scaffold}${theme.note('(shown above)')}`);
      continue;
    }
    const provider = providerOf(row.task);
    const label = row.task.model ? `${provider} ${row.task.model}` : provider;
    // Only the tasks that may act are badged. Badging every read-only task too
    // would spend the reader's attention on the harmless majority.
    const access = row.task.access === 'read-write' ? theme.warn('  read-write') : '';
    const group = packed
      ? theme.note(`  (group #${groupOf.get(row.task.id) ?? '?'})`)
      : '';
    lines.push(
      `${scaffold}${theme.provider(label.padEnd(18))} ${row.task.title}${access}${group}`,
    );
  }

  if (packed) {
    lines.push(
      '',
      `  ${theme.note(
        '· a group is one process worked through in order · projected from this plan, so a failure re-forms the groups after it',
      )}`,
    );
    // The one thing a large group costs that a small one doesn't: the scheduler
    // commits to the whole group before the first task runs, so a process that
    // dies partway never reaches the rest.
    if (full.length > 0) {
      const which =
        full.length === 1
          ? `group #${full[0]?.index} fills`
          : full.length <= 3
            ? `groups ${full.map((group) => `#${group.index}`).join(', ')} fill`
            : `${full.length} groups fill`;
      lines.push(
        `  ${theme.status('warn')} ${theme.warn(
          `${which} --group-size ${cap} — the process is committed before its first task, so one that dies partway skips the members it never reached`,
        )}`,
      );
    }
  }

  return lines.join('\n');
}
