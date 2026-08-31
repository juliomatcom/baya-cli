import {
  MODEL_MANUAL_ENTRY,
  PROVIDER_DEFAULT_MODEL,
  buildModelChoices,
  buildProviderChoices,
  nonInteractiveDefault,
  wizardDecision,
} from '../../../src/config/wizard.js';
import type { ProviderStatus } from '../../../src/providers/index.js';

/**
 * No test here opens a prompt (conventions.md #13). Everything the wizard
 * decides is a pure function; only the thin prompt shell is untested, and it
 * has no logic to get wrong.
 */
const status = (
  id: string,
  resolved: { bin: string; version: string } | null,
): ProviderStatus =>
  ({
    id,
    adapter: { id, installHint: `npm i -g ${id}` },
    resolved: resolved ? { ...resolved, source: 'path' } : null,
  }) as unknown as ProviderStatus;

const ctx = (overrides = {}) => ({
  command: 'run',
  userConfigExists: false,
  stdinIsTty: true,
  stdoutIsTty: true,
  providerFlagGiven: false,
  yes: false,
  env: {} as NodeJS.ProcessEnv,
  ...overrides,
});

describe('buildProviderChoices', () => {
  it('lists detected providers first, selectable', () => {
    const choices = buildProviderChoices([
      status('claude', null),
      status('codex', { bin: '/b/codex', version: '0.5' }),
    ]);
    expect(choices[0]?.value).toBe('codex');
    expect(choices[0]?.disabled).toBe(false);
  });

  it('keeps undetected providers visible but disabled, with an install hint', () => {
    const choices = buildProviderChoices([status('copilot', null)]);
    expect(choices[0]?.disabled).toContain('npm i -g copilot');
  });

  it('shows the resolved version and path, so the list doubles as a check', () => {
    const choices = buildProviderChoices([
      status('codex', { bin: '/b/codex', version: '0.5' }),
    ]);
    expect(choices[0]?.description).toBe('0.5 · /b/codex');
  });
});

describe('buildModelChoices', () => {
  it('always offers the provider default first — it never goes stale', () => {
    expect(buildModelChoices('codex')[0]?.value).toBe(PROVIDER_DEFAULT_MODEL);
  });

  it('always offers manual entry last, unvalidated', () => {
    const choices = buildModelChoices('codex');
    expect(choices[choices.length - 1]?.value).toBe(MODEL_MANUAL_ENTRY);
  });

  it('prefers a live enumerated list over the curated one', () => {
    const choices = buildModelChoices('opencode', ['anthropic/x', 'openai/y']);
    expect(choices.map((choice) => choice.value)).toEqual([
      PROVIDER_DEFAULT_MODEL,
      'anthropic/x',
      'openai/y',
      MODEL_MANUAL_ENTRY,
    ]);
  });

  it("offers claude's stable aliases when nothing is enumerated", () => {
    expect(buildModelChoices('claude').map((choice) => choice.value)).toContain('sonnet');
  });
});

describe('wizardDecision', () => {
  it('runs on a fresh TTY invocation of run', () => {
    expect(wizardDecision(ctx())).toEqual({ run: true });
  });

  it('never runs for doctor or config', () => {
    expect(wizardDecision(ctx({ command: 'doctor' })).run).toBe(false);
    expect(wizardDecision(ctx({ command: 'config' })).run).toBe(false);
  });

  it('never runs once a user config exists', () => {
    expect(wizardDecision(ctx({ userConfigExists: true })).run).toBe(false);
  });

  it.each([
    ['--default-provider given', { providerFlagGiven: true }],
    ['--yes given', { yes: true }],
    ['stdin is not a TTY', { stdinIsTty: false }],
    ['stdout is not a TTY', { stdoutIsTty: false }],
    ['BAYA_NO_INPUT=1', { env: { BAYA_NO_INPUT: '1' } }],
    ['CI=true', { env: { CI: 'true' } }],
  ])('never runs when %s', (_label, overrides) => {
    expect(wizardDecision(ctx(overrides)).run).toBe(false);
  });
});

describe('nonInteractiveDefault', () => {
  it('uses the only provider found, with a warning', () => {
    const outcome = nonInteractiveDefault([
      status('codex', { bin: '/b/codex', version: '0.5' }),
      status('claude', null),
    ]);
    expect(outcome).toMatchObject({ kind: 'use', provider: 'codex' });
    if (outcome.kind === 'use') expect(outcome.warning).toContain('only one found');
  });

  it('refuses to guess between several, naming the flag that resolves it', () => {
    const outcome = nonInteractiveDefault([
      status('codex', { bin: '/b/codex', version: '0.5' }),
      status('claude', { bin: '/b/claude', version: '2.1' }),
    ]);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toContain('--default-provider');
  });

  it('errors with install hints when nothing is installed', () => {
    const outcome = nonInteractiveDefault([
      status('codex', null),
      status('claude', null),
    ]);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toContain('npm i -g codex');
      expect(outcome.message).toContain('baya doctor');
    }
  });
});
