import { NextResponse } from "next/server";
import { computeSessionFamilyCost, sessionFileCostCache } from "@/lib/session-family-cost";
import { ownSessionCost } from "@/lib/fork-cost";
import { listAllSessions, mergeSessionLists } from "@/lib/session-reader";
import { getRpcSession, getRpcSessionInfos } from "@/lib/rpc-manager";
import type { SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

function readSessionCost(session: SessionInfo): number | null {
  const live = getRpcSession(session.id);
  // The live wrapper owns unflushed usage during a turn or before the first
  // JSONL exists. Its SDK stats include historical entries and pending writes.
  if (live?.isAlive() && (live.isRunning() || session.transient)) {
    try {
      const stats = live.inner.getSessionStats();
      const manager = live.inner.sessionManager;
      const header = manager.getHeader();
      return ownSessionCost(manager.getEntries() as unknown as import("@/lib/types").SessionEntry[], stats.cost, header?.parentSession, header?.id ?? session.id);
    } catch {
      return null;
    }
  }
  return sessionFileCostCache.get(session.path);
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const sessions = mergeSessionLists(
      await listAllSessions(),
      getRpcSessionInfos({ includeTransient: true }),
    );
    const familyCost = await computeSessionFamilyCost(id, sessions, readSessionCost);
    if (!familyCost) {
      return NextResponse.json({ error: "Session not found" }, {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return NextResponse.json(familyCost, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Unable to read session costs" }, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
