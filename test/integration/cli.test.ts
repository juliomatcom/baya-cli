import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FAKE_PROVIDER, makeWorkspace, runCli } from "../helpers/runCli.js";

describe("baya doctor", () => {
  it("reports the resolved path, version, and capability set", async () => {
    const result = await runCli(["doctor"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("codex");
    expect(result.stdout).toContain(FAKE_PROVIDER);
    expect(result.stdout).toContain("fake-provider 1.0.0");
    expect(result.stdout).toContain("prompt via stdin/argv");
    expect(result.stdout).toContain("schema schema-file");
    expect(result.stdout).toContain("max concurrency 2");
  });

  it("resolves a provider that is nowhere on $PATH", async () => {
    const workspace = makeWorkspace({});
    // The provider lives in ~/.local/bin; $PATH holds only the node bin dir.
    const localBin = join(workspace.home, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const { copyFileSync, chmodSync } = await import("node:fs");
    copyFileSync(FAKE_PROVIDER, join(localBin, "codex"));
    chmodSync(join(localBin, "codex"), 0o755);
    writeFileSync(
      join(workspace.cwd, ".baya", "config.json"),
      JSON.stringify({ version: 1 }),
    );

    const result = await runCli(["doctor"], { workspace });
    expect(result.stdout).toContain(join(localBin, "codex"));
    expect(result.stdout).toContain("found via known-location");
  });

  it("exits 2 with install hints when no provider resolves", async () => {
    const workspace = makeWorkspace({});
    writeFileSync(
      join(workspace.cwd, ".baya", "config.json"),
      JSON.stringify({ version: 1, providers: { codex: { bin: "/nonexistent/codex" } } }),
    );
    const result = await runCli(["doctor"], { workspace });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("npm i -g @openai/codex");
  });

  it("reports the workspace as free when no baya is running", async () => {
    const result = await runCli(["doctor"]);
    expect(result.stdout).toContain("no baya is running in this directory");
  });

  it("names an unreadable lock for a human to delete rather than removing it", async () => {
    const workspace = makeWorkspace({});
    writeFileSync(join(workspace.cwd, ".baya", "baya.lock"), "not json");
    const result = await runCli(["doctor"], { workspace });
    expect(result.stdout).toContain("delete it by hand");
  });
});

describe("baya config", () => {
  it("prints the user config path", async () => {
    const result = await runCli(["config", "path"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/baya\/config\.json$/);
  });

  it("--show names the source layer of every value", async () => {
    const result = await runCli(["config", "--show"]);
    expect(result.stdout).toContain("defaults.provider");
    expect(result.stdout).toContain("from project");
    expect(result.stdout).toContain("providers.codex.bin");
  });

  it("set writes the user layer, and --show then attributes it there", async () => {
    const workspace = makeWorkspace({});
    writeFileSync(
      join(workspace.cwd, ".baya", "config.json"),
      JSON.stringify({ version: 1 }),
    );

    const set = await runCli(["config", "set", "defaults.provider", "codex"], {
      workspace,
    });
    expect(set.code).toBe(0);

    const show = await runCli(["config", "--show"], { workspace });
    expect(show.stdout).toContain("from user");
  });

  it("rejects an unknown provider rather than storing it", async () => {
    const result = await runCli(["config", "set", "defaults.provider", "rogue"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("rogue");
  });

  it("reports a malformed config clearly, naming the file", async () => {
    const workspace = makeWorkspace({});
    writeFileSync(join(workspace.cwd, ".baya", "config.json"), "{oops");
    const result = await runCli(["config", "--show"], { workspace });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not valid JSON");
    expect(result.stderr).toContain("config.json");
  });
});

describe("baya --help", () => {
  it("lists the providers with their resolution status", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PROVIDERS");
    expect(result.stdout).toContain("codex");
    expect(result.stdout).toContain("baya ./tasks.md");
  });

  it("shows each resolved provider's version, not a placeholder", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain("fake-provider 1.0.0");
    expect(result.stdout).not.toContain("unknown");
  });

  it("resolves through the config's binary override, as every command must", async () => {
    const result = await runCli(["--help"]);
    expect(result.stdout).toContain(FAKE_PROVIDER);
  });

  it("still prints when the config is unreadable — help must survive a broken setup", async () => {
    const workspace = makeWorkspace({});
    writeFileSync(join(workspace.cwd, ".baya", "config.json"), "{oops");
    const result = await runCli(["--help"], { workspace });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("USAGE");
  });

  it("is what a bare invocation shows", async () => {
    const result = await runCli([]);
    expect(result.stdout).toContain("USAGE");
  });
});

describe("argument errors", () => {
  it("exits 2 on an unknown flag rather than ignoring it", async () => {
    const result = await runCli(["./tasks.md", "--turbo"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown flag: --turbo");
  });

  it("names commands that are not available yet instead of treating them as paths", async () => {
    const result = await runCli(["resume"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not available yet");
  });

  it("reports a missing task list", async () => {
    const result = await runCli(["./nope.md", "--yes"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot read");
  });
});

describe("non-TTY provider selection", () => {
  const noDefault = { version: 1, providers: { codex: { bin: FAKE_PROVIDER } } };

  it("uses the only provider found, with a warning, and proceeds", async () => {
    const workspace = makeWorkspace({
      scenario: {
        __planner__: {
          final: {
            tasks: [
              {
                id: "a",
                title: "A",
                instruction: "do a",
                provider: "codex",
                model: null,
                depends_on: [],
                writes: false,
                cwd: null,
              },
            ],
          },
        },
        a: {
          final: {
            baya: "1",
            kind: "task_result",
            task_id: "a",
            status: "ok",
            summary: "s",
          },
        },
      },
    });
    writeFileSync(join(workspace.cwd, ".baya", "config.json"), JSON.stringify(noDefault));

    const result = await runCli(["./tasks.md", "--yes"], { workspace });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("only one found");
  });

  it("exits 2 with install hints when zero providers resolve", async () => {
    const workspace = makeWorkspace({});
    writeFileSync(
      join(workspace.cwd, ".baya", "config.json"),
      JSON.stringify({ version: 1, providers: { codex: { bin: "/nonexistent/codex" } } }),
    );
    const result = await runCli(["./tasks.md", "--yes"], { workspace });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("no provider CLI found");
    expect(result.stderr).toContain("baya doctor");
  });

  it("never prompts under BAYA_NO_INPUT, even on a TTY", async () => {
    const workspace = makeWorkspace({});
    writeFileSync(
      join(workspace.cwd, ".baya", "config.json"),
      JSON.stringify({ version: 1, providers: { codex: { bin: "/nonexistent/codex" } } }),
    );
    const result = await runCli(["./tasks.md"], {
      workspace,
      stdinIsTty: true,
      stdoutIsTty: true,
    });
    expect(result.code).toBe(2);
  });
});
