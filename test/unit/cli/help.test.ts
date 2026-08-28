import { renderHelp } from "../../../src/cli/help.js";
import { createRegistry, type ProviderAdapter } from "../../../src/providers/index.js";
import { codexAdapter } from "../../../src/providers/codex.js";
import { createTheme } from "../../../src/ui/theme.js";

const theme = createTheme("never");

async function help(adapters: ProviderAdapter[]): Promise<string> {
  const registry = createRegistry(adapters);
  const statuses = await registry.resolveAll({
    env: { PATH: "/nonexistent", HOME: "/nonexistent" },
  });
  return renderHelp(statuses, theme);
}

describe("renderHelp", () => {
  it("matches the recorded help output", async () => {
    expect(await help([codexAdapter])).toMatchSnapshot();
  });

  it("lists every provider with its resolution status and install hint", async () => {
    const text = await help([codexAdapter]);
    expect(text).toContain("codex");
    expect(text).toContain(codexAdapter.installHint);
  });

  it("carries at least one runnable example", async () => {
    expect(await help([codexAdapter])).toContain("baya ./tasks.md");
  });

  it("changes when an adapter is registered — no other edit required", async () => {
    const fake = {
      ...codexAdapter,
      id: "opencode" as const,
      installHint: "brew install opencode",
    };
    const before = await help([codexAdapter]);
    const after = await help([codexAdapter, fake]);
    expect(after).not.toBe(before);
    expect(after).toContain("brew install opencode");
  });
});
