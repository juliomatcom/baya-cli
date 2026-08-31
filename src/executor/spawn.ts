import { spawn } from 'node:child_process';
import { stripAnsi } from '../log/index.js';
import type { SpawnPlan } from '../providers/index.js';

/**
 * Subprocess lifecycle. Two hard rules live here:
 *
 * 1. **argv only, never a shell** (conventions.md #1) — untrusted planner text
 *    reaches this layer, and a shell would make it executable.
 * 2. **stdin is always set explicitly, never inherited** (providers.md §1) —
 *    `claude -p` blocks 3s per task on inherited stdin and `codex exec` writes
 *    a spurious warning. Over a 20-task run that is a minute of pure latency.
 *
 * Children spawn `detached: true` so they lead their own process group:
 * agentic CLIs spawn their own subprocesses, and Node's `child_process` does
 * not kill grandchildren. A timeout tears the whole group down — SIGTERM, a
 * grace window, then SIGKILL to whatever is still alive — always through
 * `killGroup`, so grandchildren go with it.
 */
export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  pid: number | undefined;
  timedOut: boolean;
}

export interface RunProcessOptions {
  plan: SpawnPlan;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** SIGTERM→SIGKILL grace after a timeout (execution.md §Interrupts). */
  killGraceMs?: number;
  /**
   * Timer injection point, so the SIGKILL escalation is testable without a
   * real multi-second wait. Defaults to unref'd `setTimeout`/`clearTimeout`.
   */
  timers?: Timers;
  /** Complete lines only — partial-chunk buffering is handled here. */
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Called before any output arrives, so a pid is checkpointed before it can be lost. */
  onSpawn?: (pid: number, pgid: number) => void;
}

/** The two timer calls `runProcess` makes, injectable for deterministic tests. */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Matches the SIGINT grace in `src/cli/interrupt.ts` and execution.md §Interrupts. */
const DEFAULT_KILL_GRACE_MS = 5_000;

/** Splits a byte stream into complete lines; the tail is held until terminated. */
export function createLineSplitter(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() !== '') onLine(line);
        index = buffer.indexOf('\n');
      }
    },
    flush(): void {
      if (buffer.trim() !== '') onLine(buffer);
      buffer = '';
    },
  };
}

export function runProcess(options: RunProcessOptions): Promise<SpawnResult> {
  const { plan } = options;
  const [command, ...args] = plan.argv;
  if (command === undefined) {
    return Promise.reject(new Error('spawn plan has an empty argv'));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: plan.cwd,
      env: options.env ?? process.env,
      detached: true,
      windowsHide: true,
      stdio: [plan.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const outSplitter = createLineSplitter((line) => options.onStdoutLine?.(line));
    const errSplitter = createLineSplitter((line) => options.onStderrLine?.(line));

    if (child.pid !== undefined) {
      // pgid === pid for a detached leader on POSIX.
      options.onSpawn?.(child.pid, child.pid);
    }

    const timers = options.timers ?? REAL_TIMERS;
    const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    let killTimer: unknown;

    const timer =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? timers.set(() => {
            timedOut = true;
            killGroup(child.pid, 'SIGTERM');
            // A provider that traps SIGTERM would hang the run past its
            // deadline forever; escalate the whole group once the grace is up.
            killTimer = timers.set(() => {
              if (!settled) killGroup(child.pid, 'SIGKILL');
            }, killGraceMs);
          }, options.timeoutMs)
        : undefined;

    const clearTimers = (): void => {
      if (timer !== undefined) timers.clear(timer);
      if (killTimer !== undefined) timers.clear(killTimer);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString('utf8'));
      stdout += text;
      outSplitter.push(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString('utf8'));
      stderr += text;
      errSplitter.push(text);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      outSplitter.flush();
      errSplitter.flush();
      resolve({ code, signal, stdout, stderr, pid: child.pid, timedOut });
    });

    if (plan.stdin === 'pipe' && child.stdin) {
      // EPIPE is normal: a provider that has read enough may close stdin first.
      child.stdin.on('error', () => undefined);
      if (plan.stdinData !== undefined) child.stdin.write(plan.stdinData);
      child.stdin.end();
    }
  });
}

/** Signals the whole group, so grandchildren die with their parent. */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
