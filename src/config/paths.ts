import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$XDG_CONFIG_HOME/baya/config.json`, else `~/.config/baya/config.json`. */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : join(env['HOME'] ?? homedir(), '.config');
  return join(base, 'baya', 'config.json');
}

export function bayaDir(cwd: string): string {
  return join(cwd, '.baya');
}
