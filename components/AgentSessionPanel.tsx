"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionInfo, SubagentSessionStatus } from "@/lib/types";

interface Props {
  rootSession: SessionInfo;
  subagents: SessionInfo[];
  selectedSessionId: string;
  runningSessionIds: ReadonlySet<string>;
  onSelectSession: (session: SessionInfo) => void;
}

export function useAgentProfileNames(sessions: readonly SessionInfo[]): ReadonlyMap<string, string> {
  const cwds = [...new Set(sessions.filter((session) => session.relation?.kind === "subagent").map((session) => session.cwd))].sort().join("\n");
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    let active = true;
    void Promise.all(cwds ? cwds.split("\n").map(async (cwd) => {
      try {
        const response = await fetch(`/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`);
        if (!response.ok) return [] as [string, string][];
        const data = await response.json() as { profiles?: { name: string; displayName: string }[] };
        return (data.profiles ?? []).map((profile): [string, string] => [`${cwd}\0${profile.name}`, profile.displayName]);
      } catch { return [] as [string, string][]; }
    }) : []).then((results) => { if (active) setNames(new Map(results.flat())); });
    return () => { active = false; };
  }, [cwds]);
  return names;
}

export function agentName(session: SessionInfo, names: ReadonlyMap<string, string>): string {
  const relation = session.relation;
  if (relation?.kind !== "subagent") return session.name || session.firstMessage || session.id.slice(0, 12);
  return names.get(`${session.cwd}\0${relation.profile}`) || relation.profile || session.id.slice(0, 12);
}

export function agentStatus(session: SessionInfo, running: ReadonlySet<string>): SubagentSessionStatus | "unknown" {
  if (running.has(session.id)) return "running";
  return session.relation?.kind === "subagent" ? session.relation.status ?? "unknown" : "unknown";
}

export function agentTree(root: SessionInfo, descendants: readonly SessionInfo[]): { session: SessionInfo; depth: number }[] {
  const byParent = new Map<string, SessionInfo[]>();
  for (const session of descendants) {
    if (session.relation?.kind !== "subagent") continue;
    const siblings = byParent.get(session.relation.parentSessionId) ?? [];
    siblings.push(session);
    byParent.set(session.relation.parentSessionId, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => b.modified.localeCompare(a.modified));
  const rows: { session: SessionInfo; depth: number }[] = [];
  const seen = new Set([root.id]);
  const visit = (parentId: string, depth: number) => {
    for (const session of byParent.get(parentId) ?? []) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      rows.push({ session, depth });
      visit(session.id, depth + 1);
    }
  };
  visit(root.id, 1);
  return rows;
}

function relativeTime(value: string, locale: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.round((timestamp - Date.now()) / 60000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function AgentTreeRows({ rootSession, subagents, selectedSessionId, runningSessionIds, onSelectSession, compact = false, activeOnly = false }: Props & { compact?: boolean; activeOnly?: boolean }) {
  const { locale, t } = useI18n();
  const names = useAgentProfileNames(subagents);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => agentTree(rootSession, subagents), [rootSession, subagents]);
  const children = new Set(rows.map(({ session }) => session.relation?.kind === "subagent" ? session.relation.parentSessionId : ""));
  const visibleIds = activeOnly ? new Set(rows.filter(({ session }) => {
    const status = agentStatus(session, runningSessionIds);
    return status === "running" || status === "starting" || status === "needs_context" || status === "failed";
  }).map(({ session }) => session.id)) : null;
  if (visibleIds) {
    const byId = new Map(subagents.map((session) => [session.id, session]));
    for (const id of [...visibleIds]) {
      let parent = byId.get(id)?.relation;
      const seen = new Set([id]);
      while (parent?.kind === "subagent" && !seen.has(parent.parentSessionId)) {
        seen.add(parent.parentSessionId);
        visibleIds.add(parent.parentSessionId);
        parent = byId.get(parent.parentSessionId)?.relation;
      }
    }
  }
  const hidden = new Set<string>();
  return <div role="tree" aria-label={t("agentSwitcher.title")}>
    {([{ session: rootSession, depth: 0 }, ...rows]).map(({ session, depth }) => {
      const parentId = session.relation?.kind === "subagent" ? session.relation.parentSessionId : null;
      if ((visibleIds && depth > 0 && !visibleIds.has(session.id)) || (parentId && hidden.has(parentId))) { hidden.add(session.id); return null; }
      const isCollapsed = collapsed.has(session.id);
      if (isCollapsed) hidden.add(session.id);
      const hasChildren = children.has(session.id);
      const main = depth === 0;
      const relation = session.relation?.kind === "subagent" ? session.relation : null;
      const status = agentStatus(session, runningSessionIds);
      const primary = main ? t("agentSwitcher.main") : agentName(session, names);
      const secondary = main ? (session.name || session.firstMessage) : relation?.description;
      return <div key={session.id} role="treeitem" aria-level={depth + 1} aria-expanded={hasChildren ? !isCollapsed : undefined} aria-selected={session.id === selectedSessionId} style={{ paddingLeft: 8 + depth * 17, display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)", background: selectedSessionId === session.id ? "var(--bg-selected)" : "transparent" }}>
        {hasChildren ? <button type="button" aria-label={isCollapsed ? "Expand agents" : "Collapse agents"} onClick={() => setCollapsed((old) => { const next = new Set(old); if (next.has(session.id)) next.delete(session.id); else next.add(session.id); return next; })} style={{ border: 0, background: "none", color: "var(--text-muted)", cursor: "pointer", padding: 5 }}>{isCollapsed ? "▸" : "▾"}</button> : <span style={{ width: 26, flexShrink: 0 }} />}
        <button type="button" onClick={() => onSelectSession(session)} title={`${primary} · ${relation?.profile ?? session.id}\n${session.id}`} style={{ border: 0, background: "none", color: "var(--text)", textAlign: "left", cursor: "pointer", padding: "8px 4px", flex: 1, minWidth: 0 }}>
          <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{primary}</strong>
          {secondary && <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 11 }}>{secondary}</span>}
          {compact && <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{relativeTime(session.modified, locale)}</span>}
        </button>
        <span title={status} style={{ fontSize: 11, padding: "0 8px", whiteSpace: "nowrap", color: status === "failed" ? "#dc2626" : status === "needs_context" ? "#0d9488" : status === "running" || status === "starting" ? "var(--accent)" : "var(--text-dim)" }}>
          {main && status === "unknown" ? "" : status === "unknown" ? "—" : t(`agentSwitcher.status.${status}`)}
        </span>
      </div>;
    })}
  </div>;
}

export function AgentSessionPanel(props: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const names = useAgentProfileNames(props.subagents);
  const filtered = query.trim() ? props.subagents.filter((session) => [agentName(session, names), session.relation?.kind === "subagent" ? session.relation.description : "", session.id].some((value) => value.toLowerCase().includes(query.trim().toLowerCase()))) : props.subagents;
  // Keep ancestors when searching so results retain their hierarchy.
  const included = new Set(filtered.map((session) => session.id));
  const byId = new Map(props.subagents.map((session) => [session.id, session]));
  for (const session of filtered) {
    let parent = session.relation?.kind === "subagent" ? session.relation.parentSessionId : null;
    const seen = new Set([session.id]);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      included.add(parent);
      const relation = byId.get(parent)?.relation;
      parent = relation?.kind === "subagent" ? relation.parentSessionId : null;
    }
  }
  return <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border)", maxHeight: "min(58dvh, 480px)", overflowY: "auto" }}>
    <div style={{ padding: 10, fontSize: 12 }}><strong>{t("agentSwitcher.title")}</strong> · {props.subagents.length}</div>
    {props.subagents.length > 8 && <input type="search" aria-label={t("agentSwitcher.search")} placeholder={t("agentSwitcher.search")} value={query} onChange={(event) => setQuery(event.target.value)} style={{ width: "100%", padding: 8, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)" }} />}
    <AgentTreeRows {...props} subagents={props.subagents.filter((session) => included.has(session.id))} />
  </div>;
}
