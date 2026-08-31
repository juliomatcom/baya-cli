import { detectDoneMarkers, isDoneLine } from "../../../src/planner/done.js";

describe("detectDoneMarkers", () => {
  it("recognizes the forms a task list actually uses", () => {
    const text = [
      "- [x] ship the parser",
      "- [X] ship the printer",
      "1. write the docs [done]",
      "## Scheduler (complete)",
      "- rewrite the loop — done",
      "- add the flag | done",
      "| ✅ | M2.5 | failure classifier |",
    ].join("\n");

    expect(detectDoneMarkers(text).map((marker) => marker.line)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("reports 1-based lines so they match an editor", () => {
    const markers = detectDoneMarkers("intro\n\n- [x] done thing\n");
    expect(markers).toEqual([{ line: 3, text: "- [x] done thing" }]);
  });

  it("leaves unmarked work alone", () => {
    const text = [
      "- [ ] ship the parser",
      "1 Rewrite the scheduler loop.",
      "## Signals",
    ].join("\n");
    expect(detectDoneMarkers(text)).toEqual([]);
  });

  it("does not read a negation as a marker", () => {
    // The rule this protects: a spec that says work is *not* done is the work
    // that remains, and skipping it is the one unrecoverable mistake here.
    for (const line of [
      "A change that leaves execution.md stale is not done.",
      "- teardown — not complete",
      "this was never completed",
      "the migration isn't done yet",
    ]) {
      expect(isDoneLine(line)).toBe(false);
    }
  });

  it("does not fire on prose that merely ends in the word", () => {
    for (const line of [
      "Run the suite until it is done.",
      "Done when: concurrency never exceeds the budget",
      "Already landed — do not redo",
    ]) {
      expect(isDoneLine(line)).toBe(false);
    }
  });
});
