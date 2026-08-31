import {
  descendantsOf,
  readySet,
  topoLayers,
  topoOrder,
} from '../../../src/graph/index.js';

const node = (id: string, depends_on: string[] = []) => ({ id, depends_on });

describe('topoLayers', () => {
  it('puts a linear chain in one node per layer', () => {
    expect(topoLayers([node('a'), node('b', ['a']), node('c', ['b'])])).toEqual([
      ['a'],
      ['b'],
      ['c'],
    ]);
  });

  it('layers a diamond so the join waits for both branches', () => {
    expect(
      topoLayers([node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c'])]),
    ).toEqual([['a'], ['b', 'c'], ['d']]);
  });

  it('interleaves disconnected components by depth, not by component', () => {
    expect(
      topoLayers([node('a1'), node('a2', ['a1']), node('b1'), node('b2', ['b1'])]),
    ).toEqual([
      ['a1', 'b1'],
      ['a2', 'b2'],
    ]);
  });

  it('preserves manifest order within a layer so a plan renders identically each run', () => {
    expect(topoLayers([node('z'), node('m'), node('a')])).toEqual([['z', 'm', 'a']]);
  });

  it('returns a flat order via topoOrder', () => {
    expect(topoOrder([node('a'), node('b', ['a']), node('c', ['a'])])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('truncates rather than looping on a cycle validation should have caught', () => {
    expect(topoLayers([node('a', ['b']), node('b', ['a'])])).toEqual([]);
  });
});

describe('readySet', () => {
  const nodes = [node('a'), node('b', ['a']), node('c', ['a']), node('d', ['b', 'c'])];

  it('admits only roots when nothing has run', () => {
    const states = new Map(nodes.map((n) => [n.id, 'pending' as const]));
    expect(readySet(nodes, states)).toEqual(['a']);
  });

  it('admits both branches once the root succeeds', () => {
    const states = new Map([
      ['a', 'succeeded' as const],
      ['b', 'pending' as const],
      ['c', 'pending' as const],
      ['d', 'pending' as const],
    ]);
    expect(readySet(nodes, states)).toEqual(['b', 'c']);
  });

  it('holds a join until every dependency succeeds', () => {
    const states = new Map([
      ['a', 'succeeded' as const],
      ['b', 'succeeded' as const],
      ['c', 'running' as const],
      ['d', 'pending' as const],
    ]);
    expect(readySet(nodes, states)).toEqual([]);
  });

  it('never admits a task whose dependency failed', () => {
    const states = new Map([
      ['a', 'failed' as const],
      ['b', 'pending' as const],
      ['c', 'pending' as const],
      ['d', 'pending' as const],
    ]);
    expect(readySet(nodes, states)).toEqual([]);
  });
});

describe('descendantsOf', () => {
  const nodes = [
    node('a'),
    node('b', ['a']),
    node('c', ['b']),
    node('independent'),
    node('also-independent', ['independent']),
  ];

  it('returns every transitive dependent', () => {
    expect(descendantsOf(nodes, 'a')).toEqual(new Set(['b', 'c']));
  });

  it('leaves an independent branch untouched — that is what keeps a failure local', () => {
    expect(descendantsOf(nodes, 'a')).not.toContain('independent');
  });

  it('is empty for a leaf', () => {
    expect(descendantsOf(nodes, 'c').size).toBe(0);
  });

  it('does not loop on a diamond reachable by two paths', () => {
    const diamond = [
      node('a'),
      node('b', ['a']),
      node('c', ['a']),
      node('d', ['b', 'c']),
    ];
    expect(descendantsOf(diamond, 'a')).toEqual(new Set(['b', 'c', 'd']));
  });
});
