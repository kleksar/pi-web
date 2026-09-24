"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SubagentProfilesResponse, SubagentSettingsResponse } from "@/lib/api-types";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ModelsData } from "@/lib/models-cache";
import type { MainAgentConfig } from "@/lib/main-agent-config";
import { MAIN_NODE_ID, effectiveMapProfiles, mapOwnersForAgent } from "@/lib/orchestration-map";
import { findOrchestrationLinkIssue, withAllowedChildren } from "@/lib/orchestration-policy";
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
import { AgentResourceSelector } from "./AgentResourceSelector";
import { OrchestrationMap } from "./OrchestrationMap";

const TOOL_OPTIONS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const THINKING_OPTIONS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type EditableProfile = SubagentProfileInput;
type EditorMode = "view" | "edit" | "create";

const EMPTY_PROFILE: EditableProfile = {
  name: "custom-agent",
  displayName: "Custom agent",
  description: "",
  systemPrompt: "",
  tools: [],
  loadSkills: false,
  loadExtensions: false,
  selectedSkills: [],
  selectedExtensionTools: [],
  promptMode: "append",
  inheritContext: false,
  runInBackground: false,
  fastMode: false,
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
    loadSkills: profile.loadSkills,
    loadExtensions: profile.orchestration ? false : profile.loadExtensions,
    ...(profile.selectedSkills !== undefined ? { selectedSkills: [...profile.selectedSkills] } : {}),
    ...(profile.selectedExtensionTools !== undefined
      ? { selectedExtensionTools: profile.selectedExtensionTools.map((tool) => ({ ...tool })) } : {}),
    promptMode: profile.promptMode,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.thinking ? { thinking: profile.thinking } : {}),
    ...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
    inheritContext: profile.inheritContext,
    runInBackground: profile.runInBackground,
    fastMode: profile.fastMode,
    orchestration: profile.orchestration
      ? {
          allowedChildren: [...profile.orchestration.allowedChildren],
          ...(profile.orchestration.dependencies
            ? { dependencies: Object.fromEntries(Object.entries(profile.orchestration.dependencies).map(([name, producers]) => [name, [...producers]])) }
            : {}),
          ...(profile.orchestration.contextProviders
            ? { contextProviders: Object.fromEntries(Object.entries(profile.orchestration.contextProviders).map(([name, providers]) => [name, [...providers]])) }
            : {}),
        }
      : null,
    enabled: profile.enabled,
  };
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
  return scope === "global" || scope === "project" || scope === "roster";
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
  if ((profile.scope === "project" || profile.scope === "workspace" || profile.scope === "roster") && profile.filePath.startsWith(cwd)) {
    const relative = profile.filePath.slice(cwd.length).replace(/^[/\\]/, "");
    return `./${relative}`;
  }
  return shortenPath(profile.filePath);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <ConfigField label={label}>{children}</ConfigField>;
}

function Toggle({ checked, disabled, label, hint, onChange }: { checked: boolean; disabled: boolean; label: string; hint?: string; onChange: (checked: boolean) => void }) {
  return (
    <label title={hint} style={{ display: "flex", alignItems: "center", gap: 7, color: disabled ? "var(--text-dim)" : "var(--text-muted)", fontSize: 12, cursor: disabled ? "default" : "pointer" }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

export function AgentsConfig({
  cwd,
  projectSelected = true,
  sessionId = null,
  onClose,
  onReloaded,
  embedded = false,
  openMainMapRequest = 0,
}: {
  cwd: string;
  projectSelected?: boolean;
  sessionId?: string | null;
  onClose: () => void;
  onReloaded?: () => void;
  embedded?: boolean;
  openMainMapRequest?: number;
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
  const [customizingBuiltIn, setCustomizingBuiltIn] = useState(false);
  const [targetScope, setTargetScope] = useState<SubagentWritableScope>("roster");
  const [rosterAvailable, setRosterAvailable] = useState(false);
  const [rosterRoot, setRosterRoot] = useState("");
  const profileLoadSerial = useRef(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [builtInEnabled, setBuiltInEnabled] = useState(false);
  const [maxConcurrent, setMaxConcurrent] = useState(10);
  const [maxConcurrentInput, setMaxConcurrentInput] = useState("10");
  const [settingsEditScope, setSettingsEditScope] = useState<"roster" | "local">("local");
  const [settingsSources, setSettingsSources] = useState<SubagentSettingsResponse["sources"]>();
  const [repositorySettingsAvailable, setRepositorySettingsAvailable] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [reloadNeeded, setReloadNeeded] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [childrenQuery, setChildrenQuery] = useState("");
  const [profileQuery, setProfileQuery] = useState("");
  const [view, setView] = useState<"profiles" | "map">("profiles");
  const [mapOwner, setMapOwner] = useState<string | null>(null);
  const [mapFocusNode, setMapFocusNode] = useState<string | null>(null);
  const [pendingMapAgent, setPendingMapAgent] = useState<string | null>(null);
  const [mainConfig, setMainConfig] = useState<MainAgentConfig>({});
  const [mainDraft, setMainDraft] = useState<MainAgentConfig>({});
  const [mainOverrides, setMainOverrides] = useState<MainAgentConfig>({});
  const [mainRevision, setMainRevision] = useState<string | null>(null);
  const [mainProjectTrusted, setMainProjectTrusted] = useState(true);
  const [loadedMainSource, setLoadedMainSource] = useState<string | null>(null);
  const mainLoadSerial = useRef(0);
  const [mainMapError, setMainMapError] = useState<string | null>(null);
  const [mainMapSaving, setMainMapSaving] = useState(false);
  // AgentsConfig mounts lazily. A request issued from Main can already be positive on first mount.
  const lastMainMapRequest = useRef(0);

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
    ? findOrchestrationLinkIssue(draft.orchestration.allowedChildren, draft.orchestration.dependencies, draft.orchestration.contextProviders)
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
  const mapProfiles = useMemo(() => effectiveMapProfiles(profiles), [profiles]);
  const visibleProfiles = useMemo(() => {
    const query = profileQuery.trim().toLowerCase();
    return query ? profiles.filter((profile) => `${profile.displayName} ${profile.name}`.toLowerCase().includes(query)) : profiles;
  }, [profiles, profileQuery]);
  const profileDraftChanged = mode === "create" || Boolean(selected && mode === "edit"
    && JSON.stringify(draft) !== JSON.stringify(editableProfile(selected)));
  const mainDraftChanged = JSON.stringify(mainDraft) !== JSON.stringify(mainConfig);
  const mainMapScope = rosterAvailable ? "roster" : projectSelected ? "project" : "global";
  const wantedMainSource = `${cwd}:${mainMapScope}`;

  const loadMainForMap = useCallback(async () => {
    const loadSerial = ++mainLoadSerial.current;
    const scope = rosterAvailable ? "roster" : "project";
    setMainMapError(null);
    try {
      const response = await fetch(`/api/main/config?cwd=${encodeURIComponent(cwd)}&scope=${scope}`, { cache: "no-store" });
      const data = await response.json() as { config?: MainAgentConfig; overrides?: MainAgentConfig; trusted?: boolean; revision?: string; error?: string };
      if (loadSerial !== mainLoadSerial.current) return;
      if (!response.ok || data.error || !data.config || !data.revision) throw new Error(data.error ?? `HTTP ${response.status}`);
      setMainConfig(data.config);
      setMainDraft(data.config);
      setMainOverrides(data.overrides ?? {});
      setMainProjectTrusted(data.trusted ?? true);
      setMainRevision(data.revision);
      setLoadedMainSource(`${cwd}:${scope}`);
    } catch (cause) {
      if (loadSerial !== mainLoadSerial.current) return;
      setMainMapError(cause instanceof Error ? cause.message : String(cause));
      setMainRevision(null);
    }
  }, [cwd, rosterAvailable]);

  useEffect(() => {
    if (!loading && (mainRevision === null || loadedMainSource !== wantedMainSource)) void loadMainForMap();
  }, [loading, mainRevision, loadedMainSource, wantedMainSource, loadMainForMap]);

  useEffect(() => {
    const onMainConfigUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ config: MainAgentConfig; revision: string; origin?: string; scope?: string; overrides?: MainAgentConfig }>).detail;
      if (!detail?.config || typeof detail.revision !== "string" || detail.origin === "map" || detail.scope !== mainMapScope) return;
      if (mainDraftChanged) {
        setMainMapError(t("main.configChanged"));
        return;
      }
      setMainConfig(detail.config);
      setMainDraft(detail.config);
      setMainOverrides(detail.overrides ?? {});
      setMainRevision(detail.revision);
      setMainMapError(null);
    };
    window.addEventListener("pi-web:main-config-updated", onMainConfigUpdated);
    return () => window.removeEventListener("pi-web:main-config-updated", onMainConfigUpdated);
  }, [mainDraftChanged, mainMapScope, t]);

  const loadProfiles = useCallback(async (preferredKey?: string) => {
    const loadSerial = ++profileLoadSerial.current;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/subagents/profiles?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const data = await response.json() as Partial<SubagentProfilesResponse> & { error?: string; rosterAvailable?: boolean; rosterRoot?: string };
      if (loadSerial !== profileLoadSerial.current) return;
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      const next = (data.profiles ?? []).filter((profile) => projectSelected
        || (profile.scope !== "project" && profile.scope !== "workspace"));
      setRosterAvailable(Boolean(data.rosterAvailable));
      setRosterRoot(data.rosterRoot ?? "");
      setProfiles(next);
      window.dispatchEvent(new CustomEvent("pi-web:subagent-profiles-updated", { detail: { cwd } }));
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
      } else {
        setDraft(EMPTY_PROFILE);
        setMode("view");
      }
    } catch (cause) {
      if (loadSerial === profileLoadSerial.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (loadSerial === profileLoadSerial.current) setLoading(false);
    }
  }, [cwd, projectSelected]);

  useEffect(() => {
    const loadSerialRef = profileLoadSerial;
    void loadProfiles();
    return () => { loadSerialRef.current++; };
  }, [loadProfiles]);

  useEffect(() => {
    if (!projectSelected && targetScope === "project") setTargetScope(rosterAvailable ? "roster" : "global");
  }, [projectSelected, rosterAvailable, targetScope]);

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
        if (typeof data.maxConcurrent === "number") {
          setMaxConcurrent(data.maxConcurrent);
          setMaxConcurrentInput(String(data.maxConcurrent));
        }
        setSettingsSources(data.sources);
        setSettingsEditScope(data.defaultEditScope === "roster" ? "roster" : "local");
        setRepositorySettingsAvailable(data.defaultEditScope === "roster");
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

  const selectProfile = useCallback((profile: SubagentProfile, confirmed = false): boolean => {
    if (selectedKey === profileKey(profile) && mode !== "create") return true;
    if (!confirmed && profileDraftChanged && !window.confirm(t("agents.discardChanges"))) return false;
    setSelectedKey(profileKey(profile));
    setDraft(editableProfile(profile));
    setMode(isWritableScope(profile.scope) ? "edit" : "view");
    setCustomizingBuiltIn(false);
    if (isWritableScope(profile.scope)) setTargetScope(profile.scope);
    setError(null);
    setChildrenQuery("");
    return true;
  }, [selectedKey, mode, profileDraftChanged, t]);

  const beginCreate = () => {
    if (profileDraftChanged && !window.confirm(t("agents.discardChanges"))) return;
    let name = "custom-agent";
    let suffix = 2;
    while (profiles.some((profile) => profile.name === name)) name = `custom-agent-${suffix++}`;
    setSelectedKey(null);
    setDraft({ ...EMPTY_PROFILE, name, displayName: name });
    setMode("create");
    setCustomizingBuiltIn(false);
    setTargetScope(rosterAvailable ? "roster" : projectSelected ? "project" : "global");
    setError(null);
    setChildrenQuery("");
  };

  const beginDuplicate = () => {
    if (!selected) return;
    if (profileDraftChanged && !window.confirm(t("agents.discardChanges"))) return;
    const name = duplicateProfileName(selected.name, profiles);
    setSelectedKey(null);
    setDraft({
      ...editableProfile(selected),
      name,
      displayName: t("agents.copyName", { name: selected.displayName }),
    });
    setMode("create");
    setCustomizingBuiltIn(false);
    setTargetScope(isWritableScope(selected.scope) && (selected.scope !== "project" || projectSelected)
      ? selected.scope : rosterAvailable ? "roster" : projectSelected ? "project" : "global");
    setError(null);
    setChildrenQuery("");
  };

  const beginCustomizeBuiltIn = () => {
    if (!selected || selected.scope !== "builtin") return;
    const existing = profiles.find((profile) => profile.scope === "global" && profile.name.toLowerCase() === selected.name.toLowerCase());
    if (existing) { selectProfile(existing); return; }
    setSelectedKey(null);
    setDraft(editableProfile(selected));
    setMode("create");
    setCustomizingBuiltIn(true);
    setTargetScope("global");
    setError(null);
    setChildrenQuery("");
  };

  const save = async () => {
    if (!projectSelected && (targetScope === "project" || selected?.scope === "project")) {
      setError(t("settings.projectRequired"));
      return;
    }
    if (unavailableChildren.length > 0) {
      setError(t("agents.unavailableChildren", { names: unavailableChildren.join(", ") }));
      return;
    }
    if (dependencyIssue) {
      setError(dependencyIssue.type === "unknown"
        ? t("agents.unknownDependencies", { names: dependencyIssue.names.join(", ") })
        : dependencyIssue.type === "self"
          ? t("agents.selfDependency", { name: dependencyIssue.name })
          : dependencyIssue.type === "limit"
            ? t("agents.tooManySources", { name: dependencyIssue.name })
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
    if (!projectSelected && selected?.scope === "project") return;
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
      : targetScope === "roster" ? `${rosterRoot || "Shared roster"}/agents/${draft.name || "..."}.md`
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
    : !selected || Boolean(selected.configurationError) || !isTogglableScope(selected.scope)
      || (!projectSelected && selected.scope === "project") || saving || toggling;
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
      return {
        ...current,
        orchestration: withAllowedChildren(current.orchestration, allowedChildren),
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
      const clean = (entries: Record<string, string[]> | undefined): Record<string, string[]> => {
        const sanitized: Record<string, string[]> = {};
        for (const [consumer, producers] of Object.entries(entries ?? {})) {
          const knownConsumer = allowed.get(consumer.toLowerCase());
          if (!knownConsumer) continue;
          const validProducers = producers
            .map((producer) => allowed.get(producer.toLowerCase()))
            .filter((producer): producer is string => producer !== undefined && producer.toLowerCase() !== knownConsumer.toLowerCase());
          const unique = [...new Set(validProducers)];
          if (unique.length > 0) sanitized[knownConsumer] = unique;
        }
        return sanitized;
      };
      const dependencies = clean(current.orchestration.dependencies);
      const contextProviders = clean(current.orchestration.contextProviders);
      return { ...current, orchestration: {
        ...current.orchestration,
        ...(Object.keys(dependencies).length > 0 ? { dependencies } : { dependencies: undefined }),
        ...(Object.keys(contextProviders).length > 0 ? { contextProviders } : { contextProviders: undefined }),
      } };
    });
  };

  const toggleEnabled = async (enabled: boolean) => {
    if (!projectSelected && selected?.scope === "project") return;
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
      window.dispatchEvent(new CustomEvent("pi-web:subagent-profiles-updated", { detail: { cwd } }));
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
        body: JSON.stringify({ enabled, scope: settingsEditScope }),
      });
      const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
      if (!response.ok || data.error || typeof data.enabled !== "boolean") {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setBuiltInEnabled(data.enabled);
      setSettingsSources(data.sources);
      setReloadNeeded(Boolean(sessionId));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsSaving(false);
    }
  };

  const updateMaxConcurrent = async (raw: string) => {
    const value = Number(raw);
    if (!raw.trim() || !Number.isInteger(value) || value < 1 || value > 32) {
      setMaxConcurrentInput(String(maxConcurrent));
      setSettingsError(t("agents.concurrentRange"));
      return;
    }
    if (value === maxConcurrent) {
      setMaxConcurrentInput(String(maxConcurrent));
      return;
    }
    setSettingsSaving(true);
    setSettingsError(null);
    try {
      const response = await fetch("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxConcurrent: value, scope: settingsEditScope }),
      });
      const data = await response.json() as Partial<SubagentSettingsResponse> & { error?: string };
      if (!response.ok || data.error || typeof data.maxConcurrent !== "number") throw new Error(data.error ?? `HTTP ${response.status}`);
      setMaxConcurrent(data.maxConcurrent);
      setMaxConcurrentInput(String(data.maxConcurrent));
      setSettingsSources(data.sources);
      setReloadNeeded(Boolean(sessionId));
    } catch (cause) {
      setMaxConcurrentInput(String(maxConcurrent));
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsSaving(false);
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

  const selectMapOwner = useCallback((ownerId: string | null): boolean => {
    if (ownerId === mapOwner && (ownerId === null || ownerId === MAIN_NODE_ID || selected?.name.toLowerCase() === ownerId.toLowerCase())) return true;
    const nextProfile = ownerId && ownerId !== MAIN_NODE_ID
      ? mapProfiles.find((profile) => profile.name.toLowerCase() === ownerId.toLowerCase())
      : undefined;
    const leavingMain = mapOwner === MAIN_NODE_ID && ownerId !== MAIN_NODE_ID && mainDraftChanged;
    const leavingProfile = profileDraftChanged && (
      mapOwner !== null && mapOwner !== MAIN_NODE_ID && ownerId !== mapOwner
      || nextProfile !== undefined && profileKey(nextProfile) !== selectedKey
      || mapOwner === null && ownerId === MAIN_NODE_ID
    );
    if ((leavingMain || leavingProfile) && !window.confirm(t("agents.discardChanges"))) return false;
    if (leavingMain) setMainDraft(mainConfig);
    if (leavingProfile && selected) setDraft(editableProfile(selected));
    if (nextProfile && (profileKey(nextProfile) !== selectedKey || mode === "create")) selectProfile(nextProfile, true);
    setMapOwner(ownerId);
    setMainMapError(null);
    return true;
  }, [mapOwner, mapProfiles, mainDraftChanged, profileDraftChanged, selected, selectedKey, mode, mainConfig, selectProfile, t]);

  const openSelectedOnMap = () => {
    if (!selected) return;
    if (profileDraftChanged && !window.confirm(t("agents.discardChanges"))) return;
    if (profileDraftChanged) setDraft(editableProfile(selected));
    setMapFocusNode(selected.name);
    setPendingMapAgent(selected.name);
    setView("map");
  };

  useEffect(() => {
    if (!pendingMapAgent || mainRevision === null) return;
    const owners = mapOwnersForAgent(pendingMapAgent, mapProfiles, mainDraft.orchestration ?? null);
    const preferred = mapProfiles.find((profile) => profile.name.toLowerCase() === pendingMapAgent.toLowerCase())?.orchestration
      ? pendingMapAgent
      : owners.length === 1 ? owners[0] : null;
    const switched = selectMapOwner(preferred);
    setPendingMapAgent(null);
    if (!switched) { setMapFocusNode(null); setView("profiles"); }
  }, [pendingMapAgent, mainRevision, mapProfiles, mainDraft.orchestration, selectMapOwner]);

  const openMapProfile = (name: string) => {
    const profile = mapProfiles.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!profile) return;
    if (mapOwner === MAIN_NODE_ID && mainDraftChanged && !window.confirm(t("agents.discardChanges"))) return;
    if (mapOwner === MAIN_NODE_ID && mainDraftChanged) setMainDraft(mainConfig);
    if (profileKey(profile) !== selectedKey || mode === "create") {
      if (!selectProfile(profile)) return;
    }
    setView("profiles");
  };

  const saveMapMain = async () => {
    if (!mainRevision || !mainDraftChanged || mainMapSaving || loadedMainSource !== wantedMainSource
      || (mainMapScope === "project" && (!projectSelected || !mainProjectTrusted))) return;
    setMainMapSaving(true);
    setMainMapError(null);
    try {
      const response = await fetch("/api/main/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, scope: mainMapScope, config: mainDraft,
          expectedRevision: mainRevision,
          ...(mainMapScope !== "roster" ? { previous: mainConfig, overrides: mainOverrides } : {}) }),
      });
      const data = await response.json() as { config?: MainAgentConfig; overrides?: MainAgentConfig; trusted?: boolean; revision?: string; error?: string };
      if (!response.ok || data.error || !data.config || !data.revision) throw new Error(data.error ?? `HTTP ${response.status}`);
      setMainConfig(data.config);
      setMainDraft(data.config);
      setMainOverrides(data.overrides ?? {});
      setMainProjectTrusted(data.trusted ?? true);
      setMainRevision(data.revision);
      window.dispatchEvent(new CustomEvent("pi-web:main-config-updated", {
        detail: { config: data.config, revision: data.revision, overrides: data.overrides ?? {}, origin: "map", scope: mainMapScope },
      }));
      window.dispatchEvent(new Event("pi-web:project-trust-updated"));
    } catch (cause) {
      setMainMapError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMainMapSaving(false);
    }
  };

  const updateMapPolicy = (ownerId: string, next: NonNullable<EditableProfile["orchestration"]>) => {
    if (ownerId === MAIN_NODE_ID) {
      setMainDraft((current) => ({ ...current, orchestration: next }));
    } else if (ownerId.toLowerCase() === selected?.name.toLowerCase()) {
      setDraft((current) => ({ ...current, orchestration: next }));
    } else {
      setMainMapError(t("map.errorOwnerUnavailable"));
    }
  };

  const mapEditable = mapOwner === MAIN_NODE_ID
    ? mainRevision !== null && loadedMainSource === wantedMainSource && !mainMapSaving
      && (mainMapScope === "roster" || mainProjectTrusted)
    : Boolean(mapOwner && selected && mapOwner.toLowerCase() === selected.name.toLowerCase()
      && (projectSelected || selected.scope !== "project")
      && isWritableScope(selected.scope) && !selected.configurationError && !saving);

  useEffect(() => {
    if (openMainMapRequest === lastMainMapRequest.current) return;
    lastMainMapRequest.current = openMainMapRequest;
    if ((profileDraftChanged || (mapOwner === MAIN_NODE_ID && mainDraftChanged))
      && !window.confirm(t("agents.discardChanges"))) return;
    if (profileDraftChanged && selected) setDraft(editableProfile(selected));
    if (mainDraftChanged) setMainDraft(mainConfig);
    setMapFocusNode(null);
    setPendingMapAgent(null);
    setMapOwner(MAIN_NODE_ID);
    setView("map");
  }, [openMainMapRequest, mainConfig, mainDraftChanged, mapOwner, profileDraftChanged, selected, t]);

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.agents")} subtitle={shortenPath(cwd)} closeLabel={t("agents.close")} onClose={onClose}>
      <div className="agents-feature-setting">
        <div className="agents-feature-copy">
          <strong>{t("agents.builtInTitle")}</strong>
          <span>{t("agents.builtInDescription")}</span>
          {settingsSources && <span role="status">
            {t("agents.settingsSources")
              .replace("{enabled}", settingsSources.builtInEnabled)
              .replace("{concurrency}", settingsSources.maxConcurrent)
              .replace("{profiles}", settingsSources.disabledBuiltIns)}
          </span>}
          {reloadNeeded && <span role="status" className="agents-feature-reload-notice">{t("agents.reloadRequired")}</span>}
        </div>
        <div className="agents-feature-actions">
          {repositorySettingsAvailable && <label className="agents-concurrency-control">
            <span>{t("agents.settingsSaveTo")}</span>
            <select
              aria-label={t("agents.settingsSaveTo")}
              value={settingsEditScope}
              disabled={settingsSaving}
              onChange={(event) => setSettingsEditScope(event.target.value as "roster" | "local")}
            >
              <option value="roster">{t("agents.settingsRepo")}</option>
              <option value="local">{t("agents.settingsLocal")}</option>
            </select>
          </label>}
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
              value={maxConcurrentInput}
              disabled={settingsLoading || settingsSaving}
              onChange={(event) => setMaxConcurrentInput(event.target.value)}
              onBlur={(event) => void updateMaxConcurrent(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
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
      {!loading && !error && (
        <div className={`agents-roster-info ${rosterAvailable ? "is-connected" : "is-disconnected"}`} role="status">
          <strong>{t(rosterAvailable ? "agents.rosterConnected" : "agents.rosterUnavailable")}</strong>
          <span>{rosterAvailable
            ? t("agents.rosterConnectedDescription", {
                count: String(profiles.filter((profile) => profile.scope === "roster").length),
                path: shortenPath(rosterRoot),
              })
            : t("agents.rosterUnavailableDescription")}</span>
        </div>
      )}
      <div role="group" aria-label={t("common.agents")} style={{ display: "flex", gap: 4, padding: "7px 16px", borderBottom: "1px solid var(--border)" }}>
        <ConfigButton size="small" variant={view === "profiles" ? "primary" : undefined} onClick={() => setView("profiles")}>{t("agents.profiles")}</ConfigButton>
        <ConfigButton size="small" variant={view === "map" ? "primary" : undefined} onClick={() => {
          if (!selectMapOwner(MAIN_NODE_ID)) return;
          setMapFocusNode(null);
          setPendingMapAgent(null);
          setMapOwner(MAIN_NODE_ID);
          setView("map");
        }}>{t("agents.openMap")}</ConfigButton>
        {view === "map" && <span style={{ marginLeft: "auto", alignSelf: "center", color: "var(--text-dim)", fontSize: 11 }}>
          {t(mainMapScope === "roster" ? "main.rosterScope" : mainMapScope === "project" ? "main.projectScope" : "main.globalScope")}
        </span>}
      </div>
      {view === "map" ? (
        <OrchestrationMap
          cwd={cwd}
          profiles={mapProfiles}
          main={{ orchestration: mainDraft.orchestration ?? null,
            allowedBuiltInTools: mainDraft.allowedBuiltInTools,
            selectedSkills: mainDraft.selectedSkills,
            selectedExtensionTools: mainDraft.selectedExtensionTools }}
          ownerId={mapOwner}
          focusNodeId={mapFocusNode}
          draftOrchestration={mapOwner === MAIN_NODE_ID ? mainDraft.orchestration
            : mapOwner && selected?.name.toLowerCase() === mapOwner.toLowerCase() ? draft.orchestration : undefined}
          canEdit={mapEditable}
          onSelectOwner={selectMapOwner}
          onOpenProfile={openMapProfile}
          onRestrictMain={() => setMainDraft((current) => ({ ...current, orchestration: { allowedChildren: [] } }))}
          onToggleChild={(ownerId, _childName, _enabled, next) => updateMapPolicy(ownerId, next)}
          onToggleDependency={(ownerId, _producerName, _consumerName, _enabled, next) => updateMapPolicy(ownerId, next)}
          onToggleContextProvider={(ownerId, _providerName, _consumerName, _enabled, next) => updateMapPolicy(ownerId, next)}
        />
      ) : (
      <ConfigSplitView>
        <ConfigSidebar>
          <input className="config-sidebar-search" type="search" aria-label={t("agents.searchProfiles")}
            placeholder={t("agents.searchProfiles")} value={profileQuery}
            onChange={(event) => setProfileQuery(event.target.value)} />
          <ConfigSidebarList>
              {loading ? (
                <div style={{ padding: 10, color: "var(--text-dim)", fontSize: 12 }}>{t("agents.loading")}</div>
              ) : error ? (
                <div className="config-sidebar-message is-error">{error}
                  <ConfigButton size="small" onClick={() => { if (!profileDraftChanged || window.confirm(t("agents.discardChanges"))) void loadProfiles(selectedKey ?? undefined); }}>{t("main.retryProfiles")}</ConfigButton>
                </div>
              ) : visibleProfiles.length === 0 && profileQuery.trim() ? (
                <div className="config-sidebar-message is-empty">{t("agents.noMatchingChildren")}</div>
              ) : (["project", ...(rosterAvailable ? ["roster" as const] : []), "global", "workspace", "builtin"] as const).map((scope) => {
                const scopedProfiles = visibleProfiles.filter((profile) => profile.scope === scope);
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
                      {selected && !creating && <ConfigButton size="small" onClick={openSelectedOnMap} disabled={saving || toggling}>{t("agents.mapForAgent")}</ConfigButton>}
                      {selected?.scope === "builtin" && !creating && <ConfigButton size="small" onClick={beginCustomizeBuiltIn} disabled={saving || toggling}
                        title={t("agents.customizeBuiltInHelp")}>{t("agents.customizeBuiltIn")}</ConfigButton>}
                      {selected && (mode === "view" || mode === "edit") && <ConfigButton size="small" onClick={beginDuplicate} disabled={saving || toggling}>{t("agents.duplicate")}</ConfigButton>}
                      {selected && isWritableScope(selected.scope) && mode === "edit" && <ConfigButton variant="danger" size="small" onClick={() => void remove()} disabled={saving || toggling || (!projectSelected && selected.scope === "project")}>{t("agents.delete")}</ConfigButton>}
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
                      {customizingBuiltIn && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("agents.customizeBuiltInHelp")}</span>}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 3, padding: 3, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-panel)" }}>
                        {([...(rosterAvailable ? ["roster" as const] : []), ...(projectSelected ? ["project" as const] : []), "global"] as const).map((scope) => (
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
                        ? { ...current, orchestration: { allowedChildren: [] }, tools: [], extensionTools: [],
                          selectedExtensionTools: [], loadSkills: false, loadExtensions: false }
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
                              : dependencyIssue.type === "limit"
                                ? t("agents.tooManySources", { name: dependencyIssue.name })
                                : t("agents.cyclicDependencies", { names: dependencyIssue.names.join(" → ") })}</span>
                          {(dependencyIssue.type === "unknown" || dependencyIssue.type === "self") && !disabled && (
                            <button type="button" onClick={repairInvalidDependencies} style={{ color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, padding: "3px 6px", cursor: "pointer" }}>
                              {t("agents.removeInvalidDependencies")}
                            </button>
                          )}
                        </div>
                      )}
                    </Field>
                  )}

                  <Field label={t("agents.resources")}>
                    {!draft.orchestration && (draft.selectedSkills === undefined || draft.selectedExtensionTools === undefined) && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", marginBottom: 10 }}>
                        {draft.selectedSkills === undefined && <Toggle label={t("agents.loadSkills")} disabled={disabled} checked={draft.loadSkills} onChange={(checked) => update("loadSkills", checked)} />}
                        {draft.selectedExtensionTools === undefined && <Toggle label={t("agents.loadExtensions")} disabled={disabled} checked={draft.loadExtensions} onChange={(checked) => update("loadExtensions", checked)} />}
                      </div>
                    )}
                    <AgentResourceSelector
                      cwd={cwd}
                      allowedSkillRoot={displayedScope === "roster" ? `${rosterRoot}/skills` : undefined}
                      selectedSkills={draft.selectedSkills}
                      excludeProjectResources={!projectSelected}
                      selectedExtensionTools={draft.selectedExtensionTools}
                      onChangeSkills={(skills) => setDraft((current) => ({ ...current, selectedSkills: skills, loadSkills: false }))}
                      onChangeExtensionTools={(tools) => setDraft((current) => ({ ...current, selectedExtensionTools: tools, loadExtensions: false }))}
                      legacySkills={draft.loadSkills}
                      legacyExtensions={draft.loadExtensions}
                      hideExtensionTools={Boolean(draft.orchestration) || displayedScope === "roster"}
                      disabled={disabled}
                    />
                  </Field>

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
                    <Toggle label={t("agents.fastMode")} disabled={disabled} checked={draft.fastMode} hint={t("agents.fastModeDescription")} onChange={(checked) => update("fastMode", checked)} />
                  </div>
                  {draft.fastMode && <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("agents.fastModeDescription")}</span>}
                  {!creating && selected && mapOwnersForAgent(selected.name, mapProfiles, mainDraft.orchestration ?? null).some((id) => id !== MAIN_NODE_ID) && (
                    <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("agents.nestedForegroundHint")}</span>
                  )}
                </ConfigDetailStack>
              )}
          </ConfigDetailStack>
        </ConfigDetail>
      </ConfigSplitView>
      )}
      <ConfigFooter status={(settingsError || error || mainMapError) && <span role="alert" style={{ color: "#ef4444" }}>{settingsError || error || mainMapError}</span>}>
        {view === "map" && mapOwner === null && (profileDraftChanged || mainDraftChanged) && (
          <span role="status" style={{ color: "var(--text-muted)", fontSize: 11 }}>{t("agents.unsavedMapNotice")}</span>
        )}
        {view === "map" && mapOwner === MAIN_NODE_ID && mainMapScope === "project" && !mainProjectTrusted && (
          <ConfigButton size="small" onClick={async () => {
            try {
              const response = await fetch("/api/project-trust", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, purpose: "main-config" }) });
              const data = await response.json() as { error?: string };
              if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
              window.dispatchEvent(new Event("pi-web:project-trust-updated"));
              await loadMainForMap();
            } catch (cause) { setMainMapError(cause instanceof Error ? cause.message : String(cause)); }
          }}>{t("main.trustProject")}</ConfigButton>
        )}
        {view === "map" && mapOwner === MAIN_NODE_ID && !mainMapError && (
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
            {t(mainMapScope === "roster" ? "agents.mapRepositorySource" : mainMapScope === "project" ? "agents.mapProjectSource" : "agents.mapGlobalSource")}
            {" · "}{t("main.newSessionsOnly")}
          </span>
        )}
        {view === "map" && mapOwner === MAIN_NODE_ID && mainDraftChanged && (
          <ConfigButton variant="primary" onClick={() => void saveMapMain()} disabled={mainMapSaving || !mainRevision || !mapEditable}>
            {mainMapSaving ? t("agents.saving") : t("agents.save")}
          </ConfigButton>
        )}
        {editing && (view === "profiles" || (view === "map" && mapOwner !== null && mapOwner !== MAIN_NODE_ID && profileDraftChanged)) && (
          <ConfigButton
            variant="primary"
            onClick={() => void save()}
            disabled={saving || savedOk || toggling || !draft.name.trim() || (!projectSelected && (targetScope === "project" || selected?.scope === "project")) || unavailableChildren.length > 0 || Boolean(dependencyIssue)}
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
