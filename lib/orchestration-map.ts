import type { SubagentOrchestration, SubagentProfile } from "./subagents";

/** Impossible for a persisted agent name (which matches /^[a-zA-Z0-9_-]+$/). */
export const MAIN_NODE_ID = "\u0000main";
export const MAP_NODE_WIDTH = 216;
export const MAP_NODE_HEIGHT = 100;
export const MAP_MIN_SCALE = 0.22;

export type OrchestrationMapLayer = "delegation" | "dependencies";
export type OrchestrationMapOwner = typeof MAIN_NODE_ID | string;
export type MapProfile = Pick<SubagentProfile,
  "name" | "displayName" | "scope" | "enabled" | "orchestration" | "description" | "configurationError"
> & Partial<Pick<SubagentProfile,
  "model" | "thinking" | "tools" | "extensionTools" | "selectedSkills" | "selectedExtensionTools" | "loadSkills" | "loadExtensions"
>>;

export interface MapNode {
  id: string;
  label: string;
  kind: "main" | "orchestrator" | "specialist" | "missing";
  enabled: boolean;
  scope?: SubagentProfile["scope"];
  x: number;
  y: number;
}

export interface MapEdge {
  ownerId: OrchestrationMapOwner;
  source: string;
  target: string;
  kind: OrchestrationMapLayer;
}

export interface OrchestrationGraph {
  nodes: MapNode[];
  edges: MapEdge[];
  /** Matching agents before paths and adjacent nodes are added for context. */
  matchCount: number;
}

/** Fit readable nodes in the viewport; anchor the root when the minimum zoom still overflows. */
export function fitOrchestrationMap(
  nodes: readonly MapNode[], width: number, height: number, rootId: string,
): { x: number; y: number; scale: number } | null {
  if (!nodes.length) return null;
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + MAP_NODE_WIDTH));
  const bottom = Math.max(...nodes.map((node) => node.y + MAP_NODE_HEIGHT));
  const scale = Math.max(MAP_MIN_SCALE, Math.min(1, (width - 72) / (right - left), (height - 72) / (bottom - top)));
  const root = nodes.find((node) => node.id === rootId) ?? nodes[0];
  const position = (size: number, start: number, span: number, rootPosition: number) =>
    span * scale > size - 72 ? 36 - rootPosition * scale : (size - span * scale) / 2 - start * scale;
  return { x: position(width, left, right - left, root.x),
    y: position(height, top, bottom - top, root.y), scale };
}

const priority = { builtin: 0, global: 1, workspace: 2, project: 3 } as const;
const key = (name: string) => name.toLowerCase();
const byLabel = (left: MapProfile, right: MapProfile) => left.displayName.localeCompare(right.displayName);

/** Sources may contain shadows. An inactive higher-priority source still shadows an active one. */
export function effectiveMapProfiles<T extends MapProfile>(sources: readonly T[]): T[] {
  const effective = new Map<string, T>();
  for (const source of sources) {
    const existing = effective.get(key(source.name));
    if (!existing || priority[source.scope] > priority[existing.scope]) effective.set(key(source.name), source);
  }
  return [...effective.values()].sort(byLabel);
}

export function findMapProfile<T extends MapProfile>(profiles: readonly T[], name: string): T | undefined {
  return profiles.find((profile) => key(profile.name) === key(name));
}

/** Older Main sessions have unrestricted delegation. The first edit materializes this list. */
export function mainPolicyForMap(profiles: readonly MapProfile[], main?: SubagentOrchestration | null): SubagentOrchestration {
  return main ?? { allowedChildren: effectiveMapProfiles(profiles)
    .filter((profile) => profile.enabled && !profile.configurationError)
    .map((profile) => profile.name) };
}

export function orchestrationForOwner(
  ownerId: OrchestrationMapOwner,
  profiles: readonly MapProfile[],
  main: SubagentOrchestration | null,
  selectedOwnerId: OrchestrationMapOwner | null,
  draft?: SubagentOrchestration | null,
): SubagentOrchestration | null {
  if (selectedOwnerId !== null && key(ownerId) === key(selectedOwnerId) && draft !== undefined) {
    return ownerId === MAIN_NODE_ID ? mainPolicyForMap(profiles, draft) : draft;
  }
  return ownerId === MAIN_NODE_ID ? mainPolicyForMap(profiles, main) : findMapProfile(profiles, ownerId)?.orchestration ?? null;
}

export function mapPathFromMain(
  targetId: string,
  profiles: readonly MapProfile[],
  main: SubagentOrchestration | null,
): string[] {
  if (targetId === MAIN_NODE_ID) return [MAIN_NODE_ID];
  const normalizedMain = mainPolicyForMap(profiles, main);
  const queue: string[][] = [[MAIN_NODE_ID]];
  const seen = new Set([MAIN_NODE_ID]);
  while (queue.length) {
    const path = queue.shift()!;
    const owner = path[path.length - 1];
    const orchestration = owner === MAIN_NODE_ID ? normalizedMain : findMapProfile(profiles, owner)?.orchestration;
    for (const child of orchestration?.allowedChildren ?? []) {
      if (key(child) === key(targetId)) return [...path, findMapProfile(profiles, child)?.name ?? child];
      const canonical = key(child);
      if (!seen.has(canonical)) {
        seen.add(canonical);
        queue.push([...path, child]);
      }
    }
  }
  return [targetId];
}

function buildEdges(
  ownerId: OrchestrationMapOwner,
  orchestration: SubagentOrchestration | null,
  layer: OrchestrationMapLayer,
  profiles: readonly MapProfile[],
): MapEdge[] {
  if (!orchestration) return [];
  const childIds = new Map(orchestration.allowedChildren.map((name) => [key(name), findMapProfile(profiles, name)?.name ?? name]));
  if (layer === "delegation") {
    return [...childIds.values()].map((target) => ({ kind: layer, ownerId, source: ownerId, target }));
  }
  return Object.entries(orchestration.dependencies ?? {}).flatMap(([consumer, producers]) => {
    const target = childIds.get(key(consumer));
    return target ? producers.flatMap((producer) => {
      const source = childIds.get(key(producer));
      return source ? [{ kind: layer, ownerId, source, target }] : [];
    }) : [];
  });
}

/** A flat overview or one owner's direct children. No source file is modified. */
export function buildOrchestrationGraph({ profiles: sources, main, ownerId, draft, layer, query = "" }: {
  profiles: readonly MapProfile[];
  main: SubagentOrchestration | null;
  ownerId: OrchestrationMapOwner | null;
  draft?: SubagentOrchestration | null;
  layer: OrchestrationMapLayer;
  query?: string;
}): OrchestrationGraph {
  const profiles = effectiveMapProfiles(sources);
  const selectedPolicy = ownerId === null ? null : orchestrationForOwner(ownerId, profiles, main, ownerId, draft);
  const owners = ownerId === null ? [MAIN_NODE_ID, ...profiles.filter((profile) => profile.orchestration).map((profile) => profile.name)] : [ownerId];
  const edges = owners.flatMap((owner) => buildEdges(
    owner,
    ownerId !== null ? selectedPolicy : orchestrationForOwner(owner, profiles, main, ownerId, draft),
    layer,
    profiles,
  ));
  const wanted = new Set<string>(ownerId === null
    ? [MAIN_NODE_ID, ...profiles.map((profile) => profile.name)]
    : [ownerId, ...(selectedPolicy?.allowedChildren ?? [])]);
  const byName = new Map(profiles.map((profile) => [key(profile.name), profile]));
  const nodes: MapNode[] = [...wanted].map((id) => {
    if (id === MAIN_NODE_ID) return { id, label: "Main", kind: "main", enabled: true, x: 0, y: 0 };
    const profile = byName.get(key(id));
    return profile ? {
      id: profile.name,
      label: profile.displayName,
      kind: profile.orchestration ? "orchestrator" : "specialist",
      enabled: profile.enabled && !profile.configurationError,
      scope: profile.scope,
      x: 0,
      y: 0,
    } : { id, label: id, kind: "missing", enabled: false, x: 0, y: 0 };
  });
  const needle = query.trim().toLowerCase();
  const matches = needle ? nodes.filter((node) =>
    node.id.toLowerCase().includes(needle) || node.label.toLowerCase().includes(needle)
  ) : nodes;
  const matchedIds = new Set(matches.map((node) => node.id));
  const visibleIds = new Set(matchedIds);
  if (needle) {
    visibleIds.add(ownerId ?? MAIN_NODE_ID);
    if (layer === "delegation" && ownerId === null) {
      // Keep the shortest delegation path from Main so a found agent still has visible lineage.
      for (const node of matches) {
        for (const id of mapPathFromMain(node.id, profiles, main)) {
          visibleIds.add(findMapProfile(profiles, id)?.name ?? id);
        }
      }
    } else if (layer === "dependencies") {
      // A filtered dependency is useful only with its other endpoint and owner visible.
      // Expand once from the actual matches; expanding recursively can restore the full roster.
      for (const edge of edges) {
        if (matchedIds.has(edge.source) || matchedIds.has(edge.target) || matchedIds.has(edge.ownerId)) {
          visibleIds.add(edge.source);
          visibleIds.add(edge.target);
          visibleIds.add(edge.ownerId);
        }
      }
    }
  }
  const visible = nodes.filter((node) => visibleIds.has(node.id));
  const shownEdges = edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  return { nodes: autoLayoutGraph(visible, shownEdges, ownerId), edges: shownEdges, matchCount: matches.length };
}

/** Cycle tolerant: an overview may contain reciprocal delegations even though runtime has a depth limit. */
export function autoLayoutGraph(nodes: readonly MapNode[], edges: readonly MapEdge[], ownerId: string | null): MapNode[] {
  const ids = new Set(nodes.map((node) => node.id));
  const depth = new Map<string, number>();
  if (ids.has(MAIN_NODE_ID)) depth.set(MAIN_NODE_ID, 0);
  if (ownerId !== null) depth.set(ownerId, 0);
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const children = outgoing.get(edge.source) ?? [];
    children.push(edge.target);
    outgoing.set(edge.source, children);
  }
  if (ownerId !== null && edges.some((edge) => edge.kind === "dependencies")) {
    const waiting = new Map(nodes.filter((node) => node.id !== ownerId).map((node) => [node.id, 0]));
    for (const edge of edges) if (waiting.has(edge.target)) waiting.set(edge.target, (waiting.get(edge.target) ?? 0) + 1);
    const queue = [...waiting].filter(([, count]) => count === 0).map(([id]) => id);
    for (const id of waiting.keys()) depth.set(id, 1);
    for (let index = 0; index < queue.length; index++) {
      const source = queue[index];
      for (const target of outgoing.get(source) ?? []) {
        depth.set(target, Math.max(depth.get(target) ?? 1, Math.min((depth.get(source) ?? 1) + 1, 5)));
        const count = (waiting.get(target) ?? 0) - 1;
        waiting.set(target, count);
        if (count === 0) queue.push(target);
      }
    }
  } else {
    const queue = [...depth.keys()];
    for (let index = 0; index < queue.length; index++) {
      const source = queue[index];
      for (const target of outgoing.get(source) ?? []) {
        if (depth.has(target)) continue;
        depth.set(target, Math.min((depth.get(source) ?? 0) + 1, 5));
        queue.push(target);
      }
    }
  }
  for (const node of nodes) if (!depth.has(node.id)) depth.set(node.id, 1);
  const rows = new Map<number, number>();
  return nodes.map((node) => {
    const column = depth.get(node.id) ?? 1;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { ...node, x: 44 + column * 290, y: 40 + row * 136 };
  });
}

export type LinkChangeResult = { ok: true; next: SubagentOrchestration } | { ok: false; error: string };

export function changeChildLink(
  ownerId: string,
  policy: SubagentOrchestration,
  childName: string,
  enabled: boolean,
  profiles: readonly MapProfile[],
): LinkChangeResult {
  const profile = findMapProfile(effectiveMapProfiles(profiles), childName);
  if (enabled && (!profile || !profile.enabled || profile.configurationError)) return { ok: false, error: "Choose an available agent profile." };
  if (enabled && key(ownerId) === key(childName)) return { ok: false, error: "An orchestrator cannot delegate to itself." };
  const allowedChildren = enabled
    ? policy.allowedChildren.some((name) => key(name) === key(childName)) ? [...policy.allowedChildren] : [...policy.allowedChildren, profile!.name]
    : policy.allowedChildren.filter((name) => key(name) !== key(childName));
  const allowed = new Set(allowedChildren.map(key));
  const dependencies = Object.fromEntries(Object.entries(policy.dependencies ?? {})
    .filter(([consumer]) => allowed.has(key(consumer)))
    .map(([consumer, producers]) => [consumer, producers.filter((producer) => allowed.has(key(producer)))])
    .filter(([, producers]) => producers.length > 0));
  return { ok: true, next: { allowedChildren, ...(Object.keys(dependencies).length ? { dependencies } : {}) } };
}

export function changeDependencyLink(
  policy: SubagentOrchestration,
  producer: string,
  consumer: string,
  enabled: boolean,
): LinkChangeResult {
  const names = new Map(policy.allowedChildren.map((name) => [key(name), name]));
  const from = names.get(key(producer));
  const to = names.get(key(consumer));
  if (!from || !to) return { ok: false, error: "Both agents must be direct children of this orchestrator." };
  if (key(from) === key(to)) return { ok: false, error: "An agent cannot depend on itself." };
  const dependencies = Object.fromEntries(Object.entries(policy.dependencies ?? {}).map(([name, values]) => [name, [...values]]));
  const oldKey = Object.keys(dependencies).find((name) => key(name) === key(to));
  const before = oldKey ? dependencies[oldKey] : [];
  if (oldKey) delete dependencies[oldKey];
  const after = enabled
    ? before.some((name) => key(name) === key(from)) ? before : [...before, from]
    : before.filter((name) => key(name) !== key(from));
  if (after.length > 8) return { ok: false, error: "An agent may have at most 8 prerequisites." };
  if (after.length) dependencies[to] = after;
  const graph = new Map<string, string[]>(Object.entries(dependencies).map(([name, values]) => [key(name), values.map(key)]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): boolean => {
    if (visiting.has(name)) return true;
    if (visited.has(name)) return false;
    visiting.add(name);
    for (const dependency of graph.get(name) ?? []) if (visit(dependency)) return true;
    visiting.delete(name);
    visited.add(name);
    return false;
  };
  if (policy.allowedChildren.some((name) => visit(key(name)))) return { ok: false, error: "This link creates a dependency cycle." };
  return { ok: true, next: { allowedChildren: [...policy.allowedChildren], ...(Object.keys(dependencies).length ? { dependencies } : {}) } };
}
