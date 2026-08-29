import { routeProvider, type Manifest, type ProviderId } from "../manifest/index.js";
import { topoLayers } from "../graph/index.js";
import type { Theme } from "./theme.js";

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
 */
export function renderDag(
  manifest: Manifest,
  theme: Theme,
  defaultProvider?: ProviderId,
): string {
  const layers = topoLayers(
    manifest.tasks.map((task) => ({ id: task.id, depends_on: task.depends_on })),
  );
  const byId = new Map(manifest.tasks.map((task) => [task.id, task]));
  const lines: string[] = [];

  // The explainer earns its line only when some stage actually holds more than
  // one task; with one task per stage there is no independence to explain.
  const hasParallel = layers.some((layer) => layer.length > 1);
  lines.push(
    `  ${theme.taskId("Run order")} ${theme.note(
      `· ${layers.length} ${layers.length === 1 ? "stage" : "stages"}${
        hasParallel ? " · tasks in a stage don't wait on each other" : ""
      }`,
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
      const writes = task.writes ? theme.warn(" writes") : "";
      const provider =
        task.provider ??
        (defaultProvider ? routeProvider(task, defaultProvider) : null) ??
        "default";
      const label = task.model ? `${provider} ${task.model}` : provider;
      lines.push(
        `    ${theme.status("pending")} ${theme.taskId(id.padEnd(16))} ${theme.provider(label.padEnd(18))} ${task.title}${writes}${deps}`,
      );
    }
  });

  return lines.join("\n");
}
