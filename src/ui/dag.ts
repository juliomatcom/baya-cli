import {
  routeProvider,
  type Manifest,
  type ProviderId,
  type Task,
} from "../manifest/index.js";
import { topoLayers } from "../graph/index.js";
import {
  DEFAULT_GROUP_SIZE,
  groupKey,
  projectGroups,
  type GroupCandidate,
} from "../executor/group.js";
import type { Theme } from "./theme.js";

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
 * The plan preview shown at the confirmation gate. Stages, not a tree: the
 * question the user is answering is "what runs, and what waits for what",
 * and a staged view answers it at a glance.
 *
 * "Stage" is the user-facing word for what `topoLayers` calls a layer, borrowed
 * from CI (GitLab, Jenkins, Azure) where it already means exactly this — a group
 * that runs together while the next one waits. The graph module keeps saying
 * "layer": there it names the algorithm, not the thing a person reads.
 *
 * The provider column shows the *resolved* provider — after model-alias
 * routing — so `model: "sonnet"` reads as `claude sonnet`, not `default`. A
 * pinned model is always shown: it is the thing most likely to be wrong, and
 * the gate is the last place to catch it before a request is spent.
 *
 * ## Grouping
 *
 * Stages answer "what waits for what"; they do not answer "what shares a
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
  const lines: string[] = [];

  // The resolved provider, shown in the provider column and keyed on for
  // grouping — one function so the two can never disagree.
  const providerOf = (task: Task): string =>
    defaultProvider ? routeProvider(task, defaultProvider) : (task.provider ?? "default");

  // The scheduler's key, built from the same defaults it will use: a task that
  // pins the run's own model or cwd groups with one that pins nothing, and
  // substituting `null` here instead would split them apart in the preview
  // only.
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
          cwd: task.cwd ?? options.cwd ?? "",
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
  // That is the `--group-size 1` view, and the view of a plan with no two
  // groupable tasks in it.
  const packed = groups.some((group) => group.members.length > 1);
  const full = groups.filter((group) => group.members.length >= cap && cap > 1);

  // The explainer earns its line only when some stage actually holds more than
  // one task; with one task per stage there is no independence to explain.
  //
  // It states a property of the **graph**, not a promise about execution. It
  // used to read "tasks in a stage don't wait on each other", which was false
  // twice over: the executor is sequential until M2.1, and grouping
  // deliberately puts a stage's tasks in one process to be worked through in
  // order (execution.md §Grouping). What is true, and is the useful half, is
  // that nothing here depends on anything else here — which is why they may
  // share a process, and why one failing does not skip the others.
  const hasIndependent = layers.some((layer) => layer.length > 1);
  lines.push(
    `  ${theme.taskId("Run order")} ${theme.note(
      `· ${layers.length} ${layers.length === 1 ? "stage" : "stages"}${
        packed
          ? ` · ${manifest.tasks.length} tasks → ${groups.length} ${
              groups.length === 1 ? "process" : "processes"
            }`
          : ""
      }${hasIndependent ? " · no dependencies within a stage" : ""}`,
    )}`,
    "",
  );

  layers.forEach((layer, index) => {
    lines.push(`  ${theme.note(`stage ${index + 1}`)}`);
    for (const id of layer) {
      const task = byId.get(id);
      if (!task) continue;
      const deps =
        task.depends_on.length > 0 ? theme.note(` ← ${task.depends_on.join(", ")}`) : "";
      // Only the tasks that may act are badged. Badging every read-only task
      // too would spend the reader's attention on the harmless majority.
      const access = task.access === "read-write" ? theme.warn(" read-write") : "";
      const provider = providerOf(task);
      const label = task.model ? `${provider} ${task.model}` : provider;
      const group = packed ? theme.note(` (group #${groupOf.get(id) ?? "?"})`) : "";
      lines.push(
        `    ${theme.status("pending")} ${theme.taskId(id.padEnd(16))} ${theme.provider(label.padEnd(18))} ${task.title}${access}${deps}${group}`,
      );
    }
  });

  if (packed) {
    lines.push(
      "",
      `  ${theme.note(
        "· a group is one process worked through in order · projected from this plan, so a failure re-forms the groups after it",
      )}`,
    );
    // The one thing a large group costs that a small one doesn't: the
    // scheduler commits to the whole group before the first task runs, so a
    // process that dies partway never reaches the rest.
    if (full.length > 0) {
      // Named while the list stays readable; counted once it doesn't. Which
      // group is full stops being the useful fact when most of them are.
      const which =
        full.length === 1
          ? `group #${full[0]?.index} fills`
          : full.length <= 3
            ? `groups ${full.map((group) => `#${group.index}`).join(", ")} fill`
            : `${full.length} groups fill`;
      lines.push(
        `  ${theme.status("warn")} ${theme.warn(
          `${which} --group-size ${cap} — the process is committed before its first task, so one that dies partway skips the members it never reached`,
        )}`,
      );
    }
  }

  return lines.join("\n");
}
