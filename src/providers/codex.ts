import { type ProviderEvent, type TaskResult } from '../manifest/index.js';
import { stripAnsi } from '../log/index.js';
import { parseResultJson, synthesizeFailure } from './result.js';
import type {
  BuildRunInput,
  ExtractContext,
  Observation,
  ProviderAdapter,
  ProviderUsage,
  SpawnPlan,
} from './types.js';

/**
 * codex adapter (providers.md §codex, verified live 2026-08-28).
 *
 * The strongest surface in the set and therefore the one the engine is built
 * against: file-in / file-out schema enforcement means the result never has to
 * be parsed out of prose, so M1 exercises the clean path end to end.
 *
 * ⚠️ `-p` is `--profile`, NOT the prompt. The prompt is positional, `-`, or
 * stdin — we use `-` plus stdin. The argv snapshot test is what keeps this
 * from silently regressing when the CLI drifts.
 */

function sandboxFor(input: BuildRunInput): string {
  if (input.dangerouslyAllowAll) return 'danger-full-access';
  return input.task.access === 'read-write' ? 'workspace-write' : 'read-only';
}

/**
 * ⚠️ `codex exec` and `codex exec resume` do **not** share a flag surface.
 * Verified live 2026-08-29 against codex-cli 0.150.1: `resume` accepts
 * `--json`, `--skip-git-repo-check`, `--output-schema`, `-o`, `-m` — and
 * rejects `-C`, `-s`, and `--color`, exiting 2 with
 * `error: unexpected argument '-C' found` before the model is ever reached.
 *
 * Passing the `exec` set to `resume` is what made every session continuation
 * fail in the first real chain run. The consequences of the three it drops:
 *
 * - **`-C`** — the working directory comes from the spawn `cwd` instead, which
 *   `SpawnPlan` already carries. No behavior is lost.
 * - **`-s`** — a resumed turn **inherits the sandbox its session was opened
 *   with**; codex offers no way to change it. That is why a chain may only
 *   collapse across turns of the same `access` (execution.md §Session reuse).
 * - **`--color`** — ANSI is stripped everywhere regardless (conventions #12),
 *   so this costs nothing.
 */
function commonFlags(input: BuildRunInput, mode: 'exec' | 'resume'): string[] {
  const argv = ['--json'];
  if (mode === 'exec') argv.push('--color', 'never');
  argv.push('--skip-git-repo-check');
  if (mode === 'exec') argv.push('-C', input.cwd, '-s', sandboxFor(input));
  argv.push('--output-schema', input.schemaPath, '-o', input.resultFile);
  if (input.model !== null) argv.push('-m', input.model);
  return argv;
}

/**
 * Paths touched by a `file_change` item.
 *
 * ⚠️ The field is `changes: [{path, kind}]`, **not** `path`. Reading `path`
 * yielded a bare `Edit()` for every file change codex ever reported — the
 * older shape is kept as a fallback because it costs one `??`.
 */
function changedPaths(item: Record<string, unknown>): string[] {
  const changes = item['changes'];
  if (Array.isArray(changes)) {
    return changes
      .map((change) => {
        if (change === null || typeof change !== 'object') return '';
        return String((change as Record<string, unknown>)['path'] ?? '');
      })
      .filter((path) => path !== '');
  }
  const single = item['path'];
  return typeof single === 'string' && single !== '' ? [single] : [];
}

function toolNameFor(itemType: string, item: Record<string, unknown>): string {
  switch (itemType) {
    case 'command_execution':
      return `Shell(${String(item['command'] ?? '')})`;
    case 'file_change':
      return `Edit(${changedPaths(item).join(', ')})`;
    case 'mcp_tool_call':
      return `${String(item['server'] ?? 'mcp')}.${String(item['tool'] ?? '')}`;
    case 'web_search':
      return `Search(${String(item['query'] ?? '')})`;
    default:
      return itemType;
  }
}

function eventForLine(line: string): ProviderEvent {
  const trimmed = stripAnsi(line).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { t: 'unknown', raw: trimmed };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { t: 'unknown', raw: trimmed };
  }
  const obj = parsed as Record<string, unknown>;

  switch (obj['type']) {
    case 'thread.started': {
      const id = obj['thread_id'];
      // The session id is the whole reason this event matters; without it the
      // line is just noise, and `unknown` is where noise belongs.
      if (typeof id === 'string') return { t: 'session', id };
      return { t: 'unknown', raw: trimmed };
    }
    case 'item.completed': {
      const item = obj['item'];
      if (item === null || typeof item !== 'object') {
        return { t: 'unknown', raw: trimmed };
      }
      const record = item as Record<string, unknown>;
      const itemType = String(record['type'] ?? '');
      if (itemType === 'agent_message') {
        return { t: 'text', text: String(record['text'] ?? '') };
      }
      // codex reports its own diagnostics (a missing model-metadata entry, a
      // truncated turn) as an `error` item. That is a message to read in full,
      // not a tool call to abbreviate.
      if (itemType === 'error') {
        const message = String(record['message'] ?? trimmed);
        return { t: 'error', kind: classifyErrorText(message), message };
      }
      return { t: 'tool', name: toolNameFor(itemType, record), input: record };
    }
    case 'error': {
      const message = String(obj['message'] ?? trimmed);
      return { t: 'error', kind: classifyErrorText(message), message };
    }
    default:
      // turn.started / turn.completed and anything codex adds next. Kept, not
      // dropped: `turn.completed` carries usage, and silent drops make drift invisible.
      return { t: 'unknown', raw: trimmed };
  }
}

function classifyErrorText(message: string): 'rate_limit' | 'auth' | 'other' {
  const lower = message.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('429')) return 'rate_limit';
  if (lower.includes('unauthorized') || lower.includes('401')) return 'auth';
  return 'other';
}

export const codexAdapter: ProviderAdapter = {
  id: 'codex',

  capabilities: {
    promptDelivery: ['stdin', 'argv'],
    structuredOutput: 'schema-file',
    events: 'jsonl',
    sessionId: 'capture',
    resume: 'session',
    // `--json` already carries `command_execution` (with `exit_code`) and
    // `file_change`, so Baya's own `events.jsonl` is the record — no sidecar.
    observations: 'events',
    cwdFlag: true,
    modelFlag: true,
    maxConcurrency: 2,
  },

  installHint: 'npm i -g @openai/codex',

  buildRun(input: BuildRunInput): SpawnPlan {
    return {
      argv: [input.bin, 'exec', ...commonFlags(input, 'exec'), '-'],
      cwd: input.cwd,
      stdin: 'pipe',
      stdinData: input.prompt,
    };
  },

  /**
   * `codex exec resume <thread_id>` — the id captured from `thread.started`.
   * `thread_id` is a UUID and `resume` takes one positionally — verified live
   * 2026-08-29. What was actually wrong was the flag set; see `commonFlags`.
   */
  buildResume(sessionId: string, answer: string, input: BuildRunInput): SpawnPlan {
    return {
      argv: [
        input.bin,
        'exec',
        'resume',
        sessionId,
        ...commonFlags(input, 'resume'),
        '-',
      ],
      cwd: input.cwd,
      stdin: 'pipe',
      stdinData: answer,
    };
  },

  extractObservations(ctx: ExtractContext): Observation[] {
    const out: Observation[] = [];
    for (const event of ctx.events) {
      if (event.t !== 'tool') continue;
      const item = event.input;
      if (item === null || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (record['type'] === 'command_execution') {
        const command = record['command'];
        if (typeof command !== 'string' || command.trim() === '') continue;
        // `exit_code` arrives as a string in the JSONL; `status` is the
        // narrative version of the same thing and is the safer read.
        const ok =
          record['status'] === 'completed' && String(record['exit_code'] ?? '0') === '0';
        out.push({ kind: 'command', command, ok });
        continue;
      }
      if (record['type'] === 'file_change') {
        for (const path of changedPaths(record)) out.push({ kind: 'write', path });
      }
    }
    return out;
  },

  parseEvents(chunk: string): ProviderEvent[] {
    return chunk
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(eventForLine);
  },

  /**
   * Rung 1 of the degradation ladder and, for codex, the only rung that should
   * ever fire: `--output-schema` + `-o` means the file holds exactly the
   * conforming JSON. Anything else is a failure to report, not prose to mine.
   */
  extractResults(ctx: ExtractContext): TaskResult[] {
    if (ctx.resultFileContents !== null && ctx.resultFileContents.trim() !== '') {
      const parsed = parseResultJson(ctx.taskIds, ctx.resultFileContents);
      if (parsed) return parsed;
      return synthesizeFailure(
        ctx.taskIds,
        'codex wrote a result file that does not match task_result',
        { retryable: true },
      );
    }

    // The last error wins: codex emits non-fatal diagnostics (an unknown-model
    // metadata warning) as `error` items too, and a real failure comes after.
    const errorEvent = ctx.events.findLast((event) => event.t === 'error');
    if (errorEvent && errorEvent.t === 'error') {
      return synthesizeFailure(ctx.taskIds, errorEvent.message, {
        retryable: errorEvent.kind !== 'auth',
      });
    }

    const detail = stripAnsi(ctx.stderr).trim().split('\n').slice(-3).join(' ').trim();
    return synthesizeFailure(
      ctx.taskIds,
      `codex produced no result file (exit ${String(ctx.exitCode)})${detail ? `: ${detail}` : ''}`,
    );
  },

  extractUsage(events: ProviderEvent[]): ProviderUsage {
    // `turn.completed` lands in `unknown`; usage is read back out here rather
    // than widening the ProviderEvent union for one provider's accounting.
    // A resumed task emits several `turn.completed` lines — codex reports each
    // turn's own usage, so they sum. (codex has no `cost_usd` field of its
    // own; a run's dollar figure stays 0 until a provider that reports it.)
    const out: ProviderUsage = {};
    for (const event of events) {
      if (event.t !== 'unknown') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.raw);
      } catch {
        continue;
      }
      const obj = parsed as Record<string, unknown> | null;
      if (!obj || obj['type'] !== 'turn.completed') continue;
      const usage = obj['usage'];
      if (!usage || typeof usage !== 'object') continue;
      const u = usage as Record<string, unknown>;
      if (typeof u['input_tokens'] === 'number') {
        out.input_tokens = (out.input_tokens ?? 0) + u['input_tokens'];
      }
      // codex reports the cache split on the same line; ignoring it hid that a
      // continued turn reads ~96k of transcript to do 35k of work.
      if (typeof u['cached_input_tokens'] === 'number') {
        out.cached_input_tokens =
          (out.cached_input_tokens ?? 0) + u['cached_input_tokens'];
      }
      if (typeof u['cache_write_input_tokens'] === 'number') {
        out.cache_write_input_tokens =
          (out.cache_write_input_tokens ?? 0) + u['cache_write_input_tokens'];
      }
      if (typeof u['output_tokens'] === 'number') {
        out.output_tokens = (out.output_tokens ?? 0) + u['output_tokens'];
      }
      if (typeof u['cost_usd'] === 'number') {
        out.cost_usd = (out.cost_usd ?? 0) + u['cost_usd'];
      }
    }
    return out;
  },
};
