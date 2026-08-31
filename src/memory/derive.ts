import { isAbsolute, relative } from 'node:path';
import type { MemoryEntry, TaskObservations } from './types.js';

/**
 * Observations -> facts. Pure, so the whole of it is testable against the
 * `events.jsonl` and transcripts a real run already leaves on disk.
 *
 * The ordering of the four kinds is a value-per-token judgement, not
 * aesthetics: a command that **failed** is the most expensive thing for the
 * next task to rediscover, because rediscovering it means paying for the
 * failure again.
 */

/**
 * Commands that only ever look at the tree. Their success or failure says
 * nothing worth carrying (`rg` exits 1 on "no matches", which is not a dead
 * end), but the paths inside them say where the interesting files are.
 *
 * Everything not listed here is treated as a capability command — a build, a
 * test run, a linter, an installer — where the exit code is the fact.
 */
const EXPLORATION = new Set([
  'awk',
  'basename',
  'cat',
  'cd',
  'diff',
  'dirname',
  'du',
  'echo',
  'file',
  'find',
  'grep',
  'head',
  'less',
  'ls',
  'printf',
  'pwd',
  'readlink',
  'realpath',
  'rg',
  'sed',
  'sort',
  'stat',
  'tail',
  'tree',
  'uniq',
  'wc',
  'which',
  // `git` is read-mostly in this context — status, log, diff. A task that
  // commits is not reporting a repo capability worth remembering either.
  'git',
  // Shell and environment noise. These say nothing about the repository, so
  // their exit codes are not facts worth a later task's prompt space.
  'chmod',
  'cp',
  'date',
  'env',
  'export',
  'false',
  'mkdir',
  'mv',
  'printenv',
  'ps',
  'rm',
  'sleep',
  'touch',
  'true',
  'uname',
  'whoami',
]);

/**
 * Extensions that make a bare, slash-less token a file rather than a property
 * access. Without this, `console.log` and `Object.keys` are indistinguishable
 * from filenames — and `console.log` did show up as a "file earlier tasks
 * needed" when this list was not here.
 */
const FILE_EXTENSIONS = new Set([
  'bash',
  'cfg',
  'cjs',
  'css',
  'csv',
  'env',
  'go',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsx',
  'lock',
  'md',
  'mjs',
  'php',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'toml',
  'ts',
  'tsx',
  'txt',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

/** Directories whose contents are noise: Baya's own artifacts and vendored code. */
const IGNORED_PATH_SEGMENTS = ['.baya/', 'node_modules/', '.git/', 'dist/', 'coverage/'];

/**
 * `codex` hands back every command already wrapped for a login shell
 * (`/bin/zsh -lc '…'`). The wrapper is not the fact — unwrap it so the same
 * command observed through `claude`, which reports it bare, dedupes against it.
 */
export function normalizeCommand(raw: string): string {
  let text = raw.trim();
  const wrapper = text.match(/^(?:\S*\/)?(?:ba|z|d|k)?sh\s+-[a-z]*c\s+(.*)$/s);
  if (wrapper && wrapper[1] !== undefined) text = wrapper[1].trim();
  // Strip one balanced layer of quoting the wrapper added.
  const first = text[0];
  if ((first === "'" || first === '"') && text.endsWith(first) && text.length > 1) {
    text = text.slice(1, -1);
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** The program being run, without its directory. */
function head(command: string): string {
  const token = command.split(/\s+/, 1)[0] ?? '';
  const base = token.split('/').pop() ?? token;
  return base.toLowerCase();
}

export function isCapabilityCommand(command: string): boolean {
  if (command === '') return false;
  return !EXPLORATION.has(head(command));
}

/**
 * File-ish tokens inside a command string. `claude` reports `Read.file_path`
 * outright; `codex` only ever says `sed -n '1,220p' wiki-llm/index.md`, so for
 * that provider this regex is the only way a read becomes a fact.
 *
 * The extension must start with a letter, which keeps version strings
 * (`gpt-5.6-luna`) and numeric ranges out, and — for a token with no `/` —
 * must be one files actually use, which keeps `console.log` out.
 */
export function pathsIn(text: string): string[] {
  const found = text.match(/[\w@.\-/]*[\w@\-/]\.[A-Za-z][A-Za-z0-9]{0,7}\b/g) ?? [];
  return found.filter((token) => {
    // A `/` settles it. Without one, the extension has to be one a file
    // actually uses — otherwise `console.log` reads as a path.
    if (token.includes('/')) return true;
    return FILE_EXTENSIONS.has(token.slice(token.lastIndexOf('.') + 1).toLowerCase());
  });
}

/**
 * Absolute paths inside the workspace become repo-relative; anything outside
 * it, and anything in an ignored directory, is dropped rather than shown — an
 * absolute path from someone else's machine is noise in a later prompt.
 */
export function normalizePath(path: string, cwd: string): string | null {
  let value = path;
  if (isAbsolute(value)) {
    const rel = relative(cwd, value);
    if (rel === '' || rel.startsWith('..')) return null;
    value = rel;
  }
  value = value.replace(/^\.\//, '');
  if (value === '' || value.startsWith('..')) return null;
  const probe = `${value}/`;
  if (IGNORED_PATH_SEGMENTS.some((segment) => probe.includes(segment))) return null;
  return value;
}

export interface DeriveOptions {
  cwd: string;
  /** A path must be read by at least this many distinct tasks to be "hot". */
  hotThreshold?: number;
}

interface CommandRecord {
  ok: boolean;
  failed: boolean;
  sources: Set<string>;
}

function addSource(map: Map<string, Set<string>>, key: string, taskId: string): void {
  const existing = map.get(key);
  if (existing) existing.add(taskId);
  else map.set(key, new Set([taskId]));
}

export function deriveMemory(
  tasks: readonly TaskObservations[],
  options: DeriveOptions,
): MemoryEntry[] {
  const hotThreshold = options.hotThreshold ?? 2;
  const commands = new Map<string, CommandRecord>();
  const reads = new Map<string, Set<string>>();
  const writes = new Map<string, Set<string>>();

  for (const { taskId, observations } of tasks) {
    for (const observation of observations) {
      if (observation.kind === 'command') {
        const command = normalizeCommand(observation.command);
        for (const raw of pathsIn(command)) {
          const path = normalizePath(raw, options.cwd);
          if (path) addSource(reads, path, taskId);
        }
        if (!isCapabilityCommand(command)) continue;
        const record = commands.get(command) ?? {
          ok: false,
          failed: false,
          sources: new Set<string>(),
        };
        if (observation.ok) record.ok = true;
        else record.failed = true;
        record.sources.add(taskId);
        commands.set(command, record);
        continue;
      }
      const path = normalizePath(observation.path, options.cwd);
      if (!path) continue;
      addSource(observation.kind === 'write' ? writes : reads, path, taskId);
    }
  }

  const entries: MemoryEntry[] = [];

  // A command that failed and later succeeded is not a dead end — it is a
  // solved problem, and reporting it as a dead end would be actively wrong.
  for (const [command, record] of commands) {
    if (record.failed && !record.ok) {
      entries.push({
        kind: 'command.deadend',
        key: `command:${command}`,
        value: command,
        sources: [...record.sources],
      });
    }
  }
  for (const [command, record] of commands) {
    if (record.ok) {
      entries.push({
        kind: 'command.verified',
        key: `command:${command}`,
        value: command,
        sources: [...record.sources],
      });
    }
  }
  for (const [path, sources] of writes) {
    entries.push({
      kind: 'file.changed',
      key: `file:${path}`,
      value: path,
      sources: [...sources],
    });
  }
  for (const [path, sources] of reads) {
    // A file someone already edited is reported as changed, which is strictly
    // more informative than reporting it as popular.
    if (writes.has(path)) continue;
    if (sources.size < hotThreshold) continue;
    entries.push({
      kind: 'file.hot',
      key: `file:${path}`,
      value: path,
      sources: [...sources],
    });
  }

  return entries;
}
