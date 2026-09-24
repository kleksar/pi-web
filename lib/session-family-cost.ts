import { statSync } from "node:fs";
import type { SessionEntry, SessionInfo } from "./types";
import { getSessionFamily } from "./session-family";
import { openSessionManager, readSessionHeader } from "./session-reader";
import { computeSessionStats } from "./session-stats";
import { sessionCostWithProvenance } from "./fork-cost";

export interface SessionFamilyCost {
  rootSessionId: string;
  /** Known spend; a partial total is never presented as complete. */
  cost: number;
  /** Root and all subagent descendants, including sessions with missing cost data. */
  sessionCount: number;
  complete: boolean;
}

type ReadEntries = (path: string) => SessionEntry[];

interface CachedCost {
  fingerprint: string;
  cost: number;
}

const MAX_CACHED_SESSION_COSTS = 512;

/** Cache the cost of completed/idle JSONL sessions by their on-disk fingerprint. */
export class SessionFileCostCache {
  private readonly cache = new Map<string, CachedCost>();

  constructor(private readonly readEntries: ReadEntries = (path) =>
    openSessionManager(path).getEntries() as SessionEntry[]) {}

  get(path: string): number | null {
    if (!path) return null;
    try {
      const before = statSync(path);
      if (!before.isFile()) return null;
      const fingerprint = `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
      const cached = this.cache.get(path);
      if (cached?.fingerprint === fingerprint) {
        // Touch LRU without parsing the unchanged session again.
        this.cache.delete(path);
        this.cache.set(path, cached);
        return cached.cost;
      }

      const entries = this.readEntries(path);
      const header = readSessionHeader(path);
      const { cost, sourceDependent } = sessionCostWithProvenance(
        entries, computeSessionStats(entries).cost, header?.parentSession, header?.id,
      );
      const after = statSync(path);
      const stillCurrent = after.isFile()
        && fingerprint === `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`;
      // An append during a read may yield an incomplete total; retry next poll.
      if (!stillCurrent || cost === null || !Number.isFinite(cost) || cost < 0) {
        this.cache.delete(path);
        return null;
      }
      this.cache.delete(path);
      if (sourceDependent) return cost;
      this.cache.set(path, { fingerprint, cost });
      while (this.cache.size > MAX_CACHED_SESSION_COSTS) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      return cost;
    } catch {
      this.cache.delete(path);
      return null;
    }
  }
}

export const sessionFileCostCache = new SessionFileCostCache();

/** Return null for unknown/orphan/cyclic sessions. Forks are separate roots. */
export async function computeSessionFamilyCost(
  sessionId: string,
  sessions: readonly SessionInfo[],
  readCost: (session: SessionInfo) => number | null | Promise<number | null>,
): Promise<SessionFamilyCost | null> {
  const family = getSessionFamily(sessions, sessionId);
  if (!family) return null;

  const members = new Map<string, SessionInfo>();
  for (const session of [family.root, ...family.subagents]) members.set(session.id, session);
  let cost = 0;
  let complete = true;
  for (const session of members.values()) {
    let value: number | null;
    try {
      value = await readCost(session);
    } catch {
      value = null;
    }
    if (value === null || !Number.isFinite(value) || value < 0) {
      complete = false;
      continue;
    }
    cost += value;
  }

  return { rootSessionId: family.root.id, cost, sessionCount: members.size, complete };
}
