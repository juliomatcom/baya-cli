/**
 * Mermaid diagram sources, authored the same as in the repo's wiki and specs so
 * the two stay in sync. Rendered by `app/components/Mermaid.tsx`.
 */

export const RUN_DIAGRAM = `flowchart TB
    MD["tasks.md: freeform text"] --> P["Planner: an LLM CLI"]
    P -->|JSON manifest| V{"Validate: schema, cycles, deps"}
    V -->|invalid| R["Repair once, then linear fallback"]
    R --> V
    V -->|valid| G["DAG: topological layers"]
    G --> GATE{"Preview and confirm"}
    GATE -->|approved| S["Scheduler: budgets, single write-lock"]
    S --> GRP["Group: same provider, model, access, cwd"]
    GRP --> PROC["Agent processes: several tasks each, in order"]
    PROC --> AD["Provider adapters: argv, prompt delivery, event parsing"]
    AD --> CLIS["codex / claude / opencode / copilot"]
    CLIS --> RES{"task_result JSON"}
    RES -->|ok| BUS["Context bus: feeds dependents and later tasks"]
    RES -->|needs_input| ASK["Bubble the question"]
    RES -->|failed| REC["Classify failure, mark resumable"]
    BUS --> S
    BUS --> OUT["Report: outcomes, flagged notes, resume command"]
    ASK --> OUT
    REC --> OUT`;

// Technical version — used in the docs.
export const CONSENSUS_DIAGRAM = `flowchart TB
    ART["artifact: a file or a prompt"] --> P0["Moderator pass 0: classify, write criteria, pick access posture"]
    P0 --> ROUND{"Round N: fan out to reviewers, in parallel and blind"}
    ROUND --> RA["Reviewer A"]
    ROUND --> RB["Reviewer B"]
    ROUND --> RC["Reviewer C"]
    RA --> MERGE["Moderator: reconcile findings into a new draft"]
    RB --> MERGE
    RC --> MERGE
    MERGE --> CONV{"any blocker or major finding, and rounds left?"}
    CONV -->|yes| ROUND
    CONV -->|no| OUT["Final document, rejected findings, unresolved disagreements"]`;

// Plain-language version — used on the /consensus marketing page.
export const CONSENSUS_DIAGRAM_SIMPLE = `flowchart TB
    ART["Your spec, diff, or question"] --> P0["A moderator frames the review and decides what to check for"]
    P0 --> ROUND{"Each model reviews it on its own — no peeking at the others"}
    ROUND --> RA["Model A"]
    ROUND --> RB["Model B"]
    ROUND --> RC["Model C"]
    RA --> MERGE["The moderator merges their feedback into a new draft"]
    RB --> MERGE
    RC --> MERGE
    MERGE --> CONV{"Still something important to fix?"}
    CONV -->|yes, review the new draft| ROUND
    CONV -->|no| OUT["You get the final version, plus anything the models could not agree on"]`;
