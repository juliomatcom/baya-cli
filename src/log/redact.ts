/**
 * Redaction at the sink (conventions.md #9, logging.md): no call site can leak
 * a secret because every line passes through here before it is written.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{10,}\b/g, replacement: "sk-***REDACTED***" },
  { pattern: /\bghp_[A-Za-z0-9]{10,}\b/g, replacement: "ghp_***REDACTED***" },
];

export function redactSecrets(input: string): string {
  let result = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecrets(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactDeep(val);
    }
    return result as T;
  }
  return value;
}

/**
 * A prompt is never inlined into a log line — it is elided to its byte length
 * with the caller expected to point at request.json for the real content.
 */
export function elidePrompt(fields: Record<string, unknown>): Record<string, unknown> {
  if (typeof fields["prompt"] !== "string") return fields;
  const { prompt, ...rest } = fields;
  return { ...rest, prompt_bytes: Buffer.byteLength(prompt as string, "utf8") };
}
