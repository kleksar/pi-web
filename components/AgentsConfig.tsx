"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SubagentProfilesResponse, SubagentSettingsResponse } from "@/lib/api-types";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ModelsData } from "@/lib/models-cache";
import { isSubagentProfileOverridden } from "@/lib/subagent-profile-precedence";
import type { SubagentProfile, SubagentProfileInput, SubagentScope, SubagentWritableScope } from "@/lib/subagents";
import {
  getLastSettingsSelection,
  setLastSettingsSelection,
} from "@/lib/settings-navigation";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSidebar,
  ConfigSidebarGroupLabel,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  ConfigStatusDot,
  ConfigSwitch,
} from "./SettingsUi";
import { ModelSelector } from "./ModelSelector";

const TOOL_OPTIONS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const THINKING_OPTIONS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type EditableProfile = SubagentProfileInput;
type EditorMode = "view" | "edit" | "create";

const EMPTY_PROFILE: EditableProfile = {
  name: "custom-agent",
  displayName: "Custom agent",
  description: "",
  systemPrompt: "",
  tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  loadSkills: false,
  loadExtensions: false,
  promptMode: "append",
  inheritContext: false,
  runInBackground: false,
  orchestration: null,
  enabled: true,
};

const inputStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  height: 34,
  padding: "0 9px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
};

const disabledInputStyle: CSSProperties = {
  background: "var(--bg-panel)",
  color: "var(--text-dim)",
  cursor: "default",
};

function editableProfile(profile: SubagentProfile): EditableProfile {
  return {
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    tools: profile.orchestration ? [] : [...profile.tools],
    ...(profile.orchestration ? { extensionTools: [] } : {}),
    loadSkills: profile.orchestration ? false : profile.loadSkills,
    loadExtensions: profile.orchestration ? false : profile.loadExtensions,
    promptMode: profile.promptMode,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinking ? { thinking: profile.thinking } : {}),
    ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
    inheritContext: profile.inheritContext,
    runInBackground: profile.runInBackground,
    orchestration: profile.orchestration
      ? {
          allowedChildren: [...profile.orchestration.allowedChildren],
          ...(profile.orchestration.dependencies
            ? { dependencies: Object.fromEntries(Object.entries(profile.orchestration.dependencies).map(([name, producers]) => [name, [...producers]])) }
            : {}),
        }
      : null,
    enabled: profile.enabled,
  };
}

type DependencyIssue =
  | { type: "unknown"; names: string[] }
  | { type: "self"; name: string }
  | { type: "cycle"; names: string[] };

function findDependencyIssue(children: string[], dependencies: Record<string, string[]>): DependencyIssue | null {
  const known = new Map(children.map((name) => [name.toLowerCase(), name]));
  const unknown = new Set<string>();
  const graph = new Map<string, string[]>();
  let self: string | undefined;

  for (const [consumer, producers] of Object.entries(dependencies)) {
    const consumerName = known.get(consumer.toLowerCase());
    if (!consumerName) unknown.add(consumer);
    for (const producer of producers) {
      const producerName = known.get(producer.toLowerCase());
      if (!producerName) unknown.add(producer);
      if (!consumerName || !producerName) continue;
      if (consumerName.toLowerCase() === producerName.toLowerCase()) self = consumerName;
      const edges = graph.get(consumerName) ?? [];
      edges.push(producerName);
      graph.set(consumerName, edges);
    }
  }
  if (unknown.size > 0) return { type: "unknown", names: [...unknown] };
  if (self) return { type: "self", name: self };

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (name: string): string[] | null => {
    if (visiting.has(name)) return [...path.slice(path.indexOf(name)), name];
    if (visited.has(name)) return null;
    visiting.add(name);
    path.push(name);
    for (const producer of graph.get(name) ?? []) {
      const cycle = visit(producer);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(name);
    visited.add(name);
    return null;
  };
  for (const name of children) {
    const cycle = visit(name);
    if (cycle) return { type: "cycle", names: cycle };
  }
  return null;
}

function profileKey(profile: Pick<SubagentProfile, "scope" | "name">): string {
  return `${profile.scope}:${profile.name}`;
}

function duplicateProfileName(name: string, profiles: readonly SubagentProfile[]): string {
  const existing = new Set(profiles.map((profile) => profile.name.toLowerCase()));
  const base = `${name}-copy`;
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate.toLowerCase())) candidate = `${base}-${suffix++}`;
  return candidate;
}

function isWritableScope(scope: SubagentScope): scope is SubagentWritableScope {
  return scope === "global" || scope === "project";
}

/**
 * A built-in has no file to edit, so its fields stay read-only, but its switch is
 * live: the server records the name in `agents/settings.json` instead of writing a
 * copy of the profile to disk.
 */
function isTogglableScope(scope: SubagentScope): boolean {
  return isWritableScope(scope) || scope === "builtin";
}

function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

function displayProfilePath(profile: SubagentProfile, cwd: string): string | null {
  if (!profile.filePath) return null;
  if ((profile.scope === "project" || profile.scope === "workspace") && profile.filePath.startsWith(cwd)) {
    const relative = profile.filePath.slice(cwd.length).replace(/^[/\\]/, "");
    return `./${relative}`;
  }
  return shortenPath(profile.filePath);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <ConfigField label={label}>{children}</ConfigField>;
}

function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 7, color: disabled ? "var(--text-dim)" : "var(--text-muted)", fontSize: 12, cursor: disabled ? "default" : "pointer" }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

export function AgentsConfig({
  cwd,
  sessionId = null,
  onClose,
  onReloaded,
  embedded = false,
}: {
  cwd: string;
  sessionId?: string | null;
  onClose: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<SubagentProfile[]>([]);
  const [modelOptions, setModelOptions] = useState<ModelsData["modelList"]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(() => getLastSettingsSelection("agents", cwd));
  const [draft, setDraft] = useState<EditableProfile>(EMPTY_PROFILE);
  const [mode, setMode] = useState<EditorMode>("view");
  const [targetScope, setTargetScope] = useState<SubagentWritableScope>("global");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [builtInEnabled, setBuiltInEnabled] = useState(false);
  const [maxConcurrent, setMaxConcurrent] = useState(10);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [childrenQuery, setChildrenQuery] = useState("");

  const selected = useMemo(
    () => profiles.find((profile) => profileKey(profile) === selectedKey) ?? null,
    [profiles, selectedKey],
  );
  const childProfiles = useMemo(() => profiles.filter((profile) =>
    profile.enabled
    && profile.name.toLowerCase() !== draft.name.trim().toLowerCase()
    && !isSubagentProfileOverridden(profile, profiles)
  ), [profiles, draft.name]);
  const validChildNames = useMemo(() => new Set(childProfiles.map((profile) => profile.name.toLowerCase())), [childProfiles]);
  const unavailableChildren = draft.orchestration?.allowedChildren.filter((name) => !validChildNames.has(name.toLowerCase())) ?? [];
  const dependencyIssue = draft.orchestration
    ? findDependencyIssue(draft.orchestration.allowedChildren, draft.orchestration.dependencies ?? {})
    : null;
  const visibleChildProfiles = childProfiles.filter((profile) =>
    profile.name.toLowerCase().includes(childrenQuery.trim().toLowerCase())
    || profile.displayName.toLowerCase().includes(childrenQuery.trim().toLowerCase())
  );
  const modelSelectorOptions = useMemo(() => modelOptions.map((model) => ({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
  })), [modelOptions]);

  const loadProfiles = useCallback(async (preferredKey?: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const data = await response.json() as Partial<SubagentProfilesResponse> & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      const next = data.profiles ?? [];
      setProfiles(next);
      const rememberedKey = preferredKey ?? getLastSettingsSelection("agents", cwd);
      const chosen = next.find((profile) => profileKey(profile) === rememberedKey)
        ?? next.find((profile) => profile.scope === "project")
        ?? next.find((profile) => profile.scope === "global")
        ?? next[0]
        ?? null;
      setSelectedKey(chosen ? profileKey(chosen) : null);
      if (chosen) {
        setDraft(editableProfile(chosen));
        setMode(isWritableScope(chosen.scope) ? "edit" : "view");
        if (isWritableScope(chosen.scope)) setTargetScope(chosen.scope);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    const controller = new AbortController();
    setSettingsLoading(true);
    setSettingsError(null);
    void (async () => {
      try {
        const response = await fetch("/api/subagents/settings", {
          cache: "no-store",
          signal: controller.signal,
        });
        const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
        if (!response.ok || data.error || typeof data.enabled !== "boolean") {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        setBuiltInEnabled(data.enabled);
        if (typeof data.maxConcurrent === "number") setMaxConcurrent(data.maxConcurrent);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setSettingsError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setSettingsLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (selectedKey) setLastSettingsSelection("agents", selectedKey, cwd);
  }, [cwd, selectedKey]);

  useEffect(() => {
    const controller = new AbortController();
    setModelsLoading(true);
    setModelsError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/models?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
        const data = await response.json() as Partial<ModelsData> & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setModelOptions(data.modelList ?? []);
        setModelsError(data.modelError ?? null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setModelsError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setModelsLoading(false);
      }
    })();
    return () => controller.abort();
  }, [cwd]);

  const selectProfile = (profile: SubagentProfile) => {
    setSelectedKey(profileKey(profile));
    setDraft(editableProfile(profile));
    setMode(isWritableScope(profile.scope) ? "edit" : "view");
    if (isWritableScope(profile.scope)) setTargetScope(profile.scope);
    setError(null);
    setChildrenQuery("");
  };

  const beginCreate = () => {
    let name = "custom-agent";
    let suffix = 2;
    while (profiles.some((profile) => profile.name === name)) name = `custom-agent-${suffix++}`;
    setSelectedKey(null);
    setDraft({ ...EMPTY_PROFILE, name, displayName: name });
    setMode("create");
    setTargetScope("global");
    setError(null);
    setChildrenQuery("");
  };

  const beginDuplicate = () => {
    if (!selected) return;
    const name = duplicateProfileName(selected.name, profiles);
    setSelectedKey(null);
    setDraft({
      ...editableProfile(selected),
      name,
      displayName: t("agents.copyName", { name: selected.displayName }),
    });
    setMode("create");
    setTargetScope(isWritableScope(selected.scope) ? selected.scope : "global");
    setError(null);
    setChildrenQuery("");
  };

  const save = async () => {
    if (unavailableChildren.length > 0) {
      setError(t("agents.unavailableChildren", { names: unavailableChildren.join(", ") }));
      return;
    }
    if (dependencyIssue) {
      setError(dependencyIssue.type === "unknown"
        ? t("agents.unknownDependencies", { names: dependencyIssue.names.join(", ") })
        : dependencyIssue.type === "self"
          ? t("agents.selfDependency", { name: dependencyIssue.name })
          : t("agents.cyclicDependencies", { names: dependencyIssue.names.join(" → ") }));
      return;
    }
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const response = await fetch("/api/subagents/profiles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: targetScope, profile: draft }),
      });
      const data = await response.json() as { profile?: SubagentProfile; error?: string };
      if (!response.ok || data.error || !data.profile) throw new Error(data.error ?? `HTTP ${response.status}`);
      await loadProfiles(profileKey(data.profile));
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 2000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected || !isWritableScope(selected.scope)) return;
    if (!window.confirm(t("agents.deleteConfirm", { name: selected.displayName }))) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/subagents/profiles", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: selected.scope, name: selected.name }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      await loadProfiles();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const editing = mode !== "view";
  const creating = mode === "create";
  const disabled = !editing || saving || toggling;
  const displayedScope = creating ? targetScope : selected?.scope;
  const displayedPath = creating
    ? targetScope === "global"
      ? `~/.pi/agent/agents/${draft.name || "..."}.md`
      : `./.pi/agents/${draft.name || "..."}.md`
    : selected
      ? displayProfilePath(selected, cwd) ?? t("agents.builtinPath")
      : "";
  const fullPath = creating ? displayedPath : selected?.filePath ?? displayedPath;
  const selectedModelAvailable = !draft.model || modelOptions.some((model) => `${model.provider}/${model.id}` === draft.model);
  const selectedModel = (() => {
    if (!draft.model) return null;
    const separator = draft.model.indexOf("/");
    return separator < 0
      ? { provider: "", modelId: draft.model }
      : { provider: draft.model.slice(0, separator), modelId: draft.model.slice(separator + 1) };
  })();
  const controlStyle = disabled ? { ...inputStyle, ...disabledInputStyle } : inputStyle;
  const switchDisabled = creating
    ? disabled
    : !selected || Boolean(selected.configurationError) || !isTogglableScope(selected.scope) || saving || toggling;
  const update = <K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const toggleAllowedChild = (name: string, checked: boolean) => {
    setDraft((current) => {
      if (!current.orchestration) return current;
      const children = current.orchestration.allowedChildren;
      const allowedChildren = checked
        ? [...children, name]
        : children.filter((child) => child.toLowerCase() !== name.toLowerCase());
      const allowed = new Set(allowedChildren.map((child) => child.toLowerCase()));
      const dependencies = Object.fromEntries(
        Object.entries(current.orchestration.dependencies ?? {})
          .filter(([consumer]) => allowed.has(consumer.toLowerCase()))
          .map(([consumer, producers]) => [consumer, producers.filter((producer) => allowed.has(producer.toLowerCase()))])
          .filter(([, producers]) => producers.length > 0),
      );
      return {
        ...current,
        orchestration: {
          ...current.orchestration,
          allowedChildren,
          ...(Object.keys(dependencies).length > 0 ? { dependencies } : { dependencies: undefined }),
        },
      };
    });
  };
  const toggleDependency = (consumer: string, producer: string, checked: boolean) => {
    setDraft((current) => {
      if (!current.orchestration) return current;
      const dependencies = { ...current.orchestration.dependencies };
      const previousKey = Object.keys(dependencies).find((key) => key.toLowerCase() === consumer.toLowerCase());
      const previous = previousKey ? dependencies[previousKey] : [];
      const next = checked
        ? [...previous, producer]
        : previous.filter((name) => name.toLowerCase() !== producer.toLowerCase());
      if (previousKey) delete dependencies[previousKey];
      if (next.length > 0) dependencies[consumer] = next;
      return {
        ...current,
        orchestration: {
          ...current.orchestration,
          ...(Object.keys(dependencies).length > 0 ? { dependencies } : { dependencies: undefined }),
        },
      };
    });
  };
  const repairInvalidDependencies = () => {
    setDraft((current) => {
      if (!current.orchestration) return current;
      const allowed = new Map(current.orchestration.allowedChildren.map((name) => [name.toLowerCase(), name]));
      const dependencies: Record<string, string[]> = {};
      for (const [consumer, producers] of Object.entries(current.orchestration.dependencies ?? {})) {
        const knownConsumer = allowed.get(consumer.toLowerCase());
        if (!knownConsumer) continue;
        const validProducers = producers
          .map((producer) => allowed.get(producer.toLowerCase()))
          .filter((producer): producer is string => producer !== undefined && producer.toLowerCase() !== knownConsumer.toLowerCase());
        const unique = [...new Set(validProducers)];
        if (unique.length > 0) dependencies[knownConsumer] = unique;
      }
      return { ...current, orchestration: {
        ...current.orchestration,
        ...(Object.keys(dependencies).length > 0 ? { dependencies } : { dependencies: undefined }),
      } };
    });
  };

  const toggleEnabled = async (enabled: boolean) => {
    if (creating) {
      update("enabled", enabled);
      return;
    }
    if (!selected || selected.configurationError || !isTogglableScope(selected.scope)) return;
    setToggling(true);
    setError(null);
    try {
      const response = await fetch("/api/subagents/profiles", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: selected.scope, name: selected.name, enabled }),
      });
      const data = await response.json() as { profile?: SubagentProfile; error?: string };
      if (!response.ok || data.error || !data.profile) throw new Error(data.error ?? `HTTP ${response.status}`);
      const saved = data.profile;
      setProfiles((current) => current.map((profile) => profileKey(profile) === profileKey(saved) ? saved : profile));
      setDraft((current) => ({ ...current, enabled: saved.enabled }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setToggling(false);
    }
  };

  const toggleBuiltInSubagents = async (enabled: boolean) => {
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const response = await fetch("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
      if (!response.ok || data.error || typeof data.enabled !== "boolean") {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setBuiltInEnabled(data.enabled);
      setReloadNeeded(Boolean(sessionId));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsSaving(false);
    }
  };

  const updateMaxConcurrent = async (value: number) => {
    setMaxConcurrent(value);
    setSettingsError(null);
    try {
      const response = await fetch("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrent: value }),
      });
      const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
      if (!response.ok || data.error || typeof data.maxConcurrent !== "number") throw new Error(data.error ?? `HTTP ${response.status}`);
      setMaxConcurrent(data.maxConcurrent);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const reloadSession = async () => {
    if (!sessionId) return;
    setReloading(true);
    setSettingsError(null);
    try {
      await sendAgentCommand(sessionId, { type: "reload" });
      setReloadNeeded(false);
      onReloaded?.();
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReloading(false);
    }
  };

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.agents")} subtitle={shortenPath(cwd)} closeLabel={t("agents.close")} onClose={onClose}>
      <div className="agents-feature-setting">
        <div className="agents-feature-copy">
          <strong>{t("agents.builtInTitle")}</strong>
          <span>{t("agents.builtInDescription")}</span>
          {reloadNeeded && <span role="status" className="agents-feature-reload-notice">{t("agents.reloadRequired")}</span>}
        </div>
        <div className="agents-feature-actions">
          {reloadNeeded && sessionId && (
            <ConfigButton size="small" onClick={() => void reloadSession()} disabled={reloading || settingsSaving}>
              {reloading ? t("agents.reloading") : t("agents.reloadSession")}
            </ConfigButton>
          )}
          <label className="agents-concurrency-control" title={t("agents.maxConcurrentDescription")}>
            <span>{t("agents.maxConcurrent")}</span>
            <input
              aria-label={t("agents.maxConcurrent")}
              type="number"
              min={1}
              max={32}
              value={maxConcurrent}
              disabled={settingsLoading || settingsSaving}
              onChange={(event) => setMaxConcurrent(Number(event.target.value))}
              onBlur={() => void updateMaxConcurrent(maxConcurrent)}
            />
          </label>
          <ConfigSwitch
            checked={builtInEnabled}
            disabled={settingsLoading || reloading}
            loading={settingsSaving}
            label={t("agents.builtInTitle")}
            onChange={(enabled) => void toggleBuiltInSubagents(enabled)}
          />
        </div>
      </div>
      <ConfigSplitView>
        <ConfigSidebar>
          <ConfigSidebarList>
              {loading ? (
                <div style={{ padding: 10, color: "var(--text-dim)", fontSize: 12 }}>{t("agents.loading")}</div>
              ) : (["project", "global", "workspace", "builtin"] as const).map((scope) => {
                const scopedProfiles = profiles.filter((profile) => profile.scope === scope);
                if (scopedProfiles.length === 0) return null;
                return (
                  <div key={scope} className="config-sidebar-group">
                    <ConfigSidebarGroupLabel>{t(`agents.scope.${scope}`)}</ConfigSidebarGroupLabel>
                    {scopedProfiles.map((profile) => {
                      const overridden = isSubagentProfileOverridden(profile, profiles);
                      return (
                        <ConfigSidebarItem
                          key={profileKey(profile)}
                          active={selectedKey === profileKey(profile) && !creating}
                          onClick={() => selectProfile(profile)}
                        >
                          <ConfigStatusDot active={profile.enabled} />
                          <ConfigSidebarText className={`is-grow${profile.enabled ? "" : " is-muted"}`}>{profile.displayName}</ConfigSidebarText>
                          {overridden && <span className="agents-overridden-label">{t("agents.overridden")}</span>}
                        </ConfigSidebarItem>
                      );
                    })}
                  </div>
                );
              })}
          </ConfigSidebarList>
          <ConfigListAction
                active={creating}
                onClick={beginCreate}
              >
                {t("agents.new")}
          </ConfigListAction>
        </ConfigSidebar>

        <ConfigDetail>
          <ConfigDetailStack className="is-fill">
              {!selected && !creating ? (
                <ConfigEmptyState>{t("agents.empty")}</ConfigEmptyState>
              ) : (
                <ConfigDetailStack>
                  <ConfigDetailHeader>
                    <ConfigDetailHeaderInfo>
                      {displayedScope && (
                        <span className={`config-scope-tag${displayedScope === "project" ? " is-project" : ""}`}>
                          {t(`agents.scope.${displayedScope}`)}
                        </span>
                      )}
                      <span title={fullPath} className="config-detail-path">
                        {displayedPath}
                      </span>
                    </ConfigDetailHeaderInfo>
                    <ConfigDetailActions>
                      {selected && (mode === "view" || mode === "edit") && <ConfigButton size="small" onClick={beginDuplicate} disabled={saving || toggling}>{t("agents.duplicate")}</ConfigButton>}
                      {selected && isWritableScope(selected.scope) && mode === "edit" && <ConfigButton variant="danger" size="small" onClick={() => void remove()} disabled={saving || toggling}>{t("agents.delete")}</ConfigButton>}
                      <ConfigSwitch checked={draft.enabled} disabled={switchDisabled} label={draft.enabled ? t("agents.disable") : t("agents.enable")} onChange={(checked) => void toggleEnabled(checked)} />
                    </ConfigDetailActions>
                  </ConfigDetailHeader>

                  {selected?.configurationError && !creating && (
                    <div role="alert" style={{ display: "flex", flexDirection: "column", gap: 4, color: "#ef4444", fontSize: 12 }}>
                      <strong>{t("agents.configurationErrorTitle")}</strong>
                      <span>{selected.configurationError}</span>
                      <span>{t("agents.configurationErrorHelp")}</span>
                    </div>
                  )}

                  {creating && (
                    <Field label={t("agents.saveScope")}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3, padding: 3, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)" }}>
                        {(["global", "project"] as const).map((scope) => (
                          <button
                            key={scope}
                            type="button"
                            onClick={() => setTargetScope(scope)}
                            disabled={saving}
                            style={{ height: 28, border: "none", borderRadius: 4, background: targetScope === scope ? "var(--bg-selected)" : "transparent", color: targetScope === scope ? "var(--text)" : "var(--text-muted)", cursor: saving ? "default" : "pointer", fontSize: 11, fontWeight: targetScope === scope ? 600 : 400 }}
                          >
                            {t(`agents.scope.${scope}`)}
                          </button>
                        ))}
                      </div>
                    </Field>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1fr) minmax(0, 1fr)", gap: 12 }}>
                    <Field label={t("agents.name")}>
                      {creating ? (
                        <input aria-label={t("agents.name")} value={draft.name} disabled={disabled} onChange={(event) => update("name", event.target.value)} style={inputStyle} />
                      ) : (
                        <code style={{ minHeight: 34, display: "flex", alignItems: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12 }}>
                          {draft.name}
                        </code>
                      )}
                    </Field>
                    <Field label={t("agents.displayName")}>
                      <input aria-label={t("agents.displayName")} value={draft.displayName} disabled={disabled} onChange={(event) => update("displayName", event.target.value)} style={controlStyle} />
                    </Field>
                  </div>
                  <Field label={t("agents.description")}>
                    <input aria-label={t("agents.description")} value={draft.description} disabled={disabled} onChange={(event) => update("description", event.target.value)} style={controlStyle} />
                  </Field>
                  <Field label={t("agents.prompt")}>
                    <textarea className="agents-system-prompt" aria-label={t("agents.prompt")} value={draft.systemPrompt} disabled={disabled} onChange={(event) => update("systemPrompt", event.target.value)} style={{ ...controlStyle, height: 195, minHeight: 195, maxHeight: "60vh", padding: 9, overflow: "auto", resize: disabled ? "none" : "vertical", lineHeight: 1.5 }} />
                  </Field>

                  {!draft.orchestration && (
                    <Field label={t("agents.tools")}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px" }}>
                        {TOOL_OPTIONS.map((tool) => (
                          <Toggle key={tool} label={tool} disabled={disabled} checked={draft.tools.includes(tool)} onChange={(checked) => update("tools", checked ? [...draft.tools, tool] : draft.tools.filter((item) => item !== tool))} />
                        ))}
                      </div>
                    </Field>
                  )}

                  <Field label={t("agents.orchestration")}>
                    <Toggle
                      label={t("agents.orchestrator")}
                      disabled={disabled}
                      checked={draft.orchestration !== null && draft.orchestration !== undefined}
                      onChange={(checked) => setDraft((current) => checked
                        ? { ...current, orchestration: { allowedChildren: [] }, tools: [], extensionTools: [], loadSkills: false, loadExtensions: false }
                        : { ...current, orchestration: null })}
                    />
                    {draft.orchestration && (
                      <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                        {t("agents.orchestratorDescription")}
                      </span>
                    )}
                  </Field>
                  {draft.orchestration && (
                    <Field label={t("agents.allowedChildren")}>
                      <input
                        aria-label={t("agents.searchChildren")}
                        placeholder={t("agents.searchChildren")}
                        value={childrenQuery}
                        disabled={disabled}
                        onChange={(event) => setChildrenQuery(event.target.value)}
                        style={controlStyle}
                      />
                      <div role="group" aria-label={t("agents.allowedChildren")} style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                        {visibleChildProfiles.length === 0 && (
                          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                            {t(childProfiles.length > 0 ? "agents.noMatchingChildren" : "agents.noAvailableChildren")}
                          </span>
                        )}
                        {visibleChildProfiles.map((profile) => (
                          <Toggle
                            key={profileKey(profile)}
                            label={`${profile.displayName} (${profile.name})`}
                            disabled={disabled}
                            checked={draft.orchestration?.allowedChildren.some((name) => name.toLowerCase() === profile.name.toLowerCase()) ?? false}
                            onChange={(checked) => toggleAllowedChild(profile.name, checked)}
                          />
                        ))}
                        {unavailableChildren.map((name) => (
                          <Toggle
                            key={`unavailable:${name}`}
                            label={t("agents.unavailableChild", { name })}
                            disabled={disabled}
                            checked
                            onChange={() => toggleAllowedChild(name, false)}
                          />
                        ))}
                      </div>
                      {unavailableChildren.length > 0 && (
                        <span role="alert" style={{ color: "#ef4444", fontSize: 11 }}>
                          {t("agents.unavailableChildren", { names: unavailableChildren.join(", ") })}
                        </span>
                      )}
                    </Field>
                  )}

                  {draft.orchestration && (
                    <Field label={t("agents.dependencies")}>
                      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{t("agents.dependenciesDescription")}</span>
                      <div role="group" aria-label={t("agents.dependencies")} style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                        {draft.orchestration.allowedChildren.length < 2 && (
                          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("agents.dependenciesNeedChildren")}</span>
                        )}
                        {draft.orchestration.allowedChildren.map((consumer) => {
                          const profile = childProfiles.find((child) => child.name.toLowerCase() === consumer.toLowerCase());
                          const producers = Object.entries(draft.orchestration?.dependencies ?? {})
                            .find(([name]) => name.toLowerCase() === consumer.toLowerCase())?.[1] ?? [];
                          const otherChildren = draft.orchestration?.allowedChildren.filter((child) => child.toLowerCase() !== consumer.toLowerCase()) ?? [];
                          if (otherChildren.length === 0) return null;
                          return (
                            <details key={consumer} style={{ border: "1px solid var(--border)", borderRadius: 5, padding: "7px 9px", background: "var(--bg-panel)" }}>
                              <summary style={{ cursor: "pointer", color: "var(--text)", fontSize: 12 }}>
                                {profile?.displayName ?? consumer} ({consumer}) · {producers.length > 0
                                  ? t("agents.dependsOnCount", { count: producers.length })
                                  : t("agents.noDependencies")}
                              </summary>
                              <div role="group" aria-label={t("agents.dependsOnAgent", { name: consumer })} style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 9, paddingLeft: 5 }}>
                                {otherChildren.map((producer) => {
                                  const producerProfile = childProfiles.find((child) => child.name.toLowerCase() === producer.toLowerCase());
                                  return (
                                    <Toggle
                                      key={producer}
                                      label={`${producerProfile?.displayName ?? producer} (${producer})`}
                                      disabled={disabled}
                                      checked={producers.some((name) => name.toLowerCase() === producer.toLowerCase())}
                                      onChange={(checked) => toggleDependency(consumer, producer, checked)}
                                    />
                                  );
                                })}
                              </div>
                            </details>
                          );
                        })}
                      </div>
                      {dependencyIssue && (
                        <div role="alert" style={{ display: "flex", alignItems: "center", gap: 8, color: "#ef4444", fontSize: 11, marginTop: 8 }}>
                          <span>{dependencyIssue.type === "unknown"
                            ? t("agents.unknownDependencies", { names: dependencyIssue.names.join(", ") })
                            : dependencyIssue.type === "self"
                              ? t("agents.selfDependency", { name: dependencyIssue.name })
                              : t("agents.cyclicDependencies", { names: dependencyIssue.names.join(" → ") })}</span>
                          {dependencyIssue.type !== "cycle" && !disabled && (
                            <button type="button" onClick={repairInvalidDependencies} style={{ color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, padding: "3px 6px", cursor: "pointer" }}>
                              {t("agents.removeInvalidDependencies")}
                            </button>
                          )}
                        </div>
                      )}
                    </Field>
                  )}

                  {!draft.orchestration && (
                    <Field label={t("agents.resources")}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px" }}>
                        <Toggle label={t("agents.loadSkills")} disabled={disabled} checked={draft.loadSkills} onChange={(checked) => update("loadSkills", checked)} />
                        <Toggle label={t("agents.loadExtensions")} disabled={disabled} checked={draft.loadExtensions} onChange={(checked) => update("loadExtensions", checked)} />
                      </div>
                    </Field>
                  )}

                  <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(0, 1.5fr) minmax(120px, 0.75fr) minmax(100px, 0.5fr)", gap: 12 }}>
                    <Field label={t("agents.model")}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <ModelSelector
                          options={modelSelectorOptions}
                          value={selectedModel}
                          onChange={(provider, modelId) => update("model", `${provider}/${modelId}`)}
                          onClear={() => update("model", undefined)}
                          emptyLabel={modelsLoading ? t("agents.modelsLoading") : t("agents.inherit")}
                          selectedLabel={draft.model && !selectedModelAvailable ? t("agents.modelUnavailable", { model: draft.model }) : undefined}
                          disabled={disabled || modelsLoading || (modelOptions.length === 0 && !draft.model)}
                          ariaLabel={t("agents.model")}
                          variant="field"
                          placement="auto"
                        />
                        {modelsError && <span style={{ color: "#ef4444", fontSize: 10 }}>{modelsError}</span>}
                      </div>
                    </Field>
                    <Field label={t("agents.thinking")}>
                      <select aria-label={t("agents.thinking")} value={draft.thinking ?? ""} disabled={disabled} onChange={(event) => update("thinking", (event.target.value || undefined) as EditableProfile["thinking"])} style={controlStyle}>
                        {THINKING_OPTIONS.map((value) => <option key={value || "default"} value={value}>{value || t("agents.inherit")}</option>)}
                      </select>
                    </Field>
                    <Field label={t("agents.maxTurns")}>
                      <input aria-label={t("agents.maxTurns")} type="number" min={1} value={draft.maxTurns ?? ""} disabled={disabled} onChange={(event) => update("maxTurns", event.target.value ? Number(event.target.value) : undefined)} style={controlStyle} />
                    </Field>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 20px" }}>
                    <Toggle label={t("agents.inheritContext")} disabled={disabled} checked={draft.inheritContext} onChange={(checked) => update("inheritContext", checked)} />
                    <Toggle label={t("agents.background")} disabled={disabled} checked={draft.runInBackground} onChange={(checked) => update("runInBackground", checked)} />
                  </div>
                </ConfigDetailStack>
              )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>
      <ConfigFooter status={(settingsError || error) && <span role="alert" style={{ color: "#ef4444" }}>{settingsError || error}</span>}>
        {editing && (
          <ConfigButton
            variant="primary"
            onClick={() => void save()}
            disabled={saving || savedOk || toggling || !draft.name.trim() || unavailableChildren.length > 0 || Boolean(dependencyIssue)}
            className={savedOk ? "is-success" : undefined}
          >
            {savedOk && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="config-button-success-icon">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            <span>{savedOk ? t("i18n.saved") : saving ? t("agents.saving") : t("agents.save")}</span>
          </ConfigButton>
        )}
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
