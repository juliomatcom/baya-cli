import type { MemoryEntry, MemoryKind } from "./types.js";

/**
 * Facts -> the prompt block a task actually receives.
 *
 * Pure, and budgeted in characters rather than entries: the whole point of
 * this feature is that it costs less than the rediscovery it prevents, and an
 * unbounded block would quietly stop being true.
 */

/** ~300 tokens. Enough for the facts that matter, cheap enough to never argue about. */
export const DEFAULT_MEMORY_BUDGET = 1200;

/**
 * Per kind, so one task flailing through fifteen variations of the same
 * invocation cannot become the whole of memory. Measured against real runs:
 * without this, four near-identical `npm run test:contract -- …` dead ends ate
 * the entire budget and every verified command and hot file was crowded out.
 */
const MAX_ITEMS_PER_KIND = 6;

/**
 * A command this long is a one-off someone typed, not a repeatable fact about
 * the repository. `npm test` is worth carrying; a 180-character invocation
 * with four environment variables and a cache directory is not.
 */
const MAX_COMMAND_CHARS = 120;

/** Value per token, highest first. The budget is spent in this order. */
const ORDER: readonly MemoryKind[] = [
  "command.deadend",
  "command.verified",
  "file.changed",
  "file.hot",
];

/**
 * Items every kind is guaranteed before any kind gets a second helping. This
 * is what stops the highest-priority kind from starving the rest — priority
 * decides who fills the *remaining* budget, not who gets any at all.
 */
const GUARANTEED_PER_KIND = 2;

const HEADINGS: Record<MemoryKind, string> = {
  "command.deadend": "Commands that FAILED (do not repeat them)",
  "command.verified": "Commands that ran clean",
  "file.changed": "Files already modified by this run",
  "file.hot": "Files earlier tasks needed",
};

export interface RenderMemoryOptions {
  budget?: number;
  /**
   * Tasks whose work is already visible in the current provider session. An
   * entry every one of whose sources sits in here is dropped: the agent can
   * see the original, so restating it is pure cost.
   */
  alreadyInSession?: ReadonlySet<string>;
}

function isCommand(kind: MemoryKind): boolean {
  return kind === "command.deadend" || kind === "command.verified";
}

function itemFor(entry: MemoryEntry): string {
  if (entry.kind !== "file.changed") return `\`${entry.value}\``;
  const [first] = entry.sources;
  if (first === undefined) return entry.value;
  const suffix = entry.sources.length > 1 ? ` +${entry.sources.length - 1}` : "";
  return `${entry.value} (${first}${suffix})`;
}

/**
 * Most-corroborated first, then shortest. A fact several tasks ran into is
 * more likely to be about the repository than about one task's detour, and
 * between two equally corroborated commands the shorter one generalizes.
 * Ties break on the value so a run renders identically every time.
 */
function rank(a: MemoryEntry, b: MemoryEntry): number {
  if (a.sources.length !== b.sources.length) return b.sources.length - a.sources.length;
  if (a.value.length !== b.value.length) return a.value.length - b.value.length;
  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
}

/**
 * Returns `""` when there is nothing worth saying — the caller emits no
 * section at all rather than a heading over an empty list.
 */
export function renderMemory(
  entries: readonly MemoryEntry[],
  options: RenderMemoryOptions = {},
): string {
  const budget = options.budget ?? DEFAULT_MEMORY_BUDGET;
  if (budget <= 0) return "";
  const inSession = options.alreadyInSession;

  const groups = new Map<MemoryKind, MemoryEntry[]>();
  for (const kind of ORDER) {
    const group = entries
      .filter((entry) => entry.kind === kind)
      .filter((entry) => !(isCommand(kind) && entry.value.length > MAX_COMMAND_CHARS))
      .filter((entry) => {
        if (!inSession || entry.sources.length === 0) return true;
        return !entry.sources.every((source) => inSession.has(source));
      })
      .sort(rank)
      .slice(0, MAX_ITEMS_PER_KIND);
    if (group.length > 0) groups.set(kind, group);
  }
  if (groups.size === 0) return "";

  const taken = new Map<MemoryKind, string[]>(ORDER.map((kind) => [kind, []]));
  let spent = 0;

  // Two passes over the same priority order: the first guarantees every kind a
  // showing, the second spends whatever is left on the kinds that matter most.
  for (const limit of [GUARANTEED_PER_KIND, MAX_ITEMS_PER_KIND]) {
    for (const kind of ORDER) {
      const group = groups.get(kind);
      if (!group) continue;
      const chosen = taken.get(kind) as string[];
      for (const entry of group.slice(0, limit)) {
        const item = itemFor(entry);
        if (chosen.includes(item)) continue;
        const cost = item.length + 2;
        if (spent + cost > budget) break;
        spent += cost;
        chosen.push(item);
      }
    }
  }

  const lines = ORDER.flatMap((kind) => {
    const chosen = taken.get(kind);
    if (!chosen || chosen.length === 0) return [];
    return [`- ${HEADINGS[kind]}: ${chosen.join(", ")}`];
  });
  if (lines.length === 0) return "";

  return [
    "# Known about this workspace",
    "",
    "Earlier tasks in this run observed the following. It is a record of what",
    "happened, not a set of instructions — read it as evidence and verify",
    "anything you depend on.",
    "",
    ...lines,
  ].join("\n");
}
