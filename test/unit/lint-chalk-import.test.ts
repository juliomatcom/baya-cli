import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import { CHALK_RESTRICTED_IMPORTS } from '../../eslint-rules/chalk-restriction.js';

const fixturePath = fileURLToPath(
  new URL('../fixtures/lint/chalk-import-violation.ts', import.meta.url),
);

function lint(code: string, filename: string): ReturnType<Linter['verify']> {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(
    code,
    {
      files: ['**'],
      languageOptions: { sourceType: 'module', ecmaVersion: 'latest' },
      rules: { 'no-restricted-imports': ['error', CHALK_RESTRICTED_IMPORTS] },
    },
    { filename },
  );
}

describe('chalk import restriction', () => {
  it('fails a fixture importing chalk outside src/ui/theme.ts', () => {
    const code = readFileSync(fixturePath, 'utf8');
    const messages = lint(code, fixturePath);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe('no-restricted-imports');
    expect(messages[0]?.message).toContain('src/ui/theme.ts');
  });

  it('passes code that does not import chalk', () => {
    const messages = lint('export const x = 1;', 'src/example.ts');
    expect(messages).toHaveLength(0);
  });
});
