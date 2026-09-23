import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DefaultResourceLoader, getAgentDir, type InlineExtension, type Skill } from "@earendil-works/pi-coding-agent";
import { projectTrustReloadOptions } from "./project-trust";

export interface SelectedExtensionTool {
  extensionPath: string;
  toolName: string;
}

export interface PinnedSkill {
  filePath: string;
  realPath: string;
  sha256: string;
  content: string;
  name: string;
  description: string;
  disableModelInvocation: boolean;
}

export interface PinnedExtensionTool extends SelectedExtensionTool {
  realPath: string;
  sha256: string;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
/** SDK built-ins can be replaced by extension tools with the same name. Keep those names out of assignments. */
const RESERVED_EXTENSION_TOOL_NAMES = new Set([
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "Agent", "get_subagent_result", "steer_subagent",
]);

export function validateAgentResourceSelection(
  selectedSkills: unknown,
  selectedExtensionTools: unknown,
): { selectedSkills?: string[]; selectedExtensionTools?: SelectedExtensionTool[] } {
  if (selectedSkills !== undefined && (!Array.isArray(selectedSkills)
    || selectedSkills.some((path) => typeof path !== "string" || !isAbsolute(path) || !path.trim())
    || new Set(selectedSkills).size !== selectedSkills.length)) {
    throw new Error("Selected skills must be unique discovered absolute skill file paths");
  }
  if (selectedExtensionTools !== undefined && (!Array.isArray(selectedExtensionTools)
    || selectedExtensionTools.some((entry) => !entry || typeof entry !== "object"
      || typeof entry.extensionPath !== "string" || !isAbsolute(entry.extensionPath)
      || typeof entry.toolName !== "string" || !entry.toolName.trim())
    || new Set(selectedExtensionTools.map((entry) => `${entry.extensionPath}\u0000${entry.toolName}`)).size !== selectedExtensionTools.length)) {
    throw new Error("Selected extension tools must have unique discovered absolute extension paths and tool names");
  }
  return {
    ...(selectedSkills !== undefined ? { selectedSkills: [...selectedSkills] as string[] } : {}),
    ...(selectedExtensionTools !== undefined ? { selectedExtensionTools: selectedExtensionTools.map((entry) => ({
      extensionPath: entry.extensionPath as string,
      toolName: entry.toolName as string,
    })) as SelectedExtensionTool[] } : {}),
  };
}

function pinFile(path: string, label: string): { realPath: string; sha256: string; content: string } {
  if (!isAbsolute(path) || path.startsWith("<inline:")) throw new Error(`Invalid ${label} path`);
  let realPath: string;
  let content: string;
  try {
    realPath = realpathSync(path);
    if (!statSync(realPath).isFile()) throw new Error("Not a regular file");
    content = readFileSync(realPath, "utf8");
    if (realpathSync(path) !== realPath) throw new Error("Symlink target changed during load");
  } catch (error) {
    throw new Error(`${label} is missing or cannot be pinned: ${path}`, { cause: error });
  }
  return { realPath, sha256: createHash("sha256").update(content).digest("hex"), content };
}

export function selectedResourceSourceFingerprint(path: string): { realPath: string; sha256: string } {
  const { realPath, sha256 } = pinFile(path, "Selected resource");
  return { realPath, sha256 };
}

export function pinSelectedSkills(discovered: readonly Skill[], paths: readonly string[]): PinnedSkill[] {
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate selected skill");
  const byPath = new Map(discovered.map((skill) => [skill.filePath, skill]));
  const pinned = paths.map((path) => {
    const skill = byPath.get(path);
    if (!skill) throw new Error(`Selected skill is no longer available: ${path}`);
    return {
      filePath: path,
      ...pinFile(path, "Selected skill"),
      name: skill.name,
      description: skill.description,
      disableModelInvocation: skill.disableModelInvocation,
    };
  });
  if (new Set(pinned.map((skill) => skill.name.toLowerCase())).size !== pinned.length) {
    throw new Error("Selected skills have ambiguous duplicate names");
  }
  return pinned;
}

export function validatePinnedSkills(value: unknown): PinnedSkill[] {
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== "object"
    || typeof entry.filePath !== "string" || !isAbsolute(entry.filePath)
    || typeof entry.realPath !== "string" || !isAbsolute(entry.realPath)
    || typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)
    || typeof entry.content !== "string"
    || createHash("sha256").update(entry.content).digest("hex") !== entry.sha256
    || typeof entry.name !== "string" || !entry.name
    || typeof entry.description !== "string" || typeof entry.disableModelInvocation !== "boolean")
    || new Set(value.map((entry) => entry.filePath)).size !== value.length) {
    throw new Error("Invalid selected skill snapshot");
  }
  return value as PinnedSkill[];
}

export function assertSelectedSkillsUnchanged(pinned: readonly PinnedSkill[]): void {
  for (const skill of pinned) {
    const current = pinFile(skill.filePath, "Selected skill");
    if (current.realPath !== skill.realPath || current.sha256 !== skill.sha256) {
      throw new Error(`Selected skill changed since session start: ${skill.filePath}`);
    }
  }
}

export function filterPinnedSkills(discovered: readonly Skill[], pinned: readonly PinnedSkill[]): Skill[] {
  assertSelectedSkillsUnchanged(pinned);
  const matching = pinSelectedSkills(discovered, pinned.map((skill) => skill.filePath));
  if (matching.some((skill, index) => skill.name !== pinned[index].name
    || skill.description !== pinned[index].description
    || skill.disableModelInvocation !== pinned[index].disableModelInvocation)) {
    throw new Error("Selected skill metadata changed since session start");
  }
  const paths = new Set(pinned.map((skill) => skill.filePath));
  return discovered.filter((skill) => paths.has(skill.filePath));
}

export function pinSelectedExtensionTools(
  extensions: readonly { path: string; tools: ReadonlyMap<string, unknown> }[],
  selected: readonly SelectedExtensionTool[],
): PinnedExtensionTool[] {
  const seen = new Set<string>();
  return selected.map(({ extensionPath, toolName }) => {
    const key = `${extensionPath}\u0000${toolName}`;
    if (seen.has(key)) throw new Error("Duplicate selected extension tool");
    seen.add(key);
    const source = extensions.find((extension) => extension.path === extensionPath && extension.tools.has(toolName));
    if (!source) throw new Error(`Selected extension tool is no longer available: ${toolName} (${extensionPath})`);
    if (extensions.filter((extension) => extension.tools.has(toolName)).length !== 1) {
      throw new Error(`Selected extension tool name is ambiguous: ${toolName}`);
    }
    if (RESERVED_EXTENSION_TOOL_NAMES.has(toolName)) {
      throw new Error(`Built-in or Pi Web delegation tool cannot be selected as an extension: ${toolName}`);
    }
    const { realPath, sha256 } = pinFile(extensionPath, "Selected extension");
    return { extensionPath, toolName, realPath, sha256 };
  });
}

export function validatePinnedExtensionTools(value: unknown): PinnedExtensionTool[] {
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== "object"
    || typeof entry.extensionPath !== "string" || !isAbsolute(entry.extensionPath)
    || typeof entry.toolName !== "string" || !entry.toolName
    || typeof entry.realPath !== "string" || !isAbsolute(entry.realPath)
    || typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256))
    || new Set(value.map((entry) => `${entry.extensionPath}\u0000${entry.toolName}`)).size !== value.length) {
    throw new Error("Invalid selected extension tool snapshot");
  }
  return value as PinnedExtensionTool[];
}

export function assertSelectedExtensionToolsUnchanged(pinned: readonly PinnedExtensionTool[]): void {
  for (const tool of pinned) {
    const source = pinFile(tool.extensionPath, "Selected extension");
    if (source.realPath !== tool.realPath || source.sha256 !== tool.sha256) {
      throw new Error(`Selected extension changed since session start: ${tool.extensionPath}`);
    }
  }
}

/** A Pi Web orchestrator has no read/bash tool, so attach only its chosen skills. */
export function pinnedSkillsPrompt(pinned: readonly PinnedSkill[]): string {
  return pinned.filter((skill) => !skill.disableModelInvocation).map((skill) =>
    `<skill name=${JSON.stringify(skill.name)} source=${JSON.stringify(skill.filePath)}>\n${skill.content}\n</skill>`
  ).join("\n\n");
}

/** Catch changes while a session is still live, before its next model call. */
export function pinnedResourceIntegrityExtension(
  getSkills: () => readonly PinnedSkill[] | undefined,
  getExtensionTools: () => readonly PinnedExtensionTool[] | undefined,
): InlineExtension {
  return {
    name: "pi-web-resource-integrity",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", () => {
        const skills = getSkills();
        const extensionTools = getExtensionTools();
        if (skills) assertSelectedSkillsUnchanged(skills);
        if (extensionTools) assertSelectedExtensionToolsUnchanged(extensionTools);
      });
    },
  };
}

/** Validate IDs against the SDK's effective, trust-gated catalog before writing a config. */
export async function validateSelectedAgentResources(
  cwd: string,
  selection: { selectedSkills?: string[]; selectedExtensionTools?: SelectedExtensionTool[] },
): Promise<void> {
  const { selectedSkills, selectedExtensionTools } = validateAgentResourceSelection(
    selection.selectedSkills, selection.selectedExtensionTools,
  );
  if (selectedSkills === undefined && selectedExtensionTools === undefined) return;
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  if (selectedSkills !== undefined) pinSelectedSkills(loader.getSkills().skills, selectedSkills);
  if (selectedExtensionTools !== undefined) {
    pinSelectedExtensionTools(loader.getExtensions().extensions, selectedExtensionTools);
  }
}
