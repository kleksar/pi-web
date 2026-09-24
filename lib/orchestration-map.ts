import type { SubagentOrchestration, SubagentProfile } from "./subagents";
import { MAP_NODE_HEIGHT, MAP_NODE_WIDTH } from "./orchestration-map-size.mjs";
export { MAP_NODE_HEIGHT, MAP_NODE_WIDTH } from "./orchestration-map-size.mjs";

/** Impossible for a persisted agent name (which matches /^[a-zA-Z0-9_-]+$/). */
export const MAIN_NODE_ID = "\u0000main";
export const MAP_MIN_SCALE = 0.22;
export const MAP_READABLE_SCALE = 0.75;

export type OrchestrationMapLayer = "all" | "delegation" | "dependencies" | "contextProviders";
export type OrchestrationMapEdgeKind = Exclude<OrchestrationMapLayer, "all">;
export type OrchestrationMapOwner = typeof MAIN_NODE_ID | string;
export type MapProfile = Pick<SubagentProfile,
  "name" | "displayName" | "scope" | "enabled" | "orchestration" | "description" | "configurationError"
> & Partial<Pick<SubagentProfile,
  "model" | "thinking" | "fastMode" | "tools" | "extensionTools" | "selectedSkills" | "selectedExtensionTools" | "loadSkills" | "loadExtensions"
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
  kind: OrchestrationMapEdgeKind;
}

export interface OrchestrationGraph {
  nodes: MapNode[];
  edges: MapEdge[];
  /** Matching agents before paths and adjacent nodes are added for context. */
  matchCount: number;
  /** Profiles outside Main's delegation tree in a connected overview. */
  unreachableAgentIds: string[];
}

/** Geometry may change when a new route appears even if every card stays put. */
export function orchestrationLayoutFingerprint(storageKey: string, nodes: readonly MapNode[], edges: readonly MapEdge[]): string {
  return JSON.stringify([storageKey,
    nodes.map((node) => [node.id, node.x, node.y]),
    edges.map((edge) => [edge.kind, edge.ownerId, edge.source, edge.target])]);
}

/** The overview is a navigation surface. The full graph remains available for search and editing. */
export function navigationOrchestrationGraph(graph: OrchestrationGraph, directChildren: readonly string[], limit = 12):
  OrchestrationGraph & { hiddenDirectCount: number } {
  const children = new Set(directChildren.map(key));
  const direct = graph.nodes.filter((node) => children.has(key(node.id)) && node.id !== MAIN_NODE_ID);
  // Keep coordinators visible first; specialists still appear when space permits.
  const shown = [...direct.filter((node) => node.kind === "orchestrator"),
    ...direct.filter((node) => node.kind !== "orchestrator")].slice(0, limit);
  const visible = new Set([MAIN_NODE_ID, ...shown.map((node) => node.id)]);
  const nodes = graph.nodes.filter((node) => visible.has(node.id));
  const edges = graph.edges.filter((edge) => edge.kind === "delegation" && edge.source === MAIN_NODE_ID && visible.has(edge.target));
  return { ...graph, nodes: autoLayoutGraph(nodes, edges, null), edges, hiddenDirectCount: direct.length - shown.length };
}

/** Keep large owner branches usable without drawing hundreds of cards at once. */
export function windowOrchestrationBranch(graph: OrchestrationGraph, ownerId: string,
  layer: OrchestrationMapEdgeKind, limit = 24, focus: { edge?: MapEdge; nodeId?: string } = {}):
  OrchestrationGraph & { hiddenDirectCount: number } {
  const activeEdges = filterOrchestrationEdges(graph.edges, layer);
  const layout = autoLayoutGraph(graph.nodes, activeEdges, ownerId);
  const children = layout.filter((node) => node.id !== ownerId)
    .sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id));
  const available = new Set(children.map((node) => node.id));
  const shown = new Set([ownerId]);
  if (focus.edge?.ownerId === ownerId && focus.edge.kind === layer) {
    for (const id of [focus.edge.source, focus.edge.target]) {
      if (available.has(id) && shown.size - 1 < limit) shown.add(id);
    }
  }
  if (focus.nodeId && available.has(focus.nodeId) && shown.size - 1 < limit) shown.add(focus.nodeId);
  // Reserve the first slots for real relations; a late pair must not leave the
  // first page looking unrelated while this layer actually contains links.
  if (layer !== "delegation") for (const edge of activeEdges) {
    if (!available.has(edge.source) || !available.has(edge.target)) continue;
    const additional = [edge.source, edge.target].filter((id) => !shown.has(id));
    if (shown.size - 1 + additional.length > limit) continue;
    additional.forEach((id) => shown.add(id));
  }
  for (const child of children) {
    if (shown.size - 1 >= limit) break;
    shown.add(child.id);
  }
  return { ...graph, nodes: layout.filter((node) => shown.has(node.id)),
    edges: graph.edges.filter((edge) => shown.has(edge.source) && shown.has(edge.target)),
    hiddenDirectCount: children.length - (shown.size - 1) };
}

/** Display-only filter: keep graph layout and owner policy unchanged. */
export function filterOrchestrationEdges(edges: readonly MapEdge[], layer: OrchestrationMapLayer): MapEdge[] {
  return layer === "all" ? [...edges] : edges.filter((edge) => edge.kind === layer);
}

/** Explicit overview action: fit every node, even when labels become too small to read. */
export function fitOrchestrationMap(
  nodes: readonly MapNode[], width: number, height: number, rootId: string, routePoints: readonly { x: number; y: number }[] = [],
): { x: number; y: number; scale: number } | null {
  if (!nodes.length) return null;
  const left = Math.min(...nodes.map((node) => node.x), ...routePoints.map((point) => point.x));
  const top = Math.min(...nodes.map((node) => node.y), ...routePoints.map((point) => point.y));
  const right = Math.max(...nodes.map((node) => node.x + MAP_NODE_WIDTH), ...routePoints.map((point) => point.x));
  const bottom = Math.max(...nodes.map((node) => node.y + MAP_NODE_HEIGHT), ...routePoints.map((point) => point.y));
  const scale = Math.min(1, Math.max(1, width - 72) / (right - left), Math.max(1, height - 72) / (bottom - top));
  const root = nodes.find((node) => node.id === rootId) ?? nodes[0];
  const position = (size: number, start: number, span: number, rootPosition: number) =>
    span * scale > size - 72 ? 36 - rootPosition * scale : (size - span * scale) / 2 - start * scale;
  return { x: position(width, left, right - left, root.x),
    y: position(height, top, bottom - top, root.y), scale };
}

/** Open a large branch at a legible scale. Fit all remains a separate, explicit action. */
export function readableOrchestrationMap(
  nodes: readonly MapNode[], width: number, height: number, rootId: string, routePoints: readonly { x: number; y: number }[] = [],
): { x: number; y: number; scale: number } | null {
  const fitted = fitOrchestrationMap(nodes, width, height, rootId, routePoints);
  if (!fitted || fitted.scale >= MAP_READABLE_SCALE) return fitted;
  const left = Math.min(...nodes.map((node) => node.x), ...routePoints.map((point) => point.x));
  const right = Math.max(...nodes.map((node) => node.x + MAP_NODE_WIDTH), ...routePoints.map((point) => point.x));
  const top = Math.min(...nodes.map((node) => node.y), ...routePoints.map((point) => point.y));
  const bottom = Math.max(...nodes.map((node) => node.y + MAP_NODE_HEIGHT), ...routePoints.map((point) => point.y));
  const root = nodes.find((node) => node.id === rootId) ?? nodes[0];
  const position = (size: number, start: number, span: number, rootPosition: number) =>
    span * MAP_READABLE_SCALE > size - 72
      ? 36 - rootPosition * MAP_READABLE_SCALE
      : (size - span * MAP_READABLE_SCALE) / 2 - start * MAP_READABLE_SCALE;
  return { x: position(width, left, right - left, root.x),
    y: position(height, top, bottom - top, root.y), scale: MAP_READABLE_SCALE };
}

/** Center a selected card at a readable zoom, including after a tiny Fit all overview. */
export function centerOrchestrationMapNode(node: MapNode, width: number, height: number, scale: number) {
  return { x: width / 2 - (node.x + MAP_NODE_WIDTH / 2) * scale,
    y: height / 2 - (node.y + MAP_NODE_HEIGHT / 2) * scale, scale };
}

const priority = { builtin: 0, roster: 1, global: 2, workspace: 3, project: 4 } as const;
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

/** An agent's prerequisites belong to the coordinator that launches it. */
export function mapOwnersForAgent(
  agentId: string,
  profiles: readonly MapProfile[],
  main: SubagentOrchestration | null,
  activeOwnerId: OrchestrationMapOwner | null = null,
  draft?: SubagentOrchestration | null,
): OrchestrationMapOwner[] {
  const effective = effectiveMapProfiles(profiles);
  const owners: OrchestrationMapOwner[] = [];
  const mainPolicy = activeOwnerId === MAIN_NODE_ID && draft !== undefined ? mainPolicyForMap(effective, draft) : mainPolicyForMap(effective, main);
  if (mainPolicy.allowedChildren.some((child) => key(child) === key(agentId))) {
    owners.push(MAIN_NODE_ID);
  }
  for (const profile of effective) {
    const policy = activeOwnerId !== null && key(activeOwnerId) === key(profile.name) && draft !== undefined
      ? draft : profile.orchestration;
    if (policy?.allowedChildren.some((child) => key(child) === key(agentId))) {
      owners.push(profile.name);
    }
  }
  return owners;
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
  const delegation: MapEdge[] = layer === "dependencies" || layer === "contextProviders" ? [] : [...childIds.values()]
    .map((target) => ({ kind: "delegation", ownerId, source: ownerId, target }));
  const prerequisites: MapEdge[] = layer === "delegation" || layer === "contextProviders" ? [] : Object.entries(orchestration.dependencies ?? {}).flatMap(([consumer, producers]) => {
    const target = childIds.get(key(consumer));
    return target ? producers.flatMap((producer) => {
      const source = childIds.get(key(producer));
      return source ? [{ kind: "dependencies" as const, ownerId, source, target }] : [];
    }) : [];
  });
  const providers: MapEdge[] = layer === "delegation" || layer === "dependencies" ? [] : Object.entries(orchestration.contextProviders ?? {}).flatMap(([consumer, producers]) => {
    const target = childIds.get(key(consumer));
    return target ? producers.flatMap((producer) => {
      const source = childIds.get(key(producer));
      return source ? [{ kind: "contextProviders" as const, ownerId, source, target }] : [];
    }) : [];
  });
  return [...delegation, ...prerequisites, ...providers];
}

/** A flat overview or one owner's direct children. No source file is modified. */
export function buildOrchestrationGraph({ profiles: sources, main, ownerId, draft, layer, query = "", exactQuery = false, connectedOnly = false }: {
  profiles: readonly MapProfile[];
  main: SubagentOrchestration | null;
  ownerId: OrchestrationMapOwner | null;
  draft?: SubagentOrchestration | null;
  layer: OrchestrationMapLayer;
  query?: string;
  /** Programmatic navigation to one profile; typed search remains substring-based. */
  exactQuery?: boolean;
  /** Hide profiles outside Main's delegation tree in an unsearched overview. */
  connectedOnly?: boolean;
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
  const byName = new Map(profiles.map((profile) => [key(profile.name), profile]));
  const needle = query.trim().toLowerCase();
  const connectedOverview = ownerId === null && connectedOnly;
  const reachable = new Set<string>([MAIN_NODE_ID]);
  if (connectedOverview) {
    const queue = [MAIN_NODE_ID];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      const policy = current === MAIN_NODE_ID ? mainPolicyForMap(profiles, main)
        : byName.get(key(current))?.orchestration;
      for (const target of policy?.allowedChildren ?? []) {
        if (reachable.has(key(target))) continue;
        reachable.add(key(target));
        queue.push(target);
      }
    }
  }
  const unreachableAgentIds = connectedOverview
    ? profiles.filter((profile) => !reachable.has(key(profile.name))).map((profile) => profile.name)
    : [];
  const restrictToReachable = connectedOverview && !needle;
  const wanted = new Set<string>(ownerId === null
    ? [MAIN_NODE_ID, ...profiles.filter((profile) => !restrictToReachable || reachable.has(key(profile.name)))
      .map((profile) => profile.name)]
    : [ownerId, ...(selectedPolicy?.allowedChildren ?? [])]);
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
  const matches = needle ? nodes.filter((node) => exactQuery
    ? node.id.toLowerCase() === needle
    : node.id.toLowerCase().includes(needle) || node.label.toLowerCase().includes(needle)) : nodes;
  const matchedIds = new Set(matches.map((node) => node.id));
  const visibleIds = new Set(matchedIds);
  if (needle) {
    visibleIds.add(ownerId ?? MAIN_NODE_ID);
    if (layer !== "dependencies" && layer !== "contextProviders" && ownerId === null) {
      // Keep the shortest delegation path from Main so a found agent still has visible lineage.
      // Traverse once: searching for many matching profiles must not repeat the
      // same breadth-first search for every matching node.
      const parents = new Map<string, string | null>([[MAIN_NODE_ID, null]]);
      const queue = [MAIN_NODE_ID];
      for (let index = 0; index < queue.length; index++) {
        const owner = queue[index];
        const orchestration = owner === MAIN_NODE_ID
          ? mainPolicyForMap(profiles, main) : byName.get(key(owner))?.orchestration;
        for (const child of orchestration?.allowedChildren ?? []) {
          const normalized = key(child);
          if (parents.has(normalized)) continue;
          parents.set(normalized, owner);
          queue.push(child);
        }
      }
      for (const node of matches) {
        let current: string | null = key(node.id);
        while (current !== null && parents.has(current)) {
          visibleIds.add(current === MAIN_NODE_ID ? MAIN_NODE_ID : byName.get(current)?.name ?? current);
          current = parents.get(current) ?? null;
        }
      }
    }
    if (layer !== "delegation") {
      // A filtered dependency is useful only with its other endpoint and owner visible.
      // Expand once from the actual matches; expanding recursively can restore the full roster.
      for (const edge of edges.filter((edge) => edge.kind !== "delegation")) {
        if (matchedIds.has(edge.source) || matchedIds.has(edge.target) || matchedIds.has(edge.ownerId)) {
          visibleIds.add(edge.source);
          visibleIds.add(edge.target);
          visibleIds.add(edge.ownerId);
        }
      }
    }
  }
  const visible = nodes.filter((node) => visibleIds.has(node.id));
  const shownEdges = edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)
    && (!restrictToReachable || visibleIds.has(edge.ownerId)));
  return { nodes: autoLayoutGraph(visible, shownEdges, ownerId), edges: shownEdges,
    matchCount: matches.length, unreachableAgentIds };
}

/** Cycle tolerant: an overview may contain reciprocal delegations even though runtime has a depth limit. */
export function autoLayoutGraph(nodes: readonly MapNode[], edges: readonly MapEdge[], ownerId: string | null): MapNode[] {
  if (ownerId !== null) return layoutOwnerBranch(nodes, edges, ownerId);
  const ids = new Set(nodes.map((node) => node.id));
  const depth = new Map<string, number>();
  if (ids.has(MAIN_NODE_ID)) depth.set(MAIN_NODE_ID, 0);
  if (ownerId !== null) depth.set(ownerId, 0);
  const outgoing = new Map<string, string[]>();
  const layoutEdges = ownerId !== null && edges.some((edge) => edge.kind !== "delegation")
    ? edges.filter((edge) => edge.kind !== "delegation")
    : edges.filter((edge) => edge.kind === "delegation");
  for (const edge of layoutEdges) {
    const children = outgoing.get(edge.source) ?? [];
    children.push(edge.target);
    outgoing.set(edge.source, children);
  }
  if (ownerId !== null && edges.some((edge) => edge.kind !== "delegation")) {
    const waiting = new Map(nodes.filter((node) => node.id !== ownerId).map((node) => [node.id, 0]));
    for (const edge of layoutEdges) if (waiting.has(edge.target)) waiting.set(edge.target, (waiting.get(edge.target) ?? 0) + 1);
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
  if (ownerId === null) {
    // Keep children near their parents instead of interleaving unrelated
    // branches by profile label. Shared children take the average position of
    // their parents in the previous column; stable input order breaks ties.
    const incoming = new Map<string, string[]>();
    for (const edge of layoutEdges) {
      if ((depth.get(edge.source) ?? -1) !== (depth.get(edge.target) ?? 0) - 1) continue;
      const parents = incoming.get(edge.target) ?? [];
      parents.push(edge.source);
      incoming.set(edge.target, parents);
    }
    const columns = new Map<number, MapNode[]>();
    for (const node of nodes) {
      const column = depth.get(node.id) ?? 1;
      const members = columns.get(column) ?? [];
      members.push(node);
      columns.set(column, members);
    }
    const ranks = new Map<string, number>();
    const positions = new Map<string, number>();
    for (const column of [...columns.keys()].sort((left, right) => left - right)) {
      const members = columns.get(column)!;
      const position = (node: MapNode) => {
        const parents = (incoming.get(node.id) ?? []).filter((id) => ranks.has(id));
        return parents.length ? parents.reduce((sum, id) => sum + ranks.get(id)!, 0) / parents.length : Infinity;
      };
      const ordered = members.map((node, index) => ({ node, index, parentPosition: position(node) }))
        .sort((left, right) => left.parentPosition - right.parentPosition || left.index - right.index);
      ordered.forEach(({ node }, row) => {
        ranks.set(node.id, row);
        positions.set(node.id, row);
      });
    }
    return nodes.map((node) => {
      const column = depth.get(node.id) ?? 1;
      return { ...node, x: 44 + column * 290, y: 40 + (positions.get(node.id) ?? 0) * 136 };
    });
  }
  const rows = new Map<number, number>();
  return nodes.map((node) => {
    const column = depth.get(node.id) ?? 1;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    return { ...node, x: 44 + column * 290, y: 40 + row * 136 };
  });
}

/** Strict prerequisites determine workflow stages. Delegation and on-demand providers do not. */
function layoutOwnerBranch(nodes: readonly MapNode[], edges: readonly MapEdge[], ownerId: string): MapNode[] {
  const children = nodes.filter((node) => node.id !== ownerId);
  const prerequisites = edges.filter((edge) => edge.kind === "dependencies" && edge.source !== ownerId && edge.target !== ownerId);
  const ranks = new Map(children.map((node) => [node.id, 1]));
  const indegree = new Map(children.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of prerequisites) {
    if (!ranks.has(edge.source) || !ranks.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const queue = children.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  for (let index = 0; index < queue.length; index++) {
    const source = queue[index];
    for (const target of outgoing.get(source) ?? []) {
      ranks.set(target, Math.max(ranks.get(target) ?? 1, (ranks.get(source) ?? 1) + 1));
      indegree.set(target, (indegree.get(target) ?? 1) - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  // Imported/legacy cyclic policies still need a stable, finite layout.
  const byStage = new Map<number, MapNode[]>();
  for (const node of children) {
    const stage = ranks.get(node.id) ?? 1;
    const members = byStage.get(stage) ?? [];
    members.push(node);
    byStage.set(stage, members);
  }
  const positions = new Map<string, number>();
  for (const stage of [...byStage.keys()].sort((a, b) => a - b)) {
    const members = byStage.get(stage)!;
    // Place consumers next to the actual producers, without packing stages back at the top.
    const ordered = members.map((node, index) => ({ node, index,
      barycentre: (() => {
        const parents = prerequisites.filter((edge) => edge.target === node.id && positions.has(edge.source));
        return parents.length ? parents.reduce((sum, edge) => sum + positions.get(edge.source)!, 0) / parents.length : Infinity;
      })(),
    })).sort((a, b) => a.barycentre - b.barycentre || a.index - b.index);
    let previousY = -Infinity;
    ordered.forEach(({ node, barycentre }, row) => {
      const preferredY = Number.isFinite(barycentre) ? barycentre : 40 + row * 136;
      const y = Math.max(40, preferredY, previousY + 136);
      positions.set(node.id, y);
      previousY = y;
    });
  }
  const stageGap = 240; // Each gap is a free routing corridor, including the root-to-child bus.
  return nodes.map((node) => {
    if (node.id === ownerId) return { ...node, x: 44, y: 40 };
    const stage = ranks.get(node.id) ?? 1;
    return { ...node, x: 44 + stage * (MAP_NODE_WIDTH + stageGap),
      y: positions.get(node.id) ?? 40 };
  });
}

export type LinkChangeResult = { ok: true; next: SubagentOrchestration } | { ok: false; error: string };

function hasCombinedCycle(policy: SubagentOrchestration): boolean {
  const graph = new Map(policy.allowedChildren.map((child) => {
    const prerequisites = Object.entries(policy.dependencies ?? {}).find(([name]) => key(name) === key(child))?.[1] ?? [];
    const providers = Object.entries(policy.contextProviders ?? {}).find(([name]) => key(name) === key(child))?.[1] ?? [];
    return [key(child), [...new Set([...prerequisites, ...providers].map(key))]] as const;
  }));
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
  return policy.allowedChildren.some((name) => visit(key(name)));
}

function exceedsProviderLimit(policy: SubagentOrchestration): boolean {
  return policy.allowedChildren.some((child) => {
    const prerequisites = Object.entries(policy.dependencies ?? {}).find(([name]) => key(name) === key(child))?.[1] ?? [];
    const providers = Object.entries(policy.contextProviders ?? {}).find(([name]) => key(name) === key(child))?.[1] ?? [];
    return new Set([...prerequisites, ...providers].map(key)).size > 8;
  });
}

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
  const contextProviders = Object.fromEntries(Object.entries(policy.contextProviders ?? {})
    .filter(([consumer]) => allowed.has(key(consumer)))
    .map(([consumer, providers]) => [consumer, providers.filter((provider) => allowed.has(key(provider)))])
    .filter(([, providers]) => providers.length > 0));
  return { ok: true, next: { allowedChildren,
    ...(Object.keys(dependencies).length ? { dependencies } : {}),
    ...(Object.keys(contextProviders).length ? { contextProviders } : {}),
  } };
}

function changeSiblingLink(
  kind: "dependencies" | "contextProviders",
  policy: SubagentOrchestration,
  source: string,
  consumer: string,
  enabled: boolean,
): LinkChangeResult {
  const names = new Map(policy.allowedChildren.map((name) => [key(name), name]));
  const from = names.get(key(source));
  const to = names.get(key(consumer));
  if (!from || !to) return { ok: false, error: "Both agents must be direct children of this orchestrator." };
  if (key(from) === key(to)) return { ok: false, error: "An agent cannot depend on itself." };
  const links = Object.fromEntries(Object.entries(policy[kind] ?? {}).map(([name, values]) => [name, [...values]]));
  const oldKey = Object.keys(links).find((name) => key(name) === key(to));
  const before = oldKey ? links[oldKey] : [];
  if (oldKey) delete links[oldKey];
  const after = enabled
    ? before.some((name) => key(name) === key(from)) ? before : [...before, from]
    : before.filter((name) => key(name) !== key(from));
  if (after.length > 8) return { ok: false, error: "An agent may have at most 8 prerequisites." };
  if (after.length) links[to] = after;
  const next: SubagentOrchestration = { ...policy, allowedChildren: [...policy.allowedChildren],
    [kind]: Object.keys(links).length ? links : undefined,
  };
  if (exceedsProviderLimit(next)) return { ok: false, error: "An agent may have at most 8 prerequisites." };
  if (hasCombinedCycle(next)) return { ok: false, error: "This link creates a dependency cycle." };
  return { ok: true, next };
}

export function changeDependencyLink(
  policy: SubagentOrchestration,
  producer: string,
  consumer: string,
  enabled: boolean,
): LinkChangeResult {
  return changeSiblingLink("dependencies", policy, producer, consumer, enabled);
}

/** A coordinator may ask a sibling for extra data while a consumer is running. */
export function changeContextProviderLink(
  policy: SubagentOrchestration,
  provider: string,
  consumer: string,
  enabled: boolean,
): LinkChangeResult {
  return changeSiblingLink("contextProviders", policy, provider, consumer, enabled);
}
