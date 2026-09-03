'use client';

import { useRef, useState } from 'react';

type Segment = { text: string; className?: string };

type Command = {
  label: string;
  labelClassName: string;
  copyText: string;
  segments: Segment[];
};

// Colors mirror the CLI's own terminal palette: teal/pink section labels, a
// dim `$` prompt, the green binary name, and a highlighted argument.
const COMMANDS: Command[] = [
  {
    label: 'USAGE:',
    labelClassName: 'text-teal-300',
    copyText: 'baya <path-to-task-file>',
    segments: [
      { text: '$ ', className: 'text-slate-500' },
      { text: 'baya ', className: 'text-green-400' },
      { text: '<path-to-task-file>', className: 'text-amber-300' },
    ],
  },
  {
    label: 'HELP:',
    labelClassName: 'text-pink-300',
    copyText: 'baya -h',
    segments: [
      { text: '$ ', className: 'text-slate-500' },
      { text: 'baya ', className: 'text-green-400' },
      { text: '-h', className: 'text-cyan-300' },
    ],
  },
];

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-live="polite"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-700 px-3 py-1.5 font-sans text-xs font-semibold text-slate-300 transition-colors hover:border-slate-500 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export default function UsageTerminal() {
  return (
    <div className="terminal-window mx-auto max-w-xl bg-ink text-left">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <span className="terminal-dot bg-[#ff5f56]" />
        <span className="terminal-dot bg-[#ffbd2e]" />
        <span className="terminal-dot bg-[#27c93f]" />
        <span className="flex-1 text-center font-mono text-xs text-slate-500">
          Baya-cli
        </span>
        <span className="w-12" aria-hidden="true" />
      </div>

      <div className="px-5 py-4 font-mono text-sm">
        {COMMANDS.map((command, index) => (
          <div
            key={command.label}
            className={`flex items-center gap-4 ${
              index > 0 ? 'mt-3 border-t border-white/10 pt-3' : ''
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className={`text-xs font-bold ${command.labelClassName}`}>
                {command.label}
              </div>
              <div className="mt-1 overflow-x-auto whitespace-nowrap">
                {command.segments.map((segment) => (
                  <span key={segment.text} className={segment.className}>
                    {segment.text}
                  </span>
                ))}
              </div>
            </div>
            <CopyButton text={command.copyText} />
          </div>
        ))}
      </div>
    </div>
  );
}
