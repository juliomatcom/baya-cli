import { buildRunChoices } from '../../../src/ui/index.js';
import type { RunRow } from '../../../src/executor/index.js';

function row(overrides: Partial<RunRow> = {}): RunRow {
  return {
    run_id: '20260830T090000Z-aaa-1',
    source_path: 'tasks.md',
    started_at: '2026-08-30T09:00:00.000Z',
    status: 'failed',
    totals: {
      succeeded: 2,
      failed: 1,
      skipped: 3,
      parked: 0,
      pending: 0,
      running: 0,
    },
    damaged: false,
    resumable: true,
    ...overrides,
  };
}

describe('buildRunChoices', () => {
  it('offers one choice per run, valued by run id', () => {
    const choices = buildRunChoices([row(), row({ run_id: 'other' })]);
    expect(choices.map((choice) => choice.value)).toEqual([
      '20260830T090000Z-aaa-1',
      'other',
    ]);
  });

  it('counts everything unfinished as work left, not just the failures', () => {
    const [choice] = buildRunChoices([row()]);
    expect(choice?.name).toContain('4 left');
  });

  it('says so rather than inventing a count for a damaged run', () => {
    const [choice] = buildRunChoices([row({ totals: null, status: 'damaged' })]);
    expect(choice?.name).toContain('unknown');
  });
});
