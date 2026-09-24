"use client";

import { useMemo } from "react";
import type { SessionInfo } from "@/lib/types";
import { listSessionFamilies } from "@/lib/session-family";
import { AgentTreeRows, agentStatus } from "./AgentSessionPanel";

interface Props {
  sessions: SessionInfo[];
  selectedSessionId: string | undefined;
  runningSessionIds: ReadonlySet<string>;
  onSelectSession: (session: SessionInfo) => void;
  onClose: () => void;
}

export function AgentActivityRail({ sessions, selectedSessionId, runningSessionIds, onSelectSession, onClose }: Props) {
  const projects = useMemo(() => {
    const groups = new Map<string, { label: string; families: ReturnType<typeof listSessionFamilies> }>();
    for (const family of listSessionFamilies(sessions)) {
      const active = family.subagents.some((session) => {
        const status = agentStatus(session, runningSessionIds);
        return status === "running" || status === "starting" || status === "needs_context" || status === "failed";
      });
      if (!active) continue;
      const key = family.root.projectKey ?? family.root.projectRoot ?? family.root.cwd;
      const group = groups.get(key) ?? { label: family.root.projectRoot ?? family.root.cwd, families: [] };
      group.families.push(family);
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [sessions, runningSessionIds]);
  return <section aria-label="Agent activity" className="agent-activity-content">
    <header style={{ padding: "9px 12px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <strong style={{ fontSize: 12 }}>Agent activity</strong>
      <button type="button" onClick={onClose} aria-label="Close agent activity" style={{ background: "none", border: 0, color: "var(--text-muted)", cursor: "pointer" }}>✕</button>
    </header>
    <div style={{ overflowY: "auto", flex: 1 }}>
      {projects.length === 0 && <p style={{ padding: 12, color: "var(--text-dim)", fontSize: 12 }}>No active agents</p>}
      {projects.map((project) => <div key={project.label}>
        <div title={project.label} style={{ padding: "10px 12px", fontSize: 11, color: "var(--text-muted)", background: "var(--bg-hover)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.label} · {project.families.reduce((count, family) => count + family.subagents.filter((session) => {
          const status = agentStatus(session, runningSessionIds);
          return status === "running" || status === "starting" || status === "needs_context" || status === "failed";
        }).length, 0)}</div>
        {project.families.map((family) => <AgentTreeRows key={family.root.id} rootSession={family.root} subagents={family.subagents} selectedSessionId={selectedSessionId ?? ""} runningSessionIds={runningSessionIds} onSelectSession={onSelectSession} compact activeOnly />)}
      </div>)}
    </div>
  </section>;
}
