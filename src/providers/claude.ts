import { type ProviderEvent, type TaskResult } from '../manifest/index.js';
import { stripAnsi } from '../log/index.js';
import { extractResultFromText, parseResultJson, synthesizeFailure } from './result.js';
import { wantsEverything, type ToolCapability } from './tools.js';
import type {
  BuildRunInput,
  ExtractContext,
  ProviderAdapter,
  ProviderUsage,
  SpawnPlan,
} from './types.js';

/**
 * claude adapter (providers.md §claude, flags verified live 2026-08-28, v2.1.251).
 *
 * Second provider after codex, and the one that proves the abstraction against
 * a different schema-enforcement shape: codex is file-in/file-out, claude is
 * **inline** — `--json-schema` rejects a file path, and the conforming object
 * comes back on `.structured_output` inside a single JSON blob rather than in a
 * file of its own.
 *
 * ⚠️ No working-directory flag exists — `--add-dir` only *widens* access. The
 * working directory is the spawn `cwd` and nothing else.
 */

/** Drop the `$schema` meta-pointer claude's validator cannot resolve; keep the rest. */
function withoutSchemaKey(schemaContents: string): Record<string, unknown> {
  const parsed = JSON.parse(schemaContents) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = parsed;
  void _drop;
  return rest;
}

/**
 * The editing tools, withheld from a task granted only `read-only` access.
 * Bash is deliberately NOT in this list — see `permissionModeFor`.
 *
 * Only reachable under `tools: ['all']` now; the lean path names what it wants
 * instead of naming what it does not.
 */
const EDIT_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const;

/**
 * What a task actually gets, as an **allowlist**.
 *
 * ⚠️ `--disallowed-tools` — what this replaced — withholds a tool's *use* and
 * still ships its *definition*. That distinction is the whole cost: measured
 * 2026-09-04 (v2.1.251) on a task whose prompt is ~400 tokens, claude's default
 * surface is 14,419 input tokens and this set is 7,517. The ~7k difference is
 * tool JSON for `Task`, `WebFetch`, `WebSearch`, `Skill`, `SlashCommand`,
 * `ToolSearch` and friends, none of which a "summarize this file" task opens.
 *
 * ⚠️ `Bash` is in the **read-only** set on purpose. Withholding it would read
 * as the stricter choice — and would finally close the gap `permissionModeFor`
 * documents, where a read-only claude task can still write through a shell
 * redirect — but it would also silently break every existing read-only task
 * that shells out to `git log` or `rg`. Access semantics are not this change's
 * to alter; `access` still means what it meant.
 */
const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'] as const;
const WRITE_TOOLS = ['Write', 'Edit', 'TodoWrite'] as const;

/** Capability names to the tools claude calls them. Unmapped names are ignored. */
const CAPABILITY_TOOLS: Partial<Record<ToolCapability, readonly string[]>> = {
  web: ['WebFetch', 'WebSearch'],
  agents: ['Task'],
  notebook: ['NotebookEdit'],
};

function toolsFor(input: BuildRunInput): string[] {
  const names = new Set<string>(READ_TOOLS);
  if (input.task.access === 'read-write' || input.dangerouslyAllowAll) {
    for (const name of WRITE_TOOLS) names.add(name);
  }
  for (const capability of input.tools ?? []) {
    for (const name of CAPABILITY_TOOLS[capability] ?? []) names.add(name);
  }
  return [...names];
}

/**
 * Non-interactive `-p` cannot prompt, so the mode has to pre-decide everything
 * — and both halves of the old map pre-decided wrong.
 *
 * - `acceptEdits` pre-approves file edits *only*; Bash still wants a prompt
 *   `-p` has nobody to answer, so every command was denied. Measured: a real
 *   12-task run logged 54 `Bash` denials — `npm test`, `tsc`, bare `grep` —
 *   and shipped unverified work with an apology in the summary.
 * - `plan` is worse: it refuses every non-readonly tool, so a task could not
 *   run a test or a linter, and plan mode bends the output into a plan
 *   proposal on top of that.
 *
 * Hence `auto` for both, with `read-only` enforced by removing the editing
 * tools rather than by muzzling the session.
 *
 * ⚠️ That guard is narrower than codex's. `read-only` is an OS sandbox there;
 * here it is a tool withdrawal, so a `read-only` task can still mutate the tree
 * through a shell redirect. `auto` classifies those calls, but the enforcement
 * is not equivalent — a task that must not touch the tree belongs on codex.
 */
function permissionModeFor(input: BuildRunInput): string {
  return input.dangerouslyAllowAll ? 'bypassPermissions' : 'auto';
}

/**
 * Flags shared by `-p` and `--resume`, in a fixed order for the snapshot.
 *
 * `resuming` drops `--session-id`: the id is already named by `--resume`, and
 * passing both asks claude to create and to continue the same session in one
 * invocation.
 */
function commonFlags(input: BuildRunInput, resuming = false): string[] {
  const argv = [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    // Inline JSON only — a file path is rejected. And no `$schema` meta-pointer:
    // claude's validator has no 2020-12 meta-schema loaded and fails with
    // "no schema with key or ref https://json-schema.org/draft/2020-12/schema".
    // It validates structurally without a declared dialect.
    JSON.stringify(withoutSchemaKey(input.schemaContents)),
    '--permission-mode',
    permissionModeFor(input),
  ];
  // Comma-joined, not spread: both tool flags are variadic and would otherwise
  // swallow whatever flag follows them.
  if (input.noTools === true) {
    // An empty allowlist, which claude accepts: no tool definitions at all.
    argv.push('--tools', '');
  } else if (wantsEverything(input.tools)) {
    // `all` is the escape from the capability list: claude's own default
    // surface, with only the access guard this adapter has always applied.
    if (input.task.access === 'read-only' && !input.dangerouslyAllowAll) {
      argv.push('--disallowed-tools', EDIT_TOOLS.join(','));
    }
  } else {
    argv.push('--tools', toolsFor(input).join(','));
  }
  if (input.model !== null) argv.push('--model', input.model);
  // `--session-id` pre-assigns the id so resume needs no event parsing (M4.1).
  if (!resuming && input.sessionId !== undefined) {
    argv.push('--session-id', input.sessionId);
  }
  return argv;
}

/**
 * Suppresses claude's non-essential background traffic. The one that costs
 * money is `generate_session_title`: before the first turn, claude sends the
 * whole prompt to Haiku to write a display name for the `/resume` picker.
 *
 * Measured 2026-09-04 (v2.1.251) via `--debug api`, which names it outright —
 * `[API REQUEST] /v1/messages source=generate_session_title`. It cost 1,282
 * input tokens for an 11-token title on a task whose own prompt is ~400, and
 * ~12% of that task's spend. Baya never reads the title: sessions are addressed
 * by the id `--session-id` pre-assigns, so the picker it feeds is one nothing
 * here ever opens.
 *
 * There is no flag for it. `--no-session-persistence` does not suppress it
 * (measured: the Haiku call still fires) and would cost `--resume`, which
 * chains depend on. The variable is the only lever, and it leaves the session
 * itself intact — verified with a two-turn `--session-id` / `--resume`
 * round-trip that carried its context across and made no Haiku call on either
 * turn.
 */
const QUIET_ENV = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } as const;

function classify(text: string): 'rate_limit' | 'auth' | 'other' {
  const lower = text.toLowerCase();
  if (
    lower.includes('rate limit') ||
    lower.includes('429') ||
    lower.includes('overloaded')
  )
    return 'rate_limit';
  if (
    lower.includes('unauthorized') ||
    lower.includes('401') ||
    lower.includes('authentication') ||
    lower.includes('api key')
  )
    return 'auth';
  return 'other';
}

/** The one JSON object `--output-format json` prints, parsed. */
interface ClaudeResult {
  session_id?: unknown;
  result?: unknown;
  is_error?: unknown;
  subtype?: unknown;
  permission_denials?: unknown;
  total_cost_usd?: unknown;
  structured_output?: unknown;
  usage?: unknown;
}

function parseObject(raw: string): ClaudeResult | null {
  let value: unknown;
  try {
    value = JSON.parse(stripAnsi(raw).trim());
  } catch {
    return null;
  }
  return value !== null && typeof value === 'object' ? (value as ClaudeResult) : null;
}

function lastFinalObject(events: ProviderEvent[]): ClaudeResult | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && event.t === 'final') {
      const parsed = parseObject(event.raw);
      if (parsed) return parsed;
    }
  }
  return null;
}

function deniedTools(obj: ClaudeResult): string[] {
  if (!Array.isArray(obj.permission_denials)) return [];
  return obj.permission_denials.map((entry) => {
    if (entry !== null && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      return String(record['tool_name'] ?? record['tool'] ?? JSON.stringify(entry));
    }
    return String(entry);
  });
}

/**
 * A result that parsed is still a result — but a task refused its tools along
 * the way did work it could not verify, and that has to reach the report
 * rather than only the prose the model wrote about it. The failure path in
 * `extractResult` fires only when *nothing* parsed, so without this a denied
 * run reports a clean `succeeded` and the caveat lives in a summary nobody
 * greps. `warn` is precisely the "done, but you should know…" channel.
 */
function withDenialNote(results: TaskResult[], denied: string[]): TaskResult[] {
  if (denied.length === 0) return results;
  const counts = new Map<string, number>();
  for (const name of denied) counts.set(name, (counts.get(name) ?? 0) + 1);
  const listed = [...counts.entries()]
    .map(([name, n]) => (n > 1 ? `${name} \u00d7${n}` : name))
    .join(', ');
  // Every task in the process shares its permission set, so every task in the
  // process shares the caveat.
  return results.map((result) => ({
    ...result,
    notes: [
      ...result.notes,
      {
        severity: 'warn' as const,
        message: `claude was denied permission for: ${listed}. Whatever the task could not run, it could not verify.`,
      },
    ],
  }));
}

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',

  capabilities: {
    promptDelivery: ['stdin', 'argv'],
    structuredOutput: 'schema-inline',
    events: 'json',
    sessionId: 'preassign',
    resume: 'session',
    // `--output-format json` is one object, so no `tool` events exist to read
    // and this adapter reports no commands. Its file changes still reach
    // memory through the protocol's own `files_changed`.
    observations: 'none',
    cwdFlag: false,
    modelFlag: true,
    // Subscription-throttled until measured under load (risk register).
    maxConcurrency: 1,
  },

  installHint: 'npm i -g @anthropic-ai/claude-code',

  buildRun(input: BuildRunInput): SpawnPlan {
    return {
      argv: [input.bin, ...commonFlags(input), ...(input.extraArgs ?? [])],
      cwd: input.cwd,
      stdin: 'pipe',
      stdinData: input.prompt,
      env: { ...QUIET_ENV },
    };
  },

  /**
   * `claude --resume <session_id>` with the answer on stdin. The id is the one
   * `--session-id` pre-assigned, or the `.session_id` captured from the result.
   */
  buildResume(sessionId: string, answer: string, input: BuildRunInput): SpawnPlan {
    return {
      argv: [
        input.bin,
        '--resume',
        sessionId,
        ...commonFlags(input, true),
        ...(input.extraArgs ?? []),
      ],
      cwd: input.cwd,
      stdin: 'pipe',
      stdinData: answer,
      env: { ...QUIET_ENV },
    };
  },

  /**
   * `--output-format json` is a single object, not a stream — one line, parsed
   * once. `stream-json` would give incremental `text` events but needs
   * `--verbose` and a less certain shape; M3 takes the stable path.
   */
  parseEvents(chunk: string): ProviderEvent[] {
    const out: ProviderEvent[] = [];
    for (const line of chunk.split('\n')) {
      const trimmed = stripAnsi(line).trim();
      if (trimmed === '') continue;
      const obj = parseObject(trimmed);
      if (!obj) {
        out.push({ t: 'unknown', raw: trimmed });
        continue;
      }
      if (typeof obj.session_id === 'string') {
        out.push({ t: 'session', id: obj.session_id });
      }
      if (obj.is_error === true) {
        const message =
          typeof obj.result === 'string' && obj.result.trim() !== ''
            ? obj.result
            : String(obj.subtype ?? 'claude reported an error');
        out.push({ t: 'error', kind: classify(message), message });
      } else if (typeof obj.result === 'string' && obj.result.trim() !== '') {
        out.push({ t: 'text', text: obj.result });
      }
      out.push({ t: 'final', raw: trimmed });
    }
    return out;
  },

  extractResults(ctx: ExtractContext): TaskResult[] {
    const obj = lastFinalObject(ctx.events);

    if (obj) {
      // Read before the rungs, not after: a denial is news on a *successful*
      // result too, and both rungs below return early.
      const denied = deniedTools(obj);
      // Rung 1: the schema-enforced object claude parsed for us.
      if (obj.structured_output !== null && typeof obj.structured_output === 'object') {
        const parsed = parseResultJson(
          ctx.taskIds,
          JSON.stringify(obj.structured_output),
        );
        if (parsed) return withDenialNote(parsed, denied);
      }
      // Rungs 2–3: `.result` is the same payload as a string — often clean
      // JSON, sometimes prose around a fenced block.
      if (typeof obj.result === 'string') {
        const fromText = extractResultFromText(ctx.taskIds, obj.result);
        if (fromText) return withDenialNote(fromText.results, denied);
      }
      if (denied.length > 0) {
        return synthesizeFailure(
          ctx.taskIds,
          `claude was denied permission for: ${denied.join(', ')}. Raise --permission-mode or pass --dangerously-allow-all.`,
          { retryable: false },
        );
      }
      if (obj.is_error === true) {
        const message =
          typeof obj.result === 'string' && obj.result.trim() !== ''
            ? obj.result
            : `claude error (${String(obj.subtype ?? 'unknown')})`;
        return synthesizeFailure(ctx.taskIds, message, {
          retryable: classify(message) !== 'auth',
        });
      }
    }

    const errorEvent = ctx.events.find((event) => event.t === 'error');
    if (errorEvent && errorEvent.t === 'error') {
      return synthesizeFailure(ctx.taskIds, errorEvent.message, {
        retryable: errorEvent.kind !== 'auth',
      });
    }

    const detail = stripAnsi(ctx.stderr).trim().split('\n').slice(-3).join(' ').trim();
    return synthesizeFailure(
      ctx.taskIds,
      `claude produced no parseable result (exit ${String(ctx.exitCode)})${detail ? `: ${detail}` : ''}`,
    );
  },

  extractUsage(events: ProviderEvent[]): ProviderUsage {
    const obj = lastFinalObject(events);
    if (!obj) return {};
    const out: ProviderUsage = {};
    if (typeof obj.total_cost_usd === 'number') out.cost_usd = obj.total_cost_usd;
    if (obj.usage !== null && typeof obj.usage === 'object') {
      const usage = obj.usage as Record<string, unknown>;
      const num = (key: string): number =>
        typeof usage[key] === 'number' ? (usage[key] as number) : 0;
      const write = num('cache_creation_input_tokens');
      const read = num('cache_read_input_tokens');
      const input = num('input_tokens') + write + read;
      const output = num('output_tokens');
      if (input > 0) out.input_tokens = input;
      if (output > 0) out.output_tokens = output;
      if (write > 0) out.cache_write_input_tokens = write;
      if (read > 0) out.cached_input_tokens = read;
    }
    return out;
  },
};
