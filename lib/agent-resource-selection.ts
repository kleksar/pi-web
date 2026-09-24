import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { DefaultResourceLoader, getAgentDir, type InlineExtension, type Skill } from "@earendil-works/pi-coding-agent";
import { readBoundedRegularFile } from "./bounded-file";
import { projectTrustReloadOptions } from "./project-trust";
import { getRepositorySkillPaths } from "./repository-roster";

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
const PORTABLE_SKILL_PREFIXES = new Set(["skills", ".pi/skills", "orchestration/skills"]);
const MAX_SELECTED_SKILL_BYTES = 512 * 1024;
const MAX_SELECTED_EXTENSION_BYTES = 8 * 1024 * 1024;

/** Only a named SKILL.md below a known skill directory can be a portable reference. */
function isPortableSkillReference(reference: string, prefix?: string): boolean {
  if (!reference || reference.includes("\\") || reference.includes("\0") || isAbsolute(reference)) return false;
  const parts = reference.split("/");
  const base = prefix?.split("/") ?? (parts[0] === ".pi" || parts[0] === "orchestration"
    ? parts.slice(0, 2) : parts.slice(0, 1));
  if (!PORTABLE_SKILL_PREFIXES.has(base.join("/")) || parts.length <= base.length + 1
    || parts.slice(0, base.length).some((part, index) => part !== base[index])
    || parts.at(-1) !== "SKILL.md") return false;
  return parts.slice(base.length, -1).every((part) => part !== "." && part !== ".." && part !== ""
    && !part.includes(":") && !part.includes("\0"));
}

function withinDirectory(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve repository-owned references before passing them to the absolute-path-only runtime. */
export function resolveSelectedSkillReferences(root: string, references: readonly string[]): string[] {
  const realRoot = realpathSync(root);
  return references.map((reference) => {
    if (isAbsolute(reference)) return reference; // Existing user/global assignments retain their format.
    if (!isPortableSkillReference(reference)) throw new Error(`Invalid portable skill reference: ${reference}`);
    const target = resolve(realRoot, reference);
    let realTarget: string;
    try {
      realTarget = realpathSync(target);
      if (!statSync(realTarget).isFile()) throw new Error("Not a regular file");
    } catch (error) {
      throw new Error(`Portable skill is missing or cannot be resolved: ${reference}`, { cause: error });
    }
    if (!withinDirectory(realRoot, realTarget)) {
      throw new Error(`Portable skill escapes the repository root: ${reference}`);
    }
    return realTarget;
  });
}

/** Store a skill in Git without embedding the checkout's absolute path. */
export function portableSelectedSkillReferences(root: string, paths: readonly string[], prefix = "skills"): string[] {
  if (!PORTABLE_SKILL_PREFIXES.has(prefix)) throw new Error("Invalid portable skill prefix");
  const realRoot = realpathSync(root);
  return paths.map((path) => {
    if (!isAbsolute(path)) throw new Error(`Selected skill path must be absolute: ${path}`);
    // An external/global skill keeps its original absolute reference for older profiles.
    let realTarget: string;
    try {
      realTarget = realpathSync(path);
    } catch {
      return path;
    }
    if (!withinDirectory(realRoot, realTarget)) return path;
    const reference = relative(realRoot, realTarget).split(sep).join("/");
    return isPortableSkillReference(reference, prefix) ? reference : path;
  });
}
/** SDK built-ins can be replaced by extension tools with the same name. Keep those names out of assignments. */
export const RESERVED_EXTENSION_TOOL_NAMES = new Set([
  "read", "bash", "powershell", "edit", "write", "grep", "find", "ls",
  "Agent", "get_subagent_result", "steer_subagent",
  "github_read", "git_read",
]);

/** Explicit tool assignments must not activate a different implementation of a built-in. */
export function assertNoReservedExtensionToolCollisions(
  extensions: readonly { path: string; tools: ReadonlyMap<string, unknown> }[],
): void {
  for (const extension of extensions) {
    for (const name of extension.tools.keys()) {
      if (!RESERVED_EXTENSION_TOOL_NAMES.has(name)) continue;
      // These two inline extensions are installed by Pi Web itself and checked
      // separately by the orchestration host integrity check.
      if (extension.path === "<inline:pi-web-project-command-environment>" && name === "bash") continue;
      if (extension.path === "<inline:pi-web-subagents>"
        && (name === "Agent" || name === "get_subagent_result" || name === "steer_subagent")) continue;
      if (extension.path === "<inline:pi-web-github-read>" && name === "github_read") continue;
      if (extension.path === "<inline:pi-web-git-read>" && name === "git_read") continue;
      throw new Error(`Extension ${extension.path} overrides reserved built-in tool ${name}; remove the conflicting extension before assigning extension tools`);
    }
  }
}

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

function pinFile(path: string, label: "Selected skill" | "Selected extension" | "Selected resource"): { realPath: string; sha256: string; content: string } {
  if (!isAbsolute(path) || path.startsWith("<inline:")) throw new Error(`Invalid ${label} path`);
  let realPath: string;
  let content: string;
  try {
    realPath = realpathSync(path);
    if (!statSync(realPath).isFile()) throw new Error("Not a regular file");
    // A generic source fingerprint may represent either a skill or an extension.
    const maxBytes = label === "Selected skill" ? MAX_SELECTED_SKILL_BYTES : MAX_SELECTED_EXTENSION_BYTES;
    content = readBoundedRegularFile(realPath, maxBytes, label).toString("utf8");
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
    // The SDK may discover a directory-linked skill under ~/.pi/agent/skills,
    // while a repository profile points at its physical source in Git.
    let realPath: string | undefined;
    if (!byPath.has(path)) {
      try { realPath = realpathSync(path); } catch { /* An unavailable source has no SDK match. */ }
    }
    const matches = realPath === undefined ? [] : discovered.filter((candidate) => {
      try { return realpathSync(candidate.filePath) === realPath; } catch { return false; }
    });
    if (matches.length > 1) throw new Error(`Selected skill resolves to multiple discovered skills: ${path}`);
    const skill = byPath.get(path) ?? matches[0];
    if (!skill) throw new Error(`Selected skill is no longer available: ${path}`);
    return {
      filePath: skill.filePath,
      ...pinFile(skill.filePath, "Selected skill"),
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
  const reserved = selected.find(({ toolName }) => RESERVED_EXTENSION_TOOL_NAMES.has(toolName));
  if (reserved) throw new Error(`Built-in or Pi Web delegation tool cannot be selected as an extension: ${reserved.toolName}`);
  if (selected.length > 0) assertNoReservedExtensionToolCollisions(extensions);
  const sources = new Map<string, { paths: Set<string>; count: number }>();
  for (const extension of extensions) {
    for (const toolName of extension.tools.keys()) {
      const source = sources.get(toolName) ?? { paths: new Set<string>(), count: 0 };
      source.paths.add(extension.path);
      source.count++;
      sources.set(toolName, source);
    }
  }
  const seen = new Set<string>();
  const pinnedFiles = new Map<string, ReturnType<typeof pinFile>>();
  return selected.map(({ extensionPath, toolName }) => {
    const key = `${extensionPath}\u0000${toolName}`;
    if (seen.has(key)) throw new Error("Duplicate selected extension tool");
    seen.add(key);
    const source = sources.get(toolName);
    if (!source?.paths.has(extensionPath)) throw new Error(`Selected extension tool is no longer available: ${toolName} (${extensionPath})`);
    if (source.count !== 1) {
      throw new Error(`Selected extension tool name is ambiguous: ${toolName}`);
    }
    let file = pinnedFiles.get(extensionPath);
    if (!file) {
      file = pinFile(extensionPath, "Selected extension");
      pinnedFiles.set(extensionPath, file);
    }
    const { realPath, sha256 } = file;
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
  const checked = new Map<string, ReturnType<typeof pinFile>>();
  for (const tool of pinned) {
    let source = checked.get(tool.extensionPath);
    if (!source) {
      source = pinFile(tool.extensionPath, "Selected extension");
      checked.set(tool.extensionPath, source);
    }
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
  const loader = new DefaultResourceLoader({ cwd, agentDir,
    ...(selectedSkills?.length ? { additionalSkillPaths: getRepositorySkillPaths() } : {}),
  });
  await loader.reload(projectTrustReloadOptions(cwd, agentDir));
  if (selectedSkills !== undefined) pinSelectedSkills(loader.getSkills().skills, selectedSkills);
  if (selectedExtensionTools !== undefined) {
    pinSelectedExtensionTools(loader.getExtensions().extensions, selectedExtensionTools);
  }
}
