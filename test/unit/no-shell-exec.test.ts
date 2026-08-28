import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";
import localRules from "../../eslint-rules/index.js";

const fixturePath = fileURLToPath(
  new URL("../fixtures/lint/shell-exec-violation.js", import.meta.url),
);

function lintFixture(): ReturnType<Linter["verify"]> {
  const linter = new Linter({ configType: "flat" });
  const code = readFileSync(fixturePath, "utf8");
  return linter.verify(
    code,
    {
      plugins: { local: localRules },
      languageOptions: { sourceType: "module", ecmaVersion: "latest" },
      rules: { "local/no-shell-exec": "error" },
    },
    { filename: fixturePath },
  );
}

describe("local/no-shell-exec", () => {
  it("fails a fixture that uses shell: true and exec/execSync", () => {
    const messages = lintFixture();
    const ruleIds = messages.map((m) => m.ruleId);

    expect(messages.length).toBeGreaterThan(0);
    expect(ruleIds.every((id) => id === "local/no-shell-exec")).toBe(true);
  });

  it("flags every banned construct: shell:true, imported exec, imported execSync, and both call sites", () => {
    const messages = lintFixture();
    const texts = messages.map((m) => m.message);

    expect(texts.filter((t) => t.includes("shell: true"))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("`exec`"))).toHaveLength(2);
    expect(texts.filter((t) => t.includes("`execSync`"))).toHaveLength(2);
  });

  it("passes clean code with no shell/exec usage", () => {
    const linter = new Linter({ configType: "flat" });
    const messages = linter.verify(
      "export function ok() { return 1; }",
      {
        plugins: { local: localRules },
        languageOptions: { sourceType: "module", ecmaVersion: "latest" },
        rules: { "local/no-shell-exec": "error" },
      },
      { filename: "clean.js" },
    );

    expect(messages).toHaveLength(0);
  });
});
