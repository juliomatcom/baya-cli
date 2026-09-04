import { renderPlannerCost } from '../../../src/cli/run.js';
import { createTheme } from '../../../src/ui/theme.js';

const theme = createTheme('never');
const render = (
  usage: Parameters<typeof renderPlannerCost>[0],
  attempts = 1,
  model: string | null = 'gpt-5.6-luna',
): string | null => renderPlannerCost(usage, 'codex', model, attempts, theme);

/**
 * Planning is the one spend a run makes before the user has agreed to
 * anything, and `report.json` totals what the *tasks* spent — the planner is
 * not a task, so it was invisible.
 */
describe('renderPlannerCost', () => {
  it('names the provider and model that planned, with the token total', () => {
    expect(render({ input_tokens: 13_600, output_tokens: 400 })).toBe(
      '  planned by codex gpt-5.6-luna · 14k tokens',
    );
  });

  it('omits the model when the provider default was used', () => {
    expect(render({ input_tokens: 1000 }, 1, null)).toBe(
      '  planned by codex · 1.0k tokens',
    );
  });

  // A cached total means something different from a fresh one; the report line
  // already makes that distinction and this one has to agree with it.
  it('calls out the cached share', () => {
    expect(
      render({ input_tokens: 9000, output_tokens: 1000, cached_input_tokens: 6000 }),
    ).toBe('  planned by codex gpt-5.6-luna · 10k tokens (6.0k cached)');
  });

  it('shows cost only when the provider reported one', () => {
    expect(render({ input_tokens: 5000, cost_usd: 0.02 })).toContain('$0.02');
    expect(render({ input_tokens: 5000 })).not.toContain('$');
    expect(render({ input_tokens: 5000, cost_usd: 0 })).not.toContain('$');
  });

  // A repair round is a second call to the model, paid for like the first.
  // Without the count the number is not explicable.
  it('names the attempt count when a repair round happened', () => {
    expect(render({ input_tokens: 20_000 }, 2)).toContain('2 attempts');
    expect(render({ input_tokens: 20_000 }, 1)).not.toContain('attempt');
  });

  // `--plan-in` runs no planner, and an adapter without `extractUsage` has
  // nothing to say. `0 tokens` would be a claim, not an absence.
  it('renders nothing rather than a zero line when there is no usage', () => {
    expect(render({})).toBeNull();
    expect(render({ input_tokens: 0, output_tokens: 0 })).toBeNull();
  });

  it('still renders when a provider reports only cost', () => {
    expect(render({ cost_usd: 0.03 })).toBe('  planned by codex gpt-5.6-luna · $0.03');
  });
});
