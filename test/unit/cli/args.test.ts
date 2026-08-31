import { parseArgs } from "../../../src/cli/args.js";

describe("subcommand vs path resolution", () => {
  it("treats a bare path as run", () => {
    const args = parseArgs(["./tasks.md"]);
    expect(args.command).toBe("run");
    expect(args.file).toBe("./tasks.md");
  });

  it("treats a bare path with no ./ prefix as run", () => {
    expect(parseArgs(["tasks.md", "--yes"])).toMatchObject({
      command: "run",
      file: "tasks.md",
    });
  });

  it("dispatches a known subcommand name", () => {
    expect(parseArgs(["doctor"]).command).toBe("doctor");
    expect(parseArgs(["run", "tasks.md"])).toMatchObject({
      command: "run",
      file: "tasks.md",
    });
  });

  it("dispatches models and accepts an optional provider filter", () => {
    expect(parseArgs(["models"])).toMatchObject({
      command: "models",
      file: null,
    });
    expect(parseArgs(["models", "codex", "--json"])).toMatchObject({
      command: "models",
      modelsProvider: "codex",
      flags: { json: true },
    });
  });

  it("lets ./doctor disambiguate a file that shares a subcommand's name", () => {
    expect(parseArgs(["./doctor"])).toMatchObject({ command: "run", file: "./doctor" });
  });

  it("shows help with no arguments at all", () => {
    expect(parseArgs([]).command).toBe("help");
  });

  it("makes plan an alias for run --dry-run", () => {
    const args = parseArgs(["plan", "tasks.md"]);
    expect(args.command).toBe("plan");
    expect(args.flags.dryRun).toBe(true);
  });

  it("routes -h to help regardless of the subcommand", () => {
    expect(parseArgs(["run", "tasks.md", "--help"]).command).toBe("help");
  });

  it("sets showVersion for -v, -V, and --version alike", () => {
    expect(parseArgs(["-v"]).showVersion).toBe(true);
    expect(parseArgs(["-V"]).showVersion).toBe(true);
    expect(parseArgs(["--version"]).showVersion).toBe(true);
  });
});

describe("flags", () => {
  it("parses value flags", () => {
    const { flags } = parseArgs([
      "tasks.md",
      "--default-provider",
      "codex",
      "--planner-model",
      "some-model",
      "--plan-out",
      "plan.json",
    ]);
    expect(flags).toMatchObject({
      defaultProvider: "codex",
      plannerModel: "some-model",
      planOut: "plan.json",
    });
  });

  it("parses boolean flags", () => {
    const { flags } = parseArgs(["tasks.md", "--dry-run", "-y", "--json", "--no-color"]);
    expect(flags).toMatchObject({ dryRun: true, yes: true, json: true, noColor: true });
  });

  it("validates --log-level against the known set", () => {
    expect(parseArgs(["tasks.md", "--log-level", "debug"]).flags.logLevel).toBe("debug");
    expect(parseArgs(["tasks.md", "--log-level", "shout"]).errors[0]).toContain(
      "--log-level",
    );
  });

  it("rejects the summarize context strategy, which is not in v1", () => {
    expect(
      parseArgs(["tasks.md", "--context-strategy", "summarize"]).errors[0],
    ).toContain("summarize");
  });

  it("rejects a non-numeric --max-tasks", () => {
    expect(parseArgs(["tasks.md", "--max-tasks", "many"]).errors).toHaveLength(1);
  });

  it("parses and validates --max-parallel", () => {
    expect(parseArgs(["tasks.md", "--max-parallel", "3"]).flags.maxParallel).toBe(3);
    expect(parseArgs(["tasks.md", "--max-parallel", "0"]).errors).toContain(
      "--max-parallel must be a positive integer",
    );
  });

  it("reports a value flag with no value", () => {
    expect(parseArgs(["tasks.md", "--default-provider"]).errors[0]).toContain(
      "requires a value",
    );
  });

  it("reports an unknown flag rather than ignoring it", () => {
    expect(parseArgs(["tasks.md", "--turbo"]).errors[0]).toBe("unknown flag: --turbo");
  });
});

describe("config subcommand", () => {
  it("parses --show", () => {
    expect(parseArgs(["config", "--show"]).configAction).toBe("show");
  });

  it("parses path", () => {
    expect(parseArgs(["config", "path"]).configAction).toBe("path");
  });

  it("parses set with a key and a value", () => {
    expect(parseArgs(["config", "set", "defaults.provider", "codex"])).toMatchObject({
      configAction: "set",
      configKey: "defaults.provider",
      configValue: "codex",
    });
  });

  it("reports set without both arguments", () => {
    expect(parseArgs(["config", "set", "defaults.provider"]).errors[0]).toContain(
      "<key> <value>",
    );
  });

  it("has no action for the bare wizard form", () => {
    expect(parseArgs(["config"]).configAction).toBeUndefined();
  });
});

describe("memory and grouping flags", () => {
  it("defaults both features on", () => {
    const parsed = parseArgs(["tasks.md"]);
    expect(parsed.flags.noMemory).toBe(false);
    expect(parsed.flags.groupSize).toBeUndefined();
    expect(parsed.flags.memoryBudget).toBeUndefined();
  });

  it("turns each off independently", () => {
    expect(parseArgs(["tasks.md", "--no-memory"]).flags.noMemory).toBe(true);
    expect(parseArgs(["tasks.md", "--group-size", "1"]).flags).toMatchObject({
      noMemory: false,
      groupSize: 1,
    });
  });

  it("rejects a group size below one, which would admit nothing", () => {
    expect(parseArgs(["tasks.md", "--group-size", "0"]).errors).toContain(
      "--group-size must be a positive integer",
    );
  });

  it("takes a memory budget and rejects a nonsensical one", () => {
    expect(parseArgs(["tasks.md", "--memory-budget", "500"]).flags.memoryBudget).toBe(
      500,
    );
    expect(parseArgs(["tasks.md", "--memory-budget", "-1"]).errors).toContain(
      "--memory-budget must be a non-negative integer",
    );
  });
});

describe("failure flags", () => {
  it("defaults --on-error to continue", () => {
    expect(parseArgs(["tasks.md"]).flags.onError).toBe("continue");
  });

  it("parses the supported --on-error values", () => {
    expect(parseArgs(["tasks.md", "--on-error", "stop"]).flags.onError).toBe("stop");
    expect(parseArgs(["tasks.md", "--on-error", "continue"]).flags.onError).toBe(
      "continue",
    );
  });

  it("rejects an unknown --on-error value", () => {
    expect(parseArgs(["tasks.md", "--on-error", "pause"]).errors).toContain(
      "--on-error must be continue or stop",
    );
  });
});
