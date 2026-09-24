import { MAP_NODE_HEIGHT, MAP_NODE_WIDTH } from "./orchestration-map-size.mjs";
import type { MapEdge, MapNode } from "./orchestration-map";

export interface MapPoint { x: number; y: number }
export interface RoutedMapEdge { edge: MapEdge; points: MapPoint[]; path: string }

function segmentIntersectsCard(a: MapPoint, b: MapPoint, node: MapNode): boolean {
  return a.y === b.y
    ? a.y > node.y && a.y < node.y + MAP_NODE_HEIGHT
      && Math.max(a.x, b.x) > node.x && Math.min(a.x, b.x) < node.x + MAP_NODE_WIDTH
    : a.x > node.x && a.x < node.x + MAP_NODE_WIDTH
      && Math.max(a.y, b.y) > node.y && Math.min(a.y, b.y) < node.y + MAP_NODE_HEIGHT;
}

/** Reject manual placements that overlap cards or make a visible route cross any card. */
export function canPlaceMapNode(id: string, point: MapPoint, nodes: readonly MapNode[], edges: readonly MapEdge[]): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  if (!nodes.some((node) => node.id === id)) return false;
  const clearance = 12;
  if (nodes.some((node) => node.id !== id
    && point.x < node.x + MAP_NODE_WIDTH + clearance && point.x + MAP_NODE_WIDTH + clearance > node.x
    && point.y < node.y + MAP_NODE_HEIGHT + clearance && point.y + MAP_NODE_HEIGHT + clearance > node.y)) return false;
  const moved = nodes.map((node) => node.id === id ? { ...node, x: point.x, y: point.y } : node);
  return routeOrchestrationEdges(moved, edges).every(({ points }) =>
    points.slice(1).every((point, index) => moved.every((node) => !segmentIntersectsCard(points[index], point, node))));
}

/** Persisted coordinates are treated as proposals; invalid old positions fall back to auto layout. */
export function applyManualMapPositions(nodes: readonly MapNode[], saved: Readonly<Record<string, MapPoint>>,
  edges: readonly MapEdge[]): MapNode[] {
  let current = [...nodes];
  for (const node of nodes) {
    const point = saved[node.id];
    if (!point || (point.x === node.x && point.y === node.y)) continue;
    if (canPlaceMapNode(node.id, point, current, edges)) {
      current = current.map((candidate) => candidate.id === node.id ? { ...candidate, x: point.x, y: point.y } : candidate);
    }
  }
  return current;
}

const center = (node: MapNode) => node.y + MAP_NODE_HEIGHT / 2;
const edgeKey = (edge: MapEdge) => [edge.kind, edge.ownerId, edge.source, edge.target].join("\0");
const pathFromPoints = (points: readonly MapPoint[]) => points.map((point, index) =>
  `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");

/** Allocate the first free lane for overlapping edge spans; disjoint spans can reuse a lane. */
function lanesFor<T>(items: readonly T[], key: (item: T) => string, interval: (item: T) => [number, number]): Map<string, number> {
  const lanes: Array<Array<[number, number]>> = [];
  const assigned = new Map<string, number>();
  for (const item of [...items].sort((a, b) => key(a).localeCompare(key(b)))) {
    const span = interval(item);
    let lane = lanes.findIndex((occupied) => occupied.every(([start, end]) => span[1] < start || span[0] > end));
    if (lane < 0) { lane = lanes.length; lanes.push([]); }
    lanes[lane].push(span);
    assigned.set(key(item), lane);
  }
  return assigned;
}

/**
 * Orthogonal routes use empty gaps between columns. Sibling provider links travel
 * outside the rightmost column; long and backward links travel above every card.
 * The returned points make the no-card-intersection invariant testable.
 */
export function routeOrchestrationEdges(nodes: readonly MapNode[], edges: readonly MapEdge[]): RoutedMapEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const valid = edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target));
  const top = Math.min(0, ...nodes.map((node) => node.y)) - 48;
  const right = Math.max(0, ...nodes.map((node) => node.x + MAP_NODE_WIDTH));
  const direct: MapEdge[] = [];
  const sameColumn: MapEdge[] = [];
  const outer: MapEdge[] = [];
  for (const edge of valid) {
    const source = byId.get(edge.source)!;
    const target = byId.get(edge.target)!;
    if (source.x === target.x) sameColumn.push(edge);
    else if (target.x > source.x && target.x - source.x - MAP_NODE_WIDTH <= 300) direct.push(edge);
    else outer.push(edge);
  }
  const directSet = new Set(direct);
  const directLanes = lanesFor(direct.filter((edge) => edge.kind !== "delegation"), edgeKey, (edge) => {
    const a = center(byId.get(edge.source)!);
    const b = center(byId.get(edge.target)!);
    return [Math.min(a, b), Math.max(a, b)];
  });
  const sameLanes = lanesFor(sameColumn, edgeKey, (edge) => {
    const a = center(byId.get(edge.source)!);
    const b = center(byId.get(edge.target)!);
    return [Math.min(a, b), Math.max(a, b)];
  });
  const outerLanes = lanesFor(outer, edgeKey, (edge) => {
    const source = byId.get(edge.source)!;
    const target = byId.get(edge.target)!;
    return [Math.min(source.x, target.x), Math.max(source.x, target.x)];
  });
  return valid.map((edge) => {
    const source = byId.get(edge.source)!;
    const target = byId.get(edge.target)!;
    const a = center(source);
    const b = center(target);
    let points: MapPoint[];
    if (source.id === target.id) {
      // Old hand-authored policies can contain a self-link; keep it visible for inspection.
      const gutter = right + 36 + (sameLanes.get(edgeKey(edge)) ?? 0) * 16;
      const below = source.y + MAP_NODE_HEIGHT + 18;
      points = [{ x: source.x + MAP_NODE_WIDTH, y: source.y + 32 }, { x: gutter, y: source.y + 32 },
        { x: gutter, y: below }, { x: source.x - 24, y: below },
        { x: source.x - 24, y: source.y + 68 }, { x: source.x, y: source.y + 68 }];
    } else if (source.x === target.x) {
      // Both ports face right. A return arrow points left into the consumer.
      const gutter = right + 36 + (sameLanes.get(edgeKey(edge)) ?? 0) * 16;
      points = [{ x: source.x + MAP_NODE_WIDTH, y: a }, { x: gutter, y: a },
        { x: gutter, y: b }, { x: target.x + MAP_NODE_WIDTH, y: b }];
    } else if (directSet.has(edge)) {
      const first = source.x + MAP_NODE_WIDTH;
      const last = target.x;
      const lane = directLanes.get(edgeKey(edge)) ?? 0;
      // Delegation uses one shared trunk, the other kinds get separated tracks.
      const gutter = edge.kind === "delegation" ? first + Math.min(72, (last - first) / 2)
        : first + Math.min(48 + lane * 18, last - first - 24);
      points = [{ x: first, y: a }, { x: gutter, y: a },
        { x: gutter, y: b }, { x: last, y: b }];
    } else {
      const lane = outerLanes.get(edgeKey(edge)) ?? 0;
      const upper = top - lane * 18;
      points = [{ x: source.x + MAP_NODE_WIDTH, y: a }, { x: source.x + MAP_NODE_WIDTH + 26, y: a },
        { x: source.x + MAP_NODE_WIDTH + 26, y: upper },
        { x: target.x - 26, y: upper }, { x: target.x - 26, y: b }, { x: target.x, y: b }];
    }
    return { edge, points, path: pathFromPoints(points) };
  });
}
