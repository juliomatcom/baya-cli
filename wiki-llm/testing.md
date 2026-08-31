# Testing

> **Maintenance Invariant:** Strategy + commands only. Every new adapter adds an argv snapshot test + a contract-test case in the SAME commit. Update when tiers or commands change. Token-optimized: imperative, no prose, no redundancy.
> **Answers:** How a paid, nondeterministic LLM-CLI orchestrator is tested. The fake-provider harness. Which command runs which tier.

## Core problem

Every component spawns nondeterministic, rate-limited, paid subprocesses. The fake provider is built in **P0, before any adapter** — not retrofitted.

## Fake-provider harness

`test/fixtures/fake-provider.mjs` — a real executable pointed at via the user config's binary override. Reads a scenario from `BAYA_FAKE_SCRIPT` (JSON) and replays it deterministically:

```json
{
  "emit": [
    { "delay_ms": 10, "line": "{\"type\":\"session\",\"id\":\"s-1\"}" },
    { "delay_ms": 10, "line": "{\"type\":\"text\",\"text\":\"working\"}" }
  ],
  "final": {
    "baya": "1",
    "kind": "task_result",
    "task_id": "t1",
    "status": "ok",
    "summary": "done",
    "output": "…"
  },
  "exit_code": 0,
  "on_signal": "exit"
}
```

Required knobs, each mapping to a real failure mode:

| Knob                              | Exercises                                          |
| :-------------------------------- | :------------------------------------------------- |
| `final.status: needs_input`       | Park → bubble → resume path                        |
| `exit_code: 1` + `stderr`         | Failure → descendants `skipped`                    |
| `final` malformed / prose-wrapped | Result-parsing degradation ladder                  |
| `hang_ms` + `on_signal: "ignore"` | SIGINT teardown, grace, SIGKILL escalation         |
| `spawn_child: true`               | Grandchild reaping — process-group teardown        |
| `emit` unknown event types        | `ProviderEvent.unknown` passthrough                |
| `emit` lines with ANSI escapes    | ANSI stripping before persist/render               |
| `error.kind: rate_limit`          | Retry classification + backoff                     |
| `writes_file`                     | Workspace write-lock serialization                 |
| `expect_stdin` / `expect_file`    | Prompt-delivery preference chain                   |
| `by_task` map keyed by task id    | One scenario file scripting a whole multi-task run |
| `fail_attempts: <n>`              | `--retries`: a transient failure that then clears  |

Emulates the **codex file-out contract**: when argv carries `-o <path>`, `final` is written there (not stdout) and the task id is read back from `tasks/<id>/result.json`. This lets one scenario file script a whole run with no stdin coordination, and lets `test/helpers/runCli.ts` drive the real CLI end to end via a user-config binary override — exactly as a user would.

Also emulates the **claude `--output-format json` contract**: argv carries `--output-format` and no `-o` ⇒ prompt read from stdin, task id off the prompt, `final` printed as one JSON object with the result string on `.result`. Lets a run stand a second, differently-shaped provider beside codex (the quota-halt case).

Every engine test runs against this: zero network, zero LLM, zero cost, deterministic.

`fail_attempts: <n>` is the only attempt-aware knob: the task answers a retryable `status: "failed"` and the process exits 1 for its first `n` invocations, then behaves normally. The counter lives beside the scenario file, keyed by task id, because every invocation is a fresh process. Needed because a retry is only observable across two attempts of the same task, and no other knob differs between them.

New harness knob: `reject_stdin: "<substring>"` — exit 1 with nothing parseable when stdin carries it. Models a CLI refusing an invocation outright (a resume identifier it will not accept), which is structurally different from running and reporting failure through the schema.

## Tiers

| Tier            | Scope                                                                                                                                                                          | Command                                          | CI         |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------- | :--------- |
| **Unit**        | Pure layers: manifest validation, cycle detection, topo order, model catalog + alias resolution, context budgeting, redaction, failure classifier, **adapter argv snapshots**. | `npm test`                                       | ✅         |
| **Integration** | Full engine against fake providers.                                                                                                                                            | `npm test`                                       | ✅         |
| **Contract**    | Real binaries, trivial prompt, asserts flag surfaces still hold; unresolved binary ⇒ skipped.                                                                                  | `npm run test:contract` (sets `BAYA_CONTRACT=1`) | ❌ offline |

Run tests via `npm test`, never bare `npx jest` (needs `--experimental-vm-modules`). Contract tier = the defense against provider drift (the class of bug that made the spec's universal `-p` wrong: `codex -p` = `--profile`). Run before every release; never in offline CI. Config `jest.contract.config.js`, excluded from `jest.config.js` via `testPathIgnorePatterns`.

## Integration cases that must exist

1. **Fan-out/fan-in** — 1→3 parallel→1 join; concurrency never exceeds budgets; the join sees all three contexts.
2. **Failure isolation** — mid-graph failure marks only descendants `skipped`; a parallel independent branch still `succeeds`; exit `1`.
3. **Park and resume** — `needs_input` parks one node, other branches run, injected answer resumes the session, run completes `0`.
4. **SIGINT teardown** — long fakes spawning grandchildren; SIGINT ⇒ exit `130` + **zero surviving pids** (verify via `ps`, not the promise).
5. **Write serialization** — two independent `access:"read-write"` tasks never overlap; two readers do.
6. **Context budgeting** — 200 KB upstream ⇒ `link-only` entry, `inline: null`, valid `output_path`.
7. **Malformed plan recovery** — planner returns cycle → dangling → valid; assert the repair path + linear fallback.
8. **Result degradation** — prose-wrapped, fenced, garbage each land on the right rung.
9. **Non-TTY** — `needs_input` with no TTY fails cleanly, never hangs (a hang here is the worst failure mode).
10. **Plan round-trip** — `--plan-out` then `--plan-in` produces an identical execution.
11. **Model gate** — a task-named model resolves via catalog/alias; an unresolvable name aborts (exit `2`), never defaults.
12. **Quota halt** — two providers, one `quota`-fails partway; admission stops run-wide, in-flight work on the other provider finishes (not killed), never-started tasks are `skipped` carrying the quota `failure` (not a null dependency skip); `state.json` stays resumable and `baya resume` re-runs exactly the unfinished tasks, never the one that completed.

## Grouping & memory

Both are tested against the record a real run leaves, not against invented shapes.

- **Pure halves** (`formGroup`, `deriveMemory`, `renderMemory`) are unit-tested directly — `test/unit/executor/group.test.ts`, `test/unit/memory/`. The selection tests encode measured failures: one task flailing through variations of one invocation crowded out every other fact kind, and `console.log` was reported as a file.
- **Delivery** rides on the fake provider's `expect_stdin` (`test/integration/memory.test.ts`): if the memory block never reached the prompt, the task fails and the run exits non-zero. Stronger than reading `memory.json` back — it proves the fact travelled into what a CLI was actually sent.
- **Grouping** asserts `state.tasks[id].group_id` — chains, siblings, the cap, and the `access` boundary. Pin the ungrouped path with `--group-size 1` for anything that is about a single process: the context bus (grouped, an in-group upstream is pointed at, not inlined), a captured session id, and "the provider wrote no result at all", which only a one-task process can be in.
- The fake provider answers with a `task_result_batch` when the output path is `batch.json`, assembling one entry per member from that member's own scenario. Process-level fields come from the leader, because there is one process.
- **Do not over-test.** No assertions on literal prompt wording, terminal formatting, or field order. Test the rule (what got grouped, what did not, what state each task landed in), not the prose that carries it.

## Dogfooding: your own runs are the fixture set

Baya records every run to `.baya/runs/<runId>/` — normalized `events.jsonl` per task, `state.json`, `memory.json`, `report.json`. That is a corpus of **real provider behavior on a real repository**, accumulating for free every time you use the tool on itself. Mine it before inventing anything.

The method, in order:

1. **Never author a provider's event shape from documentation.** Read it back out of a recorded run (`hard rule #6`). The `codex` `file_change` field was `changes: [{path, kind}]`, not `path` — the adapter had read `path` since M1, so every file change ever reported rendered as a bare `Edit()`. No amount of re-reading the docs would have shown that; one `jq` over `events.jsonl` did.
2. **Run a new heuristic over the corpus and look at the output before shipping it.** Cross-task memory's first rendering was dominated by fourteen near-identical `npm run test:contract -- …` dead ends from one task's flailing, and reported `console.log` as a file the repo needed. Both were invisible in unit tests written against invented inputs, and obvious in one pass over real data.
3. **Turn what you found into a committed test with an invented-but-minimal input.** The corpus finds the bug; the fixture pins it. Recorded runs are for **authoring** heuristics, never for regression tests — they are per-machine, unshared, and would break CI's offline guarantee.
4. **Measure a behavior change against a flag, not against a memory of how it used to feel.** Ship the off-switch (`--no-memory`) in the same change, and compare **tool-call counts, not tokens or wall time** — provider token variance and test-runner caching both swamp the effect you are looking for.

⚠️ `.baya/` is gitignored and stays local. It holds prompts, paths, and source excerpts from whatever you were working on, so it is evidence for you, never an attachment on an issue ([logging.md](logging.md) covers redaction for the parts that do get shared).

## Color in tests

- **All snapshot tests run with color forced off** (`FORCE_COLOR=0`, chalk level `0`, Jest global setup).
- A test asserts the inverse: color forced _on_ ⇒ `theme` tokens emit expected ANSI + every status carries its glyph.
- A test asserts `--json` output parses as JSON with color forced on — regression guard for ANSI leaking into machine output.
- A test feeds ANSI escapes through the fake provider and asserts they are stripped from `events.jsonl`, `stdout.log`, and the display.

## Conventions

- Jest + `@swc/jest` (ESM caveat: `conventions.md`). Coverage gate on `src/manifest`/`src/graph`/`src/context` at 90% statements/lines/functions. Branch floor lower by design — `noUncheckedIndexedAccess` forces `?? []` on every `Map.get`, arms describing states earlier validation already ruled out.
- No test touches the network or a real provider outside the contract tier.
- No test writes outside its own `tmp` dir; `.baya/` roots are per-test temp dirs.
- Every bug fix lands with a failing-first regression test.
