import { formatCommand } from "../../../src/ui/text.js";

describe("formatCommand", () => {
  it("quotes only the tokens that need it", () => {
    expect(formatCommand(["codex", "exec", "-C", "/a/b", "--model", "gpt-5"])).toBe(
      "codex exec -C /a/b --model gpt-5",
    );
    expect(formatCommand(["sh", "-c", "a b"])).toBe("sh -c 'a b'");
  });

  it("labels the (long) prompt argument by its byte length", () => {
    const prompt = "hello world ".repeat(20);
    const out = formatCommand(["copilot", "-p", prompt, "--json"], {
      promptBytes: Buffer.byteLength(prompt),
    });
    expect(out).toBe("copilot -p <prompt> --json");
  });

  it("leaves a short argument alone even if its length matches promptBytes", () => {
    const out = formatCommand(["copilot", "-p", "sonnet"], { promptBytes: 6 });
    expect(out).toBe("copilot -p sonnet");
  });

  it("collapses an inlined JSON blob to a char count", () => {
    const schema = `{${"x".repeat(500)}}`;
    expect(formatCommand(["claude", "--json-schema", schema])).toBe(
      "claude --json-schema <502 chars>",
    );
  });

  it("leaves a long but whitespace-free path readable", () => {
    const path = `/tmp/${"nested/".repeat(30)}result.json`;
    expect(formatCommand(["codex", "-o", path])).toBe(`codex -o ${path}`);
  });
});
