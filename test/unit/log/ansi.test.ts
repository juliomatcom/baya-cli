import { stripAnsi } from '../../../src/log/ansi.js';

const ESC = String.fromCharCode(27);

describe('stripAnsi', () => {
  it('strips SGR color codes', () => {
    expect(stripAnsi(`${ESC}[31mhello${ESC}[39m`)).toBe('hello');
  });

  it('strips multiple sequences and cursor movement', () => {
    const input = `${ESC}[1m${ESC}[32mok${ESC}[0m ${ESC}[2Kspinner`;
    expect(stripAnsi(input)).toBe('ok spinner');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain text, no escapes')).toBe('plain text, no escapes');
  });

  it('handles the empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});
