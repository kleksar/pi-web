import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { ArchiveConflict, changeBranchArchive } from "@/lib/session-archive";

async function change(id: string, archived: boolean) {
  try {
    const sessions = await listAllSessions({ force: true });
    return NextResponse.json({ ok: true, sessionIds: changeBranchArchive(id, sessions, archived) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: error instanceof ArchiveConflict ? 409 : 500 });
  }
}

// POST /api/sessions/[id]/archive archives the whole persisted branch.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return change((await params).id, true);
}

// DELETE /api/sessions/[id]/archive restores the whole branch (including
// descendants previously archived independently). The session DELETE is untouched.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return change((await params).id, false);
}
