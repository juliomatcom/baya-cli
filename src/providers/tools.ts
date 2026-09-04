/**
 * Tool capabilities: the provider-neutral names a user turns back on when a
 * lean default withholds something a task needs.
 *
 * Every adapter drives its CLI with the smallest tool surface the task's
 * `access` implies, because tool **definitions** are what the context is made
 * of. Measured 2026-09-04 on a task whose own prompt is ~400 tokens:
 * claude 14,419 -> 7,517 input tokens, opencode ~21,130 -> ~10,427,
 * codex 17,421 -> 13,498. The prompt was never the problem.
 *
 * These names are the way back. They are deliberately few and deliberately
 * provider-neutral — the same word means the same thing everywhere, the way
 * `access` already does — and a name that has no meaning for a provider is
 * ignored rather than rejected, so `--tools web` is safe on a mixed run.
 *
 * `all` is the escape from the enum itself: it restores whatever surface the
 * CLI offers by default, for the tools no name here covers (claude's `Skill`,
 * `SlashCommand`, `ToolSearch`, …). Anything past that is
 * `providers.<id>.extraArgs`, which is raw argv and belongs to the CLI, not here.
 */
export const TOOL_CAPABILITIES = [
  'all',
  'web',
  'agents',
  'notebook',
  'memories',
  'plugins',
] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

/** What each name means, for `--help` and for the config error message. */
export const CAPABILITY_HELP: Record<ToolCapability, string> = {
  all: "the CLI's own default tool surface — the escape from this list",
  web: 'fetching and searching the web (claude, codex)',
  agents: 'spawning sub-agents (claude, codex)',
  notebook: 'editing Jupyter notebooks (claude)',
  memories: "the provider's own stored memories (codex)",
  plugins: 'externally installed plugins (opencode)',
};

export function isToolCapability(value: string): value is ToolCapability {
  return (TOOL_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Parses a comma- or space-separated capability list, naming the offender and
 * the full vocabulary on a miss. A typo in `--tools` silently costing a task
 * its web access is the failure this exists to prevent.
 */
export function parseToolCapabilities(raw: string, origin: string): ToolCapability[] {
  const seen = new Set<ToolCapability>();
  for (const part of raw.split(/[\s,]+/)) {
    if (part === '') continue;
    const name = part.toLowerCase();
    if (!isToolCapability(name)) {
      throw new Error(
        `${origin}: unknown tool capability "${part}" — expected one of ${TOOL_CAPABILITIES.join(', ')}`,
      );
    }
    seen.add(name);
  }
  return [...seen];
}

/** `all` short-circuits every other name: the full surface already contains them. */
export function wantsEverything(tools: readonly ToolCapability[] | undefined): boolean {
  return tools?.includes('all') ?? false;
}

export function wants(
  tools: readonly ToolCapability[] | undefined,
  capability: ToolCapability,
): boolean {
  return tools?.includes(capability) ?? false;
}
