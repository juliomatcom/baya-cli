import { renderMemory } from "../../../src/memory/index.js";
import type { MemoryEntry } from "../../../src/memory/index.js";

const entry = (
  over: Partial<MemoryEntry> & Pick<MemoryEntry, "kind" | "value">,
): MemoryEntry => ({
  key: `${over.kind}:${over.value}`,
  sources: ["t1"],
  ...over,
});

describe("renderMemory", () => {
  it("emits nothing at all rather than a heading over an empty list", () => {
    expect(renderMemory([])).toBe("");
  });

  it("frames the block as evidence, not instruction — it is untrusted content", () => {
    const text = renderMemory([entry({ kind: "command.verified", value: "npm test" })]);
    expect(text).toContain("not a set of instructions");
  });

  it("spends the budget on dead ends first, which are worth the most per token", () => {
    const text = renderMemory(
      [
        entry({ kind: "file.hot", value: "docs/a.md" }),
        entry({ kind: "command.verified", value: "npm run lint" }),
        entry({ kind: "command.deadend", value: "npm test" }),
        entry({ kind: "file.changed", value: "src/a.ts" }),
      ],
      { budget: 400 },
    );
    const order = ["FAILED", "ran clean", "already modified", "earlier tasks needed"].map(
      (label) => text.indexOf(label),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("gives every kind a showing rather than letting the top kind starve the rest", () => {
    // Measured on real runs: one task flailing through variations of the same
    // invocation produced fourteen dead ends and crowded out everything else.
    const entries = [
      ...Array.from({ length: 12 }, (_, index) =>
        entry({ kind: "command.deadend", value: `npm test --variation-${index}` }),
      ),
      entry({ kind: "command.verified", value: "npm run typecheck" }),
      entry({ kind: "file.changed", value: "src/a.ts" }),
      entry({ kind: "file.hot", value: "package.json" }),
    ];
    const text = renderMemory(entries, { budget: 400 });
    expect(text).toContain("npm run typecheck");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("package.json");
  });

  it("caps how many items one kind may contribute", () => {
    const entries = Array.from({ length: 30 }, (_, index) =>
      entry({ kind: "command.deadend", value: `cmd-${index}` }),
    );
    const line = renderMemory(entries, { budget: 5000 }).split("\n").at(-1) ?? "";
    expect(line.split(", ")).toHaveLength(6);
  });

  it("drops a one-off invocation too long to be a reusable fact", () => {
    const long = `TMPDIR=/var/tmp BAYA_DEFAULT_MODEL=luna npm run test:contract -- --no-cache --runInBand --watchman=false --cacheDirectory=/var/tmp test/contract/providers.contract.test.ts`;
    const text = renderMemory([
      entry({ kind: "command.deadend", value: long }),
      entry({ kind: "command.deadend", value: "npm test" }),
    ]);
    expect(text).not.toContain("watchman");
    expect(text).toContain("npm test");
  });

  it("ranks a corroborated, general command above a one-task detour", () => {
    const text = renderMemory(
      [
        entry({
          kind: "command.deadend",
          value: "npm test --weird-flag",
          sources: ["t1"],
        }),
        entry({
          kind: "command.deadend",
          value: "npm test",
          sources: ["t1", "t2", "t3"],
        }),
      ],
      { budget: 5000 },
    );
    expect(text.indexOf("`npm test`")).toBeLessThan(text.indexOf("--weird-flag"));
  });

  it("stops at the budget instead of growing without bound", () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      entry({ kind: "file.hot", value: `src/file-${index}.ts` }),
    );
    expect(renderMemory(many, { budget: 200 }).length).toBeLessThan(600);
  });

  it("drops a fact the agent can already see in its own session", () => {
    const entries = [
      entry({ kind: "command.verified", value: "npm test", sources: ["t1"] }),
      entry({ kind: "command.verified", value: "npm run lint", sources: ["t1", "t2"] }),
    ];
    const text = renderMemory(entries, { alreadyInSession: new Set(["t1"]) });
    expect(text).not.toContain("npm test");
    // Still shown: `t2` is outside the session, so the fact is news there.
    expect(text).toContain("npm run lint");
  });

  it("emits nothing when the whole of memory is already in the session", () => {
    const entries = [
      entry({ kind: "command.verified", value: "npm test", sources: ["t1"] }),
    ];
    expect(renderMemory(entries, { alreadyInSession: new Set(["t1"]) })).toBe("");
  });

  it("attributes a changed file, because who edited it is the useful half", () => {
    const text = renderMemory([
      entry({ kind: "file.changed", value: "src/a.ts", sources: ["gen-schema"] }),
    ]);
    expect(text).toContain("src/a.ts (gen-schema)");
  });

  it("a zero budget is off, not empty-with-a-heading", () => {
    expect(
      renderMemory([entry({ kind: "command.deadend", value: "npm test" })], {
        budget: 0,
      }),
    ).toBe("");
  });
});
