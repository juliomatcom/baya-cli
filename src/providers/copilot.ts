import { type ProviderEvent, type TaskResult } from '../manifest/index.js';
import { stripAnsi } from '../log/index.js';
import { extractResultFromText, synthesizeFailure } from './result.js';
import type {
  BuildRunInput,
  ExtractContext,
  ProviderAdapter,
  ProviderUsage,
  SpawnPlan,
} from './types.js';

/**
 * copilot adapter (providers.md §copilot, flags verified live 2026-08-28,
 * v1.0.81; **success path unverified** — the monthly quota was exhausted before
 * the probe reached any tool use).
 *
 * The one provider that breaks the "prefer files" rule: `-p` takes the prompt
 * as a **flag value**, argv-only. `--attachment` is for images, not a prompt
 * file. So the prompt travels in argv here and nowhere else does.
 *
 * `--output-format json` is JSONL where ~3/4 of the lines are `ephemeral:true`
 * progress noise — filtered. The terminal `result` line carries the session id,
 * the exit code, and `usage.codeChanges.filesModified` for free.
 *
 * ⚠️ The assistant-text event shape is UNVERIFIED (the probe failed before any
 * text). `readText` guesses at a few plausible keys; the contract tier (M3.7)
 * settles it once quota resets.
 */

function needsAllTools(input: BuildRunInput): boolean {
  return input.dangerouslyAllowAll || input.task.access === 'read-write';
}

/** Flags shared by `-p` and `--resume`, in a fixed order for the snapshot. */
function commonFlags(input: BuildRunInput): string[] {
  const argv = [
    '--output-format',
    'json',
    '-C',
    input.cwd,
    '--no-color',
    // Disable the `ask_user` tool: a question must come back as a
    // `needs_input` result, never block the process on an interactive prompt.
    '--no-ask-user',
  ];
  // Required for unattended *tool execution*, not for parsing. Readers are left
  // without it — copilot has no read-only sandbox, so this is the only lever.
  if (needsAllTools(input)) argv.push('--allow-all-tools');
  if (input.model !== null) argv.push('--model', input.model);
  if (input.sessionId !== undefined) argv.push('--session-id', input.sessionId);
  return argv;
}

interface CopilotLine {
  type?: unknown;
  data?: unknown;
  ephemeral?: unknown;
  sessionId?: unknown;
  exitCode?: unknown;
  usage?: unknown;
}

function parseLine(raw: string): CopilotLine | null {
  let value: unknown;
  try {
    value = JSON.parse(stripAnsi(raw).trim());
  } catch {
    return null;
  }
  return value !== null && typeof value === 'object' ? (value as CopilotLine) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function classify(
  code: string,
  status: number | undefined,
): 'rate_limit' | 'auth' | 'other' {
  const lower = code.toLowerCase();
  if (status === 401 || status === 403 || lower.includes('auth')) return 'auth';
  if (
    status === 402 ||
    status === 429 ||
    lower.includes('quota') ||
    lower.includes('rate')
  )
    return 'rate_limit';
  return 'other';
}

function readError(obj: CopilotLine): {
  kind: 'rate_limit' | 'auth' | 'other';
  message: string;
  retryable: boolean;
} | null {
  if (obj.type !== 'session.error' && obj.type !== 'error') return null;
  const data = asRecord(obj.data);
  const errorType = String(data['errorType'] ?? '');
  const errorCode = String(data['errorCode'] ?? data['message'] ?? 'error');
  const status =
    typeof data['statusCode'] === 'number' ? (data['statusCode'] as number) : undefined;
  const kind = classify(`${errorType} ${errorCode}`, status);
  // quota/auth never succeed on a blind retry — that is a "retry later, maybe
  // elsewhere" case, so this adapter reports it as non-retryable.
  return {
    kind,
    message: `${errorCode}${status !== undefined ? ` (HTTP ${status})` : ''}`,
    retryable: kind === 'rate_limit' && status !== 402 && !errorType.includes('quota'),
  };
}

function readText(obj: CopilotLine): string | null {
  const type = String(obj.type ?? '');
  const data = asRecord(obj.data);
  const candidate =
    data['text'] ??
    data['content'] ??
    data['message'] ??
    obj['text' as keyof CopilotLine];
  if (
    (type.includes('assistant') || type.includes('message') || type === 'text') &&
    typeof candidate === 'string' &&
    candidate.trim() !== ''
  ) {
    return candidate;
  }
  return null;
}

function filesModified(obj: CopilotLine): string[] {
  const usage = asRecord(obj.usage);
  const codeChanges = asRecord(usage['codeChanges']);
  const files = codeChanges['filesModified'];
  return Array.isArray(files) ? files.map((f) => String(f)) : [];
}

function lastResultLine(events: ProviderEvent[]): CopilotLine | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.t !== 'final') continue;
    const obj = parseLine(event.raw);
    if (obj && obj.type === 'result') return obj;
  }
  return null;
}

function collectText(events: ProviderEvent[]): string {
  return events
    .filter((event): event is Extract<ProviderEvent, { t: 'text' }> => event.t === 'text')
    .map((event) => event.text)
    .join('\n');
}

export const copilotAdapter: ProviderAdapter = {
  id: 'copilot',

  capabilities: {
    promptDelivery: ['argv'],
    structuredOutput: 'none',
    events: 'jsonl',
    sessionId: 'preassign',
    resume: 'session',
    // Deferred: this adapter emits `tool` events, but neither its event
    // shapes nor its resume path have been exercised for memory. Scoped to
    // codex + claude first (execution.md §Memory), widened one at a time.
    observations: 'none',
    cwdFlag: true,
    modelFlag: true,
    maxConcurrency: 1,
  },

  installHint: 'npm i -g @github/copilot',

  buildRun(input: BuildRunInput): SpawnPlan {
    return {
      // `-p <text>` — the one place a prompt rides in argv. Everything after is
      // fixed-order flags so the snapshot catches drift.
      argv: [input.bin, '-p', input.prompt, ...commonFlags(input)],
      cwd: input.cwd,
      stdin: 'ignore',
    };
  },

  /** `copilot --resume=<id>` with the answer as a fresh `-p` prompt. */
  buildResume(sessionId: string, answer: string, input: BuildRunInput): SpawnPlan {
    return {
      argv: [input.bin, '-p', answer, '--resume', sessionId, ...commonFlags(input)],
      cwd: input.cwd,
      stdin: 'ignore',
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
      // ~3/4 of the stream is ephemeral progress noise — documented, drop it.
      if (obj.ephemeral === true) continue;

      const error = readError(obj);
      if (error) {
        out.push({ t: 'error', kind: error.kind, message: error.message });
        out.push({ t: 'unknown', raw: trimmed });
        continue;
      }

      if (obj.type === 'result') {
        if (typeof obj.sessionId === 'string') {
          out.push({ t: 'session', id: obj.sessionId });
        }
        out.push({ t: 'final', raw: trimmed });
        continue;
      }

      const text = readText(obj);
      if (text !== null) {
        out.push({ t: 'text', text });
        continue;
      }

      const type = String(obj.type ?? '');
      if (type.includes('tool')) {
        const data = asRecord(obj.data);
        out.push({
          t: 'tool',
          name: String(data['name'] ?? data['tool'] ?? type),
          input: data,
        });
        continue;
      }

      out.push({ t: 'unknown', raw: trimmed });
    }
    return out;
  },

  extractResults(ctx: ExtractContext): TaskResult[] {
    const resultLine = lastResultLine(ctx.events);
    const changed = resultLine ? filesModified(resultLine) : [];

    const fromText = extractResultFromText(ctx.taskIds, collectText(ctx.events));
    if (fromText) {
      const results = fromText.results;
      // The `result` line is the authority on what actually changed on disk —
      // but it reports the whole **process**, so it can only be attributed
      // when the process ran one task. Splitting a process-wide file list
      // across a group would credit every task with every other task's edits.
      const only = results[0];
      return results.length === 1 &&
        only !== undefined &&
        only.files_changed.length === 0 &&
        changed.length > 0
        ? [{ ...only, files_changed: changed }]
        : results;
    }

    for (let i = ctx.events.length - 1; i >= 0; i -= 1) {
      const event = ctx.events[i];
      if (!event || event.t !== 'unknown') continue;
      const error = readError(parseLine(event.raw) ?? {});
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

    const exit = resultLine?.exitCode;
    const detail = stripAnsi(ctx.stderr).trim().split('\n').slice(-3).join(' ').trim();
    return synthesizeFailure(
      ctx.taskIds,
      `copilot produced no parseable result (exit ${String(exit ?? ctx.exitCode)})${detail ? `: ${detail}` : ''}`,
    );
  },

  extractUsage(events: ProviderEvent[]): ProviderUsage {
    const resultLine = lastResultLine(events);
    if (!resultLine) return {};
    const usage = asRecord(resultLine.usage);
    const out: ProviderUsage = {};
    const num = (...keys: string[]): number | undefined => {
      for (const key of keys) {
        if (typeof usage[key] === 'number') return usage[key] as number;
      }
      return undefined;
    };
    const input = num('inputTokens', 'input_tokens', 'promptTokens');
    const output = num('outputTokens', 'output_tokens', 'completionTokens');
    const cost = num('costUsd', 'cost_usd', 'aiCredits', 'premiumRequests');
    if (input !== undefined) out.input_tokens = input;
    if (output !== undefined) out.output_tokens = output;
    if (cost !== undefined) out.cost_usd = cost;
    return out;
  },
};
