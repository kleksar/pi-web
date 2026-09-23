"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import type { MainPromptScope, MainPromptState } from "@/lib/main-prompt";
import { ConfigButton } from "./SettingsUi";

interface Props {
  cwd: string;
  sessionId?: string | null;
  onReloaded?: () => void;
}

type Drafts = Record<MainPromptScope, string>;
type ErrorResponse = { error?: string; code?: string };

export function MainPromptEditor({ cwd, sessionId, onReloaded }: Props) {
  const { t } = useI18n();
  const [state, setState] = useState<MainPromptState | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({ global: "", project: "" });
  const [revisions, setRevisions] = useState<Drafts>({ global: "absent", project: "absent" });
  const [scope, setScope] = useState<MainPromptScope>("global");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [conflictedScope, setConflictedScope] = useState<MainPromptScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setState(null);
    setDrafts({ global: "", project: "" });
    setRevisions({ global: "absent", project: "absent" });
    setError(null);
    setConflictedScope(null);
    setReloadNeeded(false);
    void fetch(`/api/main/prompt?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as MainPromptState & ErrorResponse;
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (controller.signal.aborted) return;
        setState(data);
        setDrafts({ global: data.global.content, project: data.project.content });
        setRevisions({ global: data.global.revision, project: data.project.revision });
        setScope(data.effectiveScope ?? "global");
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cwd]);

  const selected = state?.[scope];
  const dirty = Boolean(selected && (drafts[scope] !== selected.content || !selected.exists));

  const save = async () => {
    if (!state || !selected || saving || conflictedScope === scope) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/main/prompt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope, content: drafts[scope], revision: revisions[scope] }),
      });
      const data = await response.json() as MainPromptState & ErrorResponse;
      if (cwdRef.current !== cwd) return;
      if (response.status === 409 && data.code === "conflict") {
        const latestResponse = await fetch(`/api/main/prompt?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
        const latest = await latestResponse.json() as MainPromptState & ErrorResponse;
        if (cwdRef.current !== cwd) return;
        if (latestResponse.ok && !latest.error) setState(latest);
        setConflictedScope(scope);
        setError(t("mainPrompt.conflict"));
        return;
      }
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setState(data);
      setDrafts((previous) => ({ ...previous, [scope]: data[scope].content }));
      setRevisions((previous) => ({ ...previous, [scope]: data[scope].revision }));
      setReloadNeeded((previous) => previous || data.effectiveScope === scope);
    } catch (cause) {
      if (cwdRef.current === cwd) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const reload = async () => {
    if (!sessionId) return;
    setReloading(true);
    setError(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      setReloadNeeded(false);
      onReloaded?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReloading(false);
    }
  };

  return (
    <section className="main-prompt-editor" aria-label={t("mainPrompt.aria")}>
      <header>
        <h3>{t("mainPrompt.title")}</h3>
        <p>{t("mainPrompt.description")}</p>
      </header>
      {loading && <p role="status">{t("mainPrompt.loading")}</p>}
      {state && (
        <>
          <div className="main-prompt-scopes" role="tablist" aria-label={t("mainPrompt.scope")}>
            {(["global", "project"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={scope === item}
                className={scope === item ? "is-selected" : ""}
                onClick={() => { setScope(item); setError(null); }}
              >
                {item === "global" ? t("mainPrompt.global") : t("mainPrompt.project")}
                {state[item].effective && <span className="main-prompt-badge">{t("mainPrompt.effective")}</span>}
                {state[item].exists && !state[item].effective && <span className="main-prompt-badge">{t("mainPrompt.inactive")}</span>}
              </button>
            ))}
          </div>
          <div className="main-prompt-source">
            <span>{t("mainPrompt.file")} <code title={selected?.path}>{selected?.path}</code></span>
            {!selected?.exists && <span>{t("mainPrompt.missing")}</span>}
            {scope === "global" && state.project.effective && <span>{t("mainPrompt.overridden")}</span>}
            {scope === "project" && !state.projectTrusted && (
              <span role="status">{t("mainPrompt.untrusted")}</span>
            )}
          </div>
          <label className="main-prompt-label" htmlFor="main-prompt-text">{t("mainPrompt.instructions")}</label>
          <textarea
            id="main-prompt-text"
            value={drafts[scope]}
            onChange={(event) => setDrafts((previous) => ({ ...previous, [scope]: event.target.value }))}
            spellCheck={false}
            disabled={saving}
            placeholder={t("mainPrompt.placeholder")}
          />
          {conflictedScope === scope && selected && (
            <div className="main-prompt-conflict">
              <details><summary>{t("mainPrompt.latest")}</summary><pre>{selected.content || t("mainPrompt.empty")}</pre></details>
              <ConfigButton size="small" onClick={() => {
                setDrafts((previous) => ({ ...previous, [scope]: selected.content }));
                setRevisions((previous) => ({ ...previous, [scope]: selected.revision }));
                setConflictedScope(null);
                setError(null);
              }}>{t("mainPrompt.useLatest")}</ConfigButton>
              <ConfigButton size="small" onClick={() => {
                setRevisions((previous) => ({ ...previous, [scope]: selected.revision }));
                setConflictedScope(null);
                setError(null);
              }}>
                {t("mainPrompt.keepEdits")}
              </ConfigButton>
            </div>
          )}
          <div className="main-prompt-footer">
            <span role="status">
              {error ?? (reloadNeeded
                ? t("mainPrompt.savedReload")
                : t("mainPrompt.newSessions"))}
            </span>
            {reloadNeeded && sessionId && (
              <ConfigButton onClick={() => void reload()} disabled={reloading || saving}>
                {reloading ? t("mainPrompt.reloading") : t("mainPrompt.reloadSession")}
              </ConfigButton>
            )}
            <ConfigButton variant="primary" onClick={() => void save()} disabled={!dirty || loading || saving || conflictedScope === scope}>
              {saving ? t("mainPrompt.saving") : selected?.exists ? t("mainPrompt.save") : t("mainPrompt.create")}
            </ConfigButton>
          </div>
        </>
      )}
      <style>{`
        .main-prompt-editor { display: flex; flex-direction: column; gap: 14px; min-height: 0; padding: 22px; color: var(--text); }
        .main-prompt-editor h3 { margin: 0 0 5px; font-size: 15px; }
        .main-prompt-editor p { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
        .main-prompt-scopes { display: flex; gap: 6px; }
        .main-prompt-scopes button { display: flex; gap: 8px; align-items: center; padding: 7px 10px; color: var(--text-muted); background: var(--bg-panel); border: 1px solid var(--border); border-radius: 5px; cursor: pointer; }
        .main-prompt-scopes button.is-selected { color: var(--text); border-color: var(--accent); }
        .main-prompt-badge { font-size: 10px; color: var(--text-dim); }
        .main-prompt-scopes button.is-selected .main-prompt-badge { color: var(--accent); }
        .main-prompt-source { display: flex; flex-direction: column; gap: 5px; color: var(--text-muted); font-size: 12px; }
        .main-prompt-source code { overflow-wrap: anywhere; color: var(--text); }
        .main-prompt-label { font-weight: 600; font-size: 12px; }
        .main-prompt-editor textarea { width: 100%; min-height: 230px; max-height: 55vh; resize: vertical; padding: 12px; border: 1px solid var(--border); border-radius: 5px; outline: none; background: var(--bg-panel); color: var(--text); font: 12px/1.6 var(--font-mono); }
        .main-prompt-editor textarea:focus-visible { border-color: var(--accent); }
        .main-prompt-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 9px; }
        .main-prompt-footer [role=status] { margin-right: auto; color: var(--text-muted); font-size: 12px; }
        .main-prompt-conflict { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
        .main-prompt-conflict details { width: 100%; font-size: 12px; }
        .main-prompt-conflict pre { overflow: auto; max-height: 160px; padding: 9px; white-space: pre-wrap; background: var(--bg-panel); }
      `}</style>
    </section>
  );
}
