# Providers

> **Maintenance Invariant:** One section per provider with **verification status + date**. Never document an unverified flag as fact — mark `⚠️ UNVERIFIED`. Re-verify via contract tests (`testing.md`); update in the SAME commit as any adapter change. Token-optimized: imperative, no prose, no redundancy.
> **Answers:** Each CLI's real flag surface, event shape, session-id field, capability set. How its binary is found. How drift is survived.

v1 set: `opencode`, `codex`, `claude`, `copilot`. `gemini` verified, deferred to v1.1. All live-probed 2026-08-28 (help + real invocation). `grok` planned, **never probed** — no flag surface, schema support, or event shape is known; record nothing about it here until a live invocation says so.

**Adapter status (M3, 2026-08-29):** all four implemented + registered in `src/providers/registry.ts`; each has an argv snapshot test + a contract-test case. `codex`/`claude` verified end to end. `opencode` (invalid local key) / `copilot` (quota exhausted) — engine paths unit-covered; success-path event shapes `⚠️ UNVERIFIED`, flagged inline; contract tier settles them post env-fix.

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
| **Observation source**    | own `events.jsonl`          | ❌ none (one result object)          | ❌ none                      | ❌ none               |
| Tool calls in events      | ✅ `item.completed`         | ❌ single result object              | ✅ (unwired)                 | ✅ (unwired)          |
| Working dir flag          | ✅ `-C/--cd`                | ❌ **none** — set spawn `cwd`        | ✅ `-C`                      | ✅ `--dir`            |
| Disable color             | ✅ `--color never`          | ❌ none                              | ✅ `--no-color`              | ❌ none               |
| Cost cap                  | —                           | `--max-budget-usd`                   | `--max-ai-credits`           | —                     |

Session id has four spellings — normalizing it is the adapter layer's core justification.

**Grouping needs nothing from an adapter.** A group is one process, so it is one `buildRun` with a longer prompt and the `task_result_batch` schema — no resume verb, no session id, no per-provider path. All four adapters get it for free (execution.md §Grouping).

Command observations are scoped to `codex`, the only provider whose documented event stream names what it ran. Every provider contributes `files_changed` through the protocol result. `copilot`/`opencode` do emit tool events; they widen one at a time, each with its own contract-test case.

## Cross-cutting rules

1. **stdin set explicitly on every spawn** (pipe or `/dev/null`), never inherit. `claude -p` with an argv prompt blocks 3s then warns `no stdin data received in 3s`; `codex exec` writes `Reading additional input from stdin...` to stderr. Both vanish when stdin is set. Inheriting costs ~1min/20-task run + log noise.
2. **Schema enforcement, three tiers:** codex = file-in/file-out (`--output-schema <FILE>` + `-o <FILE>`, no parsing); claude = `--json-schema` **inline JSON only** (file path rejected: `Error: --json-schema is not valid JSON`), read `.structured_output` (`.result` = same as string); copilot/opencode = none → degradation ladder (`protocol.md` §4).
3. **ANSI stripping mandatory.** Use `--color never` / `--no-color` where they exist (claude/opencode have none); strip residual ANSI everywhere. `events.jsonl`, `stdout.log`, `result.json` always ANSI-free. Adapters never re-emit provider bytes to the terminal — render via `src/ui/theme.ts`. Provider stdout is untrusted (can carry escape sequences).
4. **Retry signal per provider:** copilot `session.error.errorCode` (`quota_exceeded`, `statusCode:402`) · opencode `error.data.isRetryable` boolean · claude `is_error`/`subtype`/`permission_denials[]` · codex exit code + stderr.

## Adapter interface

```ts
interface ProviderAdapter {
  id: ProviderId;
  resolve(): Promise<{ bin: string; version: string } | null>;
  capabilities: {
    promptDelivery: ('file' | 'stdin' | 'argv')[]; // ordered preference
    structuredOutput: 'schema-file' | 'schema-inline' | 'none';
    events: 'jsonl' | 'json' | 'none';
    sessionId: 'preassign' | 'capture';
    resume: 'session' | 'none';
    observations: 'events' | 'none'; // execution.md §Memory
    cwdFlag: boolean;
    modelFlag: boolean;
    maxConcurrency: number;
  };
  buildRun(task, env): { argv: string[]; cwd: string; stdin: 'pipe' | 'ignore' };
  buildResume(
    sessionId,
    answer,
    env,
  ): { argv: string[]; cwd: string; stdin: 'pipe' | 'ignore' };
  extractObservations?(ctx: ExtractContext): Observation[];
  parseEvents(chunk: string): ProviderEvent[]; // fed complete lines only
  extractResults(ctx: ExtractContext): TaskResult[]; // one per ctx.taskIds
  extractUsage?(events): { cost_usd?; input_tokens?; output_tokens? };
}
```

- `buildRun`/`buildResume` return `argv: string[]`, never a command string; `shell: true` banned repo-wide. Pure + snapshot-tested — the snapshot is the drift alarm.
- `extractUsage` optional, per-provider. codex reports usage on `turn.completed` (normalized to `unknown`); read it back here rather than widening the `ProviderEvent` union.
- `parseEvents` gets whole lines only. Partial-chunk buffering lives in `src/executor/spawn.ts`.
- `extractResults` returns **one result per `ctx.taskIds`**, in order. An adapter only says where this provider put the answer; whether that answer is a `task_result` or a `task_result_batch` is settled once in `src/providers/result.ts`, so no adapter knows grouping exists.
- `extractObservations` is optional and is how a provider contributes commands to memory. `observations: "none"` means it consumes memory and contributes none. Never self-reported by the model, and never scraped from a file the provider does not document.

## Model resolution

A model name reaches a provider **resolved**, never as typed. Task-named models go through the model gate (`planModelGate`); the run-level `--default-model` / `--planner-model` and their config equivalents go through `resolveRunModel`. Both apply the same confidence rule: an exact id, a catalog alias, or a user alias is applied; anything else is not guessed at.

⚠️ The catalog is a **convenience list, not an allowlist**. An unrecognized run-level model passes through unchanged, because model ids ship faster than this catalog does and a real id must always reach the provider. Only a task-named model can stop the run (M3.6) — the user typed the run-level one on this invocation, a planner invented the other.

⚠️ Measured 2026-08-30: before `resolveRunModel`, `--planner-model luna` spawned `codex … -m luna`, codex answered ``Model metadata for `luna` not found``, the planner exited 1 three times and the run fell back to a linear plan — from a name `baya models` lists and the task gate resolves without complaint.

## Binary resolution

Chain: user config (`providers.<id>.bin`) override → `$PATH` → known locations → not found. Known: `~/.local/bin`, `~/.opencode/bin`, active nvm `bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`.

Reference machine: `claude`/`codex` in `~/.local/bin`; `copilot`/`gemini` in nvm bin; `opencode` in `~/.opencode/bin`. **None in a system directory** — never assume a plain `$PATH` lookup.

---

## codex — ✅ verified 2026-08-28 (live); adapter M1.5 landed

`codex exec [PROMPT]`. Prompt: positional, `-`, or stdin.

Flags: `-m/--model` · `-C/--cd <DIR>` · `--add-dir` · `-s/--sandbox {read-only,workspace-write,danger-full-access}` · `--json` · `--output-schema <FILE>` · `-o/--output-last-message <FILE>` · `--color never` · `--skip-git-repo-check` · `--ephemeral` · resume `codex exec resume [--last]`.

⚠️ **`-p` is `--profile`, NOT prompt.** Canonical drift trap.

Events (`--json`): `thread.started`→`thread_id` · `turn.started` · `item.completed`→`item.type:"agent_message"`/`item.text`, `item.type:"error"`→error event (full message, e.g. an unknown-model metadata warning) · top-level `type:"error"`→error event · `turn.completed`→`usage`.

Capabilities: `promptDelivery ['stdin','argv']` · `structuredOutput 'schema-file'` · `sessionId 'capture'` · `resume 'session'` · `observations 'events'` · `cwdFlag true` · `maxConcurrency 2`.

⚠️ `file_change` items carry **`changes: [{path, kind}]`, not `path`.** Reading `path` rendered every file change as a bare `Edit()` — verified against 8 recorded events. `command_execution` carries `command`, `exit_code` (a **string** in the JSONL), and `status`; those three are the whole of codex's memory contribution.

Adapter `src/providers/codex.ts`, snapshot `test/unit/providers/codex.test.ts`. argv: `codex exec --json --color never --skip-git-repo-check -C <cwd> -s <sandbox> --output-schema <file> -o <file> [-m <model>] -`, prompt on stdin behind `-`. Sandbox from task: `access:"read-only"`⇒`read-only`, `access:"read-write"`⇒`workspace-write`, `--dangerously-allow-all`⇒`danger-full-access`.

⚠️ **`codex exec resume` does not share `exec`'s flag surface.** Verified live 2026-08-29 (codex-cli 0.150.1): `resume` takes `--json`, `--skip-git-repo-check`, `--output-schema`, `-o`, `-m`, and **rejects `-C`, `-s`, `--color`** — exit 2, `error: unexpected argument '-C' found`, before the model is reached. Passing the `exec` set is what made every session continuation fail in the first real chain run (caught by the cold-retry fallback, so it cost two unbilled spawns rather than two tasks). Consequences: the working directory comes from the spawn `cwd`, and ANSI stripping covers `--color`. Applies to `buildResume` (escalation, M4) only — grouping never resumes.

⚠️ `read-only` blocks **every** write, `$TMPDIR` and `/tmp` included — there is no writable-root escape (`sandbox_workspace_write.writable_roots` applies to `workspace-write` only). So a `read-only` task cannot run a test runner, a build, or anything that touches a cache: measured 2026-08-29, jest died on `EPERM` writing its haste-map before a single assertion. That is why the field is named `access` — what the task needs permission to **do**, not what it edits. The old name, `writes`, was read as "this modifies my code" and made a task that only ran a test look dangerous. See protocol.md. `read-only` is for pure reading: reviewing, summarizing, answering.

⚠️ **UNVERIFIED:** whether `thread_id` is what `exec resume` accepts. `buildResume` assumes it; contract tier (M3.7) settles it. Not needed until M4.

## claude — ✅ verified 2026-08-28 (live, v2.1.251); adapter M3.3 landed

`claude -p/--print [prompt]`. Prompt: positional or stdin.

Flags: `--model` (aliases `opus`/`sonnet`/`haiku`, or full id) · `--output-format {text,json,stream-json}` · `--input-format` · `--json-schema '<inline JSON>'` · `--permission-mode {acceptEdits,auto,bypassPermissions,manual,dontAsk,plan}` · `--allowedTools`/`--disallowedTools`/`--tools` · `--add-dir` · `-r/--resume [id]` · `--session-id <uuid>` · `--fork-session` · `--max-budget-usd` · `--append-system-prompt` · `--no-session-persistence` · `-w/--worktree` · `--bare` (skips hooks/plugins/`CLAUDE.md` — consider for determinism).

`--output-format json` = one object: `.result` (final text) · `.session_id` · `.is_error` · `.subtype` · `.permission_denials[]` · `.total_cost_usd` · `.num_turns`. With `--json-schema`: `.structured_output` = parsed object.

⚠️ No working-directory flag (`--add-dir` only widens) — set spawn `cwd`.
⚠️ `--json-schema` rejects a file path; inline JSON only, and strip the `$schema` meta-pointer (claude's validator has no 2020-12 meta-schema: `no schema with key or ref https://json-schema.org/draft/2020-12/schema`).
💡 `--session-id <uuid>` pre-assigns the id — resume needs no event parsing.

Capabilities: `promptDelivery ['stdin','argv']` · `structuredOutput 'schema-inline'` · `sessionId 'preassign'` · `resume 'session'` · `observations 'none'` · `cwdFlag false` · `maxConcurrency 1` (subscription-throttled until measured).

⚠️ **`--resume` and `--session-id` are mutually exclusive in practice** — one continues a session, the other creates it. `commonFlags(input, resuming)` drops `--session-id` on `buildResume`.

**Transcript.** `--output-format json` prints one object, so `parseEvents` emits no `tool` events and observations come from Claude Code's own session log at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`. Verified 2026-08-29: 9 of 10 recorded Baya claude tasks had theirs on disk. Located by **globbing the session id** across project directories — the slug's escaping rules are undocumented and are deliberately not reproduced. Records with `type` `assistant`/`user` carry `message.content[]`; `attachment` / `ai-title` / `queue-operation` / `atis-latch` / `last-prompt` are bookkeeping. `tool_use` gives `Bash.command` (plus a free model-written `description`), `Read.file_path`, `Edit.file_path`; the matching `tool_result.tool_use_id` gives `is_error`.

Adapter `src/providers/claude.ts`, snapshot `test/unit/providers/claude.test.ts`. argv: `claude -p --output-format json --json-schema <inline JSON, $schema stripped> --permission-mode <mode> [--model <m>] [--session-id <uuid>]`, prompt on stdin, `cwd` on spawn. `--output-format json` (not `stream-json`): one object parsed once. `.structured_output`=rung 1; `.result`=rungs 2–3; `permission_denials[]`⇒non-retryable `permission` failure **when no rung parsed**, else a `warn` note on the succeeding result (a denied run must not report clean); `is_error`⇒failure classified by message. Usage: `total_cost_usd`⇒`cost_usd`; `usage.{input,output}_tokens` + both cache token fields folded into `input_tokens`.

`--permission-mode` map: `auto` for every task, `--dangerously-allow-all`⇒`bypassPermissions`. `access:"read-only"` additionally passes `--disallowed-tools Write,Edit,NotebookEdit` (comma-joined — the flag is variadic and would swallow the next flag if spread).

⚠️ **Never `acceptEdits`, never `plan`.** `access` bounds whether a task may **act on** the workspace, not merely whether it edits source — a task that runs the suite needs Bash, and (on codex) a writable `$TMPDIR` besides. `acceptEdits` pre-approves edits only, so `-p`, with nobody to answer a Bash prompt, denies every command: measured 2026-08-29, a 12-task run logged 54 `Bash` denials (`npm test`, `tsc`, bare `grep`) and shipped unverified work. `plan` is worse — it refuses every non-readonly tool and bends the output into a plan proposal.

⚠️ The `access:"read-only"` guard is **narrower than codex's**: a tool withdrawal, not an OS sandbox, so a read-only task can still mutate the tree through a shell redirect. A task that must not touch the tree belongs on codex.

⚠️ copilot has the same shape of bug unfixed: `needsAllTools` gates `--allow-all-tools` on `access`, so a read-only task there is likely denied its tools too. Unverified — copilot was not installed when this was found.

## copilot — ⚠️ partially verified 2026-08-28 (v1.0.81, quota exhausted); adapter M3.5 landed

`copilot -p/--prompt <text>`. **Prompt is a flag value — argv only.** `--attachment` = images/documents, not a prompt file.

Flags: `--model` · `-C <dir>` · `--add-dir` · `--output-format {text,json}` (json=JSONL) · `-s/--silent` · `--no-color` · `--allow-all-tools`/`--allow-all`/`--yolo` · `--allow-tool`/`--deny-tool` · `--no-ask-user` · `-r/--resume[=id]` · `--session-id <id>` · `--secret-env-vars` · `--usage-output-file <file>` · `--max-ai-credits`.

Events: `{type, data, ephemeral, id, timestamp, parentId}`. **15/20 events `ephemeral:true` — filter.** Terminal `{"type":"result","sessionId":…,"exitCode":…,"usage":{"codeChanges":{"filesModified":[…]}}}` → session id + exit code + `files_changed`. Error `{"type":"session.error","data":{"errorType":"quota","errorCode":"quota_exceeded","statusCode":402}}`.

💡 Set `--no-ask-user` — disables the `ask_user` tool so a question returns as `status:"needs_input"` instead of blocking.
⚠️ `--allow-all-tools`: help says "required for non-interactive", but a run reached quota without it. Treat as required for unattended tool _execution_, not parsing. Re-verify post-quota.

Capabilities: `promptDelivery ['argv']` · `structuredOutput 'none'` · `sessionId 'preassign'` · `resume 'session'` · `observations 'none'` · `cwdFlag true` · `maxConcurrency 1`.

Adapter `src/providers/copilot.ts`, snapshot `test/unit/providers/copilot.test.ts`. argv: `copilot -p <text> --output-format json -C <cwd> --no-color --no-ask-user [--allow-all-tools] [--model <m>] [--session-id <id>]`. `-p <text>` = the one place a prompt rides in argv in Baya. `--allow-all-tools` only for `access:"read-write"` / `--dangerously-allow-all` (no read-only sandbox). `parseEvents` drops `ephemeral:true`; `result` line → session id + exit code + `usage.codeChanges.filesModified`⇒`files_changed`. No schema ⇒ degradation ladder.

⚠️ **UNVERIFIED (quota):** assistant-text event shape. `readText` guesses `data.{text,content,message}` on a `type` containing `assistant`/`message`/`text`. `session.error`⇒`rate_limit`/`auth` event + raw line kept for classifier; `quota`/402⇒non-retryable here.

### M3.4 — re-probe copilot _(blocked: quota, retry after reset)_

Unprobed: assistant text events, `result` usage fields, `--allow-all-tools` parse-vs-execution. Adapter written to documented flags + fake-stream unit tests. Run `BAYA_CONTRACT=1 npm run test:contract` post-quota; fill shapes above in the SAME commit.

## opencode — ⚠️ partially verified 2026-08-28 (flags ✅, invalid local key); adapter M3.1 landed

`opencode run [message..]`. Prompt: positional, or `-f/--file` (native file attach — the only true file delivery in the set).

Flags: `-m <provider/model>` (compound) · `--dir` · `--format {default,json}` · `-c/--continue` · `-s/--session <id>` · `--fork` · `--agent` · `--title` · `--share`.

Events: JSONL `{type, timestamp, sessionID, …}`. Error `{"type":"error","error":{"name":…,"data":{"statusCode":401,"isRetryable":false}}}` — `isRetryable` boolean, cleanest retry signal in the set.

⚠️ **Environment, not a bug:** this machine's opencode holds an invalid key (`"asd"`), every run 401s. Fix local auth before the contract test.

Capabilities: `promptDelivery ['file','argv']` · `structuredOutput 'none'` · `sessionId 'capture'` · `resume 'session'` · `observations 'none'` · `cwdFlag true` · `maxConcurrency 2`.

Adapter `src/providers/opencode.ts`, snapshot `test/unit/providers/opencode.test.ts`. Proves the abstraction against a **third** prompt-delivery shape (file `-f` vs codex/claude stdin). argv: `opencode run --format json --dir <cwd> [-m <provider/model>] -f <promptFile>`, `stdin:"ignore"`, prompt written to `<taskDir>/prompt.md` via `SpawnPlan.files`. `-m` passed verbatim. No schema ⇒ degradation ladder.

⚠️ **UNVERIFIED (key):** success-path event shape. `readText` tries `text` / `content` / `part.{type:"text",text}` / `message.content`. Error shape known — `isRetryable` preserved by keeping the raw line as an `unknown` event beside the normalized `error` event, so `extractResult` + the M2.5 classifier both read it. `extractUsage` reads `tokens.{input,output}` + `cost` off `step-finish` lines.

## gemini — ✅ verified 2026-08-28 (help), deferred to v1.1

`gemini -p <prompt>` (stdin prepended) · `-m` · `-o {text,json,stream-json}` · `--approval-mode {default,auto_edit,yolo,plan}` · `-y/--yolo` · `--include-directories` · `-r/--resume`. Adapter interface accommodates it; only registration is missing.

---

## Drift policy

CLIs ship weekly; `codex -p` will recur.

1. argv **snapshot tests** on `buildRun`/`buildResume` — any change fails loudly.
2. **Contract tests** — `test/contract/providers.contract.test.ts`, config `jest.contract.config.js`, `npm run test:contract` (sets `BAYA_CONTRACT=1`). Excluded from `jest.config.js` via `testPathIgnorePatterns` — offline CI never runs them. Drives each adapter `buildRun → spawn → parseEvents → extractResult` on a trivial task; unresolved binary ⇒ **skipped, not failed**. Run before each release.
3. `baya doctor` records each provider's version; a change since the last successful run warns.
4. Add a provider = adapter + capability block + section here + contract-test case. No other file changes.

## Model catalog, routing, failure classification

- **Model catalog** (`src/providers/catalog.ts`, M3.6). `codex`/`claude`/`copilot` have no "list models" command — `{ id, aliases, description }` lists hardcoded here, edit on drift. `opencode` enumerates live (`opencode models`). Config `modelCatalog` stores the live `opencode` list + user-authored entries only — **never a `BUILTIN_CATALOG` snapshot** (`withoutBuiltinEntries` migrates a stored one out on rewrite; config.md §What the file stores). Wizard and `baya config refresh-models` both write it. Known ids: codex `gpt-5.6-{sol,terra,luna}`; claude `claude-{fable-5,opus-5,sonnet-5,haiku-4-5-20251001}`; copilot ⚠️ slugs UNVERIFIED (docs list display names, no list command).
- **Resolution** (`src/ui/model-gate.ts`). Every run, before the plan gate: resolve a task-named model — user alias → exact id/alias → best match (char-bigram Dice for typos, description scored). No confident hit ⇒ gate prompts (best match / provider default / exit); `--yes`/non-TTY takes best match only at score ≥ 0.85, else exit `2`. **A named model never silently becomes the default.** Explicit `task.provider` wins ties, then run default.
- **`providerForModel`** (`src/manifest/aliases.ts`). Fallback for a name not in the catalog: pattern match (`gpt-*`→codex, `claude-*`/`sonnet`/`opus`→claude) supplies a provider for a plausible literal id. `validateManifest` rejects (with a suggestion) an explicit `provider` paired with a model that pattern-matches another provider, or a `gemini`-family model.
- **Failure classifier** (`src/executor/classify.ts`, M2.5). Maps timeout flag + exit code + normalized `error` events + adapter `error.retryable` → `Failure {kind, retry}`. `quota`⇒`retry:"later"`; `auth`/`permission`/bad-model⇒`"never"` — a run never spends its attempt budget on an endpoint that keeps refusing.
