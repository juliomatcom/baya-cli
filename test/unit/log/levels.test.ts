import { isAtLeast, resolveStderrLevel } from '../../../src/log/levels.js';

describe('isAtLeast', () => {
  it('orders trace < debug < info < warn < error', () => {
    expect(isAtLeast('trace', 'debug')).toBe(false);
    expect(isAtLeast('debug', 'trace')).toBe(true);
    expect(isAtLeast('info', 'info')).toBe(true);
    expect(isAtLeast('warn', 'error')).toBe(false);
    expect(isAtLeast('error', 'warn')).toBe(true);
  });
});

describe('resolveStderrLevel', () => {
  it('defaults to info', () => {
    expect(resolveStderrLevel({})).toBe('info');
  });

  it('--verbose resolves to debug', () => {
    expect(resolveStderrLevel({ verbose: true })).toBe('debug');
  });

  it('--quiet resolves to warn', () => {
    expect(resolveStderrLevel({ quiet: true })).toBe('warn');
  });

  it('--log-level wins over --verbose and --quiet', () => {
    expect(resolveStderrLevel({ logLevel: 'error', verbose: true })).toBe('error');
    expect(resolveStderrLevel({ logLevel: 'trace', quiet: true })).toBe('trace');
  });
});
