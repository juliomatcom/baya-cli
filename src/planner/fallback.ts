import { MANIFEST_VERSION, type Manifest, type Task } from "../manifest/index.js";

/**
 * The deterministic linear fallback (risk register: "Planner unreliability").
 *
 * **Baya never aborts on a bad plan.** When the planner cannot produce a valid
 * manifest, the Markdown is split structurally into a chain, each task
 * depending on the one before. That loses parallelism and any real dependency
 * insight, which is why it warns loudly — but a degraded run beats no run,
 * and the user's task list is still executed in the order they wrote it.
 *
 * Pure and deterministic: the same Markdown always yields the same chain.
 */
export function slugify(text: string, index: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return /^[a-z0-9]/.test(slug) ? slug : `task-${index + 1}`;
}

interface Section {
  title: string;
  body: string;
}

/**
 * Split order: ATX headings, then top-level list items, then the whole
 * document. Headings first because a task list written for humans almost
 * always uses them, and they carry a title the list-item form has to invent.
 */
export function splitSections(markdown: string): Section[] {
  const lines = markdown.split("\n");

  const headingIndexes = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^#{1,6}\s+\S/.test(line));

  if (headingIndexes.length > 1) {
    const depths = headingIndexes.map(({ line }) => line.match(/^#+/)?.[0].length ?? 1);
    const topDepth = Math.min(...depths);
    const tops = headingIndexes.filter(
      ({ line }) => (line.match(/^#+/)?.[0].length ?? 1) === topDepth,
    );
    if (tops.length > 1) {
      return tops.map(({ line, index }, position) => {
        const end = tops[position + 1]?.index ?? lines.length;
        return {
          title: line.replace(/^#+\s+/, "").trim(),
          body: lines.slice(index, end).join("\n").trim(),
        };
      });
    }
  }

  const items: Section[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^\s{0,3}(?:[-*+]|\d+[.)])\s+\S/.test(line)) {
      if (current) items.push(toSection(current));
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current) items.push(toSection(current));
  if (items.length > 1) return items;

  const title =
    markdown
      .trim()
      .split("\n")[0]
      ?.replace(/^#+\s*/, "")
      .trim() ?? "task";
  return [{ title: title === "" ? "task" : title, body: markdown.trim() }];
}

function toSection(lines: string[]): Section {
  const body = lines.join("\n").trim();
  const first = (lines[0] ?? "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
  return { title: first === "" ? body.slice(0, 60) : first, body };
}

export function linearFallback(
  markdown: string,
  source: Manifest["source"],
  options: { maxTasks?: number } = {},
): Manifest {
  const sections = splitSections(markdown).slice(0, options.maxTasks ?? 50);
  const used = new Set<string>();

  const tasks: Task[] = sections.map((section, index) => {
    let id = slugify(section.title, index);
    // Duplicate headings are common ("## Tests" twice); ids must still be unique.
    if (used.has(id)) {
      let suffix = 2;
      while (used.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }
    used.add(id);

    return {
      id,
      title: section.title.slice(0, 200),
      instruction: section.body === "" ? section.title : section.body,
      provider: null,
      model: null,
      depends_on: index === 0 ? [] : [],
      // `writes` is unknowable without a model reading the text. Assume true:
      // a read-only task denied a write fails loudly, which is the safer error.
      writes: true,
      cwd: null,
    };
  });

  for (let index = 1; index < tasks.length; index += 1) {
    const previous = tasks[index - 1] as Task;
    (tasks[index] as Task).depends_on = [previous.id];
  }

  return { version: MANIFEST_VERSION, source, tasks };
}
