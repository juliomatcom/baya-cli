import type { ProviderStatus } from "../providers/index.js";
import type { Theme } from "../ui/theme.js";

/**
 * `-h/--help` (cli.md §-h/--help). The provider list is **generated from the
 * adapter registry**, never hard-coded: registering an adapter updates help
 * with no other edit, and each entry carries its resolution status so `--help`
 * doubles as a first-line sanity check.
 */
export function renderHelp(statuses: ProviderStatus[], theme: Theme): string {
  // Version strings are whatever the CLI prints — `codex-cli 0.148.0` today,
  // something else next release. Size the column to the widest one rather than
  // guessing a width, so the paths stay aligned instead of ragged.
  const versionWidth = Math.max(
    0,
    ...statuses.map((status) => status.resolved?.version.length ?? 0),
  );

  const providerLines = statuses.map((status) => {
    const id = status.id.padEnd(11);
    if (status.resolved) {
      return `  ${id}${theme.status("ok")} ${status.resolved.version.padEnd(versionWidth)}  ${status.resolved.bin}`;
    }
    return `  ${id}${theme.status("fail")} ${theme.skip(`not found — ${status.adapter.installHint}`)}`;
  });

  return [
    "baya — orchestrate local AI coding CLIs from a Markdown task list",
    "",
    theme.taskId("USAGE"),
    "  baya <file.md> [options]        run a task list (default)",
    "  baya run|plan <file.md>         explicit form",
    "  baya doctor                     check provider installs",
    "  baya config [--show|path|set]   change defaults",
    "",
    theme.taskId("PROVIDERS"),
    ...providerLines,
    "",
    theme.taskId("OPTIONS"),
    "  --dry-run                  render the plan and exit",
    "  -y, --yes                  auto-confirm the plan gate",
    "  --plan-out <f>             write the manifest and exit",
    "  --plan-in <f>              execute a manifest directly, skipping planning",
    "  --planner-provider <id>    provider that plans the Markdown",
    "  --planner-model <m>        unset means the provider's own default",
    "  --default-provider <id>    provider for tasks that name none",
    "  --default-model <m>        unset means the provider's own default",
    "  --max-tasks <n>            planner output ceiling (default 50)",
    "  --context-strategy <s>     link-only (default) | truncate",
    "  --context-budget <n>       total inline chars (default 12000)",
    "  --dangerously-allow-all    full permission bypass",
    "  --json                     machine-readable run report on stdout",
    "  --log-level <l>            trace|debug|info|warn|error (default info)",
    "  --verbose                  alias for --log-level debug",
    "  --quiet                    alias for --log-level warn",
    "  --no-progress              disable the spinner",
    "  --no-color                 disable ANSI",
    "",
    theme.taskId("EXAMPLES"),
    "  baya ./tasks.md",
    "  baya ./tasks.md --default-provider codex",
    "  baya ./tasks.md --dry-run          # show the plan, run nothing",
    "  baya plan tasks.md --plan-out plan.json",
    "  baya run tasks.md --plan-in plan.json --yes",
    "",
    "  Run `baya doctor` to check installs, `baya config` to change defaults.",
    "  Full reference: wiki-llm/cli.md",
    "",
  ].join("\n");
}
