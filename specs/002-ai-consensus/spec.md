# 002 — `baya consensus` (Multi-Provider Debate & Alignment)

> **Maintenance Invariant:** One file. Validation findings, design, open decisions, and build order live here together — the `001` split into `00-validation`/`01-spec`/`02-plan`/`03-tasks` is not repeated. Every requirement is implementable against a provider surface verified in `wiki-llm/providers.md`, or is marked ⚠️ UNVERIFIED. Design that lands moves to `wiki-llm/`; this file never becomes the source of truth. Token-optimized: imperative, one fact per line, no prose, no mock walls.
> **Answers:** What is `baya consensus`, what does it send and read back, and what was decided against what?

**Issue:** [#33 Multi-Provider Debate & Alignment Engine](https://github.com/dephelion/baya-cli/issues/33) — close on merge.
**Status:** design settled and **built** 2026-09-06. Behaviour now lives in [`wiki-llm/consensus.md`](../../wiki-llm/consensus.md) — this file is the refinement record, not the source of truth. Open: step 10 (validate the 8000-char budget against a real debate) and step 11 (copilot argv guard, blocked on quota).
**Origin:** a Gemini-authored draft written without repository access. §A records what it got wrong; the rest replaces it.

---

## A. Validation of the origin draft

| #   | Original claim                                                                         | Reality                                                                                                                                               | Resolution                                    |
| :-- | :------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------- |
| A1  | Providers exchange **Markdown** critiques; a "Format Sanitizer" strips CLI boilerplate | `specs/001/01-spec.md` §2: JSON in both directions, prose is never the interface. The sanitizer exists only because the draft chose prose.            | §4 — two schemas, existing degradation ladder |
| A2  | Two providers ping-pong (A → B → A)                                                    | Fixes N=2, serializes what can fan out, and gives reviewer B reviewer A's answer before it forms its own.                                             | §3 — moderator-mediated star                  |
| A3  | `-p claude,copilot` default                                                            | `copilot` is the least-verified adapter: argv-only prompt, `structuredOutput 'none'`, assistant-text shape ⚠️ UNVERIFIED (quota), `maxConcurrency 1`. | §2 — default is the configured provider       |
| A4  | `gemini` listed as a participant                                                       | `providers.md`: verified 2026-08-28, **deferred to v1.1**, no adapter in `src/providers/registry.ts`.                                                 | Out of scope; §14 D5                          |
| A5  | Short flags `-p -r -o -d`                                                              | Baya has no single-letter flags but `-v`/`-V`. `providers.md` names `-p` the canonical drift trap (`--profile` on codex, `--prompt` on copilot).      | §2 — long form only                           |
| A6  | `--diff` renders a textual diff                                                        | Deps are `@inquirer/prompts`, `chalk`, `ora`, `zod`. A diff library for a summary the reconciler can return structurally is a bad trade.              | §4 — `changes[]` is the diff                  |
| A7  | `--rounds 2`, fixed                                                                    | Nothing in the draft measures agreement or stops early. "Consensus" is a label, not a mechanism.                                                      | §6 — convergence gate, rounds as ceiling      |
| A8  | "Reuse existing subprocess wrapper functions"                                          | Right instinct, names nothing. `src/planner/provider.ts` already is prompt-in/document-out over `runProcess`.                                         | §5.4 — reuse it                               |
| A9  | Rounds chain stdout into stdin, statelessly                                            | A reviewer that cannot see its own round-1 position can only re-derive it. Rebuttal is impossible; it never held a position to defend.                | §3.1 — per-reviewer ledger on disk            |

**Omissions the draft never raised:** no run directory or checkpoint (§8) · no interrupt teardown for N detached children (§5.4) · no cost gate or usage report (§10) · no trust boundary for provider→provider text (§9) · copilot argv size limit (§11) · no offline test seam (§12).

---

## 1. What this is

One artifact, several provider CLIs, a moderator. Reviewers critique in parallel and blind; the moderator reconciles their findings into a new draft; repeat until findings stop or the round ceiling is hit.

**Not a `run`.** No DAG, no manifest, no task list, no `depends_on`. It is the second thing Baya does with providers, not a mode of the first. It may still touch the working tree — §7.

| Term          | Meaning                                                                                                        |
| :------------ | :------------------------------------------------------------------------------------------------------------- |
| **Artifact**  | What is under debate: a file, or a raw string. Never mutated in place.                                         |
| **Moderator** | One provider. Writes the criteria, reconciles each round, declares convergence. Default: `planner.provider`.   |
| **Reviewer**  | A provider producing findings. Never sees another reviewer's findings.                                         |
| **Round**     | One parallel reviewer fan-out plus one moderator reconcile.                                                    |
| **Finding**   | One structured critique. Namespaced `<provider>:<id>` by Baya, never by the model.                             |
| **Agreement** | Distinct reviewers whose findings the moderator merged into one change. Falls out of §4; not computed by Baya. |

## 2. CLI surface

```bash
baya consensus <file|"prompt"> [options]
```

Alias `con`. **No `sync`** — `cli.md` resolution is "first positional matching a known subcommand ⇒ that subcommand", so every alias steals a filename.

**Input resolution:** positional resolves as a path first; a non-existent path is treated as a raw prompt. Diverges from `run`, which errors. Empty / C0-binary input ⇒ exit `2` before any spawn, same check as `checkTaskText`.

| Flag                    | Default             | Meaning                                                                                                                                                        |
| :---------------------- | :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--providers <list>`    | `defaults.provider` | Reviewers. Comma/space separated. Unknown id errors. Unset **and** no configured default ⇒ exit `2` naming the flag — never a silent single-model run. §14 D2. |
| `--moderator <id>`      | `planner.provider`  | Reconciler. May also appear in `--providers`; it then reviews blind before reconciling.                                                                        |
| `--moderator-model <m>` | _unset_             | Resolved via `resolveRunModel` like `--planner-model`. **A raw id that reaches a CLI unresolved kills the run** (`providers.md` §Model resolution).            |
| `--rounds <n>`          | `2`                 | **Ceiling**, not a count. §6 stops earlier.                                                                                                                    |
| `--kind <k>`            | _inferred_          | `plan\|spec\|review\|idea\|prompt`. Given ⇒ skips the moderator's classification call (§5.1).                                                                  |
| `--output <f>`          | stdout              | Final document. Banner is on stderr, so a piped stdout stays clean.                                                                                            |
| `--no-diff`             | off                 | Suppress the change summary. Default-on, so the negative form — matches `--no-color`/`--no-memory`.                                                            |
| `--ledger-budget <n>`   | `8000`              | Chars of a reviewer's own history carried into its next prompt, before compaction (§3.2).                                                                      |
| `--json`                | off                 | Machine-readable consensus report to stdout. Suppresses the banner.                                                                                            |
| `--yes`                 | off                 | Auto-confirm the cost gate (§10).                                                                                                                              |

Inherited unchanged: `--verbose` `--quiet` `--log-level` `--no-color` `--no-progress` `--tools` (`all` forces the full surface — §7).

**Exit codes** (`cli.md` table, unextended): `0` converged, or ceiling reached with a document produced · `1` a reviewer or the moderator failed and no document survived · `2` bad input, unknown provider, moderator unresolved; nothing spawned · `130`/`143`/`129` signals, same teardown.

## 3. Topology

```
              moderator ── pass 0: classify → criteria            (§5.1)
                  │
      ┌───────────┼───────────┬───────────┐                        round N
      ▼           ▼           ▼           ▼   ← parallel, blind to each other
   claude       codex      copilot     opencode
      │           │           │           │
      └───────────┴─────┬─────┴───────────┘
                        ▼
                    moderator ── merge findings → draft + changes[]  (§5.3)
                        │
                 converged? ──no──► round N+1 reviews the **new draft**
                        │yes
                        ▼
          final document + rejected findings + unresolved disagreements
```

**Reviewers are blind by design.** A reviewer shown another's critique anchors on it and stops searching independently — independence in the critique phase is the whole reason to pay four CLIs. Providers still answer each other, through the reconciled draft: round 2 critiques a document that already absorbed round 1.

Cost is O(N·R) calls, not O(N²·R). Fan-out is one call per provider, so per-provider `maxConcurrency` (claude `1`, codex `2`) never binds.

### 3.6 The moderator does not know the answer

⚠️ **The moderator never knows the answer to the job, or how the job should be done, and it must not.** It is usually not the strongest model in the run and may be the weakest. Nothing it believes about the subject may reach the output.

**There is nothing to judge against, because the job isn't judging.** When the artifact asks for something, no criteria are written at all: pass 0 returns an empty `criteria` array. The reviewers produce; the moderator reports only whether they are on the same page. That is its entire contribution.

Enforced by the protocol, not by instruction. `agreement_result` is `{agreed, differences[], notes[]}` and **has no `document` field** — nowhere to put an answer, no ranking, no count.

Measured 2026-09-06, on `if 5 workers build 5 tables in 5 minutes, how long for 100 workers to build 100 tables`, pass 0 wrote `correct-time` — _"Does the answer correctly conclude that 100 workers take 5 minutes?"_. That is a scoring key. One model answered the question and then handed itself a rubric in which every reviewer who disagreed was wrong by construction: consensus decided before anyone spoke, by whichever model happened to moderate.

**Voting was considered and rejected.** Counting answers and printing the most common still makes the moderator an arbiter, and a majority is not a correctness signal.

**Output.** Agreed ⇒ any answer is the answer, so Baya takes the first reviewer in the order the user named them — predictable, never the moderator's pick. No agreement at the ceiling ⇒ every answer side by side, none chosen. Running out of rounds grants no power the moderator never had.

This does not apply to a review run, where the artifact already **is** the thing: nobody is answering, so criteria and the critique/reconcile loop stand (§5.2, §5.3).

### 3.1 Reviewer continuity — a ledger on disk, not a session

**Every reviewer owns a directory. Its own prior turns live there, in round order, and are replayed into its next prompt.**

```
reviewers/<provider>/
  round-1.critique.json     verbatim result, never rewritten
  round-2.critique.json
  ledger.md                 append-only, ordered; this is what the prompt carries
```

`ledger.md` grows by exactly one section per round and is the reviewer's whole memory. Round N+1's prompt inlines it, so the model opens with what it argued, what the moderator did with each finding, and why.

**No provider sessions.** No session id, no resume verb, no expiry window, no cold-retry fallback, no per-adapter divergence. `buildResume` stays uncalled and `codex exec resume` stays unprobed. Every round is a plain `buildRun` with the full flag set — which also means codex keeps `-C` and `-s` on every round, a sandbox gap the session route quietly opened.

**Baya writes the ledger; the model never does.** Each round appends, deterministically, from documents that already exist:

- the reviewer's own `critique_result`, verbatim
- the `changes[]` entries citing its finding ids — verdict **and rationale**
- the anonymized rival findings its own were merged against (§3.3)

⚠️ This satisfies `execution.md` §Memory rather than fighting it: _"Every fact is read back out of a record the provider already wrote."_ The ledger is a derivation over prior results, not a `learnings[]` field a model fills in. Nothing in it can be hallucinated into existence, because nothing in it is written for the purpose.

**No extra moderator call.** The append is mechanical — `reconcile_result` already carries the verdicts and rationale. Asking the moderator to compose each reviewer's recap would cost a call per reviewer per round and add something it can get wrong. Same reasoning as §4: it falls out of the protocol.

**Inline, never a path.** In the tool-less posture (§7) the model cannot open a file at all. In the other, it could — and a path would still be wrong: a ledger the model must choose to open is one it can skip, and opening it costs a tool call plus the re-send of the whole conversation after it (`prompt.ts`, measured 16.8k → 35.6k tokens on that exact pattern). Its own history is not optional context.

See §3.2 for what happens when it outgrows its budget.

**Why this is the better trade.** It is replayable (re-run round 3 against the same files), inspectable (the whole debate is diffable text), uniform across all four adapters, and needs no machinery Baya does not already have. A session is opaque, per-provider, expiring, and unverified on two of four CLIs.

### 3.2 Compaction

The ledger grows every round. Two tiers, cheapest first; the second is only reached when the first is not enough.

**Tier 1 — projection. Free, deterministic, no call.** Findings are structured (§4), so compacting a superseded round is field selection, not summarization: keep `id`, `severity`, `claim`, the verdict and its rationale; drop `evidence`, `suggestion`, `location`, `position`. The previous round always stays at full detail — it is the one being argued about.

**Tier 2 — the moderator compacts.** When projection still overflows, the moderator is handed one reviewer's projected ledger and returns a shorter one. One call per over-budget reviewer per round, and only then.

⚠️ **Compaction is verified, not trusted.** The moderator is a participant: it is the party that rejected some of the findings it is now summarizing for the reviewer who raised them. Baya knows every finding id in the ledger before the call and asserts the same set after it. Ids missing ⇒ the compaction is discarded and tier 1's projection is used. A model may shorten an argument; it may not lose a position, least of all one it argued against.

**Raw records are never touched.** `round-<n>.critique.json`, `rounds/<n>/reconcile.json`, `events.jsonl`, `stdout.log` and `baya.jsonl` are immutable for the life of the run. `ledger.md` stays append-only and complete. Compaction writes a **separate** `digest-<n>.md`, which is what the prompt carries from that round on. Nothing is ever destroyed to save tokens — the full debate stays on disk and diffable.

⚠️ **The trigger is a Baya budget, not a provider's real context limit.** Baya does not know any provider's window: `CatalogModel` is `{id, aliases, description}` and there is no such field anywhere. Adding a per-provider limits table would repeat the mistake `specs/001/00-validation.md` A4 records for model defaults — _"IDs churn faster than this tool will ship"_ — and a stale table would compact too late, which is the failure that cannot be recovered from. So the threshold is a character budget Baya owns, in the shape of `--context-budget 12000` and `--memory-budget 1200`: **`--ledger-budget 8000`**, per reviewer.

**Where 8,000 comes from.** A round of ~6 findings runs ~4,700 chars (claim ~200, evidence ~300, suggestion ~200 each, plus `position`). Tier-1 projection drops a superseded round to ~250 chars per finding. So a 3-round architecture debate lands near 4,700 (last round, full) + ~1,500 (two projected rounds) ≈ 6,200 — inside 8,000, with tier 2 never firing. It sits between the two existing budgets and holds the case this feature is actually for. A first estimate, not a measurement.

**Tunable from run logs, by construction.** Every round logs `consensus.ledger` with `{provider, round, chars_raw, chars_sent, tier}`. Re-tuning reads `baya.jsonl` across past runs; it never needs a fresh experiment.

⚠️ `copilot` is argv-only, so its ceiling is the OS argv limit rather than a model's window. It can hit the wall first and for an unrelated reason (§12).

### 3.3 Anonymity in the digest

**A reviewer never learns which provider it is arguing with.** Rival findings reach it as stable pseudonyms — `Reviewer B`, `Reviewer C` — never as `claude` or `codex`.

Brand names corrupt the judgement. A model handed "claude disagrees" weighs the name, not the evidence: deference to a reputation, or reflexive defence against a rival, in place of reading the argument. Anonymity forces the finding to stand on its `evidence` field, which is the only thing that should carry weight.

**Pseudonyms are stable across rounds.** `Reviewer B` is the same provider in round 3 as in round 1, or continuity (§3.1) buys nothing — a reviewer cannot track an opposing position it cannot recognize.

**Anonymity is a prompt-layer transform, not a record.** `reviewers/<provider>/round-<n>.critique.json`, the report, and `--json` all carry real provider ids. The user always sees who said what; only the models do not. The pseudonym map is written to the run directory.

A reviewer's **own** findings are of course identified as its own — it is being asked what it now thinks of them.

### 3.4 The standing rule this does not touch

`wiki-llm/execution.md` §Grouping closes with: **"Do not reintroduce session management to solve a cost problem grouping already solves."** M6.4 shipped session chain-collapse and was removed whole — `buildContinue`, `transcriptPath`, `continued_from`, `--no-session-reuse` all deleted.

§3.1 does not reopen it. The ledger is the filesystem carrying the record, which is what Baya already does for every task (`request.json`, `result.json`, `output.md`, and the context bus's `result_path`). No session id, no warm-cache window, no resume verb, no cold-retry fallback — the four costs the removal named are all avoided, not paid.

`execution.md` needs **no amendment**. That is the point of choosing this route.

⚠️ **Reviewers never talk directly, and this is not a v1 deferral** — it is rejected outright (§16). Independence in the critique phase is what makes N CLIs worth more than one.

## 4. Wire format

JSON both directions (`specs/001/01-spec.md` §2). New schemas in `src/manifest/schemas.ts`, new `kind` values on the existing envelope; `PROTOCOL_VERSION` unchanged — these are additions, not a break.

**`consensus_criteria`** — moderator, pass 0.
`{ baya, kind, artifact_kind, needs_workspace, needs_draft, criteria: [{ id, question }] }`

`needs_workspace` is a boolean and it decides the access posture for every reviewer in the run (§7).

**`critique_result`** — one per reviewer per round.
`{ baya, kind, round, position, findings: [{ id, criterion_id, severity, claim, evidence, suggestion, location? }], notes[] }`
`severity: blocker | major | minor | nit`. `notes[]` reuses `NoteSchema` verbatim. `evidence` is required and is what separates a finding from an opinion; reviewers have the tools to ground it in a real path or a command they ran (§7).

`position` is a short free-text stance — the overall read that individual findings do not carry. It is the one self-reported field, exempted the way `protocol.md` §3 exempts `summary` / `output` / `notes`, and it is capped. It is what "its own thinking, in order" means concretely in §3.1.

**`reconcile_result`** — moderator, once per round.
`{ baya, kind, round, document, changes: [{ finding_ids: [], action, rationale }], unresolved: [{ claim, providers: [], rationale }], converged }`
`action: accepted | rejected | deferred`.

Three consequences, all of them the reason for the schema:

1. **Agreement needs no clustering code.** A change citing `claude:f1` and `codex:f4` _is_ the cluster; distinct providers in `finding_ids` _is_ the agreement count. No embeddings, no similarity heuristics, no tuning.
2. **`changes[]` is the diff.** It says what moved and why — strictly more than a textual diff, at zero dependency cost.
3. **`unresolved[]` is kept, not discarded.** A debate's most valuable output is often the disagreement that did not resolve. The origin draft threw it away.

**Finding ids are namespaced by Baya** on read: reviewers pick ids independently and `f1` will collide across providers. A model never sees or writes the prefix.

Whole-document echo each round is deliberate. Measured across 17 runs (`protocol.md` §3), output is **1.3%** of tokens — re-emitting the document is the cheap half, and a patch format is a second parser plus a class of misapplication bugs.

Parsing is the existing ladder unchanged: native (`codex --output-schema`, `claude .structured_output`) → verbatim → fenced → synthesized failure. `opencode`/`copilot` reach rungs 2–3 with the schema inlined in the prompt (~+1,000 tokens each).

## 5. Orchestration

### 5.1 Pass 0 — criteria

The moderator classifies the artifact and returns `consensus_criteria`. This is what makes "consensus on anything" work without a mode switch per artifact type.

It also answers `needs_workspace` — does settling this question require reading files, running a command, or reaching the network? That one boolean sets the access posture for every reviewer in the run (§7).

And `needs_draft` — does the thing being judged exist yet? `true` when the artifact only asks for it (a question, a request, a task); `false` when the artifact is it. See §5.1b.

**Criteria must be satisfiable under the posture pass 0 just chose.** A criterion demanding evidence the reviewers cannot obtain blocks every round, from every reviewer, until the ceiling. Pass 0 is told so explicitly; §6 catches what gets through anyway.

**Criteria are structured, never a free-text system prompt.** Baya renders them into a fixed skeleton. A model-written prompt handed to other models is both non-deterministic across runs and an injection surface (§9).

⚠️ **And they are never handed to a reviewer at all.** They are the moderator's yardstick for weighing what comes back. A rubric given to every reviewer is a script: measured 2026-09-06, three reviewers reading the same five questions returned the same five findings, and in later rounds every finding cited one criterion. That reads as agreement and is one model's framing echoed N times. And there is no `out_of_scope`: deciding what is off the table is the same power as deciding the answer, so scope comes from the artifact in the user's own words, which the reviewers read whole.

Reviewers therefore cannot cite a criterion, so `criterion_id` lives on `Change`: the moderator declares which criterion each decision serves, and Baya discards an accepted change naming one the run does not have (§9).

⚠️ `--kind` skips the classification call, so it must carry the posture too: `plan` / `idea` / `prompt` ⇒ `false`, `spec` / `review` ⇒ `true`. A `--kind` that guessed the criteria but left the posture unset would be a silent `false`.

### 5.1b Producing runs — answer, then ask if they agree

When `needs_draft`, round 1 sends **the artifact itself, first and unframed**, and every reviewer answers it independently and blind. The moderator merges those answers into the first document; rounds 2+ critique it.

⚠️ A question wrapped in a review task gets reviewed. Measured 2026-09-06: round 1 said "you are reviewing the artifact below" and pasted a question; all three reviewers returned five findings each whose entire evidence was a quote of it. The bug was the framing, not a missing draft.

A moderator-written seed fixed the symptom for one call instead of four, and made the moderator the author of every answer. Asking N models is only worth paying for if N answers come back.

The moderator then answers one question — are they saying the same thing (§3.6). Not agreed ⇒ each reviewer sees its own answer, everyone else's anonymised, and the differences named, then revises or holds **with a reason**. Reviewers are told to hold where they are not convinced: an answer that stays put for a stated reason beats one that moves to end the round.

One reviewer needs no agreement call — one answer agrees with itself. Every answer is kept verbatim at `reviewers/<provider>/round-<n>.answer.md`.

⚠️ Once the document is a merged answer, the request is nowhere in the prompt; every later prompt carries it separately.

### 5.2 Reviewer prompt

Fixed skeleton, per `src/executor/prompt.ts` conventions: artifact fenced and tagged as data · the criteria · the response contract · schema inlined only for a provider that enforces none. From round 2 the artifact is the reconciled draft, and the reviewer is told the round number and nothing else about the previous round.

⚠️ **Never name a schema by path.** Measured 2026-08-30 (`prompt.ts`): "matching the schema at `<path>`" made codex `sed` a file the CLI was already enforcing, taking one task from 16.8k to 35.6k tokens.

**Shared-workspace note — workspace posture only.** One short block, rendered verbatim by Baya into every prompt of that posture, reviewer and moderator alike:

> You are one of several agents working in this directory at the same time. Others are reading files, running commands, and may write while you work. Keep scratch files in `$TMPDIR`. Expect the tree to change under you, and do not read a command's output as reflecting only your own actions.

It states a fact and forbids nothing — a reviewer that needs to write still can (§8). Practically it is the moderator's note: the posture is the moderator's call in pass 0, and the note rides the posture.

⚠️ **Baya renders it, not the moderator.** Fixed text in the skeleton for the same reason the criteria are structured (§5.1) — model-authored prompt text is non-deterministic across runs and an injection surface. Asking for it per run would also cost a call to say the same sentence.

### 5.3 Reconcile prompt

Artifact + every reviewer's findings, provider-attributed, fenced as data. Returns `reconcile_result`.

### 5.4 Execution

Reuse [src/planner/provider.ts](src/planner/provider.ts) — its own comment reads _"planning is just a task with an unusual schema"_, inheriting argv construction, stdin discipline, detached process groups, and ANSI stripping. A consensus call is that same shape with a different schema.

**Minimum change, no new abstraction.** Widen `RunPlannerProviderOptions` with the two or three fields that differ — task id/title, `access`, `tools` — and call it. If that turns the signature awkward, **copy the function** into `src/consensus/provider.ts` and adjust it. A duplicated 90-line function is cheaper than a shared abstraction two callers have to agree on forever. Do not rename it, do not introduce a `runProviderCall` layer.

The one hard rule survives either way: **no second spawn path.** Everything goes through `runProcess`.

⚠️ **Interrupt teardown is mandatory and already cost once.** Children spawn `detached: true`, so a terminal SIGINT never reaches them. Measured 2026-08-31: without `onProcessSpawn`/`onProcessExit`, SIGINT left `opencode run` alive and orphaned, still spending. Consensus spawns N children _per round_. Every call wires the pair, or the fixed bug returns multiplied.

### 5.5 Ledger assembly

After the moderator returns, per reviewer, mechanically:

1. Persist `round-<n>.critique.json` verbatim in that reviewer's directory.
2. Append a round section to `reviewers/<provider>/ledger.md` — its own findings, the verdict and rationale on each, the anonymized rivals it was merged against.
3. Append the moderator's own section to `moderator/ledger.md` — what it accepted, rejected and deferred, with rationale.
4. Compact any reviewer's ledger now over `--ledger-budget` (§3.2).

A reviewer that failed the round gets a section saying so; it is told it missed a round rather than silently arguing from a stale position.

No provider call, no tokens, nothing to retry.

## 6. Convergence

Stop before the ceiling when **no reviewer returned a `blocker` or `major` finding**. Deterministic, computed by Baya, trusts no model's self-assessment.

`reconcile_result.converged` is advisory: logged, shown in the report, never the gate. A model asked whether it is done says yes.

A reviewer that fails is recorded and the round proceeds on the rest. A round with **zero** successful reviewers ends the run at the last good draft; the ceiling never spends into a dead provider.

**Stall stop.** A round whose blocking criteria are _all_ repeats of criteria the previous round accepted and applied a change for raises no new ground, and the debate stops as `stalled`. The reconcile runs first, so that round's findings still land; only the next round is saved. A criterion blocking for the first time is progress, never a stall.

⚠️ This exists because an unsatisfiable criterion is otherwise a guaranteed ceiling. Measured 2026-09-06: pass 0 asked for mission schedules and dated milestones while answering `needs_workspace: false`, so tool-less reviewers could never satisfy it. Every finding in rounds 2 and 3 was that one criterion, and $0.118 of a $0.197 run bought the sentence admitting it.

## 7. Access

**Two postures. The moderator picks one for the whole run in pass 0; there is no flag.**

| `needs_workspace` | Posture                                              | For                                                                              |
| :---------------- | :--------------------------------------------------- | :------------------------------------------------------------------------------- |
| `false`           | `noTools`, nothing but the prompt                    | a pure question — an idea, a naming call, a tradeoff argued from the text itself |
| `true`            | `access: "read-write"`, full lean tool set, in `cwd` | anything touching the filesystem, a command, the network, or real code           |

**There is no middle.** `read-only` is not a smaller `read-write`: codex's blocks every write including `$TMPDIR`, so a reviewer cannot run the suite or open a scratch file, and claude's keeps `Bash` anyway. A reviewer that must ground a claim needs all of it; one that must not touch anything needs none of it. The middle rung only ever produced tasks that looked confined and were not.

**Ambiguity resolves to `true`.** A wrong `false` silently costs the debate its evidence and yields opinion dressed as review — the failure `evidence` (§4) exists to prevent, and invisible in the output. A wrong `true` costs about 10k tokens per reviewer per round (`providers.md` §Lean tool sets: claude 14,419 against 4,294). Pay the tokens.

**`--tools all` overrides to full**, with the meaning it already has run-wide (`cli.md`). Nothing new is added to force the tool-less posture: a run that wants no tools is a run whose question does not need them, and that is the moderator's read to make.

⚠️ **In the `true` posture reviewers can modify the repository.** Deliberate — it is what makes code review real. Two things follow, both display-only: the gate names the working directory in that posture and only in that one (§10), and every prompt of that posture carries the shared-workspace note (§5.2).

Concretely: codex `-s workspace-write` plus `-c sandbox_workspace_write.network_access=true`; claude `--tools Read,Grep,Glob,Bash,Write,Edit,TodoWrite`; copilot `--allow-all-tools`.

## 8. On disk

`.baya/consensus/<runId>/` — sibling of `runs/`, not a child. `makeRunId` and `runPaths` conventions reused.

```
input.md              the artifact as read
criteria.json         moderator pass 0
reviewers/<provider>/ one space per reviewer (§3.1)
  round-<n>.critique.json
  ledger.md           append-only, ordered
  digest-<n>.md         compacted view, when one exists (§3.2)
moderator/
  ledger.md             its own accept/reject record, in order
rounds/<n>/reconcile.json
pseudonyms.json       Reviewer B -> real id (§3.3)
final.md · report.json · baya.jsonl
```

**Per reviewer is the primary axis**, per §3.1; the per-round view is a glob over it, never a second copy. Every provider call keeps `events.jsonl` / `stdout.log` / `stderr.log` as tasks do.

Written as each round settles, so Ctrl+C on round 3 leaves rounds 1–2 complete and readable. This is the most expensive thing Baya can do per unit of output; losing it to a signal is not acceptable.

### Concurrent writers — warned, not prevented

**No lock, in either posture.** Consensus never takes `.baya/baya.lock`, never serializes reviewers, never isolates them, and forbids them nothing. Agents run loose in the working directory. They are _told_ they have company (§5.2) — awareness, not a constraint.

That is `specs/001/00-validation.md` B1 knowingly left open — _"two agents editing the same repo clobber each other"_ — and the trade is deliberate: the write surface exists so a reviewer can run the suite and ground a finding, and every mechanism that would make it safe (a lock, serialization, a worktree per reviewer) costs either the parallelism the topology exists for or machinery that does not exist. `--isolation worktree` is still `later` in `cli.md`.

**So it is stated once, plainly, at the gate** (§10) in the workspace posture: agents run unsupervised here, several at a time; commit or stash first; do not run this while you or another `baya run` are working in the same tree.

⚠️ **Consensus is for reviewing, not for developing.** Two reviewers running the suite at once can collide on a build cache, and one that decides to fix what it found will write to source with nothing stopping it. Reviewers ask for findings; nothing enforces that they only produce findings. This is the feature's known sharp edge and it is documented rather than sanded down.

`baya runs` / `baya resume` key on `runs/` and are **not** extended to consensus (§14 D3). Artifacts on disk are the whole integration.

## 9. Trust boundaries

Consensus adds a hop Baya has never had: **one provider's output becomes another provider's input.**

- Reviewer and moderator output is untrusted text. It is delivered fenced and tagged as data. A finding reading "ignore previous instructions" is a finding, nothing more.
- The existing rule holds: untrusted text never reaches argv, only stdin or a file. ⚠️ `copilot` is the exception and the reason for §12.
- The moderator's criteria are structured (§5.1) precisely so model text never becomes prompt structure.
- ⚠️ **Pass 0's output selects a privilege level** — exactly the hazard `specs/001/00-validation.md` B2 records for the planner. Bounded two ways: the moderator picks between two fixed postures and can never construct one, and the upper posture is what `baya run` already grants in the same directory. Untrusted text can move the run to Baya's normal privilege, never past it.
- ⚠️ In that posture reviewers hold the full tool set while reasoning over attacker-influenceable text, and they can write. The largest exposure in the feature, accepted deliberately. The gate names the working directory for exactly this reason.

## 10. Cost

A confirm gate before the first spawn, in the shape of the plan gate: artifact, kind, moderator, reviewers, `<n> rounds max`, projected call count `1 + R × (N + 1)`, and, **only when the moderator chose the workspace posture**, the working-directory warning:

```
  🤖 4 agents will run unsupervised in /Users/you/project
     they can write here, several at once, and nothing isolates them
     commit or stash first · not for use while developing in this tree
```

Path in `theme.path`. Conditional on purpose: a warning that fires on every run stops being read within a week. The posture itself is always stated, warning or not. `--yes` skips the gate.

The report prints per-provider usage from each adapter's `extractUsage`, plus totals. Also: rounds run, why it stopped (converged / ceiling / no reviewers), agreement counts per accepted change, rejected findings, `unresolved[]`.

## 11. Logging and display

Everything `baya run` records, consensus records — `logging.md` applies unchanged: two sinks, `baya.jsonl` at `trace` holding everything, structured fields not interpolated prose, log before acting, never to stdout, redact at the sink, per-run files only.

**Reused verbatim:** `cli.invoked` · `config.loaded` · `provider.resolved` / `provider.missing` · `task.spawned` (argv, pid, pgid, delivery) · `provider.text` / `provider.tool` / `provider.stderr` / `provider.error` · `provider.session` / `provider.event.unknown` (`debug`) · `task.result.parsed` (**which ladder rung**) · `task.note` · `task.succeeded` / `task.failed` / `task.timeout` · `process.killed` and the teardown set.

**Added:** `consensus.created` (run_id, artifact, kind) · `consensus.criteria` (artifact_kind, `needs_workspace`, criteria count) · `consensus.posture` (which of §7, and why) · `consensus.round.started` / `.completed` (round, reviewers, duration) · `consensus.reviewer.failed` (provider, kind) · `consensus.reconciled` (accepted, rejected, deferred, unresolved) · `consensus.agreement` (finding, providers) · `consensus.ledger` (provider, round, chars_raw, chars_sent, tier) · `consensus.compacted` (provider, tier, ids_before, ids_after) · `consensus.converged` (reason: `no_major` \| `ceiling` \| `no_reviewers`).

**Cost accounting is identical to a run's.** Each call's `extractUsage` is recorded against its provider; the report prints per-provider `cost_usd` / `input_tokens` / `output_tokens` plus totals, and pass 0 and every compaction call are counted like any other — the moderator's overhead is never folded away. `--json` carries the same numbers.

### Quiet by default

**Baya's own voice is unchanged and stays at `info`, in full.** The gate, model-resolution lines, one line per round as it settles, `warn` / `action_required` notes, the cost line, the report. Everything the orchestrator has to say, a run says and consensus says.

⚠️ **What goes quiet is the models' output, and only that.** `provider.text`, `provider.tool` and `provider.stderr` drop from `info` to `debug` — inverting `cli.md` §Run output, deliberately. A run streams provider prose live so a task is not a black box; consensus does not.

Four reviewers critiquing one document produce four simultaneous streams of prose about the same paragraphs, interleaved. In a run those lines are the work; here they are four drafts of an answer that only matters once reconciled. The deliverable is the document and the change summary, not the deliberation.

| Setting     | You see                                                                                    |
| :---------- | :----------------------------------------------------------------------------------------- |
| `--quiet`   | Failures, warnings, the final document.                                                    |
| **default** | + the gate, one line per round settling, the report. **No provider prose, no tool calls.** |
| `--verbose` | + every reviewer's stream, provider-prefixed, exactly as a run shows it.                   |

### One spinner line per process

Reviewers run in parallel, so the live block is **one line per in-flight process**, not one line for the run.

```
  round 2 of 3

  ⠋ claude     claude-sonnet-5   reviewing   1m03s
  ⠙ codex      gpt-5.6-luna      reviewing     47s
  ⠹ copilot                      reviewing     12s
```

`ora` paints one line and cannot do this. **Add `log-update`** and hand it the whole block each frame; it measures rendered height against terminal width and erases exactly what it drew. `run` keeps ora and its single line untouched — the new renderer is a sibling factory in `src/ui/progress.ts`, not a generalization both callers must then agree on.

**A finished reviewer leaves the block.** Its line is promoted to a persistent completion line through `write()` — `✓ claude 1m12s · 6 findings (2 blocker)` — and the live block shrinks. Same shape as a run's completion lines, and the block only ever holds what is actually running.

`conventions.md` 16b still governs and gets stricter, not looser: every persistent write clears **all** N rows, prints, and re-renders. Nothing writes to stderr around it.

**Why a dependency here and not a hand-rolled redraw.** A line longer than the terminal wraps to two physical rows, and cursor-up-N then walks over the wrong lines — the classic failure of every hand-rolled multi-line spinner, and it only shows up in a narrow terminal on someone else's machine. `log-update` already tracks that, along with `SIGWINCH` and the cursor. Buying the one hard part is a better trade than owning sixty lines of ANSI to get it subtly wrong.

**Footprint: ~6 packages, all leaves.** `log-update` + `slice-ansi`, plus its own ESM copies of `ansi-escapes`, `string-width`, `strip-ansi`, `wrap-ansi` — the top-level copies are CJS-era versions pulled in by jest and inquirer. Zero native code, same family `ora` already nests (`string-width@8.2.2` is in the tree today). `cli-cursor@5` is shared outright.

**No table library.** `report.ts`, `dag.ts` and `render.ts` align every column by hand with `padEnd` / `padStart`, and the DAG is a hand-drawn tree. A grid renderer would add a second visual language next to it and replace code that works. Consensus renders its report in the existing style.

⚠️ **Cap the block at six rows**, five plus `+n more`. Height overflow is the one thing `log-update` does not solve: a block taller than the viewport scrolls and there is nothing left to erase. `--max-parallel` bounds this in practice; the cap is the guard for when it does not.

Disabled exactly as today: non-TTY, `--json`, `NO_COLOR`, `--no-progress`, each falling back to plain completion lines. The cursor guard on `exit` and `dispose()` is reused unchanged — a hidden cursor surviving the process is the one bug worse than no spinner.

**Liveness matters more here than in a run.** With provider prose at `debug`, this block is the only sign of life at the default level, and `claude --output-format json` emits nothing at all between spawn and result.

`warn` / `action_required` notes still print the moment a round settles; `provider.error` still prints, in full, even under `--quiet`. Silence covers prose, never diagnostics. `baya.jsonl` and `events.jsonl` hold the full stream regardless — verbosity filters display, never the record.

## 12. Provider constraints

| Provider   | Constraint                                                  | Consequence for consensus                                                                                                                                                                                                                     |
| :--------- | :---------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copilot`  | prompt is **argv only**                                     | Round-N prompt = document + criteria + its ledger. `E2BIG` is reachable and the ledger grows every round — this is the provider that makes D8's budget mandatory, not optional. Cap argv and degrade with a warning; never truncate silently. |
| `copilot`  | `structuredOutput 'none'`, text shape ⚠️ UNVERIFIED (quota) | Schema inlined; rungs 2–3. Not in the default set until `M3.4` re-probes it.                                                                                                                                                                  |
| `opencode` | `structuredOutput 'none'`                                   | Schema inlined (~+1,000 tokens/call).                                                                                                                                                                                                         |
| `claude`   | `maxConcurrency 1`                                          | Non-binding — one call per provider per round.                                                                                                                                                                                                |
| `codex`    | `-p` is `--profile`                                         | Adapter's problem, already solved. Named here so no consensus code grows its own argv.                                                                                                                                                        |
| all four   | `buildResume` is uncalled                                   | Stays that way. §3.1 uses `buildRun` every round, so no adapter's resume surface is exercised and `codex exec resume`'s ⚠️ UNVERIFIED `thread_id` assumption stays out of the critical path.                                                  |
| `gemini`   | no adapter                                                  | Cannot participate. §14 D5.                                                                                                                                                                                                                   |

## 13. Testing

Offline by default, per `testing.md`. The seam is the planner's: `PlannerRunner` is injectable _"so every planner test runs offline against a scripted response"_ — `runProviderCall` carries the same seam, and every round test runs against scripted critiques.

Unit: criteria rendering · reviewer/reconcile prompt snapshots · id namespacing across colliding reviewer ids · agreement counting from `finding_ids` · convergence gate (severity floor, all-reviewers-failed, ceiling) · argv size degradation for copilot · **ledger append is deterministic and ordered** · a missed round appears as a missed round · `needs_workspace` maps to the right argv per adapter, both postures · an absent or malformed `needs_workspace` resolves to `true` · `--kind` carries a posture · pseudonyms stable across rounds · tier-1 projection is lossless on finding ids · a tier-2 compaction that drops an id is rejected and falls back · raw records byte-identical after a compacting run.
Prompts: the shared-workspace note appears in every workspace-posture prompt and in no tool-less one.
Display: block redraw is width-truncated and survives a narrow terminal · a finished process leaves the block · the block never exceeds the cap · non-TTY renders no block · default level forwards no `provider.text` / `provider.tool` · `--verbose` forwards both, provider-prefixed · `provider.error` prints under `--quiet` · usage sums pass 0 and compaction calls into the totals.
Contract (`BAYA_CONTRACT=1`): one real two-provider round per schema tier — one native (`codex`/`claude`), one laddered (`opencode`).

## 14. Decisions

All settled 2026-09-06. Recorded so a later reader sees what was chosen against what.

| #   | Question                 | Settled                                                                                                                                                                                                                                                                                                                       |
| :-- | :----------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Reviewers talk directly? | **No, and not later.** Rejected outright, not deferred — §15. Independence is the product.                                                                                                                                                                                                                                    |
| D2  | Default reviewer set     | `defaults.provider`. Unset and no `--providers` ⇒ exit `2` with a warning. §2.                                                                                                                                                                                                                                                |
| D3  | Run-machinery reuse      | Only what is already abstracted, or a one-argument widening. Duplication preferred over a new layer. No `baya runs` / `resume`. §5.4.                                                                                                                                                                                         |
| D4  | Code review in v1        | **Yes.** Access is not a flag: the moderator sets `needs_workspace` in pass 0 — tool-less for a pure question, full `read-write` for anything else, ambiguity resolving to full. §7.                                                                                                                                          |
| D5  | `gemini`                 | Ship without it.                                                                                                                                                                                                                                                                                                              |
| D6  | Moderator also reviews   | Allowed. Same model, separate process, blind like any other reviewer.                                                                                                                                                                                                                                                         |
| D7  | Config keys              | No new ones. Consensus reads `defaults.provider` / `planner.provider`, which already exist; `consensus.*` keys are not added.                                                                                                                                                                                                 |
| D8  | `--ledger-budget`        | `8000` chars, reasoned in §3.2 and re-tunable from `consensus.ledger` log lines.                                                                                                                                                                                                                                              |
| D9  | Verdict attribution      | Anonymize, stable pseudonyms. Records stay attributed. §3.3.                                                                                                                                                                                                                                                                  |
| D10 | Moderator continuity     | Its own ledger, in order. §3.1.                                                                                                                                                                                                                                                                                               |
| D12 | Concurrent writers       | **Warn, do not prevent.** No lock, no serialization, no isolation, no prompt constraint. Stated at the gate; consensus is for reviewing, not developing. §8.                                                                                                                                                                  |
| D15 | Off-criteria findings    | **Dropped before the moderator sees them.** Flagging is too late: the document is already edited by the time a marker could print. Deterministic and portable — no provider flag, no prompt to be ignored. The raw critique and the report still hold them. `claude --bare` is not the fix; it breaks subscription auth. §10. |
| D17 | Criteria visibility      | **Moderator only.** Shown to the user at the gate, never in a reviewer prompt: a shared rubric is a script, and three reviewers reading one produced three copies of one framing. `out_of_scope` removed for the same reason: scope is the user's to state, in the artifact. §5.1.                                            |
| D16 | Report content           | Positions verbatim plus every decision with the claim behind it. A rationale alone says what moved, not why. Not duplicated into `report.json`. §10.                                                                                                                                                                          |
| D18 | Moderator's knowledge    | **It never knows the answer to the job.** No criteria at all for a producing run; `agreement_result` has no `document`, no ranking, no count. Voting rejected — counting still makes it an arbiter, and a majority is not correctness. §3.6.                                                                                  |
| D13 | Round 1 for a request    | **Every reviewer answers it, raw and blind**; the moderator only reports agreement. A moderator-written seed was cheaper and made it the author — three critics of one opinion is not consensus. §5.1b.                                                                                                                       |
| D14 | Unsatisfiable criteria   | Three guards: pass 0 told to write only answerable criteria, reviewers told such a finding is `minor`, moderator told it belongs in `unresolved`. The stall stop is the backstop. §6.                                                                                                                                         |
| D11 | Terminal rendering       | **`log-update`** for the multi-line block; no table library. ~6 leaf packages, `ora` kept for `run`. §11.                                                                                                                                                                                                                     |

## 15. Build order

Each step ends runnable. `☐` not started. Everything through step 5 is testable offline against scripted responses.

| #    | Task               | Done when                                                                                                                                                                                                                       |
| :--- | :----------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ☑ 1  | Schemas            | `consensus_criteria` / `critique_result` / `reconcile_result` in `src/manifest/schemas.ts`, zod + JSON Schema, unit-covered.                                                                                                    |
| ☑ 2  | Provider call      | `RunPlannerProviderOptions` widened by two or three fields, **or** the function copied into `src/consensus/` (§5.4). Planner argv snapshots identical byte for byte. No new shared layer, no rename.                            |
| ☑ 3  | Prompts            | Criteria, reviewer, reconcile renderers in `src/consensus/prompt.ts`. Snapshot-tested. Schema never named by path.                                                                                                              |
| ☑ 4  | Round engine       | Pass 0 → fan-out → reconcile → convergence gate. Scripted-runner tests only. No CLI yet.                                                                                                                                        |
| ☑ 5  | Ledgers            | `reviewers/<provider>/` and `moderator/` spaces; append-only ordered `ledger.md`; stable pseudonym map; a missed round recorded as missed.                                                                                      |
| ☑ 6  | Artifacts          | `.baya/consensus/<runId>/` written as each round settles; Ctrl+C leaves completed rounds intact and readable.                                                                                                                   |
| ☑ 7  | CLI                | Subcommand, flags, input resolution, cost gate + the unsupervised-agents warning (§10), interrupt wiring, exit codes, the no-provider warning. `args.test.ts` extended. **First end-to-end run happens here.**                  |
| ☑ 8  | Compaction         | Tier-1 field projection; tier-2 moderator call with the finding-id assertion and its fallback; `digest-<n>.md`; `--ledger-budget 8000`; the `consensus.ledger` log line. Raw records provably untouched.                        |
| ☑ 9  | Report             | Change summary, agreement counts, rejected findings, `unresolved[]`, per-provider usage. `--json` shape.                                                                                                                        |
| ☑ 9b | Multi-line spinner | One row per in-flight process in `src/ui/progress.ts`; completion lines promote out of the block; width truncation, `SIGWINCH`, the six-row cap, cursor guard. `run` unchanged.                                                 |
| ☑ 13 | Agreement loop     | `needs_draft` and `draft_result` in the protocol; `resolveDraft` before round 1; the request threaded through every prompt; `stalledCriteria` and the `stalled` stop reason; posture-satisfiable criteria in all three prompts. |
| ☐ 10 | Validate the 8000  | A real 3-round architecture debate: does the ledger stay inside budget, does tier 2 ever fire, what is copilot's argv length by round 3? Re-tune from `consensus.ledger` if wrong. §3.2.                                        |
| ☐ 11 | copilot argv guard | Size cap + warning, never a silent truncation. Contract case once quota clears (`M3.4`).                                                                                                                                        |
| ☑ 12 | Docs               | `wiki-llm/cli.md` + `protocol.md` + new `consensus.md` with an `index.md` row, SAME commit. `execution.md` untouched (§3.4). `README.md` untouched beyond the pointer.                                                          |

## 16. Not building

**Reviewers talking to each other directly — rejected, not deferred.** Independence in the critique phase is what makes several CLIs worth more than one. A reviewer that has read another's findings anchors on them and stops searching. The earlier sketch of an anonymized agree/disagree pass is withdrawn.

**Provider-session continuity — rejected.** §3.4. The filesystem carries the record.

Deferred, may return: `baya runs` / `resume` for consensus · `gemini` · `consensus.*` config keys · a document-only access mode (§7) · patch-format documents · `--in-place` rewrite · consensus over a whole `baya run` report · a textual diff renderer.
