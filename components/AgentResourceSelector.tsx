"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  AgentExtensionToolResource,
  AgentResourceCatalog,
  AgentSkillResource,
} from "@/lib/agent-resource-catalog";
import {
  explicitExtensionToolSelection,
  explicitSkillSelection,
  extensionToolKey,
  matchesResourceSearch,
  missingSelectedExtensionTools,
  missingSelectedSkills,
  toggleSelectedExtensionTool,
  toggleSelectedSkill,
} from "@/lib/agent-resource-selectors";
import type { SelectedExtensionTool } from "@/lib/agent-resource-selection";
import { useI18n } from "@/hooks/useI18n";
import "./AgentResourceSelector.css";

export interface AgentResourceSelectorProps {
  cwd: string;
  selectedSkills?: string[];
  selectedExtensionTools?: SelectedExtensionTool[];
  onChangeSkills: (skills: string[]) => void;
  onChangeExtensionTools: (tools: SelectedExtensionTool[]) => void;
  disabled?: boolean;
  /** Undefined lists on old profiles follow the old load-all flags until explicitly edited. */
  legacySkills?: boolean;
  legacyExtensions?: boolean;
  /** Orchestrators can use selected instructions but cannot receive extension tools. */
  hideExtensionTools?: boolean;
  /** A Git-owned policy can only store skill references inside its own catalog. */
  allowedSkillRoot?: string;
}

const EMPTY_SKILLS: string[] = [];
const EMPTY_TOOLS: SelectedExtensionTool[] = [];

function ResourcePath({ logical, real }: { logical: string; real: string | null }) {
  const { t } = useI18n();
  return (
    <details className="agent-resource-path">
      <summary>{t("agentResources.showPath")}</summary>
      <code>{logical}</code>
      {real && logical !== real && <><span>{t("agentResources.resolvedPath")}</span><code>{real}</code></>}
    </details>
  );
}

function ResourceLabel({ title, description, scope }: {
  title: string;
  description?: string;
  scope?: string;
}) {
  return (
    <span className="agent-resource-label">
      <span className="agent-resource-name" title={title}>
        {title}{scope ? <span className="agent-resource-scope">{scope}</span> : null}
      </span>
      {description ? <span className="agent-resource-description" title={description}>{description}</span> : null}
    </span>
  );
}

function ResourceRow({ title, description, scope, logical, real, checked, disabled, reason, onChange }: {
  title: string;
  description?: string;
  scope?: string;
  logical: string;
  real: string | null;
  checked: boolean;
  disabled: boolean;
  reason?: string;
  onChange: () => void;
}) {
  return (
    <div className={`agent-resource-row${checked ? " is-selected" : ""}${reason ? " is-unavailable" : ""}`}>
      <label title={reason}>
        <input type="checkbox" disabled={disabled} checked={checked} onChange={onChange} />
        <ResourceLabel title={title} description={description} scope={scope} />
      </label>
      <ResourcePath logical={logical} real={real} />
    </div>
  );
}

function currentSkillList(catalog: AgentResourceCatalog, query: string, selected: readonly string[]): AgentSkillResource[] {
  const selectedPaths = new Set(selected);
  return catalog.skills
    .filter((skill) => matchesResourceSearch(query, skill.name, skill.description, skill.filePath, skill.realPath ?? undefined, skill.sourceInfo.source))
    .sort((a, b) => Number(selectedPaths.has(b.filePath)) - Number(selectedPaths.has(a.filePath)) || a.name.localeCompare(b.name));
}

function currentToolList(catalog: AgentResourceCatalog, query: string, selected: readonly SelectedExtensionTool[]): AgentExtensionToolResource[] {
  const selectedKeys = new Set(selected.map(extensionToolKey));
  return catalog.extensionTools
    .filter((tool) => matchesResourceSearch(query, tool.toolName, tool.label, tool.description, tool.extensionPath, tool.realPath ?? undefined, tool.sourceInfo.source))
    .sort((a, b) => Number(selectedKeys.has(extensionToolKey(b))) - Number(selectedKeys.has(extensionToolKey(a))) || a.toolName.localeCompare(b.toolName));
}

export function AgentResourceSelector({
  cwd,
  selectedSkills,
  selectedExtensionTools,
  onChangeSkills,
  onChangeExtensionTools,
  disabled = false,
  legacySkills = false,
  legacyExtensions = false,
  hideExtensionTools = false,
  allowedSkillRoot,
}: AgentResourceSelectorProps) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<AgentResourceCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [skillSearch, setSkillSearch] = useState("");
  const [toolSearch, setToolSearch] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null);
    setLoading(true);
    setError(null);
    fetch(`/api/agent-resources?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        return body as AgentResourceCatalog;
      })
      .then((next) => setCatalog(next))
      .catch((cause) => { if (!controller.signal.aborted) setError(String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cwd, reloadKey]);

  const legacyAllSkills = selectedSkills === undefined && legacySkills;
  const legacyAllExtensions = selectedExtensionTools === undefined && legacyExtensions;
  const skills = selectedSkills ?? EMPTY_SKILLS;
  const tools = selectedExtensionTools ?? EMPTY_TOOLS;
  const assignableSkills = useMemo(() => {
    if (!catalog) return [];
    if (!allowedSkillRoot) return catalog.skills;
    const root = `${allowedSkillRoot.replaceAll("\\", "/").replace(/\/$/, "")}/`;
    return catalog.skills.filter((skill) => (skill.realPath ?? skill.filePath).replaceAll("\\", "/").startsWith(root));
  }, [catalog, allowedSkillRoot]);
  const visibleSkills = useMemo(() => catalog
    ? currentSkillList({ ...catalog, skills: assignableSkills }, skillSearch, skills) : [], [catalog, assignableSkills, skillSearch, skills]);
  const visibleTools = useMemo(() => catalog ? currentToolList(catalog, toolSearch, tools) : [], [catalog, toolSearch, tools]);
  const selectedToolKeys = useMemo(() => new Set(tools.map(extensionToolKey)), [tools]);
  const missingSkills = catalog ? missingSelectedSkills(skills, assignableSkills) : [];
  const missingTools = catalog ? missingSelectedExtensionTools(tools, catalog.extensionTools) : [];
  const unavailableSkills = assignableSkills.some((skill) => skill.unavailableReason);
  const unavailableTools = catalog?.extensionTools.some((tool) => tool.unavailableReason) ?? false;

  return (
    <div className="agent-resource-selector">
      <div className="agent-resource-selector-header">
        <span>{t("agentResources.assign")}</span>
        <button type="button" disabled={loading} onClick={() => setReloadKey((key) => key + 1)}>{t("agentResources.refresh")}</button>
      </div>
      {loading && <span className="agent-resource-status">{t("agentResources.loading")}</span>}
      {error && <span role="alert" className="agent-resource-error">{t("agentResources.loadError", { error })}</span>}
      {catalog && !catalog.projectResourcesLoaded && (
        <span role="status" className="agent-resource-status">
          {t("agentResources.untrusted")}
        </span>
      )}
      {catalog && (
        <>
          <section aria-label={t("agentResources.assignedSkills")} className="agent-resource-section">
            <div className="agent-resource-section-heading">
              <strong>{legacyAllSkills
                ? t("agentResources.skillsAll")
                : t("agentResources.skillsCount", { count: skills.length })}</strong>
              {legacyAllSkills && <span className="agent-resource-section-actions">
                <button type="button" disabled={disabled || unavailableSkills} title={unavailableSkills ? t("agentResources.resolveSkills") : undefined} onClick={() => onChangeSkills(explicitSkillSelection(selectedSkills, assignableSkills, true))}>
                  {t("agentResources.chooseSkills")}
                </button>
                {unavailableSkills && <button type="button" disabled={disabled} onClick={() => onChangeSkills([])}>{t("agentResources.startEmpty")}</button>}
              </span>}
            </div>
            {(assignableSkills.length > 5 || skillSearch) && <input className="agent-resource-search" type="search" aria-label={t("agentResources.searchSkills")} value={skillSearch} onChange={(event) => setSkillSearch(event.target.value)} placeholder={t("agentResources.searchSkillsPlaceholder")} />}
            <div className="agent-resource-list">
              {visibleSkills.map((skill) => (
                <ResourceRow key={skill.filePath} title={skill.name}
                  description={skill.unavailableReason ?? (skill.disableModelInvocation ? t("agentResources.hiddenSkill", { description: skill.description }) : skill.description)}
                  scope={skill.sourceInfo.scope ?? skill.sourceInfo.source} logical={skill.filePath} real={skill.realPath}
                  checked={legacyAllSkills || skills.includes(skill.filePath)}
                  disabled={disabled || legacyAllSkills || Boolean(skill.unavailableReason)} reason={skill.unavailableReason}
                  onChange={() => onChangeSkills(toggleSelectedSkill(skills, skill.filePath))} />
              ))}
              {visibleSkills.length === 0 && <span className="agent-resource-status">{t("agentResources.noSkills")}</span>}
            </div>
            {!legacyAllSkills && missingSkills.map((filePath) => (
              <ResourceRow key={filePath} title={t("agentResources.missingSkill")} logical={filePath} real={null}
                checked disabled={disabled} reason={t("agentResources.missingSkill")}
                onChange={() => onChangeSkills(toggleSelectedSkill(skills, filePath))} />
            ))}
          </section>

          {!hideExtensionTools && <section aria-label={t("agentResources.assignedTools")} className="agent-resource-section">
            <div className="agent-resource-section-heading">
              <strong>{legacyAllExtensions
                ? t("agentResources.toolsAll")
                : t("agentResources.toolsCount", { count: tools.length })}</strong>
              {legacyAllExtensions && (
                <span className="agent-resource-section-actions">
                  <button type="button" disabled={disabled || unavailableTools} title={unavailableTools ? t("agentResources.resolveTools") : undefined} onClick={() => onChangeExtensionTools(explicitExtensionToolSelection(selectedExtensionTools, catalog.extensionTools, true))}>
                    {t("agentResources.chooseTools")}
                  </button>
                  {unavailableTools && <button type="button" disabled={disabled} onClick={() => onChangeExtensionTools([])}>{t("agentResources.startEmpty")}</button>}
                </span>
              )}
            </div>
            {(catalog.extensionTools.length > 5 || toolSearch) && <input className="agent-resource-search" type="search" aria-label={t("agentResources.searchTools")} value={toolSearch} onChange={(event) => setToolSearch(event.target.value)} placeholder={t("agentResources.searchToolsPlaceholder")} />}
            <div className="agent-resource-list">
              {visibleTools.map((tool) => (
                <ResourceRow key={extensionToolKey(tool)} title={tool.toolName}
                  description={tool.unavailableReason ?? tool.description}
                  scope={tool.sourceInfo.scope ?? tool.sourceInfo.source} logical={tool.extensionPath} real={tool.realPath}
                  checked={legacyAllExtensions || selectedToolKeys.has(extensionToolKey(tool))}
                  disabled={disabled || legacyAllExtensions || Boolean(tool.unavailableReason)} reason={tool.unavailableReason}
                  onChange={() => onChangeExtensionTools(toggleSelectedExtensionTool(tools, tool))} />
              ))}
              {visibleTools.length === 0 && <span className="agent-resource-status">{t("agentResources.noTools")}</span>}
            </div>
            {!legacyAllExtensions && missingTools.map((tool) => (
              <ResourceRow key={extensionToolKey(tool)} title={t("agentResources.missingTool", { name: tool.toolName })}
                logical={tool.extensionPath} real={null} checked disabled={disabled}
                reason={t("agentResources.missingTool", { name: tool.toolName })}
                onChange={() => onChangeExtensionTools(toggleSelectedExtensionTool(tools, tool))} />
            ))}
          </section>}
          {(catalog.diagnostics.length > 0 || catalog.extensionErrors.length > 0) && (
            <details style={{ color: "var(--text-muted)", fontSize: 11 }}>
              <summary>{t("agentResources.warnings", { count: catalog.diagnostics.length + catalog.extensionErrors.length })}</summary>
              <ul>
                {catalog.extensionErrors.map((warning, index) => <li key={`ext:${index}`}>{warning.path}: {warning.error}</li>)}
                {catalog.diagnostics.map((warning, index) => <li key={`skill:${index}`}>{JSON.stringify(warning)}</li>)}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
