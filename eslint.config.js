// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import { CHALK_RESTRICTED_IMPORTS } from './eslint-rules/chalk-restriction.js';
import localRules from './eslint-rules/index.js';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      '.baya/**',
      '.history/**',
      'node_modules/**',
      'test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mts,cts,js,mjs,cjs}'],
    plugins: {
      local: localRules,
    },
    rules: {
      'local/no-shell-exec': 'error',
      'no-restricted-imports': ['error', CHALK_RESTRICTED_IMPORTS],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'error',
    },
  },
  {
    // The single permitted importer of each terminal-owning library. M0.2's
    // spike proves chalk loads under Jest+ESM; it predates the theme.ts-only
    // rule and isn't part of the app's runtime import graph.
    files: [
      'src/ui/theme.ts',
      'src/ui/progress.ts',
      'src/config/wizard.ts',
      'src/ui/confirm.ts',
      'src/ui/model-gate.ts',
      'src/ui/run-picker.ts',
      'test/unit/esm-spike.test.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['test/**/*.{ts,mts,js,mjs}', 'eslint.config.js', 'jest.config.js'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  eslintConfigPrettier,
);
