import CopyCodeBlock from '@/app/components/CopyCodeBlock';
import { SectionHeading } from './shared';

export default function QuickStart() {
  return (
    <section aria-labelledby="quickstart" className="space-y-4">
      <SectionHeading id="quickstart">Quick start</SectionHeading>
      <p className="text-slate-600">
        Point Baya at any plain-text list of tasks. It plans, shows you the
        graph, and waits for your approval before running anything.
      </p>
      <CopyCodeBlock code="baya ./tasks.md" />
      <p className="text-slate-600">
        To see the plan without running it, use <code>baya plan</code> or{' '}
        <code>--dry-run</code>. To run unattended, review a captured manifest
        first, then execute it:
      </p>
      <CopyCodeBlock code="baya plan tasks.md --plan-out plan.json" />
      <CopyCodeBlock code="baya run tasks.md --plan-in plan.json --yes" />
    </section>
  );
}
