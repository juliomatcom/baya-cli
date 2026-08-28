# Providers

> **Maintenance Invariant:** One section per provider, each stating **verification status and date**. Never document an unverified flag as fact. Re-verify via contract tests (`testing.md`) and update in the SAME commit as any adapter change.
> **Answers:** What is each CLI's real flag surface, event shape, session-id field, and capability set? How is its binary found? How do we survive upstream drift?

v1 set: **`opencode`, `codex`, `claude`, `copilot`**. `gemini` verified, deferred to v1.1.
All four **live-probed 2026-08-28** (help text + real invocation), not read from docs.

## Capability matrix

|                           | codex                       | claude                               | copilot                      | opencode              |
| :------------------------ | :-------------------------- | :----------------------------------- | :--------------------------- | :-------------------- |
| Non-interactive           | `codex exec`                | `-p/--print`                         | `-p/--prompt <text>`         | `opencode run`        |
| Prompt via **file/stdin** | ✅ stdin or `-`             | ✅ stdin                             | ❌ **argv only**             | ✅ `-f/--file`        |
| Schema enforcement        | ✅ `--output-schema <FILE>` | ✅ `--json-schema '<inline>'`        | ❌                           | ❌                    |
| Result extraction         | `-o <FILE>` (clean JSON)    | `.structured_output` (parsed)        | JSONL text                   | JSONL text            |
| Events                    | `--json` JSONL              | `--output-format json`/`stream-json` | `--output-format json` JSONL | `--format json` JSONL |
| **Session id field**      | `thread_id`                 | `session_id`                         | `sessionId`                  | `sessionID`           |
| **Pre-assign session id** | ❌ capture                  | ✅ `--session-id <uuid>`             | ✅ `--session-id <id>`       | ❌ capture            |
| Resume                    | `codex exec resume <id>`    | `-r/--resume <id>`                   | `-r/--resume=<id>`           | `-s/--session <id>`   |
| Working dir flag          | ✅ `-C/--cd`                | ❌ **none** — set spawn `cwd`        | ✅ `-C`                      | ✅ `--dir`            |
| Disable color             | ✅ `--color never`          | ❌ none                              | ✅ `--no-color`              | ❌ none               |
| Cost cap                  | —                           | `--max-budget-usd`                   | `--max-ai-credits`           | —                     |

**Four different spellings of the session id.** Normalizing this is the single clearest justification for the adapter layer.

## Cross-cutting rules

### 1. Always set stdin explicitly — never inherit

`claude -p` with an argv prompt **blocks 3 seconds** waiting for stdin, then warns:
`Warning: no stdin data received in 3s, proceeding without it.`
`codex exec` writes `Reading additional input from stdin...` to stderr. Both vanish when stdin is set.

**Rule: every spawn sets `stdin` to the prompt pipe or `/dev/null`.** Across a 20-task run, inheriting costs a minute of pure latency and pollutes logs.

### 2. Schema enforcement has three tiers, not two

- **codex** — file in, file out. `--output-schema <FILE>` + `-o <FILE>`; the file contains exactly the conforming JSON. Cleanest path in the system; **no parsing at all**.
- **claude** — `--json-schema` accepts **inline JSON only**; a file path is rejected (`Error: --json-schema is not valid JSON`). Read the pre-parsed object from `.structured_output` (`.result` holds the same thing as a string).
- **copilot / opencode** — no enforcement. Fall to the fenced-extract rung of `protocol.md` §4.

### 3. ANSI stripping stays mandatory

`claude` and `opencode` expose no color flag. Use `--color never` / `--no-color` where they exist, and strip residual ANSI everywhere.

### 4. Retry classification is available from every provider

`copilot` → `session.error.errorCode` (e.g. `quota_exceeded`, `statusCode: 402`) · `opencode` → `error.data.isRetryable` **boolean** · `claude` → `is_error`, `subtype`, `permission_denials[]` · `codex` → exit code + stderr.

## Adapter interface

```ts
interface ProviderAdapter {
  id: ProviderId;
  resolve(): Promise<{ bin: string; version: string } | null>;
  capabilities: {
    promptDelivery: ("file" | "stdin" | "argv")[]; // ordered preference
    structuredOutput: "schema-file" | "schema-inline" | "none";
    events: "jsonl" | "json" | "none";
    sessionId: "preassign" | "capture";
    resume: "session" | "none";
    cwdFlag: boolean;
    modelFlag: boolean;
    maxConcurrency: number;
  };
  buildRun(task, env): { argv: string[]; cwd: string; stdin: "pipe" | "ignore" };
  buildResume(
    sessionId,
    answer,
    env,
  ): { argv: string[]; cwd: string; stdin: "pipe" | "ignore" };
  parseEvents(chunk: string): ProviderEvent[]; // fed complete lines; buffering is the executor's job
  extractResult(ctx: ExtractContext): TaskResult;
  extractUsage?(events): { cost_usd?; input_tokens?; output_tokens? };
}
```

`buildRun` returns `argv: string[]` — never a command string. `shell: true` is banned repo-wide. `buildRun` is pure and **snapshot-tested**; that snapshot is the drift alarm.

`extractUsage` is optional and per-provider: `codex` reports usage on `turn.completed`, which normalizes to an `unknown` event. Reading it back out here keeps accounting out of the `ProviderEvent` union, which would otherwise grow a member for one provider's bookkeeping.

`parseEvents` receives whole lines only. Partial-chunk buffering lives in `src/executor/spawn.ts`, so every adapter gets it right by not implementing it.

## Binary resolution

`.baya/config.json` override → `$PATH` → known locations → not found.
Known: `~/.local/bin`, `~/.opencode/bin`, active nvm `bin`, `~/.claude/local`, `/opt/homebrew/bin`.

Verified paths on the reference machine: `claude` and `codex` in `~/.local/bin`; `copilot` and `gemini` in the nvm bin; `opencode` in `~/.opencode/bin`. **Not one is in a system directory** — never assume a plain `$PATH` lookup.

---

## codex — ✅ verified 2026-08-28 (live)

`codex exec [PROMPT]`. Prompt: positional, `-`, or **stdin**.

`-m/--model` · `-C/--cd <DIR>` · `--add-dir` · `-s/--sandbox {read-only,workspace-write,danger-full-access}` · `--json` · `--output-schema <FILE>` · `-o/--output-last-message <FILE>` · `--color never` · `--skip-git-repo-check` · `--ephemeral` · resume `codex exec resume [--last]`.

⚠️ **`-p` is `--profile`, NOT prompt.** The canonical drift trap; the original spec assumed a universal `-p`.

Events (`--json`): `thread.started` → **`thread_id`** · `turn.started` · `item.completed` → `item.type:"agent_message"`, `item.text` · `turn.completed` → `usage`.

Capabilities: `promptDelivery ['stdin','argv']` · `structuredOutput 'schema-file'` · `sessionId 'capture'` · `resume 'session'` · `cwdFlag true`.

**Strongest provider — the adapter the engine was built against (M1.5, landed).** Implemented in `src/providers/codex.ts`; argv is snapshot-tested in `test/unit/providers/codex.test.ts`.

argv: `codex exec --json --color never --skip-git-repo-check -C <cwd> -s <sandbox> --output-schema <file> -o <file> [-m <model>] -`, prompt on stdin behind the `-` positional. Sandbox comes from the task: `writes:false` ⇒ `read-only`, `writes:true` ⇒ `workspace-write`, `--dangerously-allow-all` ⇒ `danger-full-access`.

⚠️ **UNVERIFIED:** whether `thread_id` is the identifier `exec resume` accepts. `buildResume` assumes it; the contract tier (M3.7) is where that gets settled against the real binary. Escalation does not depend on it until M4.

## claude — ✅ verified 2026-08-28 (live, v2.1.251)

`claude -p/--print [prompt]`. Prompt: positional or **stdin**.

`--model` (aliases `opus`/`sonnet`/`haiku`, or full id) · `--output-format {text,json,stream-json}` · `--input-format` · **`--json-schema '<inline JSON>'`** · `--permission-mode {acceptEdits,auto,bypassPermissions,manual,dontAsk,plan}` · `--allowedTools`/`--disallowedTools`/`--tools` · `--add-dir` · `-r/--resume [id]` · `--session-id <uuid>` · `--fork-session` · `--max-budget-usd` · `--append-system-prompt` · `--no-session-persistence` · `-w/--worktree`.

`--output-format json` returns one object: **`.result`** (final text) · **`.session_id`** · `.is_error` · `.subtype` · `.permission_denials[]` · `.total_cost_usd` · `.num_turns`. With `--json-schema`, **`.structured_output`** carries the parsed object.

⚠️ **No working-directory flag** — `--add-dir` only widens access. Set `cwd` on the spawn.
⚠️ `--json-schema` rejects a file path; inline JSON only.
💡 `--session-id <uuid>` **pre-assigns** the id — resume needs no event parsing.
💡 `--bare` skips hooks, plugins, and `CLAUDE.md` auto-discovery. Consider it for run-to-run determinism, weighing it against wanting repo context.

Capabilities: `promptDelivery ['stdin','argv']` · `structuredOutput 'schema-inline'` · `sessionId 'preassign'` · `resume 'session'` · `cwdFlag false` · `maxConcurrency 1` (subscription-throttled until measured).

## copilot — ⚠️ partially verified 2026-08-28 (v1.0.81; **monthly quota exhausted**, success path unverified)

`copilot -p/--prompt <text>`. **Prompt is a flag value — argv only.** `--attachment` takes images/native documents, not a prompt file.

`--model` · `-C <dir>` · `--add-dir` · `--output-format {text,json}` (json = **JSONL**) · `-s/--silent` · `--no-color` · `--allow-all-tools`/`--allow-all`/`--yolo` · `--allow-tool`/`--deny-tool` · `--no-ask-user` · `-r/--resume[=id]` · `--session-id <id>` · `--secret-env-vars` · `--usage-output-file <file>` · `--max-ai-credits`.

Events: `{type, data, ephemeral, id, timestamp, parentId}`. **15 of 20 events are `ephemeral: true` — filter them.** Terminal event `{"type":"result","sessionId":…,"exitCode":…,"usage":{"codeChanges":{"filesModified":[…]}}}` supplies session id, exit code, **and `files_changed` for free**. Errors: `{"type":"session.error","data":{"errorType":"quota","errorCode":"quota_exceeded","statusCode":402}}`.

⚠️ Help claims `--allow-all-tools` is "required for non-interactive mode", but the process **ran without it** (reached quota before any tool use). Treat it as required for unattended _tool execution_, not as a parse requirement. Re-verify once quota resets.
💡 **Set `--no-ask-user`.** It disables the `ask_user` tool so the agent cannot block on an interactive question — exactly right for our design, where a question must come back as `status:"needs_input"` in the result JSON instead.
⚠️ Assistant-text event shape unverified (the probe failed before any text). Confirm in M3.5.

Capabilities: `promptDelivery ['argv']` · `structuredOutput 'none'` · `sessionId 'preassign'` · `resume 'session'` · `cwdFlag true` · `maxConcurrency 1`.

## opencode — ⚠️ partially verified 2026-08-28 (flags ✅; **local install misconfigured**, success path unverified)

`opencode run [message..]`. Prompt: positional, or **`-f/--file`** (native file attach — the only true file delivery in the set).

`-m <provider/model>` (compound form) · `--dir` · `--format {default,json}` · `-c/--continue` · `-s/--session <id>` · `--fork` · `--agent` · `--title` · `--share`.

Events: JSONL with `{type, timestamp, sessionID, …}`. Errors: `{"type":"error","error":{"name":…,"data":{"statusCode":401,"isRetryable":false}}}` — **`isRetryable` is a first-class boolean**, the cleanest retry signal of any provider.

⚠️ **Environment issue, not a Baya bug:** this machine's opencode holds an invalid OpenAI key (literal `"asd"`), so every run 401s. Fix local auth before the M3.1 contract test.

Capabilities: `promptDelivery ['file','argv']` · `structuredOutput 'none'` · `sessionId 'capture'` · `resume 'session'` · `cwdFlag true`.

## gemini — ✅ verified 2026-08-28 (help), deferred to v1.1

`gemini -p <prompt>` (stdin prepended) · `-m` · `-o {text,json,stream-json}` · `--approval-mode {default,auto_edit,yolo,plan}` · `-y/--yolo` · `--include-directories` · `-r/--resume`. Adapter interface already accommodates it; only registration is missing.

---

## Provider color and ANSI

Provider stdout is **untrusted input** — model output can carry escape sequences, and `gemini` ships an explicit security warning on its own `--raw-output` for exactly this reason.

1. Disable color at the flag level where it exists (`codex --color never`, `copilot --no-color`). `claude` and `opencode` have no such flag.
2. Strip residual ANSI from every stream before rendering or persisting. `events.jsonl`, `stdout.log`, `result.json` are always ANSI-free.
3. Adapters never re-emit provider bytes to the terminal; rendering goes through `src/ui/theme.ts`.

## Drift policy

These CLIs ship weekly; `codex -p` will recur.

1. argv **snapshot tests** on `buildRun`/`buildResume` — any change fails loudly and forces review.
2. **Contract tests** run the real binaries behind `BAYA_CONTRACT=1`; offline CI never runs them. Run before each release.
3. `baya doctor` records each provider's version; a change since the last successful run emits a warning.
4. Adding a provider = adapter + capability block + a section here + a contract test. No other file changes.
