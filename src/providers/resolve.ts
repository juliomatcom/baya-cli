import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { stripAnsi } from "../log/index.js";
import type { ResolvedProvider } from "./types.js";

/**
 * Binary resolution (providers.md §Binary resolution). Never assume `$PATH`
 * (conventions.md #5): on the reference machine not one provider binary lives
 * in a system directory — they sit in `~/.local/bin`, `~/.opencode/bin`, and
 * the active nvm bin, none of which a non-login shell necessarily exports.
 *
 * Chain: config override -> `$PATH` -> known locations -> not found.
 */
export function knownLocations(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env["HOME"] ?? homedir();
  return [
    join(home, ".local", "bin"),
    join(home, ".opencode", "bin"),
    // The active nvm/volta/asdf bin: whatever directory this very Node came from.
    dirname(process.execPath),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveBinaryOptions {
  /** user config `providers.<id>.bin`. Absolute paths only. */
  override?: string | undefined;
  env?: NodeJS.ProcessEnv;
  extraLocations?: string[];
}

export function resolveBinary(
  name: string,
  options: ResolveBinaryOptions = {},
): { bin: string; source: ResolvedProvider["source"] } | null {
  const env = options.env ?? process.env;

  if (options.override) {
    // A configured path that does not exist is an error worth surfacing, not a
    // reason to silently fall through to some other binary of the same name.
    return isExecutableFile(options.override)
      ? { bin: options.override, source: "config" }
      : null;
  }

  const pathDirs = (env["PATH"] ?? "").split(delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return { bin: candidate, source: "path" };
  }

  for (const dir of [...(options.extraLocations ?? []), ...knownLocations(env)]) {
    const candidate = isAbsolute(dir) ? join(dir, name) : null;
    if (candidate && isExecutableFile(candidate)) {
      return { bin: candidate, source: "known-location" };
    }
  }

  return null;
}

/**
 * `<bin> models` — the live model list for providers that enumerate one
 * (`opencode`, ~190 ids in the compound `provider/model` form the wizard needs).
 * Returns `[]` on any failure: the wizard then falls back to the curated list
 * and the run still works. Never throws.
 */
export function enumerateModels(bin: string, timeoutMs = 10_000): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ["models"],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) {
          resolve([]);
          return;
        }
        const ids = stripAnsi(String(stdout))
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "" && !/\s/.test(line) && line.includes("/"));
        resolve([...new Set(ids)]);
      },
    );
  });
}

/**
 * `<bin> --version`, with a hard timeout. Providers occasionally hang on a
 * missing auth token, and `doctor` must never be the command that wedges.
 */
export function probeVersion(bin: string, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ["--version"],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve("unknown");
          return;
        }
        const text =
          stripAnsi(`${stdout || stderr}`)
            .trim()
            .split("\n")[0] ?? "";
        resolve(text === "" ? "unknown" : text);
      },
    );
  });
}
