import type {
  Change,
  ConsensusCriteria,
  Finding,
  FindingSeverity,
} from '../manifest/index.js';

/**
 * The prompts `baya consensus` sends (specs/002-ai-consensus §5). Pure string
 * building, no I/O, so every renderer is snapshot-testable offline.
 *
 * Untrusted text reaches here from three directions — the artifact, a
 * reviewer's findings, the moderator's document — and every one of them is
 * fenced and labelled as data. None of it is ever an instruction.
 */

export interface CriteriaPromptOptions {
  artifact: string;
  /** Where the artifact came from, or `null` for a raw prompt string. */
  sourcePath: string | null;
  /** Settled before the call when the artifact plainly asks something. */
  kindHint?: 'question';
  schema?: string;
}

export interface ProposalPromptOptions {
  artifact: string;
  needsWorkspace: boolean;
  cwd: string;
  reviewerCount: number;
  schema?: string;
}

export interface RevisePromptOptions extends ProposalPromptOptions {
  round: number;
  /** Your own last answer. */
  mine: string;
  /** Everyone else's, under stable pseudonyms — never their provider ids. */
  others: readonly { alias: string; document: string }[];
  /** What the moderator saw you disagree on. */
  differences: readonly string[];
}

export interface AgreementPromptOptions {
  artifact: string;
  round: number;
  /** Every answer this round, under stable pseudonyms. */
  answers: readonly { alias: string; document: string }[];
  needsWorkspace: boolean;
  cwd: string;
  schema?: string;
}

export interface ReviewPromptOptions {
  artifact: string;
  /** The original request, when the artifact under review is a draft of it. */
  ask?: string | null;
  criteria: ConsensusCriteria;
  round: number;
  /** This reviewer's own history, already rendered and budgeted. `''` on round 1. */
  ledger?: string;
  needsWorkspace: boolean;
  cwd: string;
  reviewerCount: number;
  schema?: string;
}

export interface ReconcilePromptOptions {
  artifact: string;
  /** The original request, when the artifact under review is a draft of it. */
  ask?: string | null;
  criteria: ConsensusCriteria;
  round: number;
  /** Findings per reviewer, ids already namespaced by Baya. */
  critiques: readonly {
    provider: string;
    position: string;
    findings: readonly Finding[];
  }[];
  /** The moderator's own history of past decisions. `''` on round 1. */
  ledger?: string;
  needsWorkspace: boolean;
  cwd: string;
  schema?: string;
}

export interface CompactPromptOptions {
  ledger: string;
  ids: readonly string[];
  budget: number;
}

const FENCE = '~~~';

/** Fenced and labelled, so nothing inside it can read as an instruction. */
function asData(label: string, body: string): string[] {
  return [`${FENCE} ${label}`, body.trimEnd(), FENCE, ''];
}

/**
 * The meta keys are dropped from an inlined schema. They carry nothing a model
 * needs and they are the half that makes the document look like something to
 * copy — `$schema`, `title` and `type` at the top read as a header.
 */
function withoutMetaKeys(schema: string): string {
  try {
    const parsed = JSON.parse(schema) as Record<string, unknown>;
    const { $schema: _s, title: _t, ...rest } = parsed;
    void _s;
    void _t;
    return JSON.stringify(rest, null, 2);
  } catch {
    return schema;
  }
}

function contractLines(schema: string | undefined, kind: string): string[] {
  const trimmed = schema?.trim() ?? '';
  if (trimmed === '') {
    return [
      `Respond with a single JSON object matching the \`${kind}\` contract, which the`,
      'CLI you are running in already enforces. Do not open or search for a schema',
      'file — there is nothing in it that is not already being applied to your output.',
      '',
    ];
  }
  return [
    `Respond with a single JSON object of kind \`${kind}\`, and nothing else — no`,
    'prose before or after it.',
    '',
    // ⚠️ Measured 2026-09-06: opencode/mimo-v2.5-free returned the schema
    // document itself. A schema and an instance are both JSON objects, so the
    // difference has to be said, not implied.
    'The block below **describes the shape** your answer must take. It is not a',
    'template and not the answer: never return `properties`, `required` or',
    '`additionalProperties`. Return a document that satisfies it, with your own',
    'values in the fields it names.',
    '',
    ...asData('shape of your answer', withoutMetaKeys(trimmed)),
  ];
}

/**
 * ⚠️ Rendered by Baya, never authored by a model (§5.2). It states a fact and
 * forbids nothing: a reviewer that needs to write still can.
 */
const SHARED_WORKSPACE_NOTE = [
  'You are one of several agents working in this directory at the same time.',
  'Others are reading files, running commands, and may write while you work.',
  'Keep scratch files in `$TMPDIR`. Expect the tree to change under you, and do',
  "not read a command's output as reflecting only your own actions.",
  '',
];

const NO_NARRATION = [
  'Work without narration: no progress updates, no restating the task, no',
  'account of what you just did. The JSON object is the whole deliverable.',
  '',
];

function workspaceLines(needsWorkspace: boolean, cwd: string, agents: number): string[] {
  if (!needsWorkspace) {
    return [
      '# Workspace',
      '',
      'Everything you need is in this prompt. You have no tools; do not plan to',
      'open a file or run a command.',
      '',
    ];
  }
  return [
    '# Workspace',
    '',
    `Working directory: ${cwd}`,
    '',
    'Read the code, run commands, and check claims against what is actually there.',
    'A finding you verified is worth several you inferred.',
    '',
    ...(agents > 1 ? SHARED_WORKSPACE_NOTE : []),
  ];
}

/** Pass 0: classify the artifact and set the criteria plus the access posture. */
export function criteriaPrompt(options: CriteriaPromptOptions): string {
  const origin =
    options.sourcePath === null
      ? 'The artifact below was given directly on the command line.'
      : `The artifact below was read from ${options.sourcePath}.`;

  const asking = options.kindHint === 'question';

  return [
    'You are moderating a review. Several other AI agents are about to critique',
    'the artifact below, independently and in parallel. Your job now is to decide',
    'what they should be judging it against.',
    '',
    'You are not one of them. Do not evaluate the artifact, do not answer any',
    'question it poses, and do not record what you think is wrong with it —',
    'write the questions the reviewers will answer, and stop there.',
    '',
    ...(asking
      ? [
          '**This artifact is a question, and `artifact_kind` is `question`.**',
          'That is settled; do not reconsider it. The reviewers are producing the',
          '**answer**, so your criteria judge a candidate answer — is it correct,',
          'is it complete, does it say what is genuinely uncertain. Do not write a',
          'single criterion about the wording, clarity, or scope of the question',
          'itself: nobody asked for their question to be improved. `needs_draft`',
          'is `true` for the same reason: the answer does not exist yet.',
          '',
        ]
      : []),
    origin,
    '',
    ...asData('artifact', options.artifact),
    '# What to decide',
    '',
    ...(asking
      ? ['1. `artifact_kind` — already settled above: `question`.', '']
      : [
          '1. `artifact_kind` — what kind of thing this is, and therefore what the',
          '   reviewers are producing.',
          '',
        ]),
    ...(asking ? [] : ['   (the kinds, in case it is not obvious:)', '']),
    '   `question` — the artifact **asks** something. The reviewers answer it;',
    '   nobody rewrites it. Someone who asks a question wants it answered.',
    '',
    '   `prompt` — the artifact **is** a prompt someone intends to send to a',
    '   model, and they want it improved. Only choose this when improving the',
    '   wording is plainly the point; a bare question is `question`.',
    '',
    '   `plan` · `spec` · `review` · `idea` — a document to be improved on its',
    '   own terms. The debate makes it better; it does not answer it.',
    '2. `needs_draft` — whether the thing being judged exists yet.',
    '',
    '   `true` when the artifact only **asks** for it: a question, a request, a',
    '   task ("write a migration plan for X"). Every reviewer then produces it,',
    '   independently, and you are asked only whether their answers agree.',
    '',
    '   `false` when the artifact **is** the thing — a plan, a spec, a diff, a',
    '   prompt to improve. The debate improves it in place.',
    '3. `needs_workspace` — whether reviewers must open files, run commands, or',
    '   reach the network to settle these questions.',
    '',
    '   The artifact above is the **entire** input; there is no more of it. Answer',
    '   `true` only when the artifact points at something outside itself that has',
    '   to be inspected — a repository, a file, a command, a running system.',
    '   A self-contained question, idea, or passage of prose needs none of that,',
    '   whatever its subject, and answering `true` for one is expensive: it adds',
    '   roughly 10k tokens of tool definitions per reviewer per round and can',
    '   send an agent exploring a codebase that has nothing to do with the',
    '   question. Answer `true` when genuinely torn — not merely because the',
    '   subject sounds technical.',
    '4. `criteria` — what reviewers should judge the artifact against.',
    '',
    '   ⚠️ **Return an empty array whenever `needs_draft` is true.** Nobody has',
    '   written the thing yet, so there is nothing to judge; several agents are',
    '   about to produce it and their answers are compared, not scored. You do',
    '   not know the answer, it is not your job to know it, and a criterion',
    '   phrased as "does the answer correctly conclude X" is you deciding the',
    '   outcome before anyone has spoken. Do not write one.',
    '',
    '   You do not decide what is out of scope either. If the artifact narrows',
    '   its own scope it says so in its own words, and the reviewers read it',
    '   whole. Nothing you write here reaches them.',
    '',
    '   Otherwise — when the artifact already **is** the thing — three to six',
    '   questions specific to this artifact, not generic review advice. Every',
    '   one has to be answerable with what the reviewers will actually have: if',
    '   `needs_workspace` is false they have this prompt and their own',
    '   knowledge and nothing else, so do not ask for citations, links or dated',
    '   figures. A criterion nobody can satisfy is raised every round by every',
    '   reviewer, and the debate burns its whole budget on it.',
    '',
    ...NO_NARRATION,
    '# Response contract',
    '',
    ...contractLines(options.schema, 'consensus_criteria'),
  ].join('\n');
}

/**
 * Round 1 when the artifact only asks for something.
 *
 * ⚠️ The artifact comes first and unframed, because a model handed a question
 * answers it. Measured 2026-09-06: wrapped in "you are reviewing the artifact
 * below", three reviewers each returned five findings whose entire evidence
 * was a quote of the question — correctly, since a question is not an answer.
 * Everything Baya has to say waits until after the artifact.
 */
export function proposalPrompt(options: ProposalPromptOptions): string {
  const lines: string[] = [options.artifact.trim(), '', '---', ''];

  lines.push(
    'Answer the above, in full and in your own words. Several other AI agents',
    'are answering the same thing right now, separately; you will not see their',
    'answers and they will not see yours. Say what you actually think, including',
    'where you are unsure — a later round reconciles the differences.',
    '',
  );

  lines.push(
    ...workspaceLines(options.needsWorkspace, options.cwd, options.reviewerCount),
    '# How to answer',
    '',
    '`document` is your answer itself, as plain Markdown — not a plan to write',
    'one and not a description of what it would contain. Anything you are',
    'unsure of or deliberately left open goes in `notes`.',
    '',
    ...NO_NARRATION,
    '# Response contract',
    '',
    ...contractLines(options.schema, 'proposal_result'),
  );

  return lines.join('\n');
}

/**
 * Rounds 2+ of a producing run. Every answer so far, anonymised, and an
 * invitation to move or to hold — never an instruction to converge.
 */
export function revisePrompt(options: RevisePromptOptions): string {
  const lines: string[] = [options.artifact.trim(), '', '---', ''];

  lines.push(
    `Round ${String(options.round)}. You answered this already. Below is what you`,
    'said and what the others said, with names removed. Read them, then answer',
    'again.',
    '',
    'Change your answer where they have convinced you and say so. Hold it where',
    'they have not, and say why. Agreeing to agree is worth nothing here — an',
    'answer that stays put for a stated reason is a better outcome than one',
    'that moves to end the round.',
    '',
    ...asData('your answer', options.mine),
  );

  for (const other of options.others) {
    lines.push(...asData(other.alias, other.document));
  }

  if (options.differences.length > 0) {
    lines.push('The moderator reports you do not yet agree on:', '');
    for (const item of options.differences) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push(
    ...workspaceLines(options.needsWorkspace, options.cwd, options.reviewerCount),
    '# How to answer',
    '',
    '`document` is your answer in full, standing on its own — not a diff, not a',
    'list of what you changed. Why you moved or held goes in `notes`.',
    '',
    ...NO_NARRATION,
    '# Response contract',
    '',
    ...contractLines(options.schema, 'proposal_result'),
  );

  return lines.join('\n');
}

/**
 * The moderator's only question.
 *
 * ⚠️ It is not asked which answer is right, and it is not given a field to
 * say so. It does not know the answer to the job and it is not its job to
 * know: the reviewers produce, it reports whether they are on the same page.
 */
export function agreementPrompt(options: AgreementPromptOptions): string {
  const lines: string[] = [
    'Several AI agents were asked the same thing, separately. Below is what was',
    'asked and what each of them said. One question for you:',
    '',
    '**Are they saying the same thing?**',
    '',
    '# What you are not doing',
    '',
    'You are not answering this yourself, not deciding who is right, and not',
    'writing a combined version. You may well not know the answer — that is',
    'expected, and it does not stop you doing this job. Whether two answers',
    'agree is a different question from which one is correct, and only the',
    'first is yours.',
    '',
    'Judge substance, not style. Different wording, ordering, length or level',
    'of detail is still agreement: the test is whether someone acting on any',
    'one of these would end up in the same place. A different conclusion, a',
    'different recommendation, or a contradiction on something that matters is',
    'not agreement, however politely it is phrased.',
    '',
    ...asData('what was asked', options.artifact),
    '# The answers',
    '',
  ];

  for (const answer of options.answers) {
    lines.push(...asData(answer.alias, answer.document));
  }

  lines.push(
    ...workspaceLines(options.needsWorkspace, options.cwd, options.answers.length + 1),
    '# How to report',
    '',
    '`agreed` is true only if they say the same thing. If it is false, every',
    'point they split on goes in `differences`, one line each, stating what the',
    'disagreement **is** — not which side you would take. They see these lines',
    'next round and answer again, so a difference nobody can act on is wasted.',
    '',
    ...NO_NARRATION,
    '# Response contract',
    '',
    ...contractLines(options.schema, 'agreement_result'),
  );

  return lines.join('\n');
}

/**
 * ⚠️ The criteria are the moderator's own yardstick and appear in no reviewer
 * prompt. A rubric handed to every reviewer is a script: measured 2026-09-06,
 * three reviewers given the same five questions returned the same five
 * findings, which reads as agreement and is not.
 */
function criterionLines(criteria: ConsensusCriteria): string[] {
  return [
    '# Your criteria — yours alone',
    '',
    'The reviewers have never seen these. They worked from their own judgment,',
    'which is the point; weighing what came back against these is your job.',
    '',
    ...criteria.criteria.map(
      (criterion) => `- \`${criterion.id}\` — ${criterion.question}`,
    ),
    '',
    'Every `changes` entry names the one criterion it serves in `criterion_id`.',
    'A decision serving none of them is not yours to accept, and Baya discards',
    "it: a reviewer's own environment — a rules file, a memory file, a house",
    'style — produces findings that look exactly like the rest.',
    '',
  ];
}

/** The original request, kept in view once the document is a draft of it. */
function askLines(ask: string | null | undefined, label: string): string[] {
  const text = (ask ?? '').trim();
  if (text === '') return [];
  return ['# What was asked', '', ...asData(label, text)];
}

/** One reviewer, one round. It never learns who else is reviewing. */
export function reviewPrompt(options: ReviewPromptOptions): string {
  const lines: string[] = [];
  const first = options.round === 1;

  const seeded = (options.ask ?? '').trim() !== '';

  if (first && seeded) {
    lines.push(
      'Below is what was asked, and a first draft of the answer to it. The draft',
      'is a starting point nobody has defended yet — test it, do not defer to it.',
      'Other agents are reviewing it too, separately, and you will not see their',
      'work. Find what they might miss.',
      '',
      `Round ${String(options.round)}.`,
      '',
    );
  } else {
    lines.push(
      first
        ? 'You are reviewing the artifact below. Other agents are reviewing it too,'
        : 'You are reviewing an updated draft of an artifact you have seen before.',
      first
        ? 'separately, and you will not see their work. Find what they might miss.'
        : "Other agents reviewed it too. A moderator merged everyone's findings.",
      '',
      `Round ${String(options.round)}.`,
      '',
    );
  }

  lines.push(
    ...askLines(options.ask, 'request'),
    ...asData(
      seeded ? 'current draft' : first ? 'artifact' : 'artifact (current draft)',
      options.artifact,
    ),
  );

  if (!first && (options.ledger ?? '').trim() !== '') {
    lines.push(
      '# Where you left off',
      '',
      'This is your own record: what you argued last round and what the moderator',
      'did with each point. Rival findings are shown under stable labels — you are',
      'not told which agent produced them, and their argument is what matters.',
      '',
      ...asData('your record', options.ledger ?? ''),
      'Defend what still stands, concede what does not, and raise what the new',
      'draft introduced. Repeating a point that was accepted and applied is noise.',
      '',
    );
  }

  lines.push(
    ...workspaceLines(options.needsWorkspace, options.cwd, options.reviewerCount),
    '# How to report',
    '',
    'Every finding needs `evidence` — a quoted line, a file you read, a command',
    'you ran. A claim with no evidence is an opinion, and the moderator has no',
    "way to weigh it against anyone else's.",
    '',
    'Severity means what it says: `blocker` stops the work, `major` needs fixing,',
    '`minor` is worth doing, `nit` is taste. Inflating severity to be heard does',
    'not work — it only keeps the debate open for another paid round.',
    '',
    'Judge the draft on its own terms and on what it is for. Any house style,',
    'formatting convention, or standing instruction from the environment you',
    'happen to be running in — a rules file, a memory file, a project',
    'convention — belongs to that project, not to this document.',
    '',
    'Something you cannot settle with what you have here is not a blocker and',
    'not a major. Say so once at `minor` and move on. Demanding evidence nobody',
    'in this run can obtain does not produce it; it just spends another round.',
    '',
    'An empty `findings` array is a valid answer. Do not manufacture findings.',
    '',
    ...NO_NARRATION,
    '# Response contract',
    '',
    ...contractLines(options.schema, 'critique_result'),
  );

  return lines.join('\n');
}

/** The moderator merges every reviewer's findings into one updated document. */
export function reconcilePrompt(options: ReconcilePromptOptions): string {
  const lines: string[] = [];

  lines.push(
    'You are moderating a review. Below is the artifact and what every reviewer',
    'said about it. Your job is to carry their work into the document.',
    '',
    `Round ${String(options.round)}.`,
    '',
    '# You have no view of your own',
    '',
    'You are not a reviewer and you are not the author. You do not answer the',
    'question the artifact poses, you do not improve what nobody objected to,',
    'and you do not add a point of your own however obvious it seems. If a',
    'problem is real and no reviewer raised it, it waits for a reviewer to',
    'raise it — that is what the next round is for.',
    '',
    'Every entry in `changes` must cite the `finding_ids` it came from. A change',
    'citing nothing is you talking, and Baya reports it as such.',
    '',
    'Judge each finding on its `evidence`, not on which reviewer sent it.',
    '',
  );

  const answering = options.criteria.artifact_kind === 'question';
  lines.push(
    ...askLines(options.ask, answering ? 'question' : 'request'),
    ...asData(
      (options.ask ?? '').trim() !== ''
        ? 'current draft'
        : answering
          ? 'question and answer so far'
          : 'artifact (current draft)',
      options.artifact,
    ),
  );

  if (answering) {
    lines.push(
      '# What `document` is here',
      '',
      'The **answer** to the question, written from what the reviewers said —',
      'not the question, and not a rewording of it. Where they agree, say it',
      'plainly; where they genuinely disagree, the answer says so rather than',
      'picking a side.',
      '',
    );
  }

  if ((options.ledger ?? '').trim() !== '') {
    lines.push(
      '# What you decided before',
      '',
      'Your own record. Do not silently reverse an earlier decision — if you now',
      'think it was wrong, say so in the rationale.',
      '',
      ...asData('your record', options.ledger ?? ''),
    );
  }

  lines.push('# Findings', '');
  for (const critique of options.critiques) {
    lines.push(`## ${critique.provider}`, '');
    if (critique.position.trim() !== '') {
      lines.push(...asData('position', critique.position));
    }
    if (critique.findings.length === 0) {
      lines.push('No findings raised.', '');
      continue;
    }
    for (const finding of critique.findings) {
      lines.push(
        `- \`${finding.id}\` (${finding.severity}) ${finding.claim}`,
        `  evidence: ${finding.evidence || '(none given)'}`,
        ...(finding.suggestion ? [`  suggestion: ${finding.suggestion}`] : []),
        ...(finding.location ? [`  location: ${finding.location}`] : []),
      );
    }
    lines.push('');
  }

  lines.push(
    ...workspaceLines(options.needsWorkspace, options.cwd, options.critiques.length + 1),
    '# How to decide',
    '',
    'Group findings that make the same point into one `changes` entry, whoever',
    'raised them — that grouping is how agreement gets counted, so do not split',
    'one point across several entries or merge two different ones.',
    '',
    'Apply an accepted finding using its own `claim` and `suggestion`. Where a',
    'wording is not given you may write the minimum needed to carry the point,',
    'and nothing beyond it.',
    '',
    'Every entry needs a `rationale`. The reviewer who raised it reads yours next',
    'round; a bare verdict gives them nothing to update on.',
    '',
    'A finding you reject is still a decision — record it with `rejected` and say',
    'why. Anything genuinely unsettled goes in `unresolved`, not quietly dropped.',
    '',
    'A finding asking for evidence no reviewer in this run can obtain belongs in',
    '`unresolved`. Accepting it again every round, and watching it come back,',
    'is how a debate spends its whole budget on one unanswerable point.',
    '',
    ...criterionLines(options.criteria),
    '`document` is the complete updated artifact, not a patch and not a summary',
    'of your edits.',
    '',
    ...NO_NARRATION,
    '# Response contract',
    '',
    ...contractLines(options.schema, 'reconcile_result'),
  );

  return lines.join('\n');
}

/**
 * Tier-2 compaction (§3.2). The caller asserts every id in `ids` survives; a
 * compaction that loses one is discarded, so the instruction says so plainly.
 */
export function compactPrompt(options: CompactPromptOptions): string {
  return [
    "Shorten one reviewer's record of a debate. It is fed back to that reviewer",
    'so it can remember the position it took.',
    '',
    `Target: under ${String(options.budget)} characters.`,
    '',
    ...asData('record', options.ledger),
    '# Rules',
    '',
    'Every finding id below must still appear, with its verdict intact. A record',
    'that drops one is discarded and this call is wasted.',
    '',
    ...options.ids.map((id) => `- \`${id}\``),
    '',
    'Shorten the reasoning, never the positions. Do not soften a finding you',
    'disagreed with, and do not add anything that was not already there.',
    '',
    'Output the shortened record as plain Markdown. No JSON, no preamble.',
  ].join('\n');
}

/** Severity order for rendering, worst first. */
export const SEVERITY_ORDER: readonly FindingSeverity[] = [
  'blocker',
  'major',
  'minor',
  'nit',
];

/** Distinct providers behind a change — the agreement count (§4). */
export function agreementOf(change: Change): string[] {
  const providers = new Set<string>();
  for (const id of change.finding_ids) {
    const provider = id.includes(':') ? id.slice(0, id.indexOf(':')) : '';
    if (provider !== '') providers.add(provider);
  }
  return [...providers].sort();
}
