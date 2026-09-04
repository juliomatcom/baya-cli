import { dirname, join } from 'node:path';
import { type ProviderEvent, type TaskResult } from '../manifest/index.js';
import { stripAnsi } from '../log/index.js';
import { extractResultFromText, synthesizeFailure } from './result.js';
import { wants, wantsEverything } from './tools.js';
import type {
  BuildRunInput,
  ExtractContext,
  ProviderAdapter,
  ProviderUsage,
  SpawnPlan,
} from './types.js';

export const OPENCODE_PROVIDER = 'opencode' as const;

/**
 * opencode adapter (providers.md §opencode; argv shape re-verified live
 * 2026-08-31 against `opencode 1.18.25`).
 *
 * Its job in the sequence is to prove the abstraction against a *third*
 * invocation shape: codex delivers the prompt on stdin, claude on stdin, and
 * opencode on **argv** as a positional.
 *
 * ⚠️ It was written against `-f`, on the reading that `-f` delivers the prompt.
 * It does not. `opencode run --help`: `-f, --file  file(s) to attach to
 * message` — an *attachment*, and the message itself is the positional
 * `[message..]`. So `run -f prompt.md` passes a file with no message and
 * opencode exits 1 with `Error: You must provide a message or a command`
 * before reaching a model. Every opencode task failed this way; the bug
 * survived because this adapter's success path was never exercised live (the
 * reference machine's opencode held an invalid provider key, so runs 401'd at
 * a later stage and the argv was never in question).
 *
 * The `--` before the prompt is load-bearing, not decoration: opencode parses
 * argv with yargs, so a prompt whose first character is `-` is read as an
 * unknown flag and the command prints its help text and exits instead of
 * running. Verified 2026-08-31. Nothing may follow the prompt — `message..`
 * is variadic and would swallow it.
 *
 * No schema enforcement: the result is mined out of the assistant text via the
 * degradation ladder (protocol.md §4, rungs 2–3), then synthesized on failure.
 */

/** `-m` wants the compound `provider/model` form; a bare model is passed as-is. */
function commonFlags(input: BuildRunInput): string[] {
  const argv = ['run', '--format', 'json', '--dir', input.cwd];
  if (input.model !== null) argv.push('-m', input.model);
  // Externally installed plugins arrive as tool definitions in every session.
  // Measured 2026-09-04 against opencode 1.18.25 on a task whose own prompt is
  // ~1,400 tokens (opencode enforces no schema, so it is inlined): ~21,130
  // input tokens without this flag, ~10,427 with it. Half the context was
  // plugins the run never called. `--tools plugins` (or `all`) keeps them.
  if (!wantsEverything(input.tools) && !wants(input.tools, 'plugins')) {
    argv.push('--pure');
  }
  return argv;
}

function promptFile(input: BuildRunInput): string {
  return join(dirname(input.resultFile), 'prompt.md');
}

interface OpencodeLine {
  type?: unknown;
  sessionID?: unknown;
  error?: unknown;
  part?: unknown;
  text?: unknown;
  content?: unknown;
  message?: unknown;
}

function parseLine(raw: string): OpencodeLine | null {
  let value: unknown;
  try {
    value = JSON.parse(stripAnsi(raw).trim());
  } catch {
    return null;
  }
  return value !== null && typeof value === 'object' ? (value as OpencodeLine) : null;
}

/** `{error:{name, data:{statusCode, isRetryable}}}` — `isRetryable` is a real boolean. */
function readError(obj: OpencodeLine): {
  kind: 'rate_limit' | 'auth' | 'other';
  message: string;
  retryable: boolean;
} | null {
  if (obj.error === null || typeof obj.error !== 'object') return null;
  const error = obj.error as Record<string, unknown>;
  const data =
    error['data'] !== null && typeof error['data'] === 'object'
      ? (error['data'] as Record<string, unknown>)
      : {};
  const status = typeof data['statusCode'] === 'number' ? data['statusCode'] : undefined;
  const retryable = data['isRetryable'] === true;
  const name = String(error['name'] ?? 'error');
  const detail = data['message'] !== undefined ? `: ${String(data['message'])}` : '';
  let kind: 'rate_limit' | 'auth' | 'other' = 'other';
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 429) kind = 'rate_limit';
  else if (retryable) kind = 'rate_limit';
  return {
    kind,
    message: `${name}${status !== undefined ? ` (HTTP ${status})` : ''}${detail}`,
    retryable,
  };
}

/** Text lives under a few plausible keys; the success shape is unprobed. */
function readText(obj: OpencodeLine): string | null {
  if (typeof obj.text === 'string' && obj.text !== '') return obj.text;
  if (typeof obj.content === 'string' && obj.content !== '') return obj.content;
  if (obj.part !== null && typeof obj.part === 'object') {
    const part = obj.part as Record<string, unknown>;
    if (part['type'] === 'text' && typeof part['text'] === 'string') {
      return part['text'] as string;
    }
  }
  if (
    obj.message !== null &&
    typeof obj.message === 'object' &&
    typeof (obj.message as Record<string, unknown>)['content'] === 'string'
  ) {
    return (obj.message as Record<string, unknown>)['content'] as string;
  }
  return null;
}

function collectText(events: ProviderEvent[]): string {
  return events
    .filter((event): event is Extract<ProviderEvent, { t: 'text' }> => event.t === 'text')
    .map((event) => event.text)
    .join('\n');
}

export const opencodeAdapter: ProviderAdapter = {
  id: OPENCODE_PROVIDER,

  capabilities: {
    promptDelivery: ['argv'],
    structuredOutput: 'none',
    events: 'jsonl',
    sessionId: 'capture',
    resume: 'session',
    // Deferred: this adapter emits `tool` events, but neither its event
    // shapes nor its resume path have been exercised for memory. Scoped to
    // codex + claude first (execution.md §Memory), widened one at a time.
    observations: 'none',
    cwdFlag: true,
    modelFlag: true,
    maxConcurrency: 2,
  },

  // `~/.opencode/bin` is already in the shared resolution chain (resolve.ts).
  installHint: 'npm i -g opencode-ai',

  buildRun(input: BuildRunInput): SpawnPlan {
    return {
      argv: [
        input.bin,
        ...commonFlags(input),
        ...(input.extraArgs ?? []),
        '--',
        input.prompt,
      ],
      cwd: input.cwd,
      stdin: 'ignore',
      // Still written, though nothing reads it back: `prompt.md` in the task's
      // run directory is the record of what was actually sent, and the run
      // output points people at that directory.
      files: [{ path: promptFile(input), contents: input.prompt }],
    };
  },

  /** `opencode run -s <sessionID>` — the id captured from the event stream. */
  buildResume(sessionId: string, answer: string, input: BuildRunInput): SpawnPlan {
    return {
      argv: [
        input.bin,
        ...commonFlags(input),
        '-s',
        sessionId,
        ...(input.extraArgs ?? []),
        '--',
        answer,
      ],
      cwd: input.cwd,
      stdin: 'ignore',
      files: [{ path: promptFile(input), contents: answer }],
    };
  },

  parseEvents(chunk: string): ProviderEvent[] {
    const out: ProviderEvent[] = [];
    for (const line of chunk.split('\n')) {
      const trimmed = stripAnsi(line).trim();
      if (trimmed === '') continue;
      const obj = parseLine(trimmed);
      if (!obj) {
        out.push({ t: 'unknown', raw: trimmed });
        continue;
      }
      if (typeof obj.sessionID === 'string') {
        out.push({ t: 'session', id: obj.sessionID });
      }
      const error = obj.type === 'error' ? readError(obj) : null;
      if (error) {
        out.push({ t: 'error', kind: error.kind, message: error.message });
        // Keep the raw line too: it carries `isRetryable`, the cleanest retry
        // signal any provider gives, and the error event cannot hold it.
        out.push({ t: 'unknown', raw: trimmed });
        continue;
      }
      const text = readText(obj);
      if (text !== null) {
        out.push({ t: 'text', text });
        continue;
      }
      if (obj.type === 'tool' || obj.type === 'tool-call' || obj.type === 'tool_use') {
        const record = obj as Record<string, unknown>;
        out.push({
          t: 'tool',
          name: String(record['name'] ?? record['tool'] ?? 'tool'),
          input: record,
        });
        continue;
      }
      out.push({ t: 'unknown', raw: trimmed });
    }
    return out;
  },

  extractResults(ctx: ExtractContext): TaskResult[] {
    const fromText = extractResultFromText(ctx.taskIds, collectText(ctx.events));
    if (fromText) return fromText.results;

    // Recover `isRetryable` from the raw error line kept as unknown.
    for (let i = ctx.events.length - 1; i >= 0; i -= 1) {
      const event = ctx.events[i];
      if (!event || event.t !== 'unknown') continue;
      const obj = parseLine(event.raw);
      const error = obj && obj.type === 'error' ? readError(obj) : null;
      if (error) {
        return synthesizeFailure(ctx.taskIds, error.message, {
          retryable: error.retryable,
        });
      }
    }

    const errorEvent = ctx.events.find((event) => event.t === 'error');
    if (errorEvent && errorEvent.t === 'error') {
      return synthesizeFailure(ctx.taskIds, errorEvent.message, {
        retryable: errorEvent.kind === 'rate_limit',
      });
    }

    const detail = stripAnsi(ctx.stderr).trim().split('\n').slice(-3).join(' ').trim();
    return synthesizeFailure(
      ctx.taskIds,
      `opencode produced no parseable result (exit ${String(ctx.exitCode)})${detail ? `: ${detail}` : ''}`,
    );
  },

  extractUsage(events: ProviderEvent[]): ProviderUsage {
    // opencode 1.18.25 emits one `step_finish` line per step, carrying
    // `part.tokens` and `part.cost`; a flatter shape put both at the top level.
    // Every such line is kept as an `unknown` event — read whichever holder is
    // present and sum across steps, without widening the ProviderEvent union.
    //
    // `tokens` splits input three ways — `input` is *fresh* only, with cache
    // reads/writes alongside under `tokens.cache`. The ProviderUsage contract
    // wants `input_tokens` gross (fresh + cache), matching claude.ts.
    const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
    let fresh = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let sawTokens = false;
    let sawCost = false;

    for (const event of events) {
      if (event.t !== 'unknown') continue;
      const obj = parseLine(event.raw);
      if (!obj) continue;
      const holder =
        obj.part !== null && typeof obj.part === 'object'
          ? (obj.part as Record<string, unknown>)
          : (obj as unknown as Record<string, unknown>);
      const tokens =
        holder['tokens'] !== null && typeof holder['tokens'] === 'object'
          ? (holder['tokens'] as Record<string, unknown>)
          : null;
      if (tokens) {
        const cache =
          tokens['cache'] !== null && typeof tokens['cache'] === 'object'
            ? (tokens['cache'] as Record<string, unknown>)
            : {};
        fresh += num(tokens['input']);
        output += num(tokens['output']);
        cacheRead += num(cache['read']);
        cacheWrite += num(cache['write']);
        sawTokens = true;
      }
      if (typeof holder['cost'] === 'number') {
        cost += holder['cost'] as number;
        sawCost = true;
      }
    }

    const out: ProviderUsage = {};
    if (sawTokens) {
      const grossInput = fresh + cacheRead + cacheWrite;
      if (grossInput > 0) out.input_tokens = grossInput;
      if (output > 0) out.output_tokens = output;
      if (cacheRead > 0) out.cached_input_tokens = cacheRead;
      if (cacheWrite > 0) out.cache_write_input_tokens = cacheWrite;
    }
    if (sawCost) out.cost_usd = cost;
    return out;
  },
};
