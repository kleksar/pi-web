import type { SubagentOrchestration } from "./subagents";

const MAX_SOURCES = 8;

export type OrchestrationLinkIssue =
  | { type: "unknown"; names: string[]; firstKind: "child" | "source" }
  | { type: "self"; name: string }
  | { type: "limit"; name: string }
  | { type: "cycle"; names: string[] };

const key = (name: string) => name.toLowerCase();

/** Check both types of sibling links together: either type can complete a cycle. */
export function findOrchestrationLinkIssue(
  children: readonly string[],
  dependencies: Record<string, string[]> = {},
  contextProviders: Record<string, string[]> = {},
): OrchestrationLinkIssue | null {
  const known = new Map(children.map((name) => [key(name), name]));
  const unknown = new Set<string>();
  let firstKind: "child" | "source" = "child";
  const graph = new Map<string, string[]>();
  let self: string | undefined;

  for (const relation of [dependencies, contextProviders]) {
    for (const [consumer, producers] of Object.entries(relation)) {
      const consumerName = known.get(key(consumer));
      if (!consumerName) {
        if (unknown.size === 0) firstKind = "child";
        unknown.add(consumer);
      }
      for (const producer of producers) {
        const producerName = known.get(key(producer));
        if (!producerName) {
          if (unknown.size === 0) firstKind = "source";
          unknown.add(producer);
        }
        if (!consumerName || !producerName) continue;
        if (key(consumerName) === key(producerName)) self = consumerName;
        const edges = graph.get(consumerName) ?? [];
        if (!edges.includes(producerName)) edges.push(producerName);
        graph.set(consumerName, edges);
      }
    }
  }
  if (unknown.size > 0) return { type: "unknown", names: [...unknown], firstKind };
  if (self) return { type: "self", name: self };
  for (const name of children) {
    const prerequisites = Object.entries(dependencies).find(([consumer]) => key(consumer) === key(name))?.[1] ?? [];
    const providers = Object.entries(contextProviders).find(([consumer]) => key(consumer) === key(name))?.[1] ?? [];
    if (prerequisites.length > MAX_SOURCES || providers.length > MAX_SOURCES || (graph.get(name)?.length ?? 0) > MAX_SOURCES) {
      return { type: "limit", name };
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (name: string): string[] | null => {
    if (visiting.has(name)) return [...path.slice(path.indexOf(name)), name];
    if (visited.has(name)) return null;
    visiting.add(name);
    path.push(name);
    for (const producer of graph.get(name) ?? []) {
      const cycle = visit(producer);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(name);
    visited.add(name);
    return null;
  };
  for (const name of children) {
    const cycle = visit(name);
    if (cycle) return { type: "cycle", names: cycle };
  }
  return null;
}

/** Drop links to or from children removed from one coordinator's policy. */
export function withAllowedChildren(
  policy: SubagentOrchestration,
  allowedChildren: readonly string[],
): SubagentOrchestration {
  const allowed = new Set(allowedChildren.map(key));
  const prune = (relation?: Record<string, string[]>): Record<string, string[]> | undefined => {
    const remaining = Object.fromEntries(Object.entries(relation ?? {})
      .filter(([consumer]) => allowed.has(key(consumer)))
      .map(([consumer, producers]) => [consumer, producers.filter((producer) => allowed.has(key(producer)))])
      .filter(([, producers]) => producers.length > 0));
    return Object.keys(remaining).length ? remaining : undefined;
  };
  const dependencies = prune(policy.dependencies);
  const contextProviders = prune(policy.contextProviders);
  return {
    allowedChildren: [...allowedChildren],
    ...(dependencies ? { dependencies } : {}),
    ...(contextProviders ? { contextProviders } : {}),
  };
}
