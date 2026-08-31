import { exec, execSync } from 'node:child_process';
import { spawn } from 'node:child_process';

export function runShell(cmd) {
  return spawn(cmd, { shell: true });
}

export function runExec(cmd) {
  return exec(cmd);
}

export function runExecSync(cmd) {
  return execSync(cmd);
}
