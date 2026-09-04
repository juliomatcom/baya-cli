/** Provider-neutral capability names. See providers.md §Lean tool sets. */
export const TOOL_CAPABILITIES = [
  'all',
  'web',
  'agents',
  'notebook',
  'memories',
] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

/** What each name means, for `--help` and the config error message. */
export const CAPABILITY_HELP: Record<ToolCapability, string> = {
  all: "the CLI's own default tool surface — the escape from this list",
  web: 'fetching and searching the web (claude, codex)',
  agents: 'spawning sub-agents (claude, codex)',
  notebook: 'editing Jupyter notebooks (claude)',
  memories: "the provider's own stored memories (codex)",
};

export function isToolCapability(value: string): value is ToolCapability {
  return (TOOL_CAPABILITIES as readonly string[]).includes(value);
}

/** A typo must not silently cost a task its access, so an unknown name throws. */
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
