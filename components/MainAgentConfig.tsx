"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SelectedExtensionTool } from "@/lib/agent-resource-selection";
import type { MainAgentConfig } from "@/lib/main-agent-config";
import { findOrchestrationLinkIssue, withAllowedChildren } from "@/lib/orchestration-policy";
import { isSubagentProfileOverridden } from "@/lib/subagent-profile-precedence";
import type { SubagentProfile, SubagentOrchestration } from "@/lib/subagents";
import { useI18n } from "@/hooks/useI18n";
import { AgentResourceSelector } from "./AgentResourceSelector";
import { MainPromptEditor } from "./MainPromptEditor";
import { ConfigButton, ConfigFooter, ConfigPanelShell } from "./SettingsUi";

interface Props {
  cwd: string;
  projectSelected?: boolean;
  sessionId?: string | null;
  onClose: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
  onOpenMap?: () => void;
}

type Tab = "instructions" | "resources" | "delegation";
type ConfigResponse = {
  config?: MainAgentConfig; revision?: string; error?: string;
  globalConfig?: MainAgentConfig; overrides?: MainAgentConfig; trusted?: boolean; projectPath?: string;
  rosterPath?: string;
};

function dependencyIssue(orchestration: SubagentOrchestration): string | null {
  const issue = findOrchestrationLinkIssue(
    orchestration.allowedChildren, orchestration.dependencies, orchestration.contextProviders,
  );
  if (!issue) return null;
  if (issue.type === "unknown") return `Unknown ${issue.firstKind}: ${issue.names[0]}`;
  if (issue.type === "self") return `${issue.name} cannot depend on itself`;
  if (issue.type === "limit") return `${issue.name} has more than 8 sources`;
  return "Dependency cycle. Remove a link before saving.";
}

export function MainAgentConfig({ cwd, projectSelected = true, sessionId = null, onClose, onReloaded, embedded = false, onOpenMap }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("resources");
  const [scope, setScope] = useState<"project" | "global" | "roster">(projectSelected ? "project" : "global");
  const initialRosterSelection = useRef(false);
  const [rosterAvailable, setRosterAvailable] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [saved, setSaved] = useState<MainAgentConfig | null>(null);
  const [globalConfig, setGlobalConfig] = useState<MainAgentConfig>({});
  const [overrides, setOverrides] = useState<MainAgentConfig>({});
  const [projectTrusted, setProjectTrusted] = useState(true);
  const [projectPath, setProjectPath] = useState("");
  const [rosterPath, setRosterPath] = useState("");
  const [draft, setDraft] = useState<MainAgentConfig>({});
  const [revision, setRevision] = useState("absent");
  const [profiles, setProfiles] = useState<SubagentProfile[]>([]);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const profileRequestId = useRef(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [conflicted, setConflicted] = useState(false);
  const [latest, setLatest] = useState<ConfigResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [childSearch, setChildSearch] = useState("");

  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);

  useEffect(() => {
    if (!projectSelected && scope === "project") setScope(rosterAvailable ? "roster" : "global");
  }, [projectSelected, rosterAvailable, scope]);

  useEffect(() => {
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ config?: MainAgentConfig; revision?: string; origin?: string; scope?: string; overrides?: MainAgentConfig }>).detail;
      if (!detail?.config || typeof detail.revision !== "string" || detail.origin === "main" || (detail.scope ?? "global") !== scope) return;
      if (dirty) {
        setLatest({ config: detail.config, revision: detail.revision });
        setConflicted(true);
        setError(t("main.configChanged"));
        return;
      }
      setSaved(detail.config);
      setDraft(detail.config);
      setOverrides(detail.overrides ?? {});
      setRevision(detail.revision);
      setSavedOk(false);
      setError(null);
    };
    window.addEventListener("pi-web:main-config-updated", onUpdated);
    return () => window.removeEventListener("pi-web:main-config-updated", onUpdated);
  }, [dirty, t, scope]);

  useEffect(() => {
    const controller = new AbortController();
    const profileRequest = ++profileRequestId.current;
    setSaved(null);
    setDraft({});
    setLoading(true);
    setError(null);
    setProfilesError(null);
    setConflicted(false);
    setSavedOk(false);
    Promise.all([
      fetch(`/api/main/config?cwd=${encodeURIComponent(cwd)}&scope=${scope}`, { cache: "no-store", signal: controller.signal }),
      fetch(`/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store", signal: controller.signal }),
    ]).then(async ([configResponse, profilesResponse]) => {
      const main = await configResponse.json() as ConfigResponse;
      const agents = await profilesResponse.json() as { profiles?: SubagentProfile[]; error?: string; rosterAvailable?: boolean };
      if (!configResponse.ok || main.error || !main.config || typeof main.revision !== "string") {
        throw new Error(main.error ?? `HTTP ${configResponse.status}`);
      }
      if (!profilesResponse.ok || agents.error || !Array.isArray(agents.profiles)) {
        throw new Error(agents.error ?? `HTTP ${profilesResponse.status}`);
      }
      if (controller.signal.aborted) return;
      setSaved(main.config);
      setDraft(main.config);
      setRevision(main.revision);
      setGlobalConfig(main.globalConfig ?? main.config);
      setOverrides(main.overrides ?? {});
      setProjectTrusted(main.trusted ?? true);
      setProjectPath(main.projectPath ?? "");
      setRosterPath(main.rosterPath ?? "");
      setRosterAvailable(Boolean(agents.rosterAvailable));
      if (!projectSelected && agents.rosterAvailable && scope === "global" && !initialRosterSelection.current) {
        initialRosterSelection.current = true;
        setScope("roster");
      }
      if (profileRequest === profileRequestId.current) setProfiles(agents.profiles.filter((profile) => projectSelected
        || (profile.scope !== "project" && profile.scope !== "workspace")));
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cwd, projectSelected, scope, refresh]);

  // Settings keeps visited tabs mounted. Refresh the roster after a profile edit
  // without discarding unsaved Main assignments or its compare-and-swap revision.
  useEffect(() => {
    let request: AbortController | null = null;
    const refreshProfiles = () => {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const generation = ++profileRequestId.current;
      void fetch(`/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (response) => {
        const data = await response.json() as { profiles?: SubagentProfile[]; error?: string };
        if (!response.ok || data.error || !Array.isArray(data.profiles)) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        if (controller.signal.aborted || generation !== profileRequestId.current) return;
        setProfiles(data.profiles.filter((profile) => projectSelected
          || (profile.scope !== "project" && profile.scope !== "workspace")));
        setProfilesError(null);
      }).catch((cause) => {
        if (controller.signal.aborted || generation !== profileRequestId.current) return;
        setProfilesError(cause instanceof Error ? cause.message : String(cause));
      });
    };
    window.addEventListener("pi-web:subagent-profiles-updated", refreshProfiles);
    return () => {
      window.removeEventListener("pi-web:subagent-profiles-updated", refreshProfiles);
      request?.abort();
    };
  }, [cwd, projectSelected]);

  const effectiveProfiles = useMemo(() => profiles.filter((profile) =>
    profile.enabled && !profile.configurationError && !isSubagentProfileOverridden(profile, profiles)
  ), [profiles]);
  const knownNames = useMemo(() => new Set(effectiveProfiles.map((profile) => profile.name.toLowerCase())), [effectiveProfiles]);
  const allowedChildren = draft.orchestration?.allowedChildren ?? [];
  const missingChildren = allowedChildren.filter((name) => !knownNames.has(name.toLowerCase()));
  const currentDependencyIssue = draft.orchestration ? dependencyIssue(draft.orchestration) : null;
  const filteredProfiles = effectiveProfiles.filter((profile) =>
    `${profile.displayName} ${profile.name}`.toLowerCase().includes(childSearch.trim().toLowerCase())
  );

  const changeSkills = (selectedSkills: string[]) => { setSavedOk(false); setDraft((current) => ({ ...current, selectedSkills })); };
  const changeTools = (selectedExtensionTools: SelectedExtensionTool[]) => { setSavedOk(false); setDraft((current) => ({ ...current, selectedExtensionTools })); };
  const restrictChildren = () => setDraft((current) => ({ ...current, orchestration: { allowedChildren: [] } }));
  const unrestrictedChildren = () => setDraft((current) => ({ ...current, orchestration: null }));
  const toggleChild = (name: string, checked: boolean) => setDraft((current) => {
    if (!current.orchestration) return current;
    const next = checked
      ? [...current.orchestration.allowedChildren, name]
      : current.orchestration.allowedChildren.filter((child) => child.toLowerCase() !== name.toLowerCase());
    return {
      ...current,
      orchestration: withAllowedChildren(current.orchestration, next),
    };
  });
  const toggleDependency = (consumer: string, producer: string, checked: boolean) => setDraft((current) => {
    if (!current.orchestration) return current;
    const previous = current.orchestration.dependencies ?? {};
    const next = Object.fromEntries(Object.entries(previous)
      .filter(([name]) => name.toLowerCase() !== consumer.toLowerCase()));
    const before = Object.entries(previous).find(([name]) => name.toLowerCase() === consumer.toLowerCase())?.[1] ?? [];
    const after = checked ? [...before, producer] : before.filter((name) => name.toLowerCase() !== producer.toLowerCase());
    if (after.length) next[consumer] = after;
    return {
      ...current,
      orchestration: {
        ...current.orchestration,
        ...(Object.keys(next).length ? { dependencies: next } : { dependencies: undefined }),
      },
    };
  });

  const save = async () => {
    if (!saved || !dirty || saving || missingChildren.length || currentDependencyIssue
      || (!projectSelected && scope === "project")) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/main/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope, config: draft, expectedRevision: revision,
          ...(scope === "project" || scope === "global" ? { previous: saved, overrides } : {}) }),
      });
      const result = await response.json() as ConfigResponse;
      if (response.status === 409) {
        const latestResponse = await fetch(`/api/main/config?cwd=${encodeURIComponent(cwd)}&scope=${scope}`, { cache: "no-store" });
        const newVersion = await latestResponse.json() as ConfigResponse;
        if (latestResponse.ok && newVersion.config && typeof newVersion.revision === "string") {
          setLatest(newVersion);
        }
        setConflicted(true);
        setError(result.error ?? t("main.configChanged"));
        return;
      }
      if (!response.ok || result.error || !result.config || typeof result.revision !== "string") {
        throw new Error(result.error ?? `HTTP ${response.status}`);
      }
      setSaved(result.config);
      setDraft(result.config);
      setRevision(result.revision);
      setGlobalConfig(result.globalConfig ?? result.config);
      setOverrides(result.overrides ?? {});
      setProjectTrusted(result.trusted ?? true);
      if (result.projectPath) setProjectPath(result.projectPath);
      if (result.rosterPath) setRosterPath(result.rosterPath);
      setSavedOk(true);
      window.dispatchEvent(new CustomEvent("pi-web:main-config-updated", {
        detail: { config: result.config, revision: result.revision,
          overrides: result.overrides ?? {}, origin: "main", scope },
      }));
      if (scope === "project") window.dispatchEvent(new Event("pi-web:project-trust-updated"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.main")} onClose={onClose}>
      <div className="main-agent-config">
        <div className="main-agent-config-header">
          <div>
            <strong>{t("main.title")}</strong>
            <p>{scope === "project" ? t("main.projectDescription") : scope === "roster" ? t("main.rosterDescription") : t("main.globalDescription")}</p>
          </div>
          {onOpenMap && <ConfigButton size="small" onClick={() => {
            if (!dirty || window.confirm(t("main.unsavedMapConfirm"))) onOpenMap();
          }}>{t("main.openMap")}</ConfigButton>}
        </div>
        <div className="main-agent-config-scope" role="group" aria-label={t("main.configScope")}>
          {projectSelected && <button type="button" aria-pressed={scope === "project"} disabled={saving} onClick={() => { if (!dirty || window.confirm(t("agents.discardChanges"))) setScope("project"); }}>{t("main.projectScope")}</button>}
          {rosterAvailable && <button type="button" aria-pressed={scope === "roster"} disabled={saving} onClick={() => { if (!dirty || window.confirm(t("agents.discardChanges"))) setScope("roster"); }}>{t("main.rosterScope")}</button>}
          <button type="button" aria-pressed={scope === "global"} disabled={saving} onClick={() => { if (!dirty || window.confirm(t("agents.discardChanges"))) setScope("global"); }}>{t("main.globalScope")}</button>
          {scope === "project" && <code title={projectPath}>{projectPath}</code>}
          {scope === "roster" && <code title={rosterPath}>{rosterPath}</code>}
        </div>
        {scope === "project" && !projectTrusted && <div className="main-agent-config-warning" role="status">
          {t("main.projectNeedsTrust")}
          <ConfigButton size="small" onClick={async () => {
            try {
              const response = await fetch("/api/project-trust", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, purpose: "main-config" }) });
              const data = await response.json() as { error?: string };
              if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
              window.dispatchEvent(new Event("pi-web:project-trust-updated"));
              setRefresh((value) => value + 1);
            } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
          }}>{t("main.trustProject")}</ConfigButton>
        </div>}
        <div role="tablist" aria-label={t("main.title")} className="main-agent-config-tabs">
          {(["resources", "delegation", "instructions"] as const).map((item) => (
            <button key={item} type="button" role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>
              {t(`main.${item}`)}
            </button>
          ))}
        </div>
        <div className="main-agent-config-scroll">
          <div hidden={tab !== "resources"} className="main-agent-config-section">
            <p className="main-agent-config-note">{t("main.resourcesDescription")}</p>
            {scope === "project" && <p className="main-agent-config-note">{t("main.projectSkillsHint")}</p>}
            {scope === "project" && overrides.selectedSkills !== undefined && <ConfigButton size="small" onClick={() => setDraft((current) => ({ ...current, selectedSkills: globalConfig.selectedSkills }))}>{t("main.inheritSkills")}</ConfigButton>}
            {scope === "project" && overrides.selectedExtensionTools !== undefined && <ConfigButton size="small" onClick={() => setDraft((current) => ({ ...current, selectedExtensionTools: globalConfig.selectedExtensionTools }))}>{t("main.inheritTools")}</ConfigButton>}
            {!loading && saved && (
              <AgentResourceSelector
                cwd={cwd}
                allowedSkillRoot={scope === "roster" ? `${rosterPath.replace(/[/\\]main-agent-config\.json$/, "")}/skills` : undefined}
                selectedSkills={draft.selectedSkills}
                excludeProjectResources={!projectSelected}
                selectedExtensionTools={draft.selectedExtensionTools}
                legacySkills={draft.selectedSkills === undefined}
                legacyExtensions={draft.selectedExtensionTools === undefined}
                onChangeSkills={changeSkills}
                onChangeExtensionTools={changeTools}
                hideExtensionTools={scope === "roster"}
                disabled={saving}
              />
            )}
          </div>
          <div hidden={tab !== "delegation"} className="main-agent-config-section">
            {scope === "project" && overrides.orchestration !== undefined && <ConfigButton size="small" onClick={() => setDraft((current) => ({ ...current, orchestration: globalConfig.orchestration }))}>{t("main.inheritDelegation")}</ConfigButton>}
            {draft.orchestration == null ? (
              <div className="main-agent-config-warning" role="status">
                <span>{t("main.unrestrictedDescription")}</span>
                <ConfigButton size="small" onClick={restrictChildren} disabled={loading || saving}>{t("main.limitChildren")}</ConfigButton>
              </div>
            ) : (
              <>
                <div className="main-agent-config-row">
                  <div>
                    <strong>{t("agents.allowedChildren")}</strong>
                    <p>{t("main.allowedDescription")}</p>
                  </div>
                  <ConfigButton size="small" onClick={unrestrictedChildren} disabled={saving}>{t("main.removeRestrictions")}</ConfigButton>
                </div>
                <input className="main-agent-config-search" aria-label={t("agents.searchChildren")} placeholder={t("agents.searchChildren")} value={childSearch} onChange={(event) => setChildSearch(event.target.value)} />
                <div role="group" aria-label={t("agents.allowedChildren")} className="main-agent-config-list">
                  {filteredProfiles.length === 0 && <span className="main-agent-config-muted">{t(effectiveProfiles.length ? "agents.noMatchingChildren" : "agents.noAvailableChildren")}</span>}
                  {filteredProfiles.map((profile) => (
                    <label key={`${profile.scope}:${profile.name}`} className="main-agent-config-choice">
                      <input type="checkbox" checked={allowedChildren.some((name) => name.toLowerCase() === profile.name.toLowerCase())} disabled={saving} onChange={(event) => toggleChild(profile.name, event.target.checked)} />
                      <span>{profile.displayName}<small>{profile.name} · {t(`agents.scope.${profile.scope}`)}</small></span>
                    </label>
                  ))}
                  {missingChildren.map((name) => (
                    <label key={`missing:${name}`} className="main-agent-config-choice is-missing">
                      <input type="checkbox" checked disabled={saving} onChange={() => toggleChild(name, false)} />
                      <span>{name}<small>{t("main.missingChild")}</small></span>
                    </label>
                  ))}
                </div>
                {allowedChildren.length === 0 && <p className="main-agent-config-note">{t("main.noDirectAgents")}</p>}
                {allowedChildren.length > 1 && (
                  <section className="main-agent-config-dependencies">
                    <strong>{t("agents.dependencies")}</strong>
                    <p>{t("agents.dependenciesDescription")}</p>
                    {allowedChildren.map((consumer) => {
                      const otherChildren = allowedChildren.filter((child) => child.toLowerCase() !== consumer.toLowerCase());
                      const producers = Object.entries(draft.orchestration?.dependencies ?? {})
                        .find(([name]) => name.toLowerCase() === consumer.toLowerCase())?.[1] ?? [];
                      return (
                        <details key={consumer}>
                          <summary>{consumer} · {producers.length ? t("agents.dependsOnCount", { count: producers.length }) : t("agents.noDependencies")}</summary>
                          <div role="group" aria-label={t("agents.dependsOnAgent", { name: consumer })} className="main-agent-config-list">
                            {otherChildren.map((producer) => (
                              <label key={producer} className="main-agent-config-choice">
                                <input type="checkbox" checked={producers.some((name) => name.toLowerCase() === producer.toLowerCase())} disabled={saving || (!producers.includes(producer) && producers.length >= 8)} onChange={(event) => toggleDependency(consumer, producer, event.target.checked)} />
                                {producer}
                              </label>
                            ))}
                          </div>
                        </details>
                      );
                    })}
                  </section>
                )}
                {allowedChildren.length > 1 && <section className="main-agent-config-dependencies">
                  <strong>{t("map.availableProviders")}</strong>
                  <p>{t("map.contextProviderHint")}</p>
                  {Object.entries(draft.orchestration.contextProviders ?? {}).map(([consumer, providers]) => (
                    <p key={consumer}>{providers.map((provider) => `${provider} → ${consumer}`).join(", ")}</p>
                  ))}
                  {onOpenMap && <ConfigButton size="small" onClick={() => {
                    if (!dirty || window.confirm(t("main.unsavedMapConfirm"))) onOpenMap();
                  }}>{t("main.openMap")}</ConfigButton>}
                </section>}
              </>
            )}
            {missingChildren.length > 0 && <p role="alert" className="main-agent-config-error">{t("agents.unavailableChildren", { names: missingChildren.join(", ") })}</p>}
            {currentDependencyIssue && <p role="alert" className="main-agent-config-error">{currentDependencyIssue}</p>}
            {profilesError && <p role="alert" className="main-agent-config-error">{profilesError} <ConfigButton size="small" onClick={() => window.dispatchEvent(new Event("pi-web:subagent-profiles-updated"))}>{t("main.retryProfiles")}</ConfigButton></p>}
          </div>
          <div hidden={tab !== "instructions"}>
            <MainPromptEditor cwd={cwd} projectSelected={projectSelected} sessionId={sessionId} onReloaded={onReloaded} />
          </div>
          {loading && tab !== "instructions" && <p role="status" className="main-agent-config-section">{t("main.loading")}</p>}
        </div>
        {tab !== "instructions" && <ConfigFooter status={
          <span role={error ? "alert" : "status"} className={error ? "main-agent-config-error" : ""}>
            {error ?? profilesError ?? (savedOk && !dirty ? t("main.savedNewSessions") : t("main.newSessionsOnly"))}
          </span>
        }>
          {conflicted && latest?.config && typeof latest.revision === "string" && (
            <div className="main-agent-config-conflict">
              <details><summary>{t("main.reviewLatest")}</summary><pre>{JSON.stringify(latest.config, null, 2)}</pre></details>
              <ConfigButton size="small" onClick={() => {
                setDraft(latest.config!);
                setSaved(latest.config!);
                setRevision(latest.revision!);
                setConflicted(false);
                setError(null);
              }}>{t("main.useLatest")}</ConfigButton>
              <ConfigButton size="small" onClick={() => {
                setRevision(latest.revision!);
                setSaved(latest.config!);
                setConflicted(false);
                setError(null);
              }}>{t("main.keepEdits")}</ConfigButton>
            </div>
          )}
          <ConfigButton variant="primary" onClick={() => void save()} disabled={loading || saving || conflicted || Boolean(profilesError) || !dirty || (scope === "project" && (!projectSelected || !projectTrusted)) || missingChildren.length > 0 || Boolean(currentDependencyIssue)}>
            {saving ? t("agents.saving") : t("agents.save")}
          </ConfigButton>
        </ConfigFooter>}
      </div>
      <style>{`
        .main-agent-config { height: 100%; min-height: 0; display: flex; flex-direction: column; color: var(--text); }
        .main-agent-config-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 22px 12px; }
        .main-agent-config-header strong { font-size: 15px; }
        .main-agent-config-scope { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 4px 22px 12px; }
        .main-agent-config-scope button { border: 1px solid var(--border); padding: 6px 11px; border-radius: 6px; color: var(--text); background: var(--bg-panel); cursor: pointer; }
        .main-agent-config-scope button[aria-pressed=true] { border-color: var(--accent); color: var(--accent); }
        .main-agent-config-scope code { color: var(--text-muted); font-size: 11px; overflow-wrap: anywhere; }
        .main-agent-config-header p, .main-agent-config-note, .main-agent-config-dependencies p, .main-agent-config-row p { margin: 5px 0 0; font-size: 12px; line-height: 1.5; color: var(--text-muted); }
        .main-agent-config-tabs { display: flex; gap: 4px; padding: 0 22px; border-bottom: 1px solid var(--border); }
        .main-agent-config-tabs button { border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 10px 13px; background: none; color: var(--text-muted); cursor: pointer; font-size: 12px; }
        .main-agent-config-tabs button[aria-selected=true] { color: var(--text); border-color: var(--accent); font-weight: 600; }
        .main-agent-config-scroll { min-height: 0; flex: 1; overflow-y: auto; }
        .main-agent-config-section { display: grid; align-content: start; gap: 14px; padding: 22px; }
        .main-agent-config-section[hidden], .main-agent-config-scroll > div[hidden] { display: none; }
        .main-agent-config-warning { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 15px; padding: 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-panel); font-size: 12px; line-height: 1.5; }
        .main-agent-config-row { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; align-items: center; }
        .main-agent-config-row strong, .main-agent-config-dependencies strong { font-size: 12px; }
        .main-agent-config-search { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 5px; color: var(--text); background: var(--bg); font-size: 12px; }
        .main-agent-config-list { max-height: 220px; overflow-y: auto; display: grid; gap: 4px; }
        .main-agent-config-choice { display: flex; align-items: flex-start; gap: 9px; padding: 7px 9px; border: 1px solid var(--border); border-radius: 5px; cursor: pointer; font-size: 12px; }
        .main-agent-config-choice span { display: grid; gap: 3px; }
        .main-agent-config-choice small, .main-agent-config-muted { color: var(--text-dim); font-size: 11px; overflow-wrap: anywhere; }
        .main-agent-config-choice.is-missing { color: #f87171; }
        .main-agent-config-dependencies { display: grid; gap: 9px; padding-top: 10px; border-top: 1px solid var(--border); }
        .main-agent-config-dependencies details { padding: 10px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-panel); }
        .main-agent-config-dependencies summary { cursor: pointer; font-size: 12px; }
        .main-agent-config-dependencies .main-agent-config-list { margin-top: 8px; }
        .main-agent-config-error { color: #f87171; font-size: 12px; }
        .main-agent-config-conflict { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
        .main-agent-config-conflict details { width: 100%; font-size: 11px; }
        .main-agent-config-conflict pre { max-height: 150px; overflow: auto; padding: 9px; background: var(--bg-panel); white-space: pre-wrap; }
      `}</style>
    </ConfigPanelShell>
  );
}
