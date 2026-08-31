/**
 * Single-importer rules (conventions.md #11, #16b; config.md §Implementation
 * notes). Each of these libraries owns a terminal resource — the color level,
 * the spinner line, stdin — and a second importer silently fights the first.
 * Shared between eslint.config.js and its test so the two never drift.
 */
export const CHALK_RESTRICTED_IMPORTS = {
  paths: [
    {
      name: 'chalk',
      message: 'chalk may only be imported in src/ui/theme.ts (conventions.md #11).',
    },
    {
      name: 'ora',
      message: 'ora may only be imported in src/ui/progress.ts (conventions.md #16b).',
    },
    {
      name: '@inquirer/prompts',
      message:
        '@inquirer/prompts may only be imported in src/config/wizard.ts and src/ui/confirm.ts (conventions.md).',
    },
  ],
};
