import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPlannerProvider } from '../../../src/planner/provider.js';
import { claudeAdapter } from '../../../src/providers/claude.js';
import type { BuildRunInput, ProviderAdapter } from '../../../src/providers/index.js';
import { writePlanDraftSchema } from '../../../src/manifest/index.js';
import { captureLogger } from '../../helpers/logger.js';

const FAKE_PROVIDER = fileURLToPath(
  new URL('../../fixtures/fake-provider.mjs', import.meta.url),
);

/**
 * Planning is a text-to-JSON transform: the task list arrives in the prompt and
 * the answer is one object. It opens no file and runs no command — yet it goes
 * through `buildRun` like a task, so it was paying for a full agentic tool
 * surface. Measured 2026-09-04: claude 14,419 input tokens with its default
 * tools, 4,294 with none.
 */
describe('planner tool surface', () => {
  function capture(): { adapter: ProviderAdapter; inputs: BuildRunInput[] } {
    const inputs: BuildRunInput[] = [];
    const adapter: ProviderAdapter = {
      ...claudeAdapter,
      buildRun(input: BuildRunInput) {
        inputs.push(input);
        return claudeAdapter.buildRun(input);
      },
    };
    return { adapter, inputs };
  }

  async function plan(adapter: ProviderAdapter): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'baya-planner-tools-'));
    await runPlannerProvider({
      adapter,
      bin: FAKE_PROVIDER,
      cwd: dir,
      model: null,
      schemaPath: writePlanDraftSchema(dir),
      resultFile: join(dir, 'plan-draft.json'),
      runId: 'run-1',
      logger: captureLogger().logger,
      env: { ...process.env, BAYA_FAKE_SCRIPT: join(dir, 'missing.json') },
    })('plan this', 0);
  }

  it('asks for no tools at all', async () => {
    const { adapter, inputs } = capture();
    await plan(adapter);
    expect(inputs[0]?.noTools).toBe(true);
  });

  it('reaches the CLI as an empty allowlist', async () => {
    const { adapter, inputs } = capture();
    await plan(adapter);
    const argv = claudeAdapter.buildRun(inputs[0] as BuildRunInput).argv;
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
  });

  // `extraArgs` is a per-provider escape for task execution. A raw flag that
  // re-armed the planner's tools would undo this for no stated reason.
  it('does not forward extraArgs', async () => {
    const { adapter, inputs } = capture();
    await plan(adapter);
    expect(inputs[0]?.extraArgs).toBeUndefined();
  });
});
