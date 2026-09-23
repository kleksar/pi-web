import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SelectedExtensionTool } from "./agent-resource-selection";

export const RESERVED_AGENT_TOOLS = new Set(["Agent", "get_subagent_result", "steer_subagent"]);

export interface AgentResourceSource {
  source?: string;
  scope?: string;
  origin?: string;
}

export interface AgentSkillResource {
  name: string;
  description: string;
  filePath: string;
  realPath: string | null;
  sourceInfo: AgentResourceSource;
  disableModelInvocation: boolean;
  unavailableReason?: string;
}

export interface AgentExtensionToolResource extends SelectedExtensionTool {
  realPath: string | null;
  label: string;
  description: string;
  sourceInfo: AgentResourceSource;
  unavailableReason?: string;
}

export interface AgentResourceCatalog {
  skills: AgentSkillResource[];
  extensionTools: AgentExtensionToolResource[];
  diagnostics: unknown[];
  extensionErrors: Array<{ path: string; error: string }>;
  projectResourcesLoaded: boolean;
}

export interface CatalogSkillLike {
  name: string;
  description: string;
  filePath: string;
  sourceInfo: AgentResourceSource;
  disableModelInvocation: boolean;
}

export interface CatalogExtensionLike {
  path: string;
  sourceInfo: AgentResourceSource;
  tools: ReadonlyMap<string, { definition: { label: string; description: string } }>;
}

function realPath(filePath: string): string | null {
  try {
    const resolved = realpathSync(filePath);
    return statSync(resolved).isFile() ? resolved : null;
  } catch {
    // Inline extensions have no filesystem path. An unreadable target stays visible
    // under its logical path so the operator can see why an assignment is stale.
    return null;
  }
}

/** Build identifiers from the same SDK paths the runtime will use. No SKILL.md is modified here. */
export function buildAgentResourceCatalog(
  skills: readonly CatalogSkillLike[],
  extensions: readonly CatalogExtensionLike[],
): Pick<AgentResourceCatalog, "skills" | "extensionTools"> {
  const skillResources = skills.map((skill): AgentSkillResource => {
    const resolved = realPath(skill.filePath);
    return {
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      realPath: resolved,
      sourceInfo: skill.sourceInfo,
      disableModelInvocation: skill.disableModelInvocation,
      ...(!isAbsolute(skill.filePath) || !resolved ? { unavailableReason: "Skill file cannot be pinned" } : {}),
    };
  });

  const toolResources = extensions.flatMap((extension) => {
    const resolved = realPath(extension.path);
    return [...extension.tools].filter(([name]) => !RESERVED_AGENT_TOOLS.has(name)).map(([toolName, registered]) => ({
      extensionPath: extension.path,
      realPath: resolved,
      toolName,
      label: registered.definition.label,
      description: registered.definition.description,
      sourceInfo: extension.sourceInfo,
      ...(!isAbsolute(extension.path) || !resolved ? { unavailableReason: "Extension file cannot be pinned" } : {}),
    }));
  });
  const counts = new Map<string, number>();
  for (const tool of toolResources) counts.set(tool.toolName, (counts.get(tool.toolName) ?? 0) + 1);
  const extensionTools = toolResources.map((tool): AgentExtensionToolResource => counts.get(tool.toolName)! > 1
    ? { ...tool, unavailableReason: "Another loaded extension provides the same tool name" }
    : tool);

  return { skills: skillResources, extensionTools };
}
