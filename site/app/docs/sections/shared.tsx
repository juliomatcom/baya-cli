import { GITHUB_URL } from '@/app/lib/site';

/** Base URL for the source-of-truth wiki pages, linked from most sections. */
export const WIKI_URL = `${GITHUB_URL}/blob/main/wiki-llm`;

export function SectionHeading({
  id,
  children,
}: {
  id: string;
  children: string;
}) {
  return (
    <h2 id={id} className="scroll-mt-24 text-2xl font-bold text-slate-900">
      {children}
    </h2>
  );
}
