import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { readSessionHeader, invalidateSessionListCache } from "./session-reader";
import { sessionPathKey } from "./session-path";
import { getRpcSession, getRpcSessionInfos, getRunningRpcSessionIds } from "./rpc-manager";
import type { SessionInfo } from "./types";

export class ArchiveConflict extends Error {}

function markerPath(id: string): string {
  // Never interpolate an untrusted id into a directory path.
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) throw new ArchiveConflict("Invalid session id");
  return join(getAgentDir(), "session-archives", `${id}.json`);
}

/** The marker is bound to the actual file, not a display-only parent or a cached row. */
export function isSessionArchived(session: Pick<SessionInfo, "id" | "path">): boolean {
  if (!session.path) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath(session.id), "utf8")) as { id?: unknown; path?: unknown };
    return marker.id === session.id && typeof marker.path === "string"
      && sessionPathKey(marker.path) === sessionPathKey(session.path)
      && readSessionHeader(session.path)?.id === session.id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // Corrupt archive state must not silently turn an archived session live.
    throw new ArchiveConflict(`Archive state is unreadable for ${session.id}`);
  }
}

function branch(rootId: string, sessions: SessionInfo[]): { members: SessionInfo[]; parents: Map<string, string | undefined> } {
  const byId = new Map<string, SessionInfo>();
  const byPath = new Map<string, string>();
  for (const session of sessions) {
    if (!session.path || session.transient || byId.has(session.id) || byPath.has(sessionPathKey(session.path))) {
      throw new ArchiveConflict("Session catalogue is ambiguous or incomplete");
    }
    byId.set(session.id, session);
    byPath.set(sessionPathKey(session.path), session.id);
  }
  if (!byId.has(rootId)) throw new ArchiveConflict("Session not found in persisted catalogue");

  // Derive ancestry from fresh headers, not the sidebar's presentation relation.
  const children = new Map<string, string[]>();
  const parents = new Map<string, string | undefined>();
  for (const session of sessions) {
    let header;
    try { header = readSessionHeader(session.path); } catch { /* concurrent removal */ }
    if (!header || header.id !== session.id) throw new ArchiveConflict("Session catalogue changed during archive");
    parents.set(session.id, header.parentSession ? sessionPathKey(header.parentSession) : undefined);
    if (!header.parentSession) continue;
    const parentId = byPath.get(sessionPathKey(header.parentSession));
    if (!parentId) continue; // a parent outside the catalogue is not this branch
    const siblings = children.get(parentId) ?? [];
    siblings.push(session.id);
    children.set(parentId, siblings);
  }
  const ids = new Set<string>();
  const pending = [rootId];
  while (pending.length) {
    const id = pending.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    pending.push(...children.get(id) ?? []);
  }
  return { members: [...ids].map((id) => byId.get(id)!), parents };
}

function assertSafe(sessions: SessionInfo[], parents: Map<string, string | undefined>): void {
  const ids = new Set(sessions.map((session) => session.id));
  const running = new Set(getRunningRpcSessionIds());
  for (const session of sessions) {
    if (running.has(session.id)) throw new ArchiveConflict("A branch session is running");
    const rpc = getRpcSession(session.id);
    if (rpc && (typeof rpc.isRunning !== "function" || rpc.isRunning())) {
      throw new ArchiveConflict("A branch session is running or its state is unknown");
    }
    let header;
    try { header = readSessionHeader(session.path); } catch { /* missing or unreadable */ }
    if (!header || header.id !== session.id || !existsSync(session.path)
      || (header.parentSession ? sessionPathKey(header.parentSession) : undefined) !== parents.get(session.id)) {
      throw new ArchiveConflict("Branch state changed or is unreadable");
    }
  }
  // A runtime-only child cannot be represented by a disk catalogue. Refuse
  // rather than leave it visible while its parent is archived.
  for (const runtime of getRpcSessionInfos({ includeTransient: true })) {
    if (runtime.transient && runtime.parentSessionId && ids.has(runtime.parentSessionId)) {
      throw new ArchiveConflict("A branch descendant has not been persisted");
    }
  }
}

export function changeBranchArchive(rootId: string, sessions: SessionInfo[], archived: boolean): string[] {
  const { members, parents } = branch(rootId, sessions);
  assertSafe(members, parents); // initial check before preparing any writes
  const markerStates = members.map((session) => isSessionArchived(session));
  if (archived) mkdirSync(join(getAgentDir(), "session-archives"), { recursive: true, mode: 0o700 });
  // Re-read live state, headers and markers directly before synchronous writes.
  assertSafe(members, parents);
  if (members.some((session, index) => isSessionArchived(session) !== markerStates[index])) {
    throw new ArchiveConflict("Archive state changed during request");
  }
  const changed: number[] = [];
  try {
    for (let index = 0; index < members.length; index += 1) {
      const session = members[index];
      if (markerStates[index] === archived) continue;
      const path = markerPath(session.id);
      if (archived) writePrivateFileAtomicSync(path, JSON.stringify({ id: session.id, path: session.path }));
      else unlinkSync(path);
      changed.push(index);
    }
  } catch (error) {
    // Best-effort rollback if a later file write fails; never report success for
    // a partially updated branch. The original error remains the response.
    for (const index of changed.reverse()) {
      const session = members[index];
      try {
        if (archived) unlinkSync(markerPath(session.id));
        else writePrivateFileAtomicSync(markerPath(session.id), JSON.stringify({ id: session.id, path: session.path }));
      } catch { /* a failed rollback remains visible as an incomplete operation */ }
    }
    invalidateSessionListCache();
    throw error;
  }
  invalidateSessionListCache();
  return members.map((session) => session.id);
}
