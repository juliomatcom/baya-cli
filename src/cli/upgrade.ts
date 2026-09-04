import { spawn } from 'node:child_process';
import type { ProviderId } from '../manifest/index.js';
import { probeVersion, type Registry } from '../providers/index.js';
import type { Theme } from '../ui/theme.js';
import type { CliIo } from './run.js';

/**
 * `baya upgrade` (cli.md §Commands). Resolution mirrors `doctor` — same
 * registry, same config `bin` overrides — but each resolved provider is then
 * spawned with its adapter's `upgradeArgs`, stdio inherited, so the tool's
 * own install progress reaches the terminal directly rather than being
 * buffered and replayed.
 */
export interface UpgradeCommandOptions {
  /** Narrows to a single provider; absent upgrades every resolved one. */
  provider?: string;
  registry: Registry;
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIo;
  theme: Theme;
  binOverrides?: Partial<Record<ProviderId, string>>;
}

/** `[bin, ...upgradeArgs]`, stdio inherited. Never `shell: true` (conventions.md #1). */
function runUpgrade(
  bin: string,
  args: string[],
  options: Pick<UpgradeCommandOptions, 'cwd' | 'env'>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function upgradeCommand(options: UpgradeCommandOptions): Promise<number> {
  const { io, theme, registry } = options;
  if (options.provider !== undefined && !registry.has(options.provider)) {
    const message = `unknown provider: ${options.provider} — expected one of ${registry.ids.join(', ')}`;
    io.stderr.write(`${theme.status('fail')} ${theme.fail(message)}\n`);
    return 2;
  }

  const ids = options.provider ? [options.provider] : registry.ids;

  const lines: string[] = ['', `  ${theme.taskId('Upgrade')}`];
  let failures = 0;
  for (const id of ids) {
    const adapter = registry.get(id);
    const resolved = adapter
      ? await registry.resolve(id, {
          ...(options.binOverrides ? { binOverrides: options.binOverrides } : {}),
          env: options.env,
          probe: false,
        })
      : null;

    if (!adapter || !resolved) {
      const installHint = adapter?.installHint ?? 'unknown provider';
      lines.push(
        `    ${theme.status('skip')} ${theme.provider(id.padEnd(10))} ${theme.skip(`not found — ${installHint}`)}`,
      );
      continue;
    }

    const before = await probeVersion(resolved.bin);
    // Printed *before* the spawn, not just in the final summary: `stdio:
    // 'inherit'` hands the terminal straight to the child, and not every
    // provider's own output names itself (codex and opencode do; claude and
    // copilot don't) — without this, their raw output is unattributed noise
    // in a multi-provider run.
    io.stdout.write(
      `\n${theme.provider(id)} ${theme.note(`upgrading (${adapter.upgradeArgs.join(' ')})...`)}\n`,
    );
    try {
      const code = await runUpgrade(resolved.bin, adapter.upgradeArgs, options);
      const after = await probeVersion(resolved.bin);
      if (code === 0) {
        lines.push(
          `    ${theme.status('ok')} ${theme.provider(id.padEnd(10))} ${before} -> ${after}`,
        );
      } else {
        failures += 1;
        lines.push(
          `    ${theme.status('fail')} ${theme.provider(id.padEnd(10))} ${theme.fail(`exited ${code}`)} (${before} -> ${after})`,
        );
      }
    } catch (error) {
      failures += 1;
      lines.push(
        `    ${theme.status('fail')} ${theme.provider(id.padEnd(10))} ${theme.fail((error as Error).message)}`,
      );
    }
  }
  lines.push('');

  io.stdout.write(`${lines.join('\n')}\n`);
  return failures === 0 ? 0 : 1;
}
