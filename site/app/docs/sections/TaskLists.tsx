import CopyCodeBlock from '@/app/components/CopyCodeBlock';
import { SectionHeading } from './shared';

const MARKDOWN_EXAMPLE = `# Ship the orders endpoint

- Design the REST API for orders — list, get, create, and cancel.
  Define pagination, the error response shapes, and an idempotency
  key on create. Write it up as an OpenAPI document. Use Sonnet.
- Generate the Postgres schema and migrations from that design.
- Build the React table that consumes the list endpoint: sortable
  columns, a status filter, and empty and loading states. Run with codex.
- Once the schema and UI are done, write integration tests that
  exercise every endpoint against a throwaway database.`;

const TODO_EXAMPLE = `1 Design the REST API for orders (list, get, create, cancel) with pagination, error shapes, and an idempotency key on create. Use Sonnet.
2 Generate the Postgres schema and migrations from that design.
3 Build the sortable, filterable React table that consumes the list endpoint. Run with codex.
4 Once the schema and UI are done, write integration tests for every endpoint.`;

const YAML_EXAMPLE = `- id: design-api
  task: |
    Design the REST API for orders — list, get, create, cancel.
    Define pagination, error response shapes, and an idempotency
    key on create. Write it up as an OpenAPI document. Use Sonnet.
- id: gen-schema
  task: Generate the Postgres schema and migrations from that design.
  depends_on: [design-api]
- id: build-ui
  task: Build the React table that consumes the list endpoint. Run with codex.
  depends_on: [gen-schema]
- id: tests
  task: Write integration tests for every endpoint.
  depends_on: [gen-schema, build-ui]`;

export default function TaskLists() {
  return (
    <section aria-labelledby="task-lists" className="space-y-4">
      <SectionHeading id="task-lists">Writing task lists</SectionHeading>
      <p className="text-slate-600">
        Any UTF-8 text file works. Baya never parses these structurally — the
        planner reads every format for intent, so <code>depends_on:</code> and
        plain prose like “once the schema and UI are done” get you the same
        graph.
      </p>
      <div className="card border-l-4 border-l-accent p-5 text-sm text-slate-600">
        <strong className="text-slate-900">
          A task is as long as it needs to be.
        </strong>{' '}
        A single item can run for several sentences and wrap across indented
        lines, spelling out constraints and acceptance criteria — the planner
        treats the whole item as one task. This site’s own build list is written
        exactly that way, one paragraph-long task per bullet.
      </div>

      <h3 className="pt-2 text-lg font-bold text-slate-900">Markdown</h3>
      <p className="text-sm text-slate-600">
        A heading for the goal, one bullet per task — each bullet as long as the
        task needs. Wrapped continuation lines are indented under the bullet.
      </p>
      <CopyCodeBlock code={MARKDOWN_EXAMPLE} />

      <h3 className="pt-2 text-lg font-bold text-slate-900">A bare TODO.txt</h3>
      <p className="text-sm text-slate-600">
        One task per line, numbered or not. The line itself can be as detailed as
        you like.
      </p>
      <CopyCodeBlock code={TODO_EXAMPLE} />

      <h3 className="pt-2 text-lg font-bold text-slate-900">YAML</h3>
      <p className="text-sm text-slate-600">
        The same intent, with explicit <code>depends_on</code> if you think
        better that way. Use a <code>|</code> block scalar for a multi-line{' '}
        <code>task:</code>.
      </p>
      <CopyCodeBlock code={YAML_EXAMPLE} />
      <p className="text-sm text-slate-500">
        If the planner can’t produce a graph, a deterministic splitter falls back
        to a linear chain in the order you wrote the tasks.
      </p>
    </section>
  );
}
