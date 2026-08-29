import { classifyFailure } from "../../../src/executor/index.js";
import type { ProviderEvent } from "../../../src/manifest/index.js";

const at = () => new Date("2026-08-29T12:00:00.000Z");

const base = {
  timedOut: false,
  exitCode: 1,
  events: [] as ProviderEvent[],
  errorMessage: "",
  retryable: true,
};

describe("classifyFailure", () => {
  it("a timeout is retryable now", () => {
    const f = classifyFailure({ ...base, timedOut: true }, at);
    expect(f).toMatchObject({ kind: "timeout", retry: "now" });
  });

  it("an auth error never retries", () => {
    const f = classifyFailure(
      { ...base, errorMessage: "401 unauthorized: invalid api key" },
      at,
    );
    expect(f).toMatchObject({ kind: "auth", retry: "never", status_code: 401 });
  });

  it("an auth error event classifies even without a matching message", () => {
    const f = classifyFailure(
      { ...base, events: [{ t: "error", kind: "auth", message: "nope" }] },
      at,
    );
    expect(f.kind).toBe("auth");
  });

  it("quota exhaustion retries later, not now — it must not burn attempts", () => {
    const f = classifyFailure({ ...base, errorMessage: "quota_exceeded (HTTP 402)" }, at);
    expect(f).toMatchObject({ kind: "quota", retry: "later", status_code: 402 });
  });

  it("a plain rate limit retries later", () => {
    const f = classifyFailure(
      { ...base, events: [{ t: "error", kind: "rate_limit", message: "429 slow down" }] },
      at,
    );
    expect(f).toMatchObject({ kind: "rate_limit", retry: "later" });
  });

  it("a permission denial never retries", () => {
    const f = classifyFailure(
      {
        ...base,
        errorMessage:
          "claude was denied permission for: Bash, Write. Raise --permission-mode.",
      },
      at,
    );
    expect(f).toMatchObject({ kind: "permission", retry: "never" });
  });

  // codex's `read-only` sandbox refuses `$TMPDIR` too, so a test runner dies on
  // its own cache file. No retry can widen a sandbox.
  it("an OS sandbox refusal is a permission failure, never retried", () => {
    for (const message of [
      "Error: EPERM: operation not permitted, open '/var/folders/x/haste-map-jest'",
      "EROFS: read-only file system, mkdir '/tmp/build'",
    ]) {
      const f = classifyFailure({ ...base, errorMessage: message }, at);
      expect(f).toMatchObject({ kind: "permission", retry: "never" });
    }
  });

  it("an unparseable result is a schema failure, retryable now", () => {
    const f = classifyFailure(
      {
        ...base,
        errorMessage: "codex wrote a result file that does not match task_result",
      },
      at,
    );
    expect(f).toMatchObject({ kind: "schema", retry: "now" });
  });

  it("a network blip retries now", () => {
    const f = classifyFailure({ ...base, errorMessage: "fetch failed: ECONNRESET" }, at);
    expect(f).toMatchObject({ kind: "network", retry: "now" });
  });

  it("a wrong model name never retries — only a config change fixes it", () => {
    const f = classifyFailure(
      {
        ...base,
        errorMessage: "404 Not Found: Model not found gpt-5.1-codex",
        retryable: true,
      },
      at,
    );
    expect(f).toMatchObject({ kind: "crash", retry: "never" });
  });

  it("an unclassifiable failure honors the adapter's retryable flag", () => {
    expect(
      classifyFailure({ ...base, errorMessage: "boom", retryable: true }, at),
    ).toMatchObject({ kind: "crash", retry: "now" });
    expect(
      classifyFailure({ ...base, errorMessage: "boom", retryable: false }, at),
    ).toMatchObject({ kind: "crash", retry: "never" });
  });
});
