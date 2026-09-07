# Consensus

> **Maintenance Invariant:** Behaviour of `baya consensus` only. Flags live in [cli.md](cli.md); wire schemas in [protocol.md](protocol.md); provider surfaces in [providers.md](providers.md). Update in the SAME commit as any change to the round loop, ledger, compaction, or access posture. Token-optimized: imperative, one fact per line, no prose, no mock walls.
> **Answers:** How does a multi-provider debate run? What does each reviewer remember, and how? Who may write to my working tree?

Several provider CLIs critique one artifact; a moderator reconciles them; repeat. Design record: [../specs/002-ai-consensus/spec.md](../specs/002-ai-consensus/spec.md).

**Not a run.** No DAG, no manifest, no task list, no `depends_on`, no `.baya/baya.lock`. `baya runs` and `baya resume` never see a consensus run.

## Topology

Two jobs, and only one of them is a review.

| The artifact                              | Round                              | Moderator's job                |
| :---------------------------------------- | :--------------------------------- | :----------------------------- |
| **asks** for something (`needs_draft`)    | every reviewer answers it, blind   | **are they on the same page?** |
| **is** the thing (a plan, a spec, a diff) | every reviewer critiques it, blind | merge the findings             |

**Reviewers never see each other's findings or answers in the same round.** A reviewer shown another's work anchors on it and stops searching; independence is the whole reason to pay N CLIs. They answer each other between rounds, through the record. Direct cross-talk is **rejected, not deferred**.

Moderator may also be a reviewer — same model, separate process, blind like any other.

## The moderator does not know the answer

⚠️ **It never knows the answer to the job, or how the job should be done, and it must not.** It is usually not the strongest model in the run; it may be the weakest. Nothing it believes about the subject may reach the output.

**There is nothing to judge against, because the job isn't judging.** When the artifact asks for something, no criteria are written at all — pass 0 returns an empty `criteria` array. The reviewers produce; the moderator reports whether they agree. That is its entire contribution.

This is enforced by what the protocol gives it, not by asking nicely: `agreement_result` is `{agreed, differences[], notes[]}` and **has no `document` field**. There is nowhere to put an answer, no ranking, and no count.

⚠️ Measured 2026-09-06, on `if 5 workers build 5 tables in 5 minutes, how long for 100 workers to build 100 tables`, pass 0 wrote:

> `correct-time` — Does the answer correctly conclude that **100 workers take 5 minutes** to build 100 tables?

That is a scoring key, not a criterion. One model answered the question, then handed itself a rubric where every reviewer who disagreed was wrong by construction — consensus decided before anyone spoke, by whichever model happened to moderate.

**Voting was considered and rejected.** Counting answers and printing the most common still makes the moderator an arbiter, and a majority is not a correctness signal. It reports agreement or disagreement; it never picks.

**What gets printed.** Agreed means the answers say the same thing, so any one of them is the answer: Baya takes the **first reviewer in the order you named them** — predictable, and never the moderator's pick. No agreement at the ceiling prints **every answer side by side** and says so. Running out of rounds does not grant a power the moderator never had.

## Question or document

⚠️ **The same text can be answered or rewritten, and the difference is the entire output.** `who created bitcoin` is either a question to answer or a prompt to improve, and nothing in the text says which.

| `artifact_kind`               | The debate produces              |
| :---------------------------- | :------------------------------- |
| `question`                    | **the answer**                   |
| `prompt`                      | a better-worded prompt           |
| `plan` `spec` `review` `idea` | a better version of the document |

⚠️ **A question is answered. The model gets no vote.** `looksLikeQuestion` decides — a single-line artifact ending in `?` or opening with an interrogative — **before** pass 0, and the moderator is told the kind is settled so it writes criteria that judge a candidate answer rather than the question's wording. If it answers `prompt` anyway, the kind is overridden and `consensus.kind.forced` is logged.

Deterministic because the stakes are one-sided: measured 2026-09-06, the same input was classified `prompt` on one run and judged as an answer on another, so identical input produced either a reworded question or the answer depending on which model happened to moderate. Nobody asks a question hoping to have it rewritten. `--kind prompt` still asks for exactly that, explicitly.

Multi-line artifacts are never forced — a spec whose last line happens to be a question stays a spec.

## Producing runs

`needs_draft` is a second axis, decided in pass 0: **does the thing being judged exist yet?** `true` when the artifact only _asks_ for it — a question, a request, a task (`write a migration plan for X`). `false` when the artifact _is_ it. A question always forces `true`, alongside its kind.

When set, the whole loop changes:

1. **Round 1** — the artifact goes down **first and unframed**, and each reviewer answers it blind.
2. **Agreement** — the moderator sees every answer under a pseudonym and answers one question.
3. Agreed ⇒ done. Not ⇒ **round 2**: each reviewer sees its own answer, everyone else's anonymised, and the differences the moderator named. It revises or holds, with a reason. Re-ask.
4. Repeat to `--rounds`.

⚠️ **A question wrapped in a review task gets reviewed, not answered.** Measured 2026-09-06: round 1 said _"you are reviewing the artifact below"_ and pasted `will a human land in Mars before 2030?`. All three reviewers returned five findings each whose entire `evidence` was a quote of the question — correctly, because a question is not an answer. Everything Baya has to say now waits until after the artifact.

**No moderator-written seed.** An earlier fix had the moderator draft version 1 and the reviewers edit it. One call instead of four, and it made the moderator the author while the others never formed a view — three critics of one opinion is not consensus.

**Reviewers are told to hold, not to converge.** An answer that stays put for a stated reason is a better outcome than one that moves to end the round.

Every answer is kept at `reviewers/<provider>/round-<n>.answer.md`, verbatim, per round, and its `notes` — why the model moved or held — go into that reviewer's `ledger.md`.

⚠️ The ledger has a producing shape of its own. Measured 2026-09-06, the critique shape told all three reviewers _"you did not complete this round — your call failed"_ on a round they had all answered, and threw the notes away. Nothing read those files, so nothing broke; they were simply false.

**One reviewer, no agreement call.** One answer agrees with itself.

**Stops.** `converged` when they agree · `split` at the ceiling without agreement · `stalled` when nobody moved and the differences are unchanged · `no_reviewers` · `no_reconcile` when the moderator could not answer.

The gate states the reading in words — `doing  answering the question` — rather than leaving it to be inferred.

## The gate

**Pass 0 runs first; the gate comes after it.** The posture and the criteria are what decide the blast radius and most of the cost, and neither is known until the moderator answers — a gate shown before that would be asking about a run nobody can see yet. So one call is spent, then the user is asked.

**Posture is coloured by blast radius** — `tool-less` green (the agents can touch nothing), `workspace` yellow (they can write in your tree). The one word on that line with consequences behind it.

Shows: artifact · `artifact_kind` · posture · moderator **with its model** (`(provider default)` when unpinned) · reviewers on one line as `[model, model, …]`, model names only, falling back to the provider id when unpinned · `R × (N + 1)` remaining calls and how the run stops · the unsupervised-agents warning in the workspace posture only.

⚠️ **Not the criteria.** They are the moderator's private yardstick and a producing run has none; showing them invited reading them as the run's definition, which they are not.

The artifact is named by its path, or — for a `--prompt` run, which has none — by its own first line, truncated. `report.json` carries the artifact text and a `source` path that is `null` for a prompt; the run's subject used to survive only in `input.md`.

`--yes` skips it. A non-TTY without `--yes` exits `2` rather than hanging — pass 0 is already on disk, no round ran. Answering no exits `0` with `nothing run`. Logged as `consensus.confirmed` / `consensus.rejected`.

⚠️ The criteria are the run's real subject and the cheapest thing to get wrong: a good debate against the wrong questions still costs full price. That is why they are on screen before the spend, not only in `criteria.json` afterwards.

## Naming participants

**Reviewers are named by model, never by provider** — `--providers luna,sonnet`. Baya already knows which CLI serves a model id, so naming both would say it twice and invite a mismatched pair. Resolution order: exact catalog id ⇒ catalog alias ⇒ `modelAliases` ⇒ `providerForModel` (shape then tokens — providers.md §Model → provider routing) ⇒ error. ⚠️ A routable name Baya does not recognize passes through unchanged — the catalog is a convenience list, not an allowlist.

A bare provider id (`claude`) is accepted and means that CLI with its **own default** model. Model defaults stay unset by design.

Default reviewer is `defaults.model`, falling back to `defaults.provider`; moderator is `--moderator`, else `planner.model`, else `planner.provider`, else the first reviewer. Neither set ⇒ exit `2` naming the flag, never a silent one-model run.

⚠️ **One model per CLI per debate.** `reviewers/<provider>/` is the ledger key, so two models of one CLI would share a history. Named twice ⇒ exit `2`. Worth revisiting if two models of one CLI turn out to be a real want.

`gemini` resolves to a specific error — verified, no adapter — not a generic "unknown".

## The moderator has no voice

**It facilitates; it never contributes.** It does not answer the question the artifact poses, does not improve what nobody objected to, and does not add a point of its own however obvious. A real problem nobody raised waits for a reviewer to raise it — that is what the next round is for.

Stated in both its prompts. Pass 0: write the questions reviewers will answer, do not evaluate the artifact. Reconcile: carry the reviewers' work into the document, applying an accepted finding through its own `claim` and `suggestion`, writing only the minimum needed to carry a point where no wording was given.

⚠️ **It still authors the document**, which is where its voice could leak back in. So every `changes` entry must cite the `finding_ids` it came from, and `unsourcedChanges` flags any that cites none. Detected, not prevented — the edit is already in the document by the time Baya reads it back, so the honest move is to name it. Surfaced as `consensus.moderator.unsourced` and in the report under **moderator edits nobody asked for**.

It judges a finding on its `evidence`, never on which reviewer sent it — the same reason reviewers see each other anonymized (§Naming participants, §Ledgers).

## Access posture

Moderator returns `needs_workspace` in pass 0. Two postures, no flag, no middle rung.

| `needs_workspace` | Posture                         | Argv                                                                                                        |
| :---------------- | :------------------------------ | :---------------------------------------------------------------------------------------------------------- |
| `false`           | `noTools`                       | claude `--tools ''`; nothing opened, nothing run                                                            |
| `true`            | `access: "read-write"` in `cwd` | codex `-s workspace-write` + network; claude lean set + `Write,Edit,TodoWrite`; copilot `--allow-all-tools` |

Ambiguity, an unparseable pass 0, or a missing field ⇒ `true`. A wrong `false` costs the debate its evidence silently.

⚠️ **A wrong `true` costs more than tokens.** Measured 2026-09-06 on the artifact `who created bitcoin` (19 bytes, no file, no code): the moderator answered `true`, claude got the full tool set, spent **six turns** on tool calls against a codebase irrelevant to the question, hit `stop_reason: "tool_use"` without ever producing a critique, and billed $0.069 for that one call. The run went $0.055 → $0.204 and lost a reviewer. Pass 0 is therefore told the artifact is the **entire** input, that `true` means the artifact points at something outside itself, and what a needless `true` costs — a technical-sounding subject is not a reason.

`--kind` skips pass 0 and carries the posture: `plan`/`idea`/`prompt` ⇒ `false`, `spec`/`review` ⇒ `true`. `--tools all` overrides to full.

⚠️ **No lock, no isolation, no serialization.** Reviewers run loose and in parallel with write access — `specs/001/00-validation.md` B1 knowingly left open. Every mechanism that would fix it costs the parallelism or needs `--isolation worktree`, which is `later`. Stated once at the gate in the workspace posture; **consensus is for reviewing, not developing.**

Every workspace-posture prompt carries a shared-workspace note, rendered by Baya, never authored by a model. It states a fact and forbids nothing.

## Ledgers — continuity without sessions

Each reviewer owns `reviewers/<provider>/`, holding `round-<n>.critique.json` and an append-only `ledger.md`. Round N+1 inlines that ledger, so the model opens with what it argued, what the moderator did with each finding, and why. Moderator keeps its own at `moderator/ledger.md`, or round 2 reverses round 1.

**Baya writes every ledger; no model does.** Each append derives from `critique_result` and `reconcile_result.changes[]`, both already on disk — inside `execution.md` §Memory's "read back out of a record the provider already wrote".

⚠️ **No provider sessions.** No session id, no resume verb, no expiry window, no cold-retry fallback. `buildResume` stays uncalled; every round is a plain `buildRun` with the full flag set, so codex keeps `-C` and `-s` on every round. `execution.md` §Grouping's rule against reintroducing session management is untouched — it is about cost, and this is a capability the filesystem already provides.

**Inlined, never a path.** A ledger the model must open is one it can skip, and opening it costs a tool call plus the conversation re-send after it.

⚠️ **Anonymized.** Rivals appear as `Reviewer A`/`Reviewer B`, stable across rounds, never as a provider id. A model handed "claude disagrees" weighs the name over the evidence. Prompt-layer only: `pseudonyms.json`, every critique file, the report and `--json` carry real ids.

## Inlined schemas

`opencode`/`copilot` enforce no schema, so it is inlined in their prompt. Two hardenings, both from a live failure.

⚠️ **Measured 2026-09-06:** `opencode/mimo-v2.5-free` returned the `reconcile_result` **schema document** verbatim instead of an instance, failing the round with a wall of unrecognized zod keys. A schema and an instance are both JSON objects, so the difference is stated rather than implied: the prompt says the block describes the shape, is not a template, and that `properties`/`required`/`additionalProperties` must never appear in the answer.

`$schema` and `title` are stripped from the inlined copy — meta keys a model needs nothing from, and the half that makes the document read as something to copy. (claude strips `$schema` too, for a different reason: its validator has no 2020-12 meta-schema. providers.md §claude.)

`isSchemaEcho` recognizes the failure and reports **"returned the schema instead of an answer"**, on the completion line and in `consensus.reconcile.failed`. The zod key dump named nothing a reader could act on.

`providerErrorIn` does the same for a CLI's own error envelope reaching the parser — `is_error` / `stop_reason` — reporting **"the provider errored before answering (stop_reason: tool_use, 6 turns)"** where zod said `Invalid literal value, expected "1"`. `describeParseFailure` picks between the three.

## Compaction

`--ledger-budget` (default `8000` chars, per reviewer). Trigger is a Baya char budget, never a provider's real context window — no `CatalogModel` field holds one, and a stale limits table would compact too late.

1. **Projection** — free, deterministic. Superseded rounds keep `id`, `severity`, `claim`, verdict, rationale; drop `evidence`, `suggestion`, `location`, `position`. Latest round always whole.
2. **Moderator call** — only when projection still overflows.

⚠️ **Verified, not trusted.** The moderator rejected some of what it is summarizing. Every finding id present before must be present after; otherwise the answer is discarded and projection stands.

**Raw records immutable.** `round-<n>.critique.json`, `rounds/<n>/reconcile.json`, `baya.jsonl` never rewritten. `ledger.md` stays append-only; compaction writes `digest-<n>.md` beside it and the prompt reads that.

## Convergence

Stop when **no reviewer returned a `blocker` or `major`**. Deterministic, computed by Baya. `reconcile_result.converged` is advisory — logged, never the gate; a model asked whether it is done says yes.

`--rounds` is a ceiling, not a count. A failed reviewer is recorded and the round proceeds on the rest; **zero** successful reviewers ends the run at the last good draft and spends no reconcile call.

**A round where nobody raised anything skips its reconcile.** Nothing to apply ⇒ the document cannot change. Measured 2026-09-06: a converging final round returned zero findings from all three reviewers and its reconcile came back with zero changes and a byte-identical document — one moderator call, the run's most expensive seat, spent to be told so. Findings of any severity still reconcile; only an empty round skips.

⚠️ **The moderator is the expensive seat.** Same run: codex moderating **and** reviewing made 5 calls against 2 each for the other reviewers, and carried 60k of the run's 115k input tokens — every reconcile prompt holds the draft plus every reviewer's findings.

**A round that raises no new blocking ground stops the debate.** `stalledCriteria` compares this round's blocking criterion ids against the ones the previous round **accepted and applied a change for**: if every one is a repeat, the debate is circling and stops as `stalled`. The reconcile still runs first, so the round's findings reach the document; only the next round is saved. A criterion blocking for the first time is progress, never a stall.

⚠️ Measured 2026-09-06 on `will a human land in Mars before 2030?`: pass 0 wrote `evidence-and-timeline` — _does the answer ground its judgment in mission schedules?_ — while answering `needs_workspace: false`. Tool-less reviewers cannot look up a launch date, so the criterion was unsatisfiable by construction. **Every finding in rounds 2 and 3 was that one criterion**, from all three reviewers, and the run ended on the ceiling with it still open. It resolved only when the moderator wrote the limitation into the prose. $0.118 of the run's $0.197 bought that sentence.

Two guards, because one is not enough. Pass 0 is told every criterion must be answerable with what reviewers will actually have — no citations, links or dated figures when the posture is tool-less. Reviewers are told a criterion they cannot settle is `minor`, never blocking. The moderator is told such a finding belongs in `unresolved`. The stall stop catches what still gets through.

Stop reasons: `converged` · `split` · `stalled` · `ceiling` · `no_reviewers` · `no_reconcile`.

## Reading the outcome

The report is where a debate becomes learnable, and until 2026-09-06 it printed only the moderator's `rationale` for the last round's changes — what moved, never why anyone thought so.

**positions** — each reviewer's `position` from the final round, verbatim and wrapped. The one field where a reviewer states a _view_ rather than a defect; it was written to `round-<n>.critique.json` and shown nowhere.

A producing run shows **same page** / **not the same page** instead, then **every reviewer's last answer in full** — wrapped, not cut to its opening line — what they differ on, and which answer is the canonical one (the first reviewer named). No answer is ranked or marked best. The stop-reason line is green when the debate converged, plain otherwise.

**decisions** — a review run's `changes[]`, each carrying the `claim` of the finding behind it, who raised it, the agreement count, and the moderator's rationale. A rationale alone says what was done; the claim beside it says what it was answering, which is the half that explains why one argument beat another. `unresolved[]` prints as `unsettled` with the reviewers behind it.

Both are suppressed by `--no-diff`. Nothing is duplicated into `report.json` — the raw records already hold it.

**spend** closes with `total <tokens> · <cost> · <wall-clock>` — the whole run's elapsed time, not just per-provider token counts. **record** is the run directory, last.

**The bare document goes to stdout only when stdout is piped.** Interactively the report already carries every answer in full, so a second raw copy is noise; a redirect (`> answer.md`) or `--output` still gets the plain document.

## The criteria are private — and absent for a producing run

**A producing run has no criteria at all** (§The moderator does not know the answer). What follows applies to a review run, where the artifact already is the thing.

Pass 0 writes the criteria; **the gate shows them to you and no reviewer ever sees them.** They appear in the reconcile and merge prompts only, as the moderator's yardstick.

⚠️ **A rubric handed to every reviewer is a script.** Measured 2026-09-06: three reviewers given the same five questions returned the same five findings, and in later rounds every finding from every reviewer cited the same single criterion. That reads as agreement and is not — it is one model's framing, echoed N times and paid for N times.

⚠️ **There is no `out_of_scope` either.** The moderator does not get to decide what is off the table any more than it decides the answer. Scope comes from the artifact, in the user's own words — and the artifact goes down whole and unframed, so a reviewer reads any limit the user wrote for itself.

**The moderator declares the mapping.** Reviewers cannot cite a criterion they have never seen, so `criterion_id` moved off `Finding` and onto `Change`: every decision names the one criterion it serves.

## Decisions that serve no criterion

⚠️ **A reviewer's own environment can enter the debate.** Measured 2026-09-06: claude raised _"does not open with a required TL;DR line"_ — a rule from its user's global instructions file, reaching the reviewer through the CLI's own memory discovery. The moderator accepted it, and the final answer grew a TL;DR nobody asked for. Every CLI has such a file (`CLAUDE.md`, `AGENTS.md`, opencode's own), so the same debate on two machines is not the same debate.

`offCriteria` names any **accepted** change whose `criterion_id` is not one of the run's criteria — empty included — and `onCriteria` strips them before Baya applies the reconcile. Dropped, not flagged: by the time a marker could print, the document is already edited.

A `rejected` change is left alone whatever it names. It changes nothing, so its criterion never has to be real.

⚠️ **This is weaker than the old finding-level check, and deliberately.** Baya can catch an invented criterion id; it cannot catch the moderator mapping a stray finding onto a real criterion. What it can do is make the mapping explicit and printed, so a wrong one is visible in the report rather than silent.

Logged as `consensus.offcriteria`, and printed under `discarded`.

⚠️ `claude --bare` would strip the leak at the source and **is not usable**: it also skips keychain reads, so a subscription login fails with `Not logged in`. Measured, not assumed.

## Agreement

A `changes[]` entry citing `claude:f1` and `codex:f4` **is** the cluster; distinct providers among `finding_ids` **is** the agreement count. No clustering code, no embeddings, no threshold. Finding ids are namespaced `<provider>:<id>` by Baya on read — `f1` collides across reviewers otherwise; no model sees the prefix.

`changes[]` is also the diff, and says why. `unresolved[]` is printed, never dropped.

## On disk

`.baya/consensus/<runId>/` — sibling of `runs/`. `input.md` · `criteria.json` · `pseudonyms.json` · `reviewers/<provider>/{round-<n>.answer.md,round-<n>.critique.json,ledger.md,digest-<n>.md}` · `moderator/ledger.md` · `rounds/<n>/{reconcile.json,agreement.json}` · `final.md` · `report.json` · `baya.jsonl`.

**Per call:** `rounds/<n>/<provider>-<kind>-<n>/` holds `answer.txt` (what the call replied, always written), `stdout.log`, `stderr.log`, and `result.json` — the last only for `codex`, the one `schema-file` provider. ⚠️ **Pass 0 lives in `criteria/`, not `rounds/0/`.** It is not a round, there is exactly one of it, and `rounds/0/` implied a round that never ran and never got a `reconcile.json`. `rounds/` holds real rounds only. ⚠️ `answer.txt` exists because `result.json` does not: claude reads `.structured_output` and opencode has no schema, so both once left an empty directory and no record of their reply.

Per reviewer is the primary axis; the per-round view is a glob. Written as each round settles, so Ctrl+C on round 3 leaves rounds 1–2 complete.

## Display

⚠️ **Quiet by default, inverting [cli.md](cli.md) §Run output.** `provider.text`/`provider.tool`/`provider.stderr` are `debug`, not `info` — four reviewers arguing about the same paragraphs at once is noise. Baya's own voice is unchanged: gate, per-round lines, notes, cost, report. `--verbose` restores provider streams; `provider.error` prints even under `--quiet`.

**The block holds only what is running; what finished is written out.** Each call that settles leaves a persistent line — `✓ claude claude-sonnet-5 42s 6 findings (2 blocking)` — written after its answer is parsed, so the finding count is real. Without it a completed row simply vanished. Pass 0 labels itself `reading the artifact`, so a single moderator row is not mistaken for a broken block.

**One spinner row per in-flight process**, via `log-update` in `src/ui/block.ts` — it measures rendered height against terminal width, which hand-rolled cursor arithmetic gets wrong on a wrapped row. `run` keeps `ora` and its single line. Capped at six rows; height overflow is the one thing `log-update` does not solve.

Events: `consensus.created` · `consensus.criteria` · `consensus.criteria.fallback` · `consensus.kind.forced` · `consensus.agreement` · `consensus.agreement.failed` · `consensus.stalled` · `consensus.offcriteria` · `consensus.posture` · `consensus.round.started`/`.completed` · `consensus.reviewer.failed` · `consensus.reconciled` · `consensus.ledger` · `consensus.compacted` · `consensus.converged`. Everything else reused from [logging.md](logging.md).

Cost accounting matches a run's: per-provider `extractUsage` plus totals, with pass 0 and every compaction call counted like any other.

## Code

`src/consensus/` — `engine.ts` (round loop, convergence, pseudonyms), `prompt.ts` (four renderers), `ledger.ts` (sections, projection), `store.ts` (persistence, compaction), `paths.ts`. CLI in `src/cli/consensus.ts`; report in `src/ui/consensus-report.ts`.

Provider calls reuse `runPlannerProvider` (`src/planner/provider.ts`) with optional `taskId`/`access`/`noTools`/`tools` — no second spawn path, no new abstraction.

## Ctrl+C

Every spawned process dies with the run, grandchildren included. Children spawn `detached: true` so each leads its own group; `onProcessSpawn`/`onProcessExit` keep the live set exact, and teardown is SIGTERM to every group → grace → SIGKILL to whatever survives, exit `130`. Same handler as `run` (execution.md §Interrupts).

**Installed before the first spawn**, so pass 0 is covered too — the planner was once orphaned by exactly this gap (providers.md, measured 2026-08-31).

⚠️ **Teardown clears the live block as well as the spinner.** The block is a second owner of the terminal (`src/ui/block.ts`), so `progress.dispose()` alone left rows painted and the cursor hidden. The handler is given a composite dispose.

Ctrl+C **at the gate** aborts the prompt: inquirer throws rather than returning, so that is caught and treated as a decline. Nothing is in flight there, and pass 0's record stays on disk.

Covered end to end by `test/integration/consensus-interrupt.test.ts`: two reviewers in flight, each with a grandchild, each trapping SIGTERM — every pid confirmed gone with `ps`, never inferred from a settled promise.
