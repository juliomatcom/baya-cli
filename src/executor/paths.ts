import { randomBytes } from "node:crypto";
import { join } from "node:path";

/**
 * On-disk layout (architecture.md §On-disk layout). One place that knows where
 * anything lives, so a layout change is one edit.
 */
export interface RunPaths {
  bayaDir: string;
  schemaDir: string;
  lockFile: string;
  runsDir: string;
  runDir: string;
  manifest: string;
  state: string;
  report: string;
  log: string;
  taskDir(taskId: string): string;
  request(taskId: string): string;
  result(taskId: string): string;
  output(taskId: string): string;
  events(taskId: string): string;
  stdout(taskId: string): string;
  stderr(taskId: string): string;
}

/**
 * `<utc-timestamp>-<rand>-<pid>` — lexically sortable so `baya runs` needs no
 * index, and unique even when two runs start in the same minute.
 */
export function makeRunId(now: Date = new Date(), pid: number = process.pid): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}-${pid}`;
}

export function runPaths(cwd: string, runId: string): RunPaths {
  const bayaDir = join(cwd, ".baya");
  const runDir = join(bayaDir, "runs", runId);
  const taskDir = (taskId: string): string => join(runDir, "tasks", taskId);

  return {
    bayaDir,
    schemaDir: join(bayaDir, "schema"),
    lockFile: join(bayaDir, "baya.lock"),
    runsDir: join(bayaDir, "runs"),
    runDir,
    manifest: join(runDir, "manifest.json"),
    state: join(runDir, "state.json"),
    report: join(runDir, "report.json"),
    log: join(runDir, "baya.jsonl"),
    taskDir,
    request: (id) => join(taskDir(id), "request.json"),
    result: (id) => join(taskDir(id), "result.json"),
    output: (id) => join(taskDir(id), "output.md"),
    events: (id) => join(taskDir(id), "events.jsonl"),
    stdout: (id) => join(taskDir(id), "stdout.log"),
    stderr: (id) => join(taskDir(id), "stderr.log"),
  };
}
