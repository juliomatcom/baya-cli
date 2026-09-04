import {
  GLYPHS,
  createTheme,
  machineTheme,
  type StatusToken,
} from '../../../src/ui/theme.js';

const STATUS_TOKENS: StatusToken[] = [
  'ok',
  'fail',
  'skip',
  'park',
  'run',
  'pending',
  'warn',
  'action',
  'note',
];

describe('theme', () => {
  describe("color off (createTheme('never'))", () => {
    const off = createTheme('never');

    it('level is 0', () => {
      expect(off.level).toBe(0);
    });

    it('renders every status token with its glyph, no ANSI, matching the cli.md table', () => {
      const rendered = Object.fromEntries(STATUS_TOKENS.map((t) => [t, off.status(t)]));
      expect(rendered).toMatchSnapshot();
    });

    it('status text still carries the glyph so meaning survives NO_COLOR', () => {
      for (const token of STATUS_TOKENS) {
        expect(off.status(token)).toBe(GLYPHS[token]);
      }
    });

    it('taskId, provider and path render plain text unchanged', () => {
      expect(off.taskId('gen-schema')).toBe('gen-schema');
      expect(off.provider('codex')).toBe('codex');
      expect(off.path('/work/repo')).toBe('/work/repo');
    });
  });

  describe("color on (createTheme('always'))", () => {
    const on = createTheme('always');

    it('level is 1', () => {
      expect(on.level).toBe(1);
    });

    it('renders every status token wrapped in ANSI, matching the cli.md table', () => {
      const rendered = Object.fromEntries(STATUS_TOKENS.map((t) => [t, on.status(t)]));
      expect(rendered).toMatchSnapshot();
    });

    it('wraps taskId, provider and path text in ANSI', () => {
      expect(on.taskId('gen-schema')).toMatchSnapshot();
      expect(on.provider('codex')).toMatchSnapshot();
      expect(on.path('/work/repo')).toMatchSnapshot();
    });

    // The gate's directory is the one input with a blast radius, so it must
    // not render as dim or unstyled next to the label beside it.
    it('renders path in bold yellow, never dim or plain', () => {
      const styled = on.path('/work/repo');
      expect(styled).toContain('/work/repo');
      expect(styled).not.toBe('/work/repo');
      expect(styled).not.toBe(on.note('/work/repo'));
      const ESCAPE = String.fromCharCode(27);
      expect(styled).toContain(`${ESCAPE}[1m`);
      expect(styled).toContain(`${ESCAPE}[33m`);
    });

    it('every colored status still contains its glyph (color never carries meaning alone)', () => {
      for (const token of STATUS_TOKENS) {
        expect(on.status(token)).toContain(GLYPHS[token]);
      }
    });
  });

  describe('glyph table', () => {
    it("matches cli.md's Color section exactly", () => {
      expect(GLYPHS).toEqual({
        ok: '✓',
        fail: '✗',
        skip: '⊘',
        park: '⏸',
        run: '▸',
        pending: '·',
        warn: '!',
        action: '⚑',
        note: '·',
      });
    });
  });

  describe('machineTheme', () => {
    it('is always level 0, independent of the environment', () => {
      expect(machineTheme.level).toBe(0);
      expect(machineTheme.status('ok')).toBe('✓');
    });
  });

  describe('auto mode', () => {
    it('resolves to level 0 under NO_COLOR', () => {
      const original = process.env['NO_COLOR'];
      process.env['NO_COLOR'] = '1';
      try {
        expect(createTheme('auto').level).toBe(0);
      } finally {
        if (original === undefined) delete process.env['NO_COLOR'];
        else process.env['NO_COLOR'] = original;
      }
    });

    it("resolves to level 0 under the test suite's forced FORCE_COLOR=0", () => {
      expect(process.env['FORCE_COLOR']).toBe('0');
      expect(createTheme('auto').level).toBe(0);
      expect(createTheme().level).toBe(0);
    });
  });
});
