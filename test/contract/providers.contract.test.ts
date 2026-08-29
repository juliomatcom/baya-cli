import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PROTOCOL_VERSION,
  TaskResultSchema,
  taskResultJsonSchema,
  writeTaskResultSchema,
  type ProviderId,
  type Task,
  type TaskRequest,
} from "../../src/manifest/index.js";
import {
  claudeAdapter,
  codexAdapter,
  copilotAdapter,
  opencodeAdapter,
  resolveBinary,
  type ProviderAdapter,
} from "../../src/providers/index.js";
import { runProcess } from "../../src/executor/spawn.js";

/**
 * Contract tier — real binaries, real calls. `npm run test:contract`.
 *
 * Each adapter is driven through `buildRun -> spawn -> parseEvents ->
 * extractResult` against a trivial read-only task. A provider whose binary does
 * not resolve is skipped: this catches drift on the CLIs you have, it is not a
 * completeness gate.
 */

const RUN = process.env["BAYA_CONTRACT"] === "1";
const describeContract = RUN ? describe : describe.skip;

const PROMPT = [
  "Return only a JSON object matching the task_result schema you were given.",
  'Set status to "ok", summary to "contract check passed", output to an empty string,',
  "and every other array to []. Do not run any tools. Do not write any files.",
].join(" ");

interface Case {
  id: ProviderId;
  adapter: ProviderAdapter;
}

const CASES: Case[] = [
  { id: "codex", adapter: codexAdapter },
  { id: "claude", adapter: claudeAdapter },
  { id: "opencode", adapter: opencodeAdapter },
  { id: "copilot", adapter: copilotAdapter },
];

describeContract("provider contract", () => {
  let dir: string;
  let schemaPath: string;
  let schemaContents: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "baya-contract-"));
    schemaPath = writeTaskResultSchema(join(dir, ".baya", "schema"));
    schemaContents = JSON.stringify(taskResultJsonSchema());
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  for (const { id, adapter } of CASES) {
    const found = resolveBinary(id);
    const maybe = found ? it : it.skip;

    maybe(
      `${id}: buildRun -> spawn -> extractResult yields a valid task_result`,
      async () => {
        const bin = (found as { bin: string }).bin;
        const task: Task = {
          id: "contract-check",
          title: "Contract check",
          instruction: PROMPT,
          provider: id,
          model: null,
          depends_on: [],
          access: "read-only",
          cwd: null,
        };
        const request: TaskRequest = {
          baya: PROTOCOL_VERSION,
          kind: "task_request",
          run_id: "contract",
          task: { id: task.id, title: task.title, instruction: task.instruction },
          workspace: { cwd: dir, access: "read-only", isolation: "shared" },
          context: [],
          response_contract: { schema_path: schemaPath },
          constraints: { max_runtime_s: 150 },
        };
        const resultFile = join(dir, `${id}-result.json`);

        const plan = adapter.buildRun({
          bin,
          task,
          request,
          model: null,
          cwd: dir,
          schemaPath,
          schemaContents,
          resultFile,
          prompt: PROMPT,
        });

        for (const file of plan.files ?? []) {
          mkdirSync(dirname(file.path), { recursive: true });
          writeFileSync(file.path, file.contents, "utf8");
        }

        const events: Parameters<typeof adapter.extractResult>[0]["events"] = [];
        const outcome = await runProcess({
          plan,
          timeoutMs: 150_000,
          onStdoutLine: (line) => events.push(...adapter.parseEvents(line)),
        });

        let resultFileContents: string | null = null;
        try {
          resultFileContents = readFileSync(resultFile, "utf8");
        } catch {
          resultFileContents = null;
        }

        const result = adapter.extractResult({
          taskId: task.id,
          events,
          resultFileContents,
          exitCode: outcome.code,
          stderr: outcome.stderr,
        });

        // The contract is structural: whatever the provider did, the adapter
        // must hand back something that parses as a task_result for this id.
        expect(TaskResultSchema.safeParse(result).success).toBe(true);
        expect(result.task_id).toBe("contract-check");
        // eslint-disable-next-line no-console
        console.log(`[contract] ${id}: status=${result.status} — ${result.summary}`);
      },
    );
  }
});
