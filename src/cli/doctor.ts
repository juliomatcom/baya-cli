import { inspectLock } from "../lock/index.js";
import type { ProviderId } from "../manifest/index.js";
import type { Registry } from "../providers/index.js";
import { runPaths } from "../executor/index.js";
import type { Theme } from "../ui/theme.js";
import { formatDuration } from "../ui/text.js";

/**
 * `baya doctor` (cli.md §Commands). The first command to run on a new machine:
 * not one provider binary lives in a system directory on the reference
 * machine, so "it's installed" and "baya can find it" are different questions.
 *
 * Stray-process reaping is M5 and is deliberately absent here — a naive
 * implementation would kill a *running* Baya's children. It may only ever act
 * on a lock judged **stale**, never on pid-liveness alone.
 */
export interface DoctorOptions {
  registry: Registry;
  cwd: string;
  theme: Theme;
  env?: NodeJS.ProcessEnv;
  binOverrides?: Partial<Record<ProviderId, string>>;
}

export interface DoctorReport {
  text: string;
  /** 0 when at least one provider resolved; 2 when none did. */
  exitCode: number;
}

export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  const { theme } = options;
  const statuses = await options.registry.resolveAll({
    ...(options.binOverrides ? { binOverrides: options.binOverrides } : {}),
    ...(options.env ? { env: options.env } : {}),
  });

  const lines: string[] = ["", `  ${theme.taskId("Providers")}`];
  for (const status of statuses) {
    if (status.resolved) {
      const caps = status.adapter.capabilities;
      lines.push(
        `    ${theme.status("ok")} ${theme.provider(status.id.padEnd(10))} ${status.resolved.version.padEnd(10)} ${status.resolved.bin}`,
      );
      lines.push(
        `      ${theme.note(`prompt via ${caps.promptDelivery.join("/")} · schema ${caps.structuredOutput} · session ${caps.sessionId} · max concurrency ${caps.maxConcurrency} · found via ${status.resolved.source}`)}`,
      );
    } else {
      lines.push(
        `    ${theme.status("fail")} ${theme.provider(status.id.padEnd(10))} ${theme.skip(`not found — ${status.adapter.installHint}`)}`,
      );
    }
  }

  const paths = runPaths(options.cwd, "-");
  const lock = inspectLock(paths.lockFile);
  lines.push("", `  ${theme.taskId("Workspace")}`);
  if (lock.state === "free") {
    lines.push(`    ${theme.status("ok")} no baya is running in this directory`);
  } else if (lock.state === "unreadable") {
    // Never removed automatically: we cannot tell whether its holder is alive.
    lines.push(
      `    ${theme.status("warn")} ${theme.warn(`unreadable lock file — delete it by hand: ${paths.lockFile}`)}`,
    );
  } else if (lock.verdict === "live") {
    lines.push(
      `    ${theme.status("run")} baya is running here — pid ${lock.info.pid} · run ${lock.info.owner} · started ${formatDuration(Date.now() - lock.info.acquiredAt)} ago`,
    );
  } else {
    lines.push(
      `    ${theme.status("warn")} ${theme.warn(`stale lock from pid ${lock.info.pid}; the next run reclaims it`)}`,
    );
  }

  const anyResolved = statuses.some((status) => status.resolved !== null);
  if (!anyResolved) {
    lines.push(
      "",
      `  ${theme.status("fail")} ${theme.fail("no provider CLI found — install one of the above, then re-run `baya doctor`")}`,
    );
  }
  lines.push("");

  return { text: lines.join("\n"), exitCode: anyResolved ? 0 : 2 };
}
