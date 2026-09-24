import type { SessionInfo } from "./types";

export interface AgentRunRow {
  session: SessionInfo;
  parentId: string;
  depth: number;
}

/** Keep actual parent/child relationships, even when a profile is started more than once. */
export function buildAgentRunTree(
  root: SessionInfo,
  descendants: readonly SessionInfo[],
  runningIds: ReadonlySet<string>,
): AgentRunRow[] {
  const byParent = new Map<string, SessionInfo[]>();
  for (const child of descendants) {
    if (child.relation?.kind !== "subagent") continue;
    const siblings = byParent.get(child.relation.parentSessionId) ?? [];
    siblings.push(child);
    byParent.set(child.relation.parentSessionId, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => {
    const aRunning = runningIds.has(a.id);
    const bRunning = runningIds.has(b.id);
    if (aRunning !== bRunning) return aRunning ? -1 : 1;
    return b.modified.localeCompare(a.modified);
  });

  const rows: AgentRunRow[] = [];
  const visited = new Set([root.id]);
  const stack = [...(byParent.get(root.id) ?? [])].reverse().map((session) => ({ session, parentId: root.id, depth: 1 }));
  while (stack.length) {
    const item = stack.pop()!;
    if (visited.has(item.session.id)) continue;
    visited.add(item.session.id);
    rows.push(item);
    for (const child of [...(byParent.get(item.session.id) ?? [])].reverse()) {
      stack.push({ session: child, parentId: item.session.id, depth: item.depth + 1 });
    }
  }
  return rows;
}

export function visibleAgentRunIds(
  rootId: string,
  rows: readonly AgentRunRow[],
  matchingIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const parentById = new Map(rows.map((row) => [row.session.id, row.parentId]));
  const visible = new Set([rootId]);
  for (const id of matchingIds) {
    const visited = new Set<string>();
    let current: string | undefined = id;
    while (current && !visited.has(current)) {
      visited.add(current);
      visible.add(current);
      current = parentById.get(current);
    }
  }
  return visible;
}
