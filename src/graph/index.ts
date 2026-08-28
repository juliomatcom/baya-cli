/**
 * Graph layer (architecture.md #3). Pure: topological layering, ready-set
 * computation, descendant marking. No I/O, no clock — this is where scheduling
 * logic belongs so it is cheap to test.
 *
 * Operates on a minimal node shape rather than `Task`, so nothing here has to
 * change when the manifest grows a field.
 */
export interface GraphNode {
  id: string;
  depends_on: string[];
}

export interface Graph {
  readonly ids: string[];
  /** id -> its dependencies. */
  readonly deps: ReadonlyMap<string, readonly string[]>;
  /** id -> the tasks that depend on it. */
  readonly dependents: ReadonlyMap<string, readonly string[]>;
}

export function buildGraph(nodes: readonly GraphNode[]): Graph {
  const ids = nodes.map((node) => node.id);
  const deps = new Map<string, readonly string[]>();
  const dependents = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const node of nodes) {
    deps.set(node.id, [...node.depends_on]);
  }
  for (const node of nodes) {
    for (const dep of node.depends_on) {
      dependents.get(dep)?.push(node.id);
    }
  }
  return { ids, deps, dependents };
}

/**
 * Kahn layering: layer *n* holds every task whose dependencies all sit in
 * layers < *n*. Disconnected components interleave naturally — a root with no
 * dependencies is in layer 0 no matter which component it belongs to.
 *
 * Within a layer the manifest's own order is preserved, so a plan renders and
 * executes identically on every run.
 *
 * Assumes the graph is acyclic and its dependencies resolve; `validateManifest`
 * has already established both. A cycle here yields truncated layers rather
 * than looping forever.
 */
export function topoLayers(nodes: readonly GraphNode[]): string[][] {
  const graph = buildGraph(nodes);
  const remaining = new Map<string, number>(
    nodes.map((node) => [node.id, node.depends_on.length]),
  );
  const layers: string[][] = [];
  let frontier = nodes.filter((node) => node.depends_on.length === 0).map((n) => n.id);

  while (frontier.length > 0) {
    layers.push(frontier);
    const next: string[] = [];
    for (const id of frontier) {
      for (const dependent of graph.dependents.get(id) ?? []) {
        const left = (remaining.get(dependent) ?? 0) - 1;
        remaining.set(dependent, left);
        if (left === 0) next.push(dependent);
      }
    }
    // Restore manifest order: `next` is built in completion order, not plan order.
    frontier = nodes.filter((node) => next.includes(node.id)).map((n) => n.id);
  }

  return layers;
}

/** A flat topological order — layers concatenated. */
export function topoOrder(nodes: readonly GraphNode[]): string[] {
  return topoLayers(nodes).flat();
}

/** The scheduler's view of a task. Mirrors `TaskState`; only `succeeded` unblocks. */
export type ReadyState =
  "pending" | "running" | "succeeded" | "failed" | "skipped" | "parked";

/**
 * The tasks the scheduler may admit right now: still `pending`, with every
 * dependency `succeeded`. Budgets and locks narrow this further; the graph
 * only answers "are its inputs there?".
 */
export function readySet(
  nodes: readonly GraphNode[],
  states: ReadonlyMap<string, ReadyState>,
): string[] {
  return nodes
    .filter((node) => states.get(node.id) === "pending")
    .filter((node) => node.depends_on.every((dep) => states.get(dep) === "succeeded"))
    .map((node) => node.id);
}

/**
 * Every task transitively downstream of `id`. A failure marks these `skipped`,
 * never `failed` — the distinction drives both the exit code and the report.
 */
export function descendantsOf(nodes: readonly GraphNode[], id: string): Set<string> {
  const graph = buildGraph(nodes);
  const found = new Set<string>();
  const queue = [...(graph.dependents.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (found.has(next)) continue;
    found.add(next);
    queue.push(...(graph.dependents.get(next) ?? []));
  }
  return found;
}
