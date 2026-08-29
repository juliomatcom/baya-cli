# Providers

> **Maintenance Invariant:** One section per provider, each stating **verification status and date**. Never document an unverified flag as fact. Re-verify via contract tests (`testing.md`) and update in the SAME commit as any adapter change.
> **Answers:** What is each CLI's real flag surface, event shape, session-id field, and capability set? How is its binary found? How do we survive upstream drift?

v1 set: **`opencode`, `codex`, `claude`, `copilot`**. `gemini` verified, deferred to v1.1.
All four **live-probed 2026-08-28** (help text + real invocation), not read from docs.

**Adapter status (M3, landed 2026-08-29):** all four adapters implemented and registered in `src/providers/registry.ts`; each has an argv **snapshot test** and a **contract test** (`test/contract/`, `BAYA_CONTRACT=1`). `codex` and `claude` verified end to end on the reference machine. `opencode` (local key invalid) and `copilot` (monthly quota) have their engine paths covered by unit tests; their **success-path event shapes remain UNVERIFIED** and are flagged inline below — the contract tier settles them once each environment is fixed.

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

**Adapter (M3.3, landed 2026-08-29)** — `src/providers/claude.ts`, argv snapshot in `test/unit/providers/claude.test.ts`.

argv: `claude -p --output-format json --json-schema <inline JSON> --permission-mode <mode> [--model <m>] [--session-id <uuid>]`, prompt on stdin, **`cwd` on the spawn**. `--json-schema` is fed `JSON.stringify(JSON.parse(schemaContents))` — inline, never the path. `--output-format json` (not `stream-json`): one object, parsed once; `.structured_output` is rung 1, `.result` feeds rungs 2–3, `permission_denials[]` ⇒ non-retryable `permission` failure, `is_error` ⇒ failure classified by message.

⚠️ **`--permission-mode` map is UNVERIFIED** pending the contract tier: `writes:false ⇒ plan` (the only mode that actually blocks file writes), `writes:true ⇒ acceptEdits`, `--dangerously-allow-all ⇒ bypassPermissions`. Flags are real; which mode gives the cleanest unattended run is not yet measured. `plan` may change output style for read-only tasks — revisit in M3.7.
💡 usage: `total_cost_usd` ⇒ `cost_usd`; `usage.{input,output}_tokens` + both cache token fields folded into `input_tokens`.

## copilot — ⚠️ partially verified 2026-08-28 (v1.0.81; **monthly quota exhausted**, success path unverified)

`copilot -p/--prompt <text>`. **Prompt is a flag value — argv only.** `--attachment` takes images/native documents, not a prompt file.

`--model` · `-C <dir>` · `--add-dir` · `--output-format {text,json}` (json = **JSONL**) · `-s/--silent` · `--no-color` · `--allow-all-tools`/`--allow-all`/`--yolo` · `--allow-tool`/`--deny-tool` · `--no-ask-user` · `-r/--resume[=id]` · `--session-id <id>` · `--secret-env-vars` · `--usage-output-file <file>` · `--max-ai-credits`.

Events: `{type, data, ephemeral, id, timestamp, parentId}`. **15 of 20 events are `ephemeral: true` — filter them.** Terminal event `{"type":"result","sessionId":…,"exitCode":…,"usage":{"codeChanges":{"filesModified":[…]}}}` supplies session id, exit code, **and `files_changed` for free**. Errors: `{"type":"session.error","data":{"errorType":"quota","errorCode":"quota_exceeded","statusCode":402}}`.

⚠️ Help claims `--allow-all-tools` is "required for non-interactive mode", but the process **ran without it** (reached quota before any tool use). Treat it as required for unattended _tool execution_, not as a parse requirement. Re-verify once quota resets.
💡 **Set `--no-ask-user`.** It disables the `ask_user` tool so the agent cannot block on an interactive question — exactly right for our design, where a question must come back as `status:"needs_input"` in the result JSON instead.
⚠️ Assistant-text event shape unverified (the probe failed before any text). Confirm in M3.5.

Capabilities: `promptDelivery ['argv']` · `structuredOutput 'none'` · `sessionId 'preassign'` · `resume 'session'` · `cwdFlag true` · `maxConcurrency 1`.

**Adapter (M3.5, landed 2026-08-29)** — `src/providers/copilot.ts`, argv snapshot in `test/unit/providers/copilot.test.ts`.

argv: `copilot -p <text> --output-format json -C <cwd> --no-color --no-ask-user [--allow-all-tools] [--model <m>] [--session-id <id>]`. `-p <text>` is the **one place a prompt rides in argv** anywhere in Baya. `--allow-all-tools` is added only for `writes:true` / `--dangerously-allow-all` — copilot has no read-only sandbox, so a reader simply runs without it. `parseEvents` drops `ephemeral:true` lines; the terminal `result` line gives session id, exit code, and `usage.codeChanges.filesModified` ⇒ `files_changed`. No schema ⇒ degradation ladder over assistant text.

⚠️ **UNVERIFIED (quota exhausted 2026-08-28):** the assistant-text event shape. `readText` guesses `data.{text,content,message}` on a `type` containing `assistant`/`message`/`text`. `session.error` ⇒ `rate_limit`/`auth` event + raw line kept for the classifier; `quota`/402 ⇒ non-retryable here (`retry: "later"` is the scheduler's call). M3.4 re-probe + M3.7 contract settle the success path.

## M3.4 — re-probe copilot _(blocked: monthly quota, retry after reset)_

The success path (assistant text events, `result` usage fields, `--allow-all-tools` as a parse vs execution requirement) is still unprobed. The adapter is written to the documented flags and covered by fake-stream unit tests; run `BAYA_CONTRACT=1 npm run test:contract` once quota returns and fill the shapes above in the SAME commit.

## opencode — ⚠️ partially verified 2026-08-28 (flags ✅; **local install misconfigured**, success path unverified)

`opencode run [message..]`. Prompt: positional, or **`-f/--file`** (native file attach — the only true file delivery in the set).

`-m <provider/model>` (compound form) · `--dir` · `--format {default,json}` · `-c/--continue` · `-s/--session <id>` · `--fork` · `--agent` · `--title` · `--share`.

Events: JSONL with `{type, timestamp, sessionID, …}`. Errors: `{"type":"error","error":{"name":…,"data":{"statusCode":401,"isRetryable":false}}}` — **`isRetryable` is a first-class boolean**, the cleanest retry signal of any provider.

⚠️ **Environment issue, not a Baya bug:** this machine's opencode holds an invalid OpenAI key (literal `"asd"`), so every run 401s. Fix local auth before the M3.1 contract test.

Capabilities: `promptDelivery ['file','argv']` · `structuredOutput 'none'` · `sessionId 'capture'` · `resume 'session'` · `cwdFlag true` · `maxConcurrency 2`.

**Adapter (M3.1, landed 2026-08-29)** — `src/providers/opencode.ts`, argv snapshot in `test/unit/providers/opencode.test.ts`. This is the adapter that proves the abstraction against a **third** prompt-delivery shape: codex and claude use stdin, opencode uses a **file** (`-f`).

argv: `opencode run --format json --dir <cwd> [-m <provider/model>] -f <promptFile>`, `stdin: "ignore"`, prompt written to `<taskDir>/prompt.md` via `SpawnPlan.files`. `-m` is passed through verbatim (the compound `provider/model` form). No schema ⇒ degradation ladder over assistant text.

⚠️ **UNVERIFIED (invalid local key):** the success-path event shape. `readText` tries `text` / `content` / `part.{type:"text",text}` / `message.content`. The error shape **is** known: `{"type":"error","error":{"name","data":{"statusCode","isRetryable}}}` — `isRetryable` is a real boolean and is preserved by keeping the raw line as an `unknown` event alongside the normalized `error` event, so `extractResult` and the M2.5 classifier can both read it. `extractUsage` reads `tokens.{input,output}` + `cost` off `step-finish` lines. M3.7 contract settles the rest.

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
2. **Contract tests** — `test/contract/providers.contract.test.ts`, config `jest.contract.config.js`, run by `npm run test:contract` (sets `BAYA_CONTRACT=1`). Excluded from `jest.config.js` via `testPathIgnorePatterns`, so offline CI never runs them. Each adapter is driven `buildRun → spawn → parseEvents → extractResult` against a trivial task; a provider whose binary does not resolve is **skipped, not failed**. Run before each release.
3. `baya doctor` records each provider's version; a change since the last successful run emits a warning.
4. Adding a provider = adapter + capability block + a section here + a contract-test case. No other file changes.

## Model catalog, routing, and failure classification

- **Model catalog** (`src/providers/catalog.ts`, M3.6). `codex`, `claude`, and `copilot` have no "list models" command, so their `{ id, aliases, description }` lists are **hardcoded** here — edit them when they drift. `opencode` enumerates live (`opencode models`). The wizard writes the merged catalog to the user config's `modelCatalog`; `baya config refresh-models` rewrites the `opencode` part. Full ids are known at the time of writing: codex `gpt-5.6-{sol,terra,luna}`; claude `claude-{fable-5,opus-5,sonnet-5,haiku-4-5-20251001}`.
- **Resolution** (`src/ui/model-gate.ts`). Every run, before the plan gate: a task-named model is resolved against the catalog — user alias → exact id/alias → best match (character-bigram Dice handles typos, description is scored too). No confident hit ⇒ the gate prompts (best match / provider default / exit); `--yes`/non-TTY takes a best match only at score ≥ 0.85, else exits `2`. **A named model never silently becomes the default.** An explicit `task.provider` wins ties, then the run default.
- **`providerForModel`** (`src/manifest/aliases.ts`). The fallback when a name is _not_ in the catalog: a pattern match (`gpt-*`→codex, `claude-*`/`sonnet`/`opus`→claude) supplies a provider for a plausible literal id. `validateManifest` still rejects — with a suggestion — an explicit `provider` paired with a model that pattern-matches another provider, or a `gemini`-family model (deferred).
- **Failure classifier** (`src/executor/classify.ts`, M2.5). Maps the timeout flag, exit code, normalized `error` events, and the adapter's `error.retryable` onto a `Failure` `{ kind, retry }`. **`quota` ⇒ `retry: "later"`, `auth`/`permission`/bad-model ⇒ `"never"`** so a run never spends its attempt budget on an endpoint that will keep refusing.
