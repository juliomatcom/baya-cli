#!/usr/bin/env node
/**
 * Fake provider CLI (testing.md). A real executable any adapter can point at
 * via a binary override. Reads a scenario from BAYA_FAKE_SCRIPT and replays
 * it deterministically: zero network, zero LLM, zero cost.
 *
 * Scenario shape (all fields optional):
 * {
 *   "emit": [{ "delay_ms": 10, "line": "...", "stream": "stdout"|"stderr" }],
 *   "stderr": "text written once, after emit, before final",
 *   "final": {...} | "raw string (malformed/prose-wrapped)" | null,
 *   "exit_code": 0,
 *   "on_signal": "exit" | "ignore",
 *   "hang_ms": 0,
 *   "spawn_child": false,
 *   "expect_stdin": false | true | "substring that must appear",
 *   "reject_stdin": "substring that makes this invocation exit 1 with nothing",
 *     — models a CLI refusing the invocation itself (a resume id it will not
 *       accept), which is structurally different from running and reporting
 *       failure through the schema.
 *   "expect_file": "path that must exist and be non-empty",
 *   "fail_attempts": 1,
 *     — this task answers `status: "failed"` (retryable) and the process exits
 *       1 for its first N invocations, then behaves normally. The only
 *       attempt-aware knob: retries need a task that fails once and then does
 *       not, and every other knob is the same on every invocation. The counter
 *       lives beside the scenario file, keyed by task id.
 *   "writes_file": "path to append start/end markers to",
 *   "by_task": { "<taskId>": {scenario}, "__planner__": {...}, "default": {...} }
 * }
 *
 * Emulates the codex file-out contract: when argv carries `-o <path>`, `final`
 * is written to that file instead of stdout, exactly as
 * `codex exec --output-schema … -o …` behaves. The task id is read back from
 * that path (`tasks/<id>/result.json`), which is what lets one scenario file
 * script a whole multi-task run without any stdin coordination.
 *
 * Emulates the claude `--output-format json` contract when argv carries
 * `--output-format` and no `-o`: the prompt is read from stdin, the task id off
 * the prompt, and `final` is printed as one JSON object with the result on
 * `.result`. This stands a second, differently-shaped provider beside codex so
 * a run can exercise cross-provider behaviour.
 *
 * When the scheduler groups tasks (execution.md §Grouping) the output path is
 * `tasks/<leader>/batch.json` instead, and the group's ids are read off the
 * prompt — the same place a real provider reads them. Each member's own
 * `final` becomes its entry in the `task_result_batch`; process-level fields
 * (`emit`, `stderr`, `hang_ms`, …) come from the leader, because there is only
 * one process. `exit_code` is the first non-zero among the members.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  process.stderr.write(`fake-provider: ${message}\n`);
  process.exit(2);
}

function outputFileFromArgv() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('-o');
  return index !== -1 && argv[index + 1] ? argv[index + 1] : null;
}

/** `.../tasks/<id>/result.json` -> `<id>`; the planner's draft has no task dir. */
function taskIdFromOutputFile(outputFile) {
  if (!outputFile) return null;
  if (basename(outputFile) === 'plan-draft.json') return '__planner__';
  return basename(dirname(outputFile));
}

/** The group prompt names every member: `Task id: <id>`, in execution order. */
function taskIdsFromPrompt(prompt) {
  return [...prompt.matchAll(/^Task id: (\S+)$/gm)].map((match) => match[1]);
}

/**
 * `claude --output-format json`: no `-o` file, the prompt arrives on stdin, and
 * the one JSON object out carries the result as a string on `.result`. Used to
 * stand a second, differently-shaped provider beside codex in one run.
 */
function isClaudeInvocation() {
  const argv = process.argv.slice(2);
  return outputFileFromArgv() === null && argv.includes('--output-format');
}

/** A lone-task prompt says `(task id: <id>)`; a group prompt lists `Task id:`. */
function taskIdsFromClaudePrompt(prompt) {
  const group = taskIdsFromPrompt(prompt);
  if (group.length > 0) return group;
  const lone = prompt.match(/\(task id: (\S+?)\)/);
  return lone ? [lone[1]] : [];
}

/** The single object `claude --output-format json` prints, `final` on `.result`. */
function writeClaudeResult(final) {
  const result =
    final === undefined || final === null
      ? ''
      : typeof final === 'string'
        ? final
        : JSON.stringify(final);
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'fake-claude-session',
      result,
    })}\n`,
  );
}

/**
 * How many times this task has been invoked, counting this one. Persisted
 * beside the scenario file because each invocation is a fresh process.
 */
function attemptNumber(taskId) {
  const path = `${process.env.BAYA_FAKE_SCRIPT}.attempts`;
  let counts = {};
  try {
    counts = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    counts = {};
  }
  const attempt = (counts[taskId] ?? 0) + 1;
  counts[taskId] = attempt;
  writeFileSync(path, JSON.stringify(counts));
  return attempt;
}

/** `fail_attempts`: a transient failure for the first N invocations of a task. */
function applyAttempts(taskId, scenario) {
  if (!scenario.fail_attempts) return scenario;
  const attempt = attemptNumber(taskId);
  if (attempt > scenario.fail_attempts) return scenario;
  return {
    ...scenario,
    exit_code: 1,
    final: {
      baya: '1',
      kind: 'task_result',
      task_id: taskId,
      status: 'failed',
      summary: '',
      output: '',
      notes: [],
      question: null,
      error: {
        message: `fake-provider: transient failure on attempt ${attempt}`,
        retryable: true,
      },
      artifacts: [],
      files_changed: [],
    },
  };
}

function loadScenario(taskId) {
  const scenarioPath = process.env.BAYA_FAKE_SCRIPT;
  if (!scenarioPath) {
    fail('BAYA_FAKE_SCRIPT env var not set');
  }
  const raw = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  if (!raw.by_task) return raw;
  const picked = (taskId && raw.by_task[taskId]) ?? raw.by_task.default;
  if (!picked) fail(`no scenario for task "${taskId}"`);
  return picked;
}

function installSignalHandlers(onSignalMode) {
  const handleSignal = (signal) => {
    if (onSignalMode === 'ignore') return;
    process.stderr.write(`fake-provider: received ${signal}, exiting\n`);
    process.exit(130);
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
}

function checkExpectFile(expectFile) {
  if (!expectFile) return;
  const ok = existsSync(expectFile) && statSync(expectFile).size > 0;
  if (!ok) fail(`expect_file failed: ${expectFile} missing or empty`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function checkExpectStdin(expectStdin, received) {
  if (!expectStdin) return;
  const ok =
    typeof expectStdin === 'string'
      ? received.includes(expectStdin)
      : received.length > 0;
  if (!ok) fail('expect_stdin failed: stdin did not meet the expectation');
}

/**
 * Refuse the invocation outright, the way a CLI does when it rejects a resume
 * identifier: non-zero exit, nothing parseable, no result file. Consumes stdin
 * first so the writer never sees EPIPE.
 */
function checkRejectStdin(rejectStdin, received) {
  if (typeof rejectStdin !== 'string' || rejectStdin === '') return;
  if (received.includes(rejectStdin)) {
    process.stderr.write('fake-provider: refusing this invocation\n');
    process.exit(1);
  }
}

function writeFileMarker(writesFile, event) {
  if (!writesFile) return;
  appendFileSync(
    writesFile,
    `${JSON.stringify({ pid: process.pid, event, ts: Date.now() })}\n`,
  );
}

function spawnGrandchild() {
  // Not detached: the grandchild stays in this process's group, the way a real
  // agentic CLI's subprocesses do, so `kill(-pgid)` reaps it with its parent.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore',
  });
  child.unref();
}

async function emitLines(emit) {
  for (const item of emit ?? []) {
    if (item.delay_ms) await sleep(item.delay_ms);
    const stream = item.stream === 'stderr' ? process.stderr : process.stdout;
    stream.write(`${item.line}\n`);
  }
}

/**
 * The one document this process answers with. A group answers with a
 * `task_result_batch`; a lone task answers exactly as it always did.
 *
 * Each member's `task_id` is stamped from the id it was asked about, so a
 * shared `by_task.default` scenario still produces a well-formed batch.
 */
function finalFor(taskIds, scenarios, grouped) {
  if (!grouped) return scenarios[0].final;
  const results = [];
  taskIds.forEach((id, index) => {
    const final = scenarios[index].final;
    if (final === undefined || final === null) return;
    if (typeof final === 'string') return;
    results.push({ ...final, task_id: id });
  });
  return { baya: '1', kind: 'task_result_batch', results };
}

function writeFinal(final, outputFile) {
  if (final === undefined || final === null) return;
  const line = typeof final === 'string' ? final : JSON.stringify(final);
  if (outputFile) {
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${line}\n`);
    return;
  }
  process.stdout.write(`${line}\n`);
}

async function main() {
  if (process.argv.slice(2).join(' ') === '--version') {
    process.stdout.write('fake-provider 1.0.0\n');
    process.exit(0);
  }

  const outputFile = outputFileFromArgv();
  const claude = isClaudeInvocation();
  // `batch.json` lives in the leader's task directory, so codex names the leader
  // in the path either way; claude names it only in the prompt, which then has
  // to be read up front. Otherwise stdin is only drained when something needs
  // it — a caller that leaves it open forever (the signal tests) must not block.
  let leaderId;
  let grouped;
  let prompt = '';
  if (claude) {
    prompt = await readStdin();
    const ids = taskIdsFromClaudePrompt(prompt);
    grouped = ids.length > 1;
    leaderId = ids[0] ?? null;
  } else {
    leaderId = taskIdFromOutputFile(outputFile);
    grouped = outputFile !== null && basename(outputFile) === 'batch.json';
  }

  const scenario = loadScenario(leaderId);
  if (!claude && (grouped || scenario.expect_stdin || scenario.reject_stdin)) {
    prompt = await readStdin();
  }
  const taskIds = grouped
    ? claude
      ? taskIdsFromClaudePrompt(prompt)
      : taskIdsFromPrompt(prompt)
    : [leaderId];
  const scenarios = taskIds.map((id) => applyAttempts(id, loadScenario(id)));

  installSignalHandlers(scenario.on_signal ?? 'exit');
  checkExpectFile(scenario.expect_file);
  checkRejectStdin(scenario.reject_stdin, prompt);
  checkExpectStdin(scenario.expect_stdin, prompt);

  writeFileMarker(scenario.writes_file, 'start');

  if (scenario.spawn_child) spawnGrandchild();

  await emitLines(scenario.emit);

  if (typeof scenario.stderr === 'string' && scenario.stderr.length > 0) {
    process.stderr.write(`${scenario.stderr}\n`);
  }

  if (scenario.hang_ms) await sleep(scenario.hang_ms);

  writeFileMarker(scenario.writes_file, 'end');
  const final = finalFor(taskIds, scenarios, grouped);
  if (claude) writeClaudeResult(final);
  else writeFinal(final, outputFile);

  const failing = scenarios.find((entry) => (entry.exit_code ?? 0) !== 0);
  process.exit(failing ? failing.exit_code : 0);
}

main();
