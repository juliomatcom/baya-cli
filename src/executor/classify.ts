import type { ProviderEvent } from "../manifest/index.js";
import type { Failure } from "./state.js";

/**
 * Failure classifier (plan M2.5). Turns the raw signals of a failed task —
 * timeout flag, exit code, the normalized error events, and the adapter's own
 * `error.retryable` — into a `Failure` with a `kind` and a `retry` policy the
 * scheduler and the resume flow can act on.
 *
 * The one rule that matters for the wallet: **`quota` and `auth` never retry
 * on their own** (`retry: "never"` / `"later"`), so a run does not burn its
 * attempts budget hammering an endpoint that will keep saying no.
 */

export interface ClassifyInput {
  timedOut: boolean;
  exitCode: number | null;
  events: ProviderEvent[];
  /** From the parsed `task_result.error`, when there was one. */
  errorMessage: string;
  /** The adapter's own read of whether a blind retry could work. */
  retryable: boolean;
}

const QUOTA = /\b(quota|402|exhaust|out of (credit|token)|credit balance|billing)\b/i;
const RATE = /\b(rate.?limit|429|overloaded|too many requests)\b/i;
const AUTH =
  /\b(401|403|unauthor|forbidden|authentication|api key|not logged in|login)\b/i;
const SCHEMA =
  /(does not match task_result|unparseable result|no parseable result|invalid json|schema)/i;
// `EPERM`/`EROFS` are how an OS-level sandbox refusal surfaces: codex's
// `read-only` mode blocks every write, `$TMPDIR` included, so a test runner
// dies on its own cache file long before a single assertion. Retrying cannot
// widen a sandbox, so this is `never` like any other permission refusal.
const PERMISSION =
  /(denied permission|permission.?mode|not allowed to|--allow|--dangerously|\bEPERM\b|\bEROFS\b|operation not permitted|read-only file system|sandbox denied)/i;
const NETWORK =
  /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network|fetch failed)\b/i;
// A wrong model name (config/plan error) — a blind retry never fixes it.
const BAD_MODEL =
  /(model.{0,3}not.{0,3}found|unrecognized.?model|model_not_found|no such model|invalid model|does not exist)/i;

function statusCodeFrom(text: string): number | null {
  const match = text.match(/\b(4\d\d|5\d\d)\b/);
  return match ? Number(match[1]) : null;
}

function lastErrorEvent(
  events: ProviderEvent[],
): Extract<ProviderEvent, { t: "error" }> | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && event.t === "error") return event;
  }
  return null;
}

export function classifyFailure(
  input: ClassifyInput,
  now: () => Date = () => new Date(),
): Failure {
  const occurred_at = now().toISOString();
  const errorEvent = lastErrorEvent(input.events);
  const haystack = `${errorEvent?.message ?? ""} ${input.errorMessage}`.trim();
  const status_code = statusCodeFrom(haystack);
  const base = {
    message: haystack || "task failed",
    provider_code: null,
    status_code,
    occurred_at,
  };

  if (input.timedOut) {
    return { ...base, kind: "timeout", retry: "now" };
  }

  if (errorEvent?.kind === "auth" || (AUTH.test(haystack) && !RATE.test(haystack))) {
    return { ...base, kind: "auth", retry: "never" };
  }

  if (QUOTA.test(haystack)) {
    return { ...base, kind: "quota", retry: "later" };
  }

  if (errorEvent?.kind === "rate_limit" || RATE.test(haystack)) {
    return { ...base, kind: "rate_limit", retry: "later" };
  }

  if (PERMISSION.test(haystack)) {
    return { ...base, kind: "permission", retry: "never" };
  }

  if (SCHEMA.test(haystack)) {
    return { ...base, kind: "schema", retry: "now" };
  }

  if (NETWORK.test(haystack)) {
    return { ...base, kind: "network", retry: "now" };
  }

  if (BAD_MODEL.test(haystack)) {
    return { ...base, kind: "crash", retry: "never" };
  }

  return { ...base, kind: "crash", retry: input.retryable ? "now" : "never" };
}
