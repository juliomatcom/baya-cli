import { AdmissionState } from "../../../src/executor/budget.js";

/**
 * The admission rule: a group starts only while the global cap and its
 * provider's `capabilities.maxConcurrency` both have room; a `read-write` group
 * additionally needs the single writer slot, and a waiting writer holds back
 * new readers so it cannot starve.
 */
const config = {
  maxParallel: 4,
  perProvider: { codex: 2, opencode: 2, claude: 1, copilot: 1 } as const,
};

const reader = (id: string, provider: "codex" | "claude" | "opencode" | "copilot") =>
  ({ id, provider, access: "read-only" }) as const;
const writer = (id: string, provider: "codex" | "claude" | "opencode" | "copilot") =>
  ({ id, provider, access: "read-write" }) as const;

describe("AdmissionState — budgets", () => {
  it("admits up to the global cap and refuses beyond it", () => {
    const state = new AdmissionState({ maxParallel: 2, perProvider: {} });
    expect(state.admit(reader("a", "codex"))).toBe(true);
    expect(state.admit(reader("b", "claude"))).toBe(true);
    expect(state.admit(reader("c", "opencode"))).toBe(false);
    expect(state.running).toBe(2);
  });

  it("refuses a provider already at its per-provider cap while others still have room", () => {
    const state = new AdmissionState(config);
    expect(state.admit(reader("a", "claude"))).toBe(true);
    expect(state.admit(reader("b", "claude"))).toBe(false);
    expect(state.admit(reader("c", "codex"))).toBe(true);
  });

  it("frees both budgets on release, so a waiting group gets in on a later pass", () => {
    const state = new AdmissionState(config);
    state.admit(reader("a", "claude"));
    expect(state.admit(reader("b", "claude"))).toBe(false);
    state.release("a");
    expect(state.admit(reader("b", "claude"))).toBe(true);
  });

  it("never lets the per-provider caps sum past the global cap", () => {
    const state = new AdmissionState({ maxParallel: 3, perProvider: config.perProvider });
    expect(state.admit(reader("a", "codex"))).toBe(true);
    expect(state.admit(reader("b", "codex"))).toBe(true);
    expect(state.admit(reader("c", "opencode"))).toBe(true);
    expect(state.admit(reader("d", "opencode"))).toBe(false);
  });

  it("bounds a provider with no configured cap by the global cap alone", () => {
    const state = new AdmissionState({ maxParallel: 2, perProvider: {} });
    expect(state.admit(reader("a", "codex"))).toBe(true);
    expect(state.admit(reader("b", "codex"))).toBe(true);
    expect(state.admit(reader("c", "codex"))).toBe(false);
  });

  it("treats admit of an already-in-flight group as a no-op", () => {
    const state = new AdmissionState(config);
    state.admit(reader("a", "codex"));
    state.admit(reader("a", "codex"));
    expect(state.running).toBe(1);
  });

  it("ignores release of a group that never started", () => {
    const state = new AdmissionState(config);
    expect(() => state.release("ghost")).not.toThrow();
    expect(state.running).toBe(0);
  });
});

describe("AdmissionState — single writer", () => {
  it("serializes two writers even when both providers have spare budget", () => {
    const state = new AdmissionState(config);
    expect(state.admit(writer("w1", "codex"))).toBe(true);
    expect(state.admit(writer("w2", "opencode"))).toBe(false);
    state.release("w1");
    expect(state.admit(writer("w2", "opencode"))).toBe(true);
  });

  it("lets read-only groups run concurrently — only budgets bound them", () => {
    const state = new AdmissionState(config);
    expect(state.admit(reader("r1", "codex"))).toBe(true);
    expect(state.admit(reader("r2", "codex"))).toBe(true);
    expect(state.admit(reader("r3", "opencode"))).toBe(true);
    expect(state.running).toBe(3);
  });

  it("runs a reader and a writer at once — the writer only excludes other writers", () => {
    const state = new AdmissionState(config);
    expect(state.admit(writer("w1", "codex"))).toBe(true);
    expect(state.admit(reader("r1", "opencode"))).toBe(true);
  });

  it("does not starve a waiting writer behind an unbounded run of readers", () => {
    const state = new AdmissionState(config);
    // A writer is in flight, so the next writer is refused and starts waiting.
    expect(state.admit(writer("w1", "codex"))).toBe(true);
    expect(state.admit(writer("w2", "opencode"))).toBe(false);

    // However many readers arrive while w2 waits, none may start.
    for (let i = 0; i < 50; i += 1) {
      expect(state.admit(reader(`r${i}`, "opencode"))).toBe(false);
    }
    expect(state.writersWaiting).toBe(1);

    // When w1 finishes, the waiting writer takes the slot ahead of the readers.
    state.release("w1");
    expect(state.admit(writer("w2", "opencode"))).toBe(true);
    expect(state.writersWaiting).toBe(0);
    // Now readers flow again, up to the budgets.
    expect(state.admit(reader("r-late", "codex"))).toBe(true);
  });

  it("stops holding readers back once an abandoned writer is released", () => {
    const state = new AdmissionState(config);
    state.admit(writer("w1", "codex"));
    expect(state.admit(writer("w2", "opencode"))).toBe(false);
    expect(state.admit(reader("r1", "opencode"))).toBe(false);
    // The scheduler drops w2 before it ever runs (a dependency failed).
    state.release("w2");
    expect(state.admit(reader("r1", "opencode"))).toBe(true);
  });
});
