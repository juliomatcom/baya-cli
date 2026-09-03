import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { pageMetadata } from '@/app/lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'FAQ – Baya',
  description:
    'Answers to the common questions about Baya: why not just use one CLI, whether it saves money, whether you need API keys, and whether parallel runs are safe.',
  path: '/faq',
});

/**
 * The four README FAQ pairs. `question` and `answerText` are plain strings that
 * feed the FAQPage JSON-LD verbatim; `answer` is the richer markup rendered on
 * the page. Keep the two in sync when either side changes.
 */
type FaqEntry = {
  id: string;
  question: string;
  answerText: string;
  answer: ReactNode;
};

const FAQ: FaqEntry[] = [
  {
    id: 'why-not-one-cli',
    question: "Why not just use one CLI's built-in agent?",
    answerText:
      'Because you probably pay for more than one, and they are good at different things. Baya lets a task list say "plan with one, build with another" and handles the plumbing.',
    answer: (
      <p>
        Because you probably pay for more than one, and they are good at
        different things. Baya lets a task list say “plan with one, build with
        another” and handles the plumbing.
      </p>
    ),
  },
  {
    id: 'save-money',
    question: 'Can this save me money?',
    answerText:
      'Yes, three ways. A task list picks the model per task, so the light steps run on a cheap model while the expensive ones are reserved for work that earns them. Baya also spawns as few agent processes as it can: tasks that share a provider, model, permission level and directory go into one process and are worked through in order, so the repo is read and oriented once instead of from scratch per task. What grouping cannot cover — a task on a different model, or one needing different permissions — is covered by memory: what earlier tasks found is derived from the providers’ own logs and handed forward, so nobody pays twice to discover the same thing. You are still spending under subscriptions you already pay for. Both grouping and memory are on by default: --group-size 1 gives every task its own process, --no-memory starts every task blind.',
    answer: (
      <>
        <p>Yes, three ways.</p>
        <p>
          A task list picks the model <em>per task</em>, so the light steps run
          on a cheap model (<code>luna</code>, <code>terra</code>) while the
          expensive ones are reserved for work that earns them.
        </p>
        <p>
          Then Baya spawns as few agent processes as it can. Tasks that share a
          provider, model, permission level and directory go into{' '}
          <strong>one</strong> process and are worked through in order — a whole
          layer of independent tasks, or a chain where each step builds on the
          last. That process reads <code>package.json</code> once, orients itself
          once, and keeps its context across the tasks, instead of every task
          paying for that from scratch.
        </p>
        <p>
          What grouping can’t cover — a task on a different model, or one that
          needs different permissions — is covered by memory: what earlier tasks
          found (which commands work, which fail, which files changed) is derived
          from the providers’ own logs and handed to later tasks, so nobody pays
          twice to discover the same thing.
        </p>
        <p>
          You are still spending under subscriptions you already pay for. Both
          are on by default: <code>--group-size 1</code> gives every task its own
          process, <code>--no-memory</code> starts every task blind.
        </p>
      </>
    ),
  },
  {
    id: 'api-keys',
    question: 'Does this need API keys?',
    answerText:
      'No. It drives locally installed CLIs under whatever subscription you already have.',
    answer: (
      <p>
        No. It drives locally installed CLIs under whatever subscription you
        already have.
      </p>
    ),
  },
  {
    id: 'parallel-safe',
    question: 'Is it safe to run in parallel?',
    answerText:
      'Tasks the planner marked read-only run concurrently; anything read-write is serialized by the scheduler. access is about what a task needs permission to do, not what it edits — a task that only runs the test suite is read-write, because a runner that cannot write its cache cannot run. One Baya runs per directory: a second is refused rather than left to fight over the same files. To run two task lists against one repo, give each its own git worktree.',
    answer: (
      <>
        <p>
          Tasks the planner marked <code>read-only</code> run concurrently;
          anything <code>read-write</code> is serialized by the scheduler.{' '}
          <code>access</code> is about what a task needs permission to{' '}
          <em>do</em>, not what it edits — a task that only runs the test suite
          is <code>read-write</code>, because a runner that cannot write its
          cache cannot run.
        </p>
        <p>
          One Baya runs per directory — a second is refused rather than left to
          fight over the same files. To run two task lists against one repo, give
          each its own <code>git worktree</code>.
        </p>
      </>
    ),
  },
];

const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map((entry) => ({
    '@type': 'Question',
    name: entry.question,
    acceptedAnswer: {
      '@type': 'Answer',
      text: entry.answerText,
    },
  })),
};

export default function FaqPage() {
  return (
    <main className="bg-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(faqJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <section className="mx-auto max-w-3xl px-6 py-16 md:py-20">
        <p className="font-mono text-sm font-semibold uppercase tracking-[0.25em] text-accent">
          FAQ
        </p>
        <h1 className="mt-4 text-4xl font-bold sm:text-5xl">
          Questions people ask
        </h1>
        <p className="mt-6 text-lg text-slate-600">
          Why Baya sits alongside the CLIs you already run, what it does for your
          bill, and how it keeps a parallel run from stepping on itself.
        </p>

        <div className="mt-12 space-y-10">
          {FAQ.map((entry) => (
            <section
              key={entry.id}
              aria-labelledby={entry.id}
              className="border-t border-slate-200 pt-8 first:border-t-0 first:pt-0"
            >
              <h2
                id={entry.id}
                className="text-xl font-bold text-slate-900 sm:text-2xl"
              >
                {entry.question}
              </h2>
              <div className="mt-4 space-y-4 text-slate-600 [&_p]:leading-relaxed">
                {entry.answer}
              </div>
            </section>
          ))}
        </div>
      </section>
    </main>
  );
}
