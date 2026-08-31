import { buildRunRow, selectRuns } from '../../../src/executor/runs.js';

/**
 * Row construction is pure and total: every input yields a row, and a
 * checkpoint that cannot be read yields a `damaged` row rather than an
 * exception.
 */
function state(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    run_id: '20260830T120000Z-aaaaaa-1',
    status: 'paused',
    started_at: '2026-08-30T12:00:00.000Z',
    source: { path: 'tasks.md', sha256: 'abc' },
    totals: {
      succeeded: 2,
      failed: 0,
      skipped: 0,
      parked: 1,
      pending: 0,
      running: 0,
    },
    ...overrides,
  });
}

describe('buildRunRow', () => {
  it('pulls id, source, start time, status and totals from a healthy state.json', () => {
    const row = buildRunRow('dir-id', state());
    expect(row).toEqual({
      run_id: '20260830T120000Z-aaaaaa-1',
      source_path: 'tasks.md',
      started_at: '2026-08-30T12:00:00.000Z',
      status: 'paused',
      totals: { succeeded: 2, failed: 0, skipped: 0, parked: 1, pending: 0, running: 0 },
      damaged: false,
      resumable: true,
    });
  });

  it('marks completed runs not resumable', () => {
    expect(buildRunRow('d', state({ status: 'completed' })).resumable).toBe(false);
  });

  it.each(['running', 'paused', 'failed', 'interrupted'])(
    'treats %s as resumable',
    (status) => {
      expect(buildRunRow('d', state({ status })).resumable).toBe(true);
    },
  );

  it('falls back to the directory id when the file omits run_id', () => {
    const row = buildRunRow('dir-id', state({ run_id: undefined }));
    expect(row.run_id).toBe('dir-id');
    expect(row.damaged).toBe(false);
  });

  it('returns a damaged row for a truncated file, without throwing', () => {
    const truncated = state().slice(0, 40);
    const row = buildRunRow('dir-id', truncated);
    expect(row).toMatchObject({ run_id: 'dir-id', status: 'damaged', damaged: true });
    expect(row.resumable).toBe(false);
    expect(row.totals).toBeNull();
  });

  it('returns a damaged row for text that is not JSON', () => {
    expect(buildRunRow('d', 'not json at all').damaged).toBe(true);
  });

  it('returns a damaged row for JSON that carries no recognizable status', () => {
    expect(buildRunRow('d', JSON.stringify({ hello: 'world' })).damaged).toBe(true);
    expect(buildRunRow('d', state({ status: 'teleported' })).damaged).toBe(true);
  });

  it('defaults missing total fields to zero rather than dropping the row', () => {
    const row = buildRunRow('d', state({ totals: { succeeded: 1 } }));
    expect(row.totals).toEqual({
      succeeded: 1,
      failed: 0,
      skipped: 0,
      parked: 0,
      pending: 0,
      running: 0,
    });
  });
});

describe('selectRuns', () => {
  it('keeps damaged and resumable rows, drops completed, newest first', () => {
    const rows = [
      buildRunRow('20260830T090000Z-a-1', state({ run_id: '20260830T090000Z-a-1' })),
      buildRunRow(
        '20260830T100000Z-b-1',
        state({ run_id: '20260830T100000Z-b-1', status: 'completed' }),
      ),
      buildRunRow('20260830T110000Z-c-1', 'truncated{'),
      buildRunRow(
        '20260830T080000Z-d-1',
        state({ run_id: '20260830T080000Z-d-1', status: 'failed' }),
      ),
    ];
    expect(selectRuns(rows).map((row) => row.run_id)).toEqual([
      '20260830T110000Z-c-1',
      '20260830T090000Z-a-1',
      '20260830T080000Z-d-1',
    ]);
  });
});
