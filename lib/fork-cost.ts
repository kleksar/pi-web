import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { SessionEntry } from "./types";
import { readBoundedRegularFile } from "./bounded-file";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { computeSessionStats } from "./session-stats";
import { readSubagentRun } from "./subagents";

const FORK_COST_BASELINE_TYPE = "pi-web:fork-cost-baseline";
const MAX_FORK_SOURCE_BYTES = 64 * 1024 * 1024;

/** Only read an existing, bounded JSONL file inside the agent's session store. */
function sourceSessionEntryIds(sourcePath: string): Set<string> | null {
  if (!sourcePath.endsWith(".jsonl")) return null;
  const sessionsRoot = join(getAgentDir(), "sessions");
  const roots = new Set([sessionsRoot]);
  if (!isPathWithinRoots(sourcePath, roots) || !isExistingPathWithinRoots(sourcePath, roots)) return null;
  const contents = readBoundedRegularFile(sourcePath, MAX_FORK_SOURCE_BYTES, "Fork source session").toString("utf8");
  // A replaced intermediate symlink must not turn a trusted path into an
  // outside file during the read. readBoundedRegularFile rejects leaf symlinks.
  if (!isExistingPathWithinRoots(sourcePath, roots)) return null;
  const ids = new Set<string>();
  let offset = 0;
  let firstLine = true;
  while (offset < contents.length) {
    const newline = contents.indexOf("\n", offset);
    const end = newline < 0 ? contents.length : newline;
    const line = contents.slice(offset, end).trim();
    offset = end + 1;
    if (!line) continue;
    let entry: { type?: unknown; id?: unknown };
    try { entry = JSON.parse(line) as { type?: unknown; id?: unknown }; }
    catch { return null; }
    if (firstLine) {
      if (entry.type !== "session" || typeof entry.id !== "string") return null;
      firstLine = false;
    } else if (typeof entry.id === "string") {
      ids.add(entry.id);
    }
  }
  return firstLine ? null : ids;
}

/** Persist the cost of copied history before the fork can make new requests. */
export function markForkCostBaseline(manager: SessionManager): void {
  const inheritedCost = computeSessionStats(manager.getEntries() as SessionEntry[]).cost;
  manager.appendCustomEntry(FORK_COST_BASELINE_TYPE, {
    version: 2, sessionId: manager.getSessionId(), inheritedCost,
  });
}

/** Legacy forks need their source file on every read, so their cost is not cacheable by fork fingerprint alone. */
export function sessionCostWithProvenance(
  entries: SessionEntry[],
  rawCost: number,
  parentSessionPath?: string,
  sessionId?: string,
): { cost: number | null; sourceDependent: boolean } {
  if (!parentSessionPath) return { cost: rawCost, sourceDependent: false };
  const baseline = entries.filter((entry) => {
    if (entry.type !== "custom" || entry.customType !== FORK_COST_BASELINE_TYPE) return false;
    const data = entry.data as { version?: unknown; sessionId?: unknown } | null;
    return data?.version === 2 && data.sessionId === sessionId;
  }).at(-1);
  if (baseline?.type === "custom") {
    const data = baseline.data as { inheritedCost?: unknown };
    if (typeof data.inheritedCost !== "number"
      || !Number.isFinite(data.inheritedCost) || data.inheritedCost < 0
      || rawCost + 1e-9 < data.inheritedCost) return { cost: null, sourceDependent: false };
    return { cost: Math.max(0, rawCost - data.inheritedCost), sourceDependent: false };
  }

  // Subagents have their own history, despite the parentSession file header.
  if (readSubagentRun(entries, "", "", parentSessionPath)) return { cost: rawCost, sourceDependent: false };

  // Old and externally created forks lack their own baseline. A marker copied
  // from the source cannot be used as this session's baseline.
  try {
    const sourceIds = sourceSessionEntryIds(parentSessionPath);
    if (!sourceIds) return { cost: null, sourceDependent: true };
    const inheritedCost = computeSessionStats(entries.filter((entry) => sourceIds.has(entry.id))).cost;
    return { cost: Math.max(0, rawCost - inheritedCost), sourceDependent: true };
  } catch {
    return { cost: null, sourceDependent: true };
  }
}

/** Cost incurred by this session, excluding entries copied when it was forked. */
export function ownSessionCost(
  entries: SessionEntry[], rawCost: number, parentSessionPath?: string, sessionId?: string,
): number | null {
  return sessionCostWithProvenance(entries, rawCost, parentSessionPath, sessionId).cost;
}
