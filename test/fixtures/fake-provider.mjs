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
 *   "expect_file": "path that must exist and be non-empty",
 *   "writes_file": "path to append start/end markers to",
 *   "by_task": { "<taskId>": {scenario}, "__planner__": {...}, "default": {...} }
 * }
 *
 * Emulates the codex file-out contract: when argv carries `-o <path>`, `final`
 * is written to that file instead of stdout, exactly as
 * `codex exec --output-schema … -o …` behaves. The task id is read back from
 * that path (`tasks/<id>/result.json`), which is what lets one scenario file
 * script a whole multi-task run without any stdin coordination.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { spawn } from "node:child_process";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  process.stderr.write(`fake-provider: ${message}\n`);
  process.exit(2);
}

function outputFileFromArgv() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf("-o");
  return index !== -1 && argv[index + 1] ? argv[index + 1] : null;
}

/** `.../tasks/<id>/result.json` -> `<id>`; the planner's draft has no task dir. */
function taskIdFromOutputFile(outputFile) {
  if (!outputFile) return null;
  if (basename(outputFile) === "plan-draft.json") return "__planner__";
  return basename(dirname(outputFile));
}

function loadScenario(taskId) {
  const scenarioPath = process.env.BAYA_FAKE_SCRIPT;
  if (!scenarioPath) {
    fail("BAYA_FAKE_SCRIPT env var not set");
  }
  const raw = JSON.parse(readFileSync(scenarioPath, "utf8"));
  if (!raw.by_task) return raw;
  const picked = (taskId && raw.by_task[taskId]) ?? raw.by_task.default;
  if (!picked) fail(`no scenario for task "${taskId}"`);
  return picked;
}

function installSignalHandlers(onSignalMode) {
  const handleSignal = (signal) => {
    if (onSignalMode === "ignore") return;
    process.stderr.write(`fake-provider: received ${signal}, exiting\n`);
    process.exit(130);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
}

function checkExpectFile(expectFile) {
  if (!expectFile) return;
  const ok = existsSync(expectFile) && statSync(expectFile).size > 0;
  if (!ok) fail(`expect_file failed: ${expectFile} missing or empty`);
}

async function checkExpectStdin(expectStdin) {
  if (!expectStdin) return;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const received = Buffer.concat(chunks).toString("utf8");
  const ok =
    typeof expectStdin === "string"
      ? received.includes(expectStdin)
      : received.length > 0;
  if (!ok) fail("expect_stdin failed: stdin did not meet the expectation");
}

function writeFileMarker(writesFile, event) {
  if (!writesFile) return;
  appendFileSync(
    writesFile,
    `${JSON.stringify({ pid: process.pid, event, ts: Date.now() })}\n`,
  );
}

function spawnGrandchild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function emitLines(emit) {
  for (const item of emit ?? []) {
    if (item.delay_ms) await sleep(item.delay_ms);
    const stream = item.stream === "stderr" ? process.stderr : process.stdout;
    stream.write(`${item.line}\n`);
  }
}

function writeFinal(final, outputFile) {
  if (final === undefined || final === null) return;
  const line = typeof final === "string" ? final : JSON.stringify(final);
  if (outputFile) {
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${line}\n`);
    return;
  }
  process.stdout.write(`${line}\n`);
}

async function main() {
  if (process.argv.slice(2).join(" ") === "--version") {
    process.stdout.write("fake-provider 1.0.0\n");
    process.exit(0);
  }

  const outputFile = outputFileFromArgv();
  const scenario = loadScenario(taskIdFromOutputFile(outputFile));

  installSignalHandlers(scenario.on_signal ?? "exit");
  checkExpectFile(scenario.expect_file);
  await checkExpectStdin(scenario.expect_stdin);

  writeFileMarker(scenario.writes_file, "start");

  if (scenario.spawn_child) spawnGrandchild();

  await emitLines(scenario.emit);

  if (typeof scenario.stderr === "string" && scenario.stderr.length > 0) {
    process.stderr.write(`${scenario.stderr}\n`);
  }

  if (scenario.hang_ms) await sleep(scenario.hang_ms);

  writeFileMarker(scenario.writes_file, "end");
  writeFinal(scenario.final, outputFile);

  process.exit(scenario.exit_code ?? 0);
}

main();
