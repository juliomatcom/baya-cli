# Testing

> **Maintenance Invariant:** Strategy and commands only. Every new adapter adds an argv snapshot test and a contract test in the SAME commit. Update when test tiers or commands change.
> **Answers:** How is an orchestrator of paid, nondeterministic LLM CLIs tested? What is the fake-provider harness? Which command runs which tier?

## The core problem

Every component depends on spawning nondeterministic, rate-limited, paid subprocesses. Untestable unless designed for fakes from day one — which is why the fake provider is built in **P0, before any adapter**, not retrofitted.

## Fake-provider harness

`test/fixtures/fake-provider.mjs` — a real executable that any adapter can be pointed at via `.baya/config.json` binary override. It reads a scenario from `BAYA_FAKE_SCRIPT` (a JSON file) and replays it deterministically:

```json
{ "emit": [ { "delay_ms": 10, "line": "{\"type\":\"session\",\"id\":\"s-1\"}" },
            { "delay_ms": 10, "line": "{\"type\":\"text\",\"text\":\"working\"}" } ],
  "final": { "baya": "1", "kind": "task_result", "task_id": "t1", "status": "ok",
             "summary": "done", "output": "…" },
  "exit_code": 0,
  "on_signal": "exit" }
```

Scenario knobs it must support — each maps to a real failure mode:

| Knob | Exercises |
| :-- | :-- |
| `final.status: needs_input` | Park → bubble → resume path |
| `exit_code: 1` + `stderr` | Failure → descendants `skipped` |
| `final` = malformed / prose-wrapped | Result-parsing degradation ladder |
| `hang_ms` + `on_signal: "ignore"` | SIGINT teardown, grace window, SIGKILL escalation |
| `spawn_child: true` | **Grandchild reaping** — process-group teardown |
| `emit` with unknown event types | `ProviderEvent.unknown` passthrough |
| `emit` lines containing ANSI escapes | ANSI stripping before persist/render |
| `error.kind: rate_limit` | Retry classification and backoff |
| `writes_file` | Workspace write-lock serialization |
| `expect_stdin` / `expect_file` | Prompt-delivery preference chain |

**Every engine test runs against this. Zero network, zero LLM, zero cost, deterministic.**

## Tiers

| Tier | Scope | Command | CI |
| :-- | :-- | :-- | :-- |
| **Unit** | Pure layers: manifest validation, cycle detection, topo order, alias resolution, context budgeting, redaction, **adapter argv snapshots**. | `npm test` | ✅ |
| **Integration** | Full engine against fake providers. | `npm test` | ✅ |
| **Contract** | Real binaries, trivial prompt, asserts flag surfaces still hold. | `BAYA_CONTRACT=1 npm run test:contract` | ❌ offline |

Contract tests are the defense against provider drift — exactly the class of bug that made the original spec's universal `-p` assumption wrong (`codex -p` = `--profile`). Run before every release; never in offline CI.

## Integration cases that must exist

1. **Fan-out/fan-in** — 1→3 parallel→1 join; assert concurrency never exceeds budgets and the join sees all three contexts.
2. **Failure isolation** — mid-graph failure marks only descendants `skipped`; a parallel independent branch still reaches `succeeded`; exit code `1`.
3. **Park and resume** — `needs_input` parks one node, other branches keep running, an injected answer resumes the session, run completes `0`.
4. **SIGINT teardown** — start long-running fakes that spawn grandchildren, send SIGINT, assert exit `130` and **zero surviving pids** (verify via `ps`, not just the promise).
5. **Write serialization** — two `writes: true` tasks with no dependency between them never overlap; two readers do.
6. **Context budgeting** — a 200 KB upstream output yields a `link-only` context entry with `inline: null` and a valid `output_path`.
7. **Malformed plan recovery** — planner returns a cycle, then dangling deps, then valid; assert the repair path and the linear fallback.
8. **Result degradation** — prose-wrapped JSON, fenced JSON, and garbage each land on the right rung of the ladder.
9. **Non-TTY** — `needs_input` with no TTY fails cleanly rather than hanging. **A hang here is the worst failure mode in the system.**
10. **Plan round-trip** — `--plan-out` then `--plan-in` produces an identical execution.

## Color in tests

- **All snapshot tests run with color forced off** (`FORCE_COLOR=0`, chalk level `0`, set in Jest global setup). Colored snapshots are unstable across CI/TTY environments and unreadable in diffs.
- A dedicated test asserts the inverse: with color forced *on*, `theme` tokens emit the expected ANSI and every status still carries its glyph.
- A test asserts `--json` output parses as JSON **with color forced on** — the regression guard for ANSI leaking into machine-readable output.
- A test feeds ANSI escape sequences through the fake provider's output and asserts they are stripped from `events.jsonl`, `stdout.log`, and the rendered display.

## Conventions

- Jest with `@swc/jest` (see `conventions.md` for the ESM caveat). Coverage gate on `src/manifest`, `src/graph`, `src/context` — the pure layers — at 90%.
- No test touches the network or a real provider outside the contract tier.
- No test writes outside its own `tmp` dir; `.baya/` roots are per-test temp dirs.
- Every bug fix lands with a failing-first regression test.
