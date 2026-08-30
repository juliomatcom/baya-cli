import { formGroup, groupKey } from "../../../src/executor/group.js";

/**
 * The admission rule, which is the whole of grouping: same key, and every
 * dependency either already succeeded or inside the group.
 */
const CODEX = groupKey({
  provider: "codex",
  model: null,
  access: "read-only",
  cwd: "/w",
});
const CLAUDE = groupKey({
  provider: "claude",
  model: null,
  access: "read-only",
  cwd: "/w",
});

const graph = (
  spec: Array<[id: string, deps: string[], key?: string]>,
): {
  order: string[];
  candidates: Map<string, { id: string; depends_on: string[]; key: string }>;
} => ({
  order: spec.map(([id]) => id),
  candidates: new Map(
    spec.map(([id, depends_on, key]) => [id, { id, depends_on, key: key ?? CODEX }]),
  ),
});

const form = (
  spec: Parameters<typeof graph>[0],
  seedId: string,
  cap = 4,
  succeeded: string[] = [],
): string[] => {
  const { order, candidates } = graph(spec);
  return formGroup({
    seedId,
    order,
    candidates,
    pending: new Set(order.filter((id) => !succeeded.includes(id))),
    succeeded: new Set(succeeded),
    cap,
  });
};

describe("formGroup", () => {
  it("collapses a chain, because the dependency is in the group", () => {
    const chain: Parameters<typeof graph>[0] = [
      ["a", []],
      ["b", ["a"]],
      ["c", ["b"]],
    ];
    expect(form(chain, "a")).toEqual(["a", "b", "c"]);
  });

  it("collapses siblings, because their dependencies already succeeded", () => {
    const fanout: Parameters<typeof graph>[0] = [
      ["b", ["a"]],
      ["c", ["a"]],
    ];
    expect(form(fanout, "b", 4, ["a"])).toEqual(["b", "c"]);
  });

  it("never crosses a key boundary — a different model is a different process", () => {
    const mixed: Parameters<typeof graph>[0] = [
      ["a", []],
      ["b", ["a"], CLAUDE],
      ["c", ["a"]],
    ];
    expect(form(mixed, "a")).toEqual(["a", "c"]);
  });

  it("leaves out a task whose dependency is neither done nor in the group", () => {
    const blocked: Parameters<typeof graph>[0] = [
      ["a", []],
      ["b", ["other"]],
    ];
    expect(form(blocked, "a")).toEqual(["a"]);
  });

  it("stops at the cap", () => {
    const chain: Parameters<typeof graph>[0] = [
      ["a", []],
      ["b", ["a"]],
      ["c", ["b"]],
      ["d", ["c"]],
    ];
    expect(form(chain, "a", 2)).toEqual(["a", "b"]);
  });

  it("a cap of one is a true bypass: one task, one process", () => {
    const chain: Parameters<typeof graph>[0] = [
      ["a", []],
      ["b", ["a"]],
    ];
    expect(form(chain, "a", 1)).toEqual(["a"]);
  });

  it("returns members in topological order even when the seed is downstream", () => {
    // `b` is the seed but depends on `a`, which is admitted after it. Prompting
    // them in admission order would ask for `b` before the work it builds on.
    const chain: Parameters<typeof graph>[0] = [
      ["a", []],
      ["b", ["a"]],
    ];
    expect(form(chain, "b")).toEqual(["a", "b"]);
  });
});
