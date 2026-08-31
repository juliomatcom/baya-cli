/**
 * testing.md "Color in tests": all snapshot tests run with color forced off
 * so they stay stable across CI and local TTY/non-TTY environments.
 */
process.env['FORCE_COLOR'] = '0';
