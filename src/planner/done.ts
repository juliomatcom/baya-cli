/**
 * Recognizing work the task list already marks as done.
 *
 * A task list outlives the run that consumed it: the user ticks off what
 * landed and re-runs the rest. Without this, every re-run re-plans and re-pays
 * for finished work, and the agent that receives it either redoes it or spends
 * a process discovering it was already done.
 *
 * Pure and deterministic — no model in the loop. The planner is told which
 * lines were marked so it does not have to notice them itself, and the
 * deterministic fallback drops them on its own.
 */

/** The done word itself. Deliberately narrow. */
const DONE_WORD = String.raw`(?:done|complete|completed)`;

/**
 * A checkbox, ticked: `[x]`, `- [X]`, `[✓]`. The list marker may precede it.
 */
const CHECKBOX = /^\s{0,8}(?:[-*+]|\d+[.)])?\s*\[\s*(?:x|✓|✔)\s*\]/i;

/** An explicit tag anywhere on the line: `[done]`, `(complete)`, `{done}`. */
const TAGGED = new RegExp(String.raw`[[({]\s*${DONE_WORD}\s*[\])}]`, "i");

/**
 * A trailing verdict after a separator: `— done`, `| done`, `· complete`,
 * `: done`. The separator is what keeps ordinary prose out: a sentence ending
 * "…is not done." has no separator before the word, and a rule that matched a
 * bare trailing "done" would mark half a spec's rules as finished.
 */
const TRAILING = new RegExp(String.raw`[-–—|:·•>]\s*${DONE_WORD}\b[.!]?\s*$`, "i");

/** The tick emoji is unambiguous wherever it sits. */
const TICK = /[✅☑]/u;

/**
 * "not done", "isn't done", "never completed" — the negation carries the
 * meaning, and matching it would skip exactly the work that remains.
 */
const NEGATED = new RegExp(
  String.raw`\b(?:not|never|isn't|isnt|aren't|arent|won't|wont|nowhere near)\s+(?:\w+\s+){0,2}${DONE_WORD}\b`,
  "i",
);

export interface DoneMarker {
  /** 1-based, so it lines up with what an editor shows. */
  line: number;
  /** The marked line, trimmed. Truncated for display. */
  text: string;
}

/** Every line the task list marks as already finished. */
export function detectDoneMarkers(taskText: string): DoneMarker[] {
  const found: DoneMarker[] = [];
  taskText.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || NEGATED.test(line)) return;
    if (
      CHECKBOX.test(line) ||
      TAGGED.test(line) ||
      TRAILING.test(line) ||
      TICK.test(line)
    ) {
      found.push({ line: index + 1, text: line.slice(0, 200) });
    }
  });
  return found;
}

/** True when this line is one the list marks as done. */
export function isDoneLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "" || NEGATED.test(trimmed)) return false;
  return (
    CHECKBOX.test(trimmed) ||
    TAGGED.test(trimmed) ||
    TRAILING.test(trimmed) ||
    TICK.test(trimmed)
  );
}
