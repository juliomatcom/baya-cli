import { createLogUpdate } from 'log-update';
import { formatElapsed } from './text.js';
import type { Theme } from './theme.js';

/**
 * One live row per in-flight provider process (specs/002-ai-consensus §11).
 *
 * `ora` paints a single line and cannot do this. `log-update` is handed the
 * whole block each frame and measures rendered height against terminal width,
 * which is the one hard part: a wrapped row occupies two physical rows, and
 * hand-rolled cursor-up arithmetic then erases the wrong lines.
 *
 * ⚠️ `run` keeps `ora` and its single line. This is a sibling, not a shared
 * abstraction both have to agree on.
 */
export interface BlockRow {
  key: string;
  provider: string;
  model: string | null;
  detail: string;
  startedAt: number;
}

export interface Block {
  readonly enabled: boolean;
  add(row: Omit<BlockRow, 'startedAt'>): void;
  remove(key: string): void;
  /** Clear the block, write a line that must persist, redraw. */
  write(line: string): void;
  header(text: string): void;
  dispose(): void;
}

/** Height overflow is the one thing `log-update` does not solve. */
export const MAX_ROWS = 6;
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;

export interface BlockOptions {
  stream?: NodeJS.WriteStream | NodeJS.WritableStream;
  theme: Theme;
  disabled?: boolean;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
}

function isTty(stream: NodeJS.WritableStream): boolean {
  return (stream as NodeJS.WriteStream).isTTY === true;
}

export function createBlock(options: BlockOptions): Block {
  const stream = options.stream ?? process.stderr;
  const env = options.env ?? process.env;
  const clock = options.clock ?? Date.now;
  const { theme } = options;

  const enabled =
    options.disabled !== true &&
    options.json !== true &&
    !(env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') &&
    isTty(stream);

  const rows: BlockRow[] = [];
  let heading = '';
  let frame = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const render = createLogUpdate(stream as NodeJS.WriteStream);

  const paint = (): void => {
    if (!enabled) return;
    if (rows.length === 0) {
      render.clear();
      return;
    }
    const width = (stream as NodeJS.WriteStream).columns ?? 80;
    const shown = rows.slice(0, MAX_ROWS - 1);
    const hidden = rows.length - shown.length;
    const lines: string[] = [];
    if (heading !== '') lines.push(`  ${theme.note(heading)}`, '');
    for (const row of shown) {
      const glyph = FRAMES[frame % FRAMES.length] as string;
      const model = row.model === null ? '' : ` ${row.model}`;
      const elapsed = formatElapsed(clock() - row.startedAt);
      const line = `  ${glyph} ${theme.provider(row.provider.padEnd(9))}${theme.note(model.padEnd(20))} ${row.detail.padEnd(11)} ${theme.note(elapsed.padStart(6))}`;
      lines.push(line.length > width - 1 ? line.slice(0, width - 1) : line);
    }
    if (hidden > 0) lines.push(`  ${theme.note(`+${String(hidden)} more`)}`);
    render(lines.join('\n'));
  };

  const start = (): void => {
    if (!enabled || ticker !== null) return;
    ticker = setInterval(() => {
      frame += 1;
      paint();
    }, FRAME_MS);
    ticker.unref();
  };

  const stop = (): void => {
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
  };

  return {
    enabled,
    add(row) {
      rows.push({ ...row, startedAt: clock() });
      start();
      paint();
    },
    remove(key) {
      const index = rows.findIndex((row) => row.key === key);
      if (index >= 0) rows.splice(index, 1);
      if (rows.length === 0) {
        stop();
        if (enabled) render.clear();
      } else {
        paint();
      }
    },
    header(text) {
      heading = text;
      paint();
    },
    write(line) {
      const payload = line.endsWith('\n') ? line : `${line}\n`;
      if (!enabled) {
        stream.write(payload);
        return;
      }
      render.clear();
      stream.write(payload);
      paint();
    },
    dispose() {
      stop();
      rows.length = 0;
      if (enabled) {
        render.clear();
        render.done();
      }
    },
  };
}
