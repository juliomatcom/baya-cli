import {
  TOOL_CAPABILITIES,
  isToolCapability,
  parseToolCapabilities,
  wants,
  wantsEverything,
} from '../../../src/providers/index.js';

describe('tool capabilities', () => {
  it('accepts comma- and space-separated lists, case-insensitively', () => {
    expect(parseToolCapabilities('web, agents', '--tools')).toEqual(['web', 'agents']);
    expect(parseToolCapabilities('web agents', '--tools')).toEqual(['web', 'agents']);
    expect(parseToolCapabilities('WEB', '--tools')).toEqual(['web']);
  });

  it('de-duplicates rather than repeating a name downstream', () => {
    expect(parseToolCapabilities('web,web,agents', '--tools')).toEqual(['web', 'agents']);
  });

  it('reads an empty list as no capabilities, not as an error', () => {
    expect(parseToolCapabilities('', '--tools')).toEqual([]);
    expect(parseToolCapabilities('  ,, ', '--tools')).toEqual([]);
  });

  // A typo silently costing a task its web access is the failure this prevents.
  it('names the offender and the whole vocabulary on a typo', () => {
    expect(() => parseToolCapabilities('wbe', '--tools')).toThrow(
      /unknown tool capability "wbe"/,
    );
    expect(() => parseToolCapabilities('wbe', '--tools')).toThrow(
      new RegExp(TOOL_CAPABILITIES.join(', ')),
    );
  });

  it('reports the origin so a config error is distinguishable from a flag error', () => {
    expect(() => parseToolCapabilities('nope', 'providers.claude.tools')).toThrow(
      /^providers\.claude\.tools:/,
    );
  });

  it('guards membership', () => {
    expect(isToolCapability('all')).toBe(true);
    expect(isToolCapability('bash')).toBe(false);
  });

  it('answers the two questions adapters ask', () => {
    expect(wantsEverything(['all'])).toBe(true);
    expect(wantsEverything(['web'])).toBe(false);
    expect(wantsEverything(undefined)).toBe(false);
    expect(wants(['web'], 'web')).toBe(true);
    expect(wants(undefined, 'web')).toBe(false);
  });
});
