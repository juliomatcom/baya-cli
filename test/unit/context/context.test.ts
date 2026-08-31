import {
  assembleContext,
  budgetFrom,
  truncateMiddle,
  type Upstream,
} from '../../../src/context/index.js';

const upstream = (overrides: Partial<Upstream> = {}): Upstream => ({
  taskId: 'design-api',
  title: 'Design the API',
  status: 'ok',
  summary: 'Defined 6 REST endpoints.',
  resultPath: '/abs/.baya/runs/r/tasks/design-api/result.json',
  outputPath: '/abs/.baya/runs/r/tasks/design-api/output.md',
  output: 'short output',
  ...overrides,
});

describe('budgetFrom', () => {
  it('makes the per-edge cap half the total', () => {
    expect(budgetFrom(12_000)).toEqual({ total: 12_000, perEdge: 6_000 });
  });
});

describe('assembleContext', () => {
  it('always carries the summary and both absolute paths', () => {
    const [entry] = assembleContext([upstream()]);
    expect(entry).toMatchObject({
      task_id: 'design-api',
      summary: 'Defined 6 REST endpoints.',
      result_path: '/abs/.baya/runs/r/tasks/design-api/result.json',
      output_path: '/abs/.baya/runs/r/tasks/design-api/output.md',
    });
  });

  it('inlines a small upstream under link-only', () => {
    const [entry] = assembleContext([upstream()]);
    expect(entry?.inline).toBe('short output');
  });

  it('links a 200 KB upstream instead of inlining it', () => {
    const [entry] = assembleContext([upstream({ output: 'x'.repeat(200_000) })]);
    expect(entry?.inline).toBeNull();
    expect(entry?.output_path).toContain('output.md');
  });

  it('truncates head-and-tail with an elision marker under truncate', () => {
    const [entry] = assembleContext([upstream({ output: 'x'.repeat(200_000) })], {
      strategy: 'truncate',
      budget: budgetFrom(1_000),
    });
    expect(entry?.inline).not.toBeNull();
    expect(entry?.inline?.length).toBeLessThanOrEqual(500);
    expect(entry?.inline).toContain('characters elided');
  });

  it('spends the total budget across edges, then links the rest', () => {
    const upstreams = Array.from({ length: 5 }, (_, index) =>
      upstream({ taskId: `up-${index}`, output: 'y'.repeat(3_000) }),
    );
    const entries = assembleContext(upstreams, { budget: budgetFrom(12_000) });
    const inlined = entries.filter((entry) => entry.inline !== null);
    expect(inlined).toHaveLength(4);
    expect(entries[4]?.inline).toBeNull();
  });

  it('links an empty upstream rather than inlining an empty string', () => {
    const [entry] = assembleContext([upstream({ output: '' })]);
    expect(entry?.inline).toBeNull();
  });
});

describe('truncateMiddle', () => {
  it('returns the text unchanged when it fits', () => {
    expect(truncateMiddle('hello', 100)).toBe('hello');
  });

  it('keeps both ends and stays within the limit', () => {
    const text = `START${'m'.repeat(5_000)}END`;
    const out = truncateMiddle(text, 400);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out.startsWith('START')).toBe(true);
    expect(out.endsWith('END')).toBe(true);
  });
});

describe('truncateMiddle stays within budget at every limit', () => {
  // The elision marker's own length depends on the number it reports, so the
  // slice size has to be solved for rather than computed once. Sweeping the
  // limits is the only way to catch an off-by-one in that loop.
  const text = 'abcdefghij'.repeat(1_000);
  const limits = Array.from({ length: 60 }, (_, index) => 60 + index);

  it.each(limits)('never exceeds a limit of %i', (limit) => {
    expect(truncateMiddle(text, limit).length).toBeLessThanOrEqual(limit);
  });

  it('clips to the limit even when there is no room for the marker itself', () => {
    expect(truncateMiddle(text, 10)).toHaveLength(10);
  });
});
