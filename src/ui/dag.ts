import type { Manifest } from "../manifest/index.js";
import { topoLayers } from "../graph/index.js";
import type { Theme } from "./theme.js";

/**
 * The plan preview shown at the confirmation gate. Layers, not a tree: the
 * question the user is answering is "what runs, and what waits for what",
 * and a layered view answers it at a glance.
 */
export function renderDag(manifest: Manifest, theme: Theme): string {
  const layers = topoLayers(
    manifest.tasks.map((task) => ({ id: task.id, depends_on: task.depends_on })),
  );
  const byId = new Map(manifest.tasks.map((task) => [task.id, task]));
  const lines: string[] = [];

  layers.forEach((layer, index) => {
    lines.push(`  ${theme.note(`layer ${index + 1}`)}`);
    for (const id of layer) {
      const task = byId.get(id);
      if (!task) continue;
      const deps =
        task.depends_on.length > 0 ? theme.note(` ← ${task.depends_on.join(", ")}`) : "";
      const writes = task.writes ? theme.warn(" writes") : "";
      const provider = task.provider ?? "default";
      lines.push(
        `    ${theme.status("pending")} ${theme.taskId(id.padEnd(16))} ${theme.provider(provider.padEnd(9))} ${task.title}${writes}${deps}`,
      );
    }
  });

  return lines.join("\n");
}
