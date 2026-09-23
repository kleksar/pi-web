"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
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
}

const searchStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  height: 34,
  padding: "0 9px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 12,
};

const resourceListStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  maxHeight: 300,
  overflowY: "auto",
  paddingRight: 4,
};

const EMPTY_SKILLS: string[] = [];
const EMPTY_TOOLS: SelectedExtensionTool[] = [];

const resourceLabelStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "16px minmax(0, 1fr)",
  alignItems: "start",
  gap: 9,
  padding: "7px 9px",
  border: "1px solid var(--border)",
  borderRadius: 5,
  cursor: "pointer",
};

function ResourcePath({ logical, real }: { logical: string; real: string | null }) {
  return (
    <span title={real && logical !== real ? `${logical} → ${real}` : logical} style={{ color: "var(--text-dim)", overflowWrap: "anywhere", fontSize: 11 }}>
      {logical}{real && logical !== real ? ` → ${real}` : ""}
    </span>
  );
}

function ResourceLabel({ title, description, scope, logical, real }: {
  title: string;
  description?: string;
  scope?: string;
  logical: string;
  real: string | null;
}) {
  return (
    <span style={{ minWidth: 0, display: "grid", gap: 2 }}>
      <span style={{ color: "var(--text)", fontSize: 12, fontWeight: 600, overflowWrap: "anywhere" }}>
        {title}{scope ? <span style={{ marginLeft: 8, color: "var(--text-dim)", fontWeight: 400 }}>{scope}</span> : null}
      </span>
      {description ? <span style={{ color: "var(--text-muted)", fontSize: 11, overflowWrap: "anywhere" }}>{description}</span> : null}
      <ResourcePath logical={logical} real={real} />
    </span>
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
}: AgentResourceSelectorProps) {
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
  const visibleSkills = useMemo(() => catalog ? currentSkillList(catalog, skillSearch, skills) : [], [catalog, skillSearch, skills]);
  const visibleTools = useMemo(() => catalog ? currentToolList(catalog, toolSearch, tools) : [], [catalog, toolSearch, tools]);
  const selectedToolKeys = useMemo(() => new Set(tools.map(extensionToolKey)), [tools]);
  const missingSkills = catalog ? missingSelectedSkills(skills, catalog.skills) : [];
  const missingTools = catalog ? missingSelectedExtensionTools(tools, catalog.extensionTools) : [];
  const unavailableSkills = catalog?.skills.some((skill) => skill.unavailableReason) ?? false;
  const unavailableTools = catalog?.extensionTools.some((tool) => tool.unavailableReason) ?? false;

  return (
    <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Assign discovered resources to this agent</span>
        <button type="button" disabled={loading} onClick={() => setReloadKey((key) => key + 1)}>Refresh catalog</button>
      </div>
      {loading && <span style={{ color: "var(--text-muted)", fontSize: 12 }}>Loading available resources…</span>}
      {error && <span role="alert" style={{ color: "#f87171", fontSize: 12 }}>Cannot load resources: {error}</span>}
      {catalog && !catalog.projectResourcesLoaded && (
        <span role="status" style={{ color: "var(--text-muted)", fontSize: 12 }}>
          Project resources are hidden until this project is trusted. Existing assignments are preserved.
        </span>
      )}
      {catalog && (
        <>
          <section aria-label="Assigned skills" style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
              <strong style={{ fontSize: 12 }}>Skills · {legacyAllSkills ? "all available" : `${skills.length} selected`}</strong>
              {legacyAllSkills && <span style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={disabled || unavailableSkills} title={unavailableSkills ? "Resolve unavailable skills before preserving the current selection" : undefined} onClick={() => onChangeSkills(explicitSkillSelection(selectedSkills, catalog.skills, true))}>
                  Choose specific skills
                </button>
                {unavailableSkills && <button type="button" disabled={disabled} onClick={() => onChangeSkills([])}>Start empty</button>}
              </span>}
            </div>
            <input style={searchStyle} aria-label="Search skills" value={skillSearch} onChange={(event) => setSkillSearch(event.target.value)} placeholder="Search skills by name, description, or source" />
            <div style={resourceListStyle}>
              {visibleSkills.map((skill) => (
                <label key={skill.filePath} title={skill.unavailableReason} style={{ ...resourceLabelStyle, cursor: disabled || legacyAllSkills || Boolean(skill.unavailableReason) ? "default" : "pointer", opacity: skill.unavailableReason ? 0.55 : legacyAllSkills ? 0.75 : 1 }}>
                  <input type="checkbox" disabled={disabled || legacyAllSkills || Boolean(skill.unavailableReason)} checked={legacyAllSkills || skills.includes(skill.filePath)} onChange={() => onChangeSkills(toggleSelectedSkill(skills, skill.filePath))} />
                  <ResourceLabel title={skill.name} description={skill.unavailableReason ?? (skill.disableModelInvocation ? `${skill.description} · hidden from model prompt` : skill.description)} scope={skill.sourceInfo.scope ?? skill.sourceInfo.source} logical={skill.filePath} real={skill.realPath} />
                </label>
              ))}
              {visibleSkills.length === 0 && <span style={{ color: "var(--text-dim)", fontSize: 12 }}>No matching skills</span>}
            </div>
            {!legacyAllSkills && missingSkills.map((filePath) => (
              <label key={filePath} style={resourceLabelStyle}>
                <input type="checkbox" checked disabled={disabled} onChange={() => onChangeSkills(toggleSelectedSkill(skills, filePath))} />
                <ResourceLabel title="Unavailable skill (assignment preserved)" logical={filePath} real={null} />
              </label>
            ))}
          </section>

          {!hideExtensionTools && <section aria-label="Assigned extension tools" style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
              <strong style={{ fontSize: 12 }}>Extension tools · {legacyAllExtensions ? "all available" : `${tools.length} selected`}</strong>
              {legacyAllExtensions && (
                <span style={{ display: "flex", gap: 8 }}>
                  <button type="button" disabled={disabled || unavailableTools} title={unavailableTools ? "Resolve unavailable or duplicate tools before preserving the current selection" : undefined} onClick={() => onChangeExtensionTools(explicitExtensionToolSelection(selectedExtensionTools, catalog.extensionTools, true))}>
                    Choose specific tools
                  </button>
                  {unavailableTools && <button type="button" disabled={disabled} onClick={() => onChangeExtensionTools([])}>Start empty</button>}
                </span>
              )}
            </div>
            <input style={searchStyle} aria-label="Search extension tools" value={toolSearch} onChange={(event) => setToolSearch(event.target.value)} placeholder="Search tools by name, description, or extension" />
            <div style={resourceListStyle}>
              {visibleTools.map((tool) => (
                <label key={extensionToolKey(tool)} title={tool.unavailableReason} style={{ ...resourceLabelStyle, cursor: disabled || legacyAllExtensions || Boolean(tool.unavailableReason) ? "default" : "pointer", opacity: tool.unavailableReason ? 0.55 : 1 }}>
                  <input type="checkbox" disabled={disabled || legacyAllExtensions || Boolean(tool.unavailableReason)} checked={legacyAllExtensions || selectedToolKeys.has(extensionToolKey(tool))} onChange={() => onChangeExtensionTools(toggleSelectedExtensionTool(tools, tool))} />
                  <ResourceLabel title={tool.toolName} description={tool.unavailableReason ?? tool.description} scope={tool.sourceInfo.scope ?? tool.sourceInfo.source} logical={tool.extensionPath} real={tool.realPath} />
                </label>
              ))}
              {visibleTools.length === 0 && <span style={{ color: "var(--text-dim)", fontSize: 12 }}>No matching extension tools</span>}
            </div>
            {!legacyAllExtensions && missingTools.map((tool) => (
              <label key={extensionToolKey(tool)} style={resourceLabelStyle}>
                <input type="checkbox" checked disabled={disabled} onChange={() => onChangeExtensionTools(toggleSelectedExtensionTool(tools, tool))} />
                <ResourceLabel title={`Unavailable tool: ${tool.toolName} (assignment preserved)`} logical={tool.extensionPath} real={null} />
              </label>
            ))}
          </section>}
          {(catalog.diagnostics.length > 0 || catalog.extensionErrors.length > 0) && (
            <details style={{ color: "var(--text-muted)", fontSize: 11 }}>
              <summary>Resource discovery warnings ({catalog.diagnostics.length + catalog.extensionErrors.length})</summary>
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
