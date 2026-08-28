/**
 * Provider stdout is untrusted and may carry escape sequences (architecture.md
 * trust boundaries). Strip them before any persist or render.
 */
const ANSI_PATTERN =
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))";

const ANSI_REGEX = new RegExp(ANSI_PATTERN, "g");

export function stripAnsi(input: string): string {
  if (input === "") return input;
  return input.replace(ANSI_REGEX, "");
}
