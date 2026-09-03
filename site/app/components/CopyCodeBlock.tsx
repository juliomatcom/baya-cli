'use client';

import { useEffect, useRef, useState } from 'react';

type CopyCodeBlockProps = {
  code: string;
  /**
   * Wrap long lines instead of scrolling them. On by default for the
   * multi-line task-list examples; pass `false` for single-line commands that
   * should stay on one line (and scroll if the container is too narrow).
   */
  wrap?: boolean;
};

const COPIED_DURATION_MS = 1500;

export default function CopyCodeBlock({
  code,
  wrap = true,
}: CopyCodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  async function copyCode() {
    await navigator.clipboard.writeText(code);
    setCopied(true);

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      setCopied(false);
      timeoutRef.current = null;
    }, COPIED_DURATION_MS);
  }

  return (
    <div className="flex items-center gap-3 overflow-hidden rounded-lg bg-ink px-4 py-3 text-sm text-slate-200">
      <pre
        className={`min-w-0 flex-1 overflow-x-auto font-mono ${
          wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
        }`}
      >
        <code>{code}</code>
      </pre>
      <button
        type="button"
        onClick={copyCode}
        className="shrink-0 rounded border border-slate-600 px-3 py-1.5 font-sans text-xs font-semibold text-slate-200 transition-colors hover:border-slate-400 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        aria-live="polite"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
