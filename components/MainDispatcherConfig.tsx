"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ModelsData } from "@/lib/models-cache";
import { ModelSelector } from "./ModelSelector";
import { ConfigButton, ConfigField, ConfigFooter, ConfigPanelShell, ConfigSwitch } from "./SettingsUi";

type DispatcherConfig = {
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  fastMode: boolean;
  additionalInstructions: string;
};

type ConfigResponse = {
  config?: DispatcherConfig;
  revision?: string;
  path?: string | null;
  basePrompt?: string;
  error?: string;
};

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function MainDispatcherConfig({ embedded = false, cwd, onClose }: {
  embedded?: boolean;
  cwd: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [saved, setSaved] = useState<DispatcherConfig | null>(null);
  const [draft, setDraft] = useState<DispatcherConfig | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [basePrompt, setBasePrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelsData["modelList"]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const dirty = saved !== null && draft !== null && JSON.stringify(saved) !== JSON.stringify(draft);

  const reload = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/main/config", { cache: "no-store", signal });
      const data = await response.json() as ConfigResponse;
      if (!response.ok || data.error || !data.config || !data.revision) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      if (signal?.aborted) return;
      setSaved(data.config);
      setDraft(data.config);
      setRevision(data.revision);
      setPath(data.path ?? "");
      setBasePrompt(data.basePrompt ?? "");
      setConflict(false);
      setSavedOk(false);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    const url = cwd ? `/api/models?cwd=${encodeURIComponent(cwd)}` : "/api/models";
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as ModelsData & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!controller.signal.aborted) {
          setModelOptions(data.modelList ?? []);
          setModelError(data.modelError ?? null);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setModelError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [cwd]);

  const parsedModel = useMemo(() => {
    if (!draft) return null;
    const separator = draft.model.indexOf("/");
    return separator > 0 ? { provider: draft.model.slice(0, separator), modelId: draft.model.slice(separator + 1) } : null;
  }, [draft]);
  const selectedModelKnown = modelOptions.some((option) =>
    `${option.provider}/${option.id}` === draft?.model);

  const update = <K extends keyof DispatcherConfig>(key: K, value: DispatcherConfig[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setSavedOk(false);
  };

  const handleReload = () => {
    if (dirty && !window.confirm(t("main.unsavedChanges"))) return;
    void reload();
  };

  const save = async () => {
    if (!draft || !revision || !path || !dirty || saving || conflict) return;
    setSaving(true);
    setSavedOk(false);
    setError(null);
    try {
      const response = await fetch("/api/main/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: draft, expectedRevision: revision }),
      });
      const data = await response.json() as ConfigResponse;
      if (response.status === 409) {
        setConflict(true);
        setError(t("main.conflict"));
        return;
      }
      if (!response.ok || data.error || !data.config || !data.revision) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setSaved(data.config);
      setDraft(data.config);
      setRevision(data.revision);
      setPath(data.path ?? path);
      setBasePrompt(data.basePrompt ?? basePrompt);
      setSavedOk(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const controlStyle = {
    background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)",
    borderRadius: 5, fontSize: 12, width: "100%", padding: "8px 9px",
  } as const;

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.main")} onClose={onClose}>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 24px", color: "var(--text)" }}>
        <h2 style={{ fontSize: 15, margin: "0 0 6px" }}>{t("common.main")}</h2>
        <p style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6, margin: "0 0 18px" }}>
          {t("main.description")}
        </p>
        <ConfigField label={t("main.path")}>
          <code style={{ color: "var(--text-muted)", fontSize: 11, overflowWrap: "anywhere" }}>{path || t("main.repositoryUnavailable")}</code>
        </ConfigField>

        {loading && !draft ? <p role="status">{t("main.loading")}</p> : draft && (
          <div style={{ display: "grid", gap: 18, maxWidth: 740, paddingTop: 12 }}>
            <ConfigField label={t("main.model")}>
              {modelOptions.length ? (
                <ModelSelector
                  options={modelOptions.map((option) => ({ provider: option.provider, modelId: option.id, name: option.name }))}
                  value={parsedModel}
                  onChange={(provider, modelId) => update("model", `${provider}/${modelId}`)}
                  selectedLabel={!selectedModelKnown ? draft.model : undefined}
                  disabled={!path || loading || saving || conflict}
                  ariaLabel={t("main.model")}
                  variant="field"
                  placement="auto"
                />
              ) : (
                <input
                  aria-label={t("main.model")}
                  value={draft.model}
                  disabled={!path || loading || saving || conflict}
                  onChange={(event) => update("model", event.target.value)}
                  style={controlStyle}
                />
              )}
              {modelError && <span style={{ display: "block", color: "#ef4444", fontSize: 11 }}>{modelError}</span>}
            </ConfigField>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 16 }}>
              <ConfigField label={t("main.thinking")}>
                <select
                  aria-label={t("main.thinking")}
                  value={draft.thinking}
                  disabled={!path || loading || saving || conflict}
                  onChange={(event) => update("thinking", event.target.value as DispatcherConfig["thinking"])}
                  style={controlStyle}
                >
                  {THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
              </ConfigField>
              <ConfigField label={t("main.fastMode")}>
                <ConfigSwitch checked={draft.fastMode} disabled={!path || loading || saving || conflict} label={t("main.fastMode")}
                  onChange={(enabled) => update("fastMode", enabled)} />
              </ConfigField>
            </div>
            <ConfigField label={t("main.additionalInstructions")}>
              <textarea
                aria-label={t("main.additionalInstructions")}
                value={draft.additionalInstructions}
                disabled={!path || loading || saving || conflict}
                onChange={(event) => update("additionalInstructions", event.target.value)}
                rows={6}
                style={{ ...controlStyle, minHeight: 130, resize: "vertical", lineHeight: 1.5 }}
              />
            </ConfigField>
            <ConfigField label={t("main.basePrompt")}>
              <pre style={{ ...controlStyle, margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "var(--bg-panel)", color: "var(--text-muted)", maxHeight: 230, overflowY: "auto", lineHeight: 1.5 }}>{basePrompt}</pre>
            </ConfigField>
          </div>
        )}
      </div>
      <ConfigFooter status={<span role={error ? "alert" : "status"} style={{ color: error ? "#ef4444" : "var(--text-muted)" }}>
        {error ?? (savedOk ? t("main.saved") : "")}
      </span>}>
        <ConfigButton size="small" onClick={handleReload} disabled={loading || saving}>{t("main.reload")}</ConfigButton>
        <ConfigButton variant="primary" onClick={() => void save()} disabled={!draft || !path || loading || saving || conflict || !dirty}>
          {saving ? t("main.saving") : t("main.save")}
        </ConfigButton>
      </ConfigFooter>
    </ConfigPanelShell>
  );
}
