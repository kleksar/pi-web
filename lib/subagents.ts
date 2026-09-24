import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dump as stringifyYaml } from "js-yaml";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { parseFrontmatter } from "./frontmatter";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { readBoundedRegularFile } from "./bounded-file";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { disabledBuiltInSubagents } from "./subagent-settings";
import { pendingContextRequest } from "./subagent-context-handoff";
import { getRepositoryRosterRoot } from "./repository-roster";
import { isProjectMainConfigTrusted } from "./project-trust";
import { PRESET_READ_ONLY } from "./tool-presets";
import type { SessionEntry, SubagentSessionStatus } from "./types";
import {
  portableSelectedSkillReferences,
  resolveSelectedSkillReferences,
  validatePinnedSkills,
  validatePinnedExtensionTools,
  type PinnedSkill,
  type PinnedExtensionTool,
} from "./agent-resource-selection";

export const SUBAGENT_META_TYPE = "pi-web:subagent";
export const SUBAGENT_STATUS_TYPE = "pi-web:subagent-status";
export const SUBAGENT_RESULT_TYPE = "pi-web:subagent-result";
export const SUBAGENT_CONTROL_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent"] as const;
/** An admitted child receives one immutable result artifact per direct prerequisite. */
export const MAX_SUBAGENT_DEPENDENCIES = 8;
const MAX_SUBAGENT_PROFILE_BYTES = 512 * 1024;

function readProfileText(path: string): string {
  return readBoundedRegularFile(path, MAX_SUBAGENT_PROFILE_BYTES, "Agent profile").toString("utf8");
}

export type SubagentStatus = SubagentSessionStatus;
export type SubagentScope = "builtin" | "roster" | "global" | "workspace" | "project";
export type SubagentWritableScope = Extract<SubagentScope, "roster" | "global" | "project">;

export interface SubagentOrchestration {
  allowedChildren: string[];
  /** A child may run only after all of its listed producer children succeed. */
  dependencies?: Record<string, string[]>;
  /** A running child may request context from these siblings via its parent. */
  contextProviders?: Record<string, string[]>;
}

export interface SubagentContextRequest {
  status: "needs_context";
  provider: string;
  request: string;
  missingFiles?: string[];
}

export interface SubagentChildProfileFingerprint {
  scope: SubagentScope;
  filePath?: string;
  sha256: string;
}

export interface SubagentSessionOrchestration extends SubagentOrchestration {
  rootSessionId: string;
  depth: number;
  childProfiles: Record<string, SubagentChildProfileFingerprint>;
}

export interface SubagentProfile {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  extensionTools?: string[];
  /** Exact discovered skill file paths. Undefined preserves legacy loadSkills. */
  selectedSkills?: string[];
  /** Exact extension source + tool identity. Undefined preserves legacy loadExtensions. */
  selectedExtensionTools?: Array<{ extensionPath: string; toolName: string }>;
  loadSkills: boolean;
  loadExtensions: boolean;
  /** Requests the native OpenAI priority service tier for this agent's turns. */
  fastMode: boolean;
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  promptMode: "replace" | "append";
  color?: string;
  isolation?: "worktree" | "off";
  persistSession?: boolean;
  orchestration?: SubagentOrchestration;
  configurationError?: string;
  enabled: boolean;
  scope: SubagentScope;
  filePath?: string;
}

/** `null` explicitly turns off orchestration; omission preserves a stored setting. */
export type SubagentProfileInput = Omit<SubagentProfile, "scope" | "filePath" | "orchestration" | "configurationError"> & {
  orchestration?: SubagentOrchestration | null;
};

export interface SubagentMetadata {
  version: 1;
  parentSessionId: string;
  parentSessionPath: string;
  parentToolCallId: string;
  profile: string;
  description: string;
  task: string;
  runInBackground: boolean;
  createdAt: string;
  resourceSnapshot: SubagentResourceSnapshot;
  /** Creation epoch of a dependency-bound child, pinned to its parent run. */
  dependencyEpoch?: string;
  contextFor?: string;
  contextForResultId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
}

interface SubagentResourceSnapshotFields {
  appendSystemPrompt: string[];
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  /** Older session snapshots omit this setting and remain on the default tier. */
  fastMode?: boolean;
  /** Effective limit for each invocation. Legacy snapshots without it retain their old unlimited resume behavior. */
  maxTurns?: number;
  exactSystemPrompt?: string;
}

export type SubagentResourceSnapshot = SubagentResourceSnapshotFields & (
  | { version: 1; orchestration?: never }
  | { version: 2; orchestration?: SubagentSessionOrchestration }
  | { version: 3; orchestration?: SubagentSessionOrchestration;
      selectedSkills?: PinnedSkill[]; selectedExtensionTools?: PinnedExtensionTool[] }
);

export interface SubagentSessionResources {
  appendSystemPrompt: string[];
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  fastMode: boolean;
  maxTurns?: number;
  exactSystemPrompt?: string;
  orchestration?: SubagentSessionOrchestration;
  selectedSkills?: PinnedSkill[];
  selectedExtensionTools?: PinnedExtensionTool[];
}

export interface SubagentResultMetadata {
  version: 1;
  status: Exclude<SubagentStatus, "starting" | "running" | "queued" | "interrupted">;
  completedAt: string;
  result?: string;
  contextRequest?: SubagentContextRequest;
  contextFor?: string;
  contextForResultId?: string;
  error?: string;
  worktreeCleanupError?: string;
  parentToolCallId?: string;
  task?: string;
  description?: string;
  runInBackground?: boolean;
}

export interface SubagentStatusMetadata {
  version: 1;
  status: Extract<SubagentStatus, "queued" | "running">;
  parentToolCallId?: string;
  task?: string;
  description?: string;
  runInBackground?: boolean;
}

export interface SubagentRunInfo {
  sessionId: string;
  sessionPath: string;
  parentSessionId: string;
  parentToolCallId: string;
  profile: string;
  description: string;
  task: string;
  runInBackground: boolean;
  status: SubagentStatus;
  createdAt: string;
  completedAt?: string;
  result?: string;
  contextRequest?: SubagentContextRequest;
  contextFor?: string;
  contextForResultId?: string;
  error?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeCleanupError?: string;
}

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const BUILTIN_TOOLS = new Set(DEFAULT_TOOLS);
const SUBAGENT_CONTROL_TOOLS = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);
const SUBAGENT_SCOPES = new Set<SubagentScope>(["builtin", "roster", "global", "workspace", "project"]);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Frontmatter keys the web UI owns. Everything else in a profile file belongs to
 * whichever runtime reads it (pi-subagents and friends), so a save from this app must
 * carry those keys through untouched. Dropping them silently changed behaviour:
 * `allowed_subagents` was lost and an orchestrator could no longer spawn anything,
 * `exclude_extensions` was lost and an opt-out became an opt-in.
 */
const MANAGED_FRONTMATTER_KEYS = new Set([
  "description",
  "display_name",
  "tools",
  "load_skills",
  "load_extensions",
  "enabled",
  "inherit_context",
  "run_in_background",
  "pi_web_fast_mode",
  "model",
  "thinking",
  "max_turns",
  "prompt_mode",
  "color",
  "isolation",
  "persist_session",
  "pi_web_orchestration",
  "pi_web_selected_skills",
  "pi_web_selected_extension_tools",
]);

const FRONTMATTER_OPEN_RE = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\n|\r)/;
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The UI exposes two booleans (`load_skills` / `load_extensions`); pi-subagents reads
 * the aliases `skills` / `extensions`, which also accept a whitelist. Aliases are
 * carried through by `unmanagedFrontmatter` and only rewritten once we own them.
 */
const OWNED_ALIAS_VALUES = new Set(["none", "all", "true", "false"]);

const BUILTIN_PROFILES: SubagentProfile[] = [
  {
    name: "general-purpose",
    displayName: "General purpose",
    description: "Handle a focused implementation or investigation task",
    systemPrompt: "Work autonomously on the delegated task. Keep the final answer concise and include important files, decisions, and remaining risks.",
    tools: DEFAULT_TOOLS,
    loadSkills: false,
    loadExtensions: false,
    fastMode: false,
    promptMode: "append",
    inheritContext: false,
    runInBackground: false,
    enabled: true,
    scope: "builtin",
  },
  {
    name: "explore",
    displayName: "Explore",
    description: "Quickly inspect a codebase without modifying it",
    systemPrompt: "Explore the codebase to answer the delegated question. Do not modify files. Report concrete findings with file paths and relevant symbols.",
    tools: [...PRESET_READ_ONLY],
    loadSkills: false,
    loadExtensions: false,
    fastMode: false,
    promptMode: "append",
    inheritContext: false,
    runInBackground: false,
    enabled: true,
    scope: "builtin",
  },
  {
    name: "plan",
    displayName: "Plan",
    description: "Design an implementation plan without modifying files",
    systemPrompt: "Produce an implementation-ready plan for the delegated task. Inspect the repository as needed, do not modify files, and call out dependencies, risks, and verification steps.",
    tools: [...PRESET_READ_ONLY],
    loadSkills: false,
    loadExtensions: false,
    fastMode: false,
    promptMode: "append",
    inheritContext: false,
    runInBackground: false,
    enabled: true,
    scope: "builtin",
  },
];

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function resourceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return Array.isArray(value) || typeof value === "string" ? true : fallback;
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return values.map((item) => String(item).trim()).filter(Boolean);
}

function allowedChildren(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const name = entry.trim();
    const key = name.toLowerCase();
    if (!PROFILE_NAME_RE.test(name) || seen.has(key)) return null;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** Validate and normalize a consumer-to-producers graph against the allowed children. */
function dependencyGraph(value: unknown, children: readonly string[]): Record<string, string[]> | null {
  if (!isRecord(value)) return null;
  const canonical = new Map(children.map((child) => [child.toLowerCase(), child]));
  const graph: Record<string, string[]> = {};
  const seenConsumers = new Set<string>();
  for (const [rawConsumer, rawProducers] of Object.entries(value)) {
    const consumer = canonical.get(rawConsumer.toLowerCase());
    if (!consumer || seenConsumers.has(consumer.toLowerCase()) || !Array.isArray(rawProducers)
      || rawProducers.length > MAX_SUBAGENT_DEPENDENCIES) return null;
    seenConsumers.add(consumer.toLowerCase());
    const producers: string[] = [];
    const seenProducers = new Set<string>();
    for (const rawProducer of rawProducers) {
      if (typeof rawProducer !== "string") return null;
      const producer = canonical.get(rawProducer.toLowerCase());
      if (!producer || producer === consumer || seenProducers.has(producer.toLowerCase())) return null;
      seenProducers.add(producer.toLowerCase());
      producers.push(producer);
    }
    graph[consumer] = producers;
  }

  // Count edges from each producer to its consumers; Kahn's algorithm also
  // handles long configured graphs without relying on recursive stack depth.
  const outstanding = new Map(children.map((child) => [
    child,
    Object.prototype.hasOwnProperty.call(graph, child) ? graph[child].length : 0,
  ]));
  const consumers = new Map(children.map((child) => [child, [] as string[]]));
  for (const [consumer, producers] of Object.entries(graph)) {
    for (const producer of producers) consumers.get(producer)?.push(consumer);
  }
  const ready = children.filter((child) => outstanding.get(child) === 0);
  let visited = 0;
  while (ready.length > 0) {
    const producer = ready.pop()!;
    visited += 1;
    for (const consumer of consumers.get(producer) ?? []) {
      const remaining = (outstanding.get(consumer) ?? 0) - 1;
      outstanding.set(consumer, remaining);
      if (remaining === 0) ready.push(consumer);
    }
  }
  return visited === children.length ? graph : null;
}

/** Both edge types are directed producer -> consumer; mixed cycles would deadlock. */
function contextProviderGraph(
  value: unknown, children: readonly string[], dependencies?: Record<string, string[]>,
): Record<string, string[]> | null {
  const contextProviders = dependencyGraph(value, children);
  if (contextProviders === null) return null;
  const combined = Object.fromEntries(children.map((child) => [child, [...new Set([
    ...(dependencies?.[child] ?? []), ...(contextProviders[child] ?? []),
  ])]]));
  return dependencyGraph(combined, children) === null ? null : contextProviders;
}

function profileOrchestration(value: unknown, profileName: string): SubagentOrchestration | undefined {
  if (!isRecord(value) || value.kind !== "orchestrator") return undefined;
  const children = allowedChildren(value.allowed_children);
  if (children === null || children.some((child) => child.toLowerCase() === profileName.toLowerCase())) return undefined;
  const dependencies = Object.prototype.hasOwnProperty.call(value, "depends_on")
    ? dependencyGraph(value.depends_on, children)
    : undefined;
  if (dependencies === null) return undefined;
  const contextProviders = Object.prototype.hasOwnProperty.call(value, "context_providers")
    ? contextProviderGraph(value.context_providers, children, dependencies)
    : undefined;
  if (contextProviders === null) return undefined;
  return { allowedChildren: children, ...(dependencies !== undefined ? { dependencies } : {}),
    ...(contextProviders !== undefined ? { contextProviders } : {}) };
}

function hasOrchestrationMarker(data: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(data, "pi_web_orchestration");
}

function parseTools(value: unknown, fallback: string[]): string[] {
  const tools = stringList(value);
  if (tools.includes("none")) return [];
  if (tools.includes("all") || tools.includes("*")) return [...DEFAULT_TOOLS];
  if (tools.length === 0) return [...fallback];
  return [...new Set(tools.filter((tool) => BUILTIN_TOOLS.has(tool)))];
}

function rawToolValues(value: unknown): string[] {
  return stringList(value);
}

function parseExtensionToolSelectors(value: unknown): string[] {
  return [...new Set(rawToolValues(value).filter((tool) => tool.toLowerCase().startsWith("ext:")))];
}

function parseSelectedSkills(value: unknown, profileFilePath: string): string[] | null {
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || !path.trim())) return null;
  try {
    // Resolve against the physical source of a directory-linked agent profile,
    // so one roster works under every checkout and through ~/.pi/agent/agents.
    const root = dirname(realpathSync(dirname(profileFilePath)));
    const paths = resolveSelectedSkillReferences(root, value as string[]);
    return new Set(paths).size === paths.length ? paths : null;
  } catch {
    return null;
  }
}

function parseSelectedExtensionTools(value: unknown): Array<{ extensionPath: string; toolName: string }> | null {
  if (!Array.isArray(value)) return null;
  const selected: Array<{ extensionPath: string; toolName: string }> = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.extensionPath !== "string" || !isAbsolute(entry.extensionPath)
      || typeof entry.toolName !== "string" || !entry.toolName.trim() || SUBAGENT_CONTROL_TOOLS.has(entry.toolName)) return null;
    const key = `${entry.extensionPath}\u0000${entry.toolName}`;
    if (seen.has(key)) return null;
    seen.add(key);
    selected.push({ extensionPath: entry.extensionPath, toolName: entry.toolName });
  }
  return selected;
}

/** Read existing frontmatter without allowing malformed metadata to be overwritten. */
function readStoredFrontmatter(filePath: string): Record<string, unknown> {
  let source: string;
  try {
    source = readProfileText(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const { data } = parseFrontmatter(source);
  if (data) return data;
  if (FRONTMATTER_OPEN_RE.test(source)) {
    throw new Error("Cannot save agent profile: existing frontmatter is invalid");
  }
  return {};
}

/** Keys another runtime owns, in file order, so a save round-trips them. */
function unmanagedFrontmatter(stored: Record<string, unknown>): Record<string, unknown> {
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (!MANAGED_FRONTMATTER_KEYS.has(key)) preserved[key] = value;
  }
  return preserved;
}

/**
 * pi-web filters `tools` down to the built-ins it can dispatch, which would drop
 * another runtime's `ext:<name>` selectors on every save — carry them through.
 */
function composeToolsField(tools: string[], storedTools: unknown): string {
  const selectors = stringList(storedTools).filter((tool) => tool.startsWith("ext:"));
  const combined = [...tools, ...selectors.filter((selector) => !tools.includes(selector))];
  return combined.length > 0 ? combined.join(", ") : "none";
}

/**
 * Keep the alias in step with the boolean the UI owns. A boolean (or a "none" /
 * "all" spelling) is ours to rewrite; a whitelist such as `extensions:
 * pi-advisor-flow` expresses scoping the UI cannot show, so it stays as authored.
 */
function syncFlagAlias(
  frontmatter: Record<string, unknown>,
  alias: string,
  storedValue: unknown,
  flag: boolean,
): void {
  const owned = storedValue === undefined
    || typeof storedValue === "boolean"
    || (typeof storedValue === "string" && OWNED_ALIAS_VALUES.has(storedValue.trim().toLowerCase()));
  if (owned) frontmatter[alias] = flag;
}
function parseProfileFile(filePath: string, scope: SubagentScope): SubagentProfile {
  const source = readProfileText(filePath);
  const { data, rest } = parseFrontmatter(source);
  // A malformed fence may contain a `name` that differs from the filename;
  // a tombstone under the filename cannot safely shadow that effective name.
  if (data === null && FRONTMATTER_OPEN_RE.test(source)) {
    throw new Error(`Invalid agent profile frontmatter: ${filePath}`);
  }
  const name = stringValue(data?.name) ?? basename(filePath, ".md");
  if (!PROFILE_NAME_RE.test(name)) throw new Error(`Invalid agent profile name in ${filePath}: ${name}`);
  const thinkingValue = stringValue(data?.thinking) as ThinkingLevel | undefined;
  const rawMaxTurns = data?.max_turns;
  const invalidMaxTurns = rawMaxTurns !== undefined && (typeof rawMaxTurns !== "number"
    || !Number.isFinite(rawMaxTurns) || rawMaxTurns < 0
    || (rawMaxTurns > 0 && rawMaxTurns < 1)
    || !Number.isSafeInteger(Math.floor(rawMaxTurns)));
  const maxTurnsValue = !invalidMaxTurns && typeof rawMaxTurns === "number" ? Math.floor(rawMaxTurns) : undefined;
  const tools = parseTools(data?.tools, DEFAULT_TOOLS);
  const disallowedTools = new Set(parseTools(data?.disallowed_tools, []));
  const disallowedExtensionTools = new Set(parseExtensionToolSelectors(data?.disallowed_tools).map((tool) => tool.toLowerCase()));
  const extensionTools = parseExtensionToolSelectors(data?.tools)
    .filter((tool) => !disallowedExtensionTools.has(tool.toLowerCase()));
  const activeTools = tools.filter((tool) => !disallowedTools.has(tool));
  const loadSkills = resourceBoolean(data?.load_skills ?? data?.skills, false);
  const loadExtensions = resourceBoolean(data?.load_extensions ?? data?.extensions, extensionTools.length > 0);
  const selectedSkills = data && "pi_web_selected_skills" in data ? parseSelectedSkills(data.pi_web_selected_skills, filePath) : undefined;
  const selectedExtensionTools = data && "pi_web_selected_extension_tools" in data
    ? parseSelectedExtensionTools(data.pi_web_selected_extension_tools) : undefined;
  const invalidSelection = selectedSkills === null || selectedExtensionTools === null
    || (scope === "roster" && (
      (Array.isArray(data?.pi_web_selected_skills)
        && data.pi_web_selected_skills.some((path) => typeof path !== "string" || isAbsolute(path)))
      || (loadSkills && selectedSkills === undefined)
      || loadExtensions
      || (selectedExtensionTools?.length ?? 0) > 0
    ));
  const orchestration = activeTools.length === 0 && extensionTools.length === 0
    && !(selectedExtensionTools === undefined ? loadExtensions : selectedExtensionTools?.length)
    && (!loadSkills || selectedSkills !== undefined)
    ? profileOrchestration(data?.pi_web_orchestration, name)
    : undefined;
  const profile: SubagentProfile = {
    name,
    displayName: stringValue(data?.display_name) ?? name,
    description: stringValue(data?.description) ?? name,
    systemPrompt: rest.trim(),
    tools: activeTools,
    ...(extensionTools.length > 0 ? { extensionTools } : {}),
    ...(selectedSkills !== undefined && selectedSkills !== null ? { selectedSkills } : {}),
    ...(selectedExtensionTools !== undefined && selectedExtensionTools !== null ? { selectedExtensionTools } : {}),
    loadSkills,
    loadExtensions,
    fastMode: booleanValue(data?.pi_web_fast_mode, false),
    ...(stringValue(data?.model) ? { model: stringValue(data?.model) } : {}),
    ...(thinkingValue && THINKING_LEVELS.has(thinkingValue) ? { thinking: thinkingValue } : {}),
    ...(maxTurnsValue && maxTurnsValue > 0 ? { maxTurns: maxTurnsValue } : {}),
    inheritContext: booleanValue(data?.inherit_context, false),
    runInBackground: booleanValue(data?.run_in_background, false),
    promptMode: data?.prompt_mode === "replace" ? "replace" : "append",
    ...(stringValue(data?.color) ? { color: stringValue(data?.color) } : {}),
    ...(data?.isolation === "worktree" || data?.isolation === "off" ? { isolation: data.isolation } : {}),
    ...(typeof data?.persist_session === "boolean" ? { persistSession: data.persist_session } : {}),
    ...(orchestration ? { orchestration } : {}),
    enabled: booleanValue(data?.enabled, true),
    scope,
    filePath,
  };
  if (!invalidSelection && !invalidMaxTurns && (!data || !hasOrchestrationMarker(data) || orchestration)) return profile;
  return {
    ...profile,
    enabled: false,
    tools: [],
    extensionTools: undefined,
    loadSkills: false,
    loadExtensions: false,
    configurationError: invalidMaxTurns
      ? "Invalid max_turns; this profile cannot run"
      : invalidSelection
      ? "Invalid Pi Web selected resources; this profile cannot run"
      : "Invalid Pi Web orchestration configuration; this profile cannot run",
  };
}

function readProfileDirectory(dir: string, scope: SubagentScope, cwd: string): SubagentProfile[] {
  try {
    if (!statSync(dir).isDirectory()) throw new Error(`Agent profile path is not a directory: ${dir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  // Keep an intentional symlink outside cwd excluded, but propagate failures
  // to resolve an existing directory instead of falling back to a lower scope.
  if (scope !== "global") {
    const allowedRoot = scope === "roster" ? getRepositoryRosterRoot() : realpathSync(cwd);
    if (!allowedRoot || !isPathWithinRoots(realpathSync(dir), new Set([allowedRoot]))) return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => parseProfileFile(join(dir, entry.name), scope));
}

function profileDirectories(cwd: string): Array<[string, Exclude<SubagentScope, "builtin">]> {
  const rosterRoot = getRepositoryRosterRoot();
  return [
    ...(rosterRoot ? [[join(rosterRoot, "agents"), "roster"] as [string, "roster"]] : []),
    [join(getAgentDir(), "agents"), "global"],
    [join(resolve(cwd), ".agents", "agents"), "workspace"],
    [join(resolve(cwd), ".pi", "agents"), "project"],
  ];
}

/** A project must be explicitly trusted before its profiles can replace a shared roster ID. */
function configuredProfileSources(cwd: string): SubagentProfile[] {
  const profiles: SubagentProfile[] = [];
  const rosterIds = new Set<string>();
  let projectTrusted: boolean | undefined;
  for (const [dir, scope] of profileDirectories(cwd)) {
    for (const profile of readProfileDirectory(dir, scope, cwd)) {
      const id = profile.name.toLowerCase();
      if (scope === "roster") rosterIds.add(id);
      if ((scope === "workspace" || scope === "project") && rosterIds.has(id)) {
        projectTrusted ??= isProjectMainConfigTrusted(cwd, getAgentDir());
        if (!projectTrusted) continue;
      }
      profiles.push(profile);
    }
  }
  return profiles;
}

/**
 * A built-in has no file, so `enabled: false` cannot be written next to it the way
 * it is for a profile on disk. Its off state is a name in `agents/settings.json`
 * instead of a copied-out override file, which would otherwise freeze the built-in
 * prompt at the version it was copied from.
 */
function builtInProfiles(): SubagentProfile[] {
  const disabled = disabledBuiltInSubagents();
  return BUILTIN_PROFILES.map((profile) => ({
    ...profile,
    tools: [...profile.tools],
    enabled: !disabled.has(profile.name.toLowerCase()),
  }));
}

/** Every eligible source, including profiles shadowed by a higher-precedence scope. */
export function listSubagentProfileSources(cwd: string): SubagentProfile[] {
  const profiles = [...builtInProfiles(), ...configuredProfileSources(cwd)];
  return profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function listSubagentProfiles(cwd: string): SubagentProfile[] {
  // A same-name file replaces the built-in outright, its own `enabled` included.
  const byName = new Map(builtInProfiles().map((profile) => [profile.name.toLowerCase(), profile]));
  for (const profile of configuredProfileSources(cwd)) byName.set(profile.name.toLowerCase(), profile);
  return [...byName.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function resolveSubagentProfile(cwd: string, name: string): SubagentProfile | undefined {
  return listSubagentProfiles(cwd).find((profile) => profile.name.toLowerCase() === name.trim().toLowerCase() && profile.enabled);
}

function assertProfileName(name: string): string {
  const normalized = name.trim();
  if (!PROFILE_NAME_RE.test(normalized)) {
    throw new Error("Agent name may contain only letters, numbers, dots, underscores, and hyphens");
  }
  return normalized;
}

function writableProfileDirectory(cwd: string, scope: SubagentWritableScope): string {
  if (scope === "roster") {
    const root = getRepositoryRosterRoot();
    if (!root) throw new Error("Repository roster is unavailable");
    return join(root, "agents");
  }
  if (scope === "global") return join(getAgentDir(), "agents");
  if (scope === "project") return join(resolve(cwd), ".pi", "agents");
  throw new Error("Agent scope must be roster, global, or project");
}

function assertWritableProfileDirectory(cwd: string, scope: SubagentWritableScope): string {
  const dir = writableProfileDirectory(cwd, scope);
  if (scope === "global") return dir;
  const allowedRoot = scope === "roster" ? getRepositoryRosterRoot() : cwd;
  if (!allowedRoot) throw new Error("Repository roster is unavailable");

  let existingAncestor = dir;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error("Agent profile directory is outside the project root");
    existingAncestor = parent;
  }
  if (!isExistingPathWithinRoots(existingAncestor, new Set([allowedRoot]))) {
    throw new Error(`Agent profile directory is outside the ${scope === "roster" ? "repository roster" : "project root"}`);
  }
  return dir;
}

function assertRegularRosterProfile(filePath: string): void {
  try {
    if (!lstatSync(filePath).isFile()) throw new Error("Repository roster profile must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function saveSubagentProfile(
  cwd: string,
  scope: SubagentWritableScope,
  profile: SubagentProfileInput,
): SubagentProfile {
  const name = assertProfileName(profile.name);
  if (scope === "project") {
    const rosterRoot = getRepositoryRosterRoot();
    if (rosterRoot && !isProjectMainConfigTrusted(cwd, getAgentDir())
      && readProfileDirectory(join(rosterRoot, "agents"), "roster", cwd)
        .some((candidate) => candidate.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Trust this project before overriding repository agent ${name}`);
    }
  }
  const tools = [...new Set(profile.tools.filter((tool) => BUILTIN_TOOLS.has(tool)))];
  const extensionTools = [...new Set(profile.extensionTools ?? [])];
  const dir = assertWritableProfileDirectory(cwd, scope);
  const filePath = join(dir, `${name}.md`);
  if (scope === "roster") assertRegularRosterProfile(filePath);
  const stored = readStoredFrontmatter(filePath);
  const selectedSkills = profile.selectedSkills === undefined
    ? ("pi_web_selected_skills" in stored ? parseSelectedSkills(stored.pi_web_selected_skills, filePath) : undefined)
    : parseSelectedSkills(profile.selectedSkills, filePath);
  const selectedExtensionTools = profile.selectedExtensionTools === undefined
    ? ("pi_web_selected_extension_tools" in stored
        ? parseSelectedExtensionTools(stored.pi_web_selected_extension_tools) : undefined)
    : parseSelectedExtensionTools(profile.selectedExtensionTools);
  if (selectedSkills === null || selectedExtensionTools === null) throw new Error("Invalid selected agent resources");
  if (scope === "roster" && selectedExtensionTools?.length) {
    throw new Error("Repository roster profiles cannot store machine-local extension tool paths");
  }
  if (profile.thinking && !THINKING_LEVELS.has(profile.thinking)) {
    throw new Error(`Invalid thinking level: ${profile.thinking}`);
  }
  if (profile.fastMode !== undefined && typeof profile.fastMode !== "boolean") {
    throw new Error("Fast mode must be a boolean");
  }
  if (profile.maxTurns !== undefined && (!Number.isFinite(profile.maxTurns) || profile.maxTurns < 0
    || (profile.maxTurns > 0 && profile.maxTurns < 1)
    || !Number.isSafeInteger(Math.floor(profile.maxTurns)))) {
    throw new Error("Max turns must be zero (unlimited) or at least one safe turn");
  }
  const maxTurns = profile.maxTurns && profile.maxTurns > 0
    ? Math.floor(profile.maxTurns)
    : undefined;
  const displayName = profile.displayName.trim() || name;
  const description = profile.description.trim() || name;
  const systemPrompt = profile.systemPrompt.trim();
  const model = profile.model?.trim() || undefined;
  const loadSkills = profile.loadSkills === true;
  const loadExtensions = profile.loadExtensions === true;
  if (scope === "roster" && loadSkills && selectedSkills === undefined) {
    throw new Error("Repository roster profiles require an explicit selected skills list");
  }
  if (scope === "roster" && loadExtensions) {
    throw new Error("Repository roster profiles cannot load unscoped extensions");
  }
  const fastMode = profile.fastMode ?? booleanValue(stored.pi_web_fast_mode, false);
  const promptMode = profile.promptMode === "replace" ? "replace" : "append";
  const requestedChildren = profile.orchestration == null
    ? undefined
    : isRecord(profile.orchestration) ? allowedChildren(profile.orchestration.allowedChildren) : null;
  if (requestedChildren === null) throw new Error("Orchestrator allowedChildren must be unique agent profile names");
  if (requestedChildren?.some((child) => child.toLowerCase() === name.toLowerCase())) {
    throw new Error("An orchestrator cannot delegate to itself");
  }
  const requestedDependencies = requestedChildren === undefined
    ? undefined
    : profile.orchestration && Object.prototype.hasOwnProperty.call(profile.orchestration, "dependencies")
      ? dependencyGraph(profile.orchestration.dependencies, requestedChildren)
      : undefined;
  if (requestedDependencies === null) {
    throw new Error(`Orchestrator dependencies must be an acyclic graph of unique allowed child profiles with at most ${MAX_SUBAGENT_DEPENDENCIES} prerequisites per child`);
  }
  const requestedContextProviders = requestedChildren === undefined
    ? undefined
    : profile.orchestration && Object.prototype.hasOwnProperty.call(profile.orchestration, "contextProviders")
      ? contextProviderGraph(profile.orchestration.contextProviders, requestedChildren, requestedDependencies)
      : undefined;
  if (requestedContextProviders === null) {
    throw new Error(`Orchestrator context providers must be an acyclic graph of unique allowed child profiles with at most ${MAX_SUBAGENT_DEPENDENCIES} providers per child`);
  }
  mkdirSync(dir, { recursive: true });
  if (scope !== "global" && !isExistingPathWithinRoots(dir,
    new Set([scope === "roster" ? getRepositoryRosterRoot()! : cwd]))) {
    throw new Error(`Agent profile directory is outside the ${scope === "roster" ? "repository roster" : "project root"}`);
  }
  if (scope === "roster") assertRegularRosterProfile(filePath);
  if (
    profile.orchestration === undefined
    && Object.prototype.hasOwnProperty.call(stored, "pi_web_orchestration")
    && !profileOrchestration(stored.pi_web_orchestration, name)
  ) {
    throw new Error("Invalid stored Pi Web orchestration configuration; provide a valid policy or null to remove it");
  }
  const orchestrationField = profile.orchestration === null
    ? undefined
    : requestedChildren === undefined
      ? stored.pi_web_orchestration
      : {
          kind: "orchestrator",
          allowed_children: requestedChildren,
          ...(requestedDependencies !== undefined ? { depends_on: requestedDependencies } : {}),
          ...(requestedContextProviders !== undefined ? { context_providers: requestedContextProviders } : {}),
        };
  const orchestration = profileOrchestration(orchestrationField, name);
  if (orchestration && (tools.length > 0 || extensionTools.length > 0
    || (selectedExtensionTools === undefined ? loadExtensions : selectedExtensionTools.length > 0)
    || (selectedExtensionTools?.length ?? 0) > 0 || (loadSkills && selectedSkills === undefined))) {
    throw new Error("Orchestrators cannot use file tools, extension tools, or the legacy all-skills flag; select individual skills only");
  }
  const managed: Record<string, unknown> = {
    description,
    display_name: displayName,
    tools: orchestration ? "none" : composeToolsField([...tools, ...extensionTools], stored.tools),
    load_skills: loadSkills,
    load_extensions: loadExtensions,
    enabled: profile.enabled,
    inherit_context: profile.inheritContext,
    run_in_background: profile.runInBackground,
    pi_web_fast_mode: fastMode,
    prompt_mode: promptMode,
  };
  syncFlagAlias(managed, "skills", stored.skills, loadSkills);
  syncFlagAlias(managed, "extensions", stored.extensions, loadExtensions);
  if (model) managed.model = model;
  if (profile.thinking) managed.thinking = profile.thinking;
  if (maxTurns) managed.max_turns = maxTurns;
  if (profile.color?.trim()) managed.color = profile.color.trim();
  if (profile.isolation) managed.isolation = profile.isolation;
  if (profile.persistSession !== undefined) managed.persist_session = profile.persistSession;
  if (orchestrationField !== undefined) managed.pi_web_orchestration = orchestrationField;
  if (selectedSkills !== undefined) {
    const linkedGlobalRoster = scope === "global" && realpathSync(dir) !== resolve(dir);
    const savedSkills = scope === "project" || scope === "roster" || linkedGlobalRoster
      ? portableSelectedSkillReferences(dirname(realpathSync(dir)), selectedSkills)
      : selectedSkills;
    if (scope === "roster" && savedSkills.some((path) => isAbsolute(path))) {
      throw new Error("Repository roster profiles may select only skills inside the repository roster");
    }
    managed.pi_web_selected_skills = savedSkills;
  }
  else if ("pi_web_selected_skills" in stored) managed.pi_web_selected_skills = stored.pi_web_selected_skills;
  if (selectedExtensionTools !== undefined) managed.pi_web_selected_extension_tools = selectedExtensionTools;
  else if ("pi_web_selected_extension_tools" in stored) managed.pi_web_selected_extension_tools = stored.pi_web_selected_extension_tools;
  // Managed keys win; keys this app does not own follow in their original order.
  const frontmatter: Record<string, unknown> = { ...managed };
  for (const [key, value] of Object.entries(unmanagedFrontmatter(stored))) {
    if (!(key in frontmatter)) frontmatter[key] = value;
  }
  const yaml = stringifyYaml(frontmatter, { noRefs: true, lineWidth: 1000 }).trimEnd();
  writePrivateFileAtomicSync(filePath, `---\n${yaml}\n---\n\n${systemPrompt}\n`);
  const normalizedProfile = { ...profile, orchestration: undefined, configurationError: undefined };
  return {
    ...normalizedProfile,
    name,
    displayName,
    description,
    systemPrompt,
    tools,
    ...(extensionTools.length > 0 ? { extensionTools } : {}),
    ...(selectedSkills !== undefined ? { selectedSkills } : {}),
    ...(selectedExtensionTools !== undefined ? { selectedExtensionTools } : {}),
    loadSkills,
    loadExtensions,
    fastMode,
    ...(model ? { model } : { model: undefined }),
    ...(maxTurns ? { maxTurns } : { maxTurns: undefined }),
    promptMode,
    ...(profile.color ? { color: profile.color } : {}),
    ...(profile.isolation ? { isolation: profile.isolation } : {}),
    ...(profile.persistSession !== undefined ? { persistSession: profile.persistSession } : {}),
    ...(orchestration ? { orchestration } : {}),
    scope,
    filePath,
  };
}

export function deleteSubagentProfile(cwd: string, scope: SubagentWritableScope, name: string): void {
  const safeName = assertProfileName(name);
  const filePath = join(assertWritableProfileDirectory(cwd, scope), `${safeName}.md`);
  if (scope === "roster") assertRegularRosterProfile(filePath);
  if (existsSync(filePath)) unlinkSync(filePath);
}

export function saveProjectSubagentProfile(cwd: string, profile: SubagentProfileInput): SubagentProfile {
  return saveSubagentProfile(cwd, "project", profile);
}

export function deleteProjectSubagentProfile(cwd: string, name: string): void {
  deleteSubagentProfile(cwd, "project", name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childProfileFingerprints(
  value: unknown,
  children: readonly string[],
): Record<string, SubagentChildProfileFingerprint> | null {
  if (!isRecord(value)) return null;
  const expected = new Set(children.map((child) => child.toLowerCase()));
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) return null;
  const pins: Record<string, SubagentChildProfileFingerprint> = {};
  for (const key of keys) {
    const pin = value[key];
    if (
      !isRecord(pin)
      || !SUBAGENT_SCOPES.has(pin.scope as SubagentScope)
      || typeof pin.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(pin.sha256)
      || (pin.scope === "builtin"
        ? pin.filePath !== undefined
        : typeof pin.filePath !== "string" || !pin.filePath.trim())
    ) return null;
    pins[key] = {
      scope: pin.scope as SubagentScope,
      ...(pin.scope !== "builtin" ? { filePath: pin.filePath as string } : {}),
      sha256: pin.sha256,
    };
  }
  return pins;
}

type ValidSubagentMetadataData = Record<string, unknown> & {
  version: 1;
  parentSessionId: string;
  parentSessionPath: string;
};

function subagentMetadataData(entries: readonly SessionEntry[]): ValidSubagentMetadataData | null {
  const metaEntry = entries.find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
  if (!metaEntry || metaEntry.type !== "custom" || !isRecord(metaEntry.data)) return null;
  const data = metaEntry.data;
  if (data.version !== 1 || typeof data.parentSessionId !== "string" || typeof data.parentSessionPath !== "string") return null;
  return data as ValidSubagentMetadataData;
}

/** Restore the isolated prompt and tool scope used by a persisted subagent session. */
export function readSubagentSessionResources(
  entries: readonly SessionEntry[],
): SubagentSessionResources | null {
  const marker = entries.find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
  if (!marker) return null;
  const data = subagentMetadataData(entries);
  if (!data) throw new Error("Invalid subagent metadata");
  const snapshot = data.resourceSnapshot;
  if (!isRecord(snapshot) || (snapshot.version !== 1 && snapshot.version !== 2 && snapshot.version !== 3)) {
    throw new Error("Invalid or unsupported subagent resource snapshot");
  }
  const loadSkills = snapshot.loadSkills === true;
  const loadExtensions = snapshot.loadExtensions === true;
  if (
    !Array.isArray(snapshot.appendSystemPrompt)
    || !snapshot.appendSystemPrompt.every((item) => typeof item === "string")
    || !Array.isArray(snapshot.tools)
    || (snapshot.exactSystemPrompt !== undefined && typeof snapshot.exactSystemPrompt !== "string")
    || (snapshot.fastMode !== undefined && typeof snapshot.fastMode !== "boolean")
    || (snapshot.maxTurns !== undefined && (typeof snapshot.maxTurns !== "number"
      || !Number.isSafeInteger(snapshot.maxTurns) || snapshot.maxTurns < 1))
    || ((snapshot.version === 2 || snapshot.version === 3) &&
      (typeof snapshot.loadSkills !== "boolean" || typeof snapshot.loadExtensions !== "boolean"))
  ) {
    throw new Error("Invalid subagent resource snapshot");
  }
  const selectedSkills = snapshot.version === 3 && snapshot.selectedSkills !== undefined
    ? validatePinnedSkills(snapshot.selectedSkills) : undefined;
  const selectedExtensionTools = snapshot.version === 3 && snapshot.selectedExtensionTools !== undefined
    ? validatePinnedExtensionTools(snapshot.selectedExtensionTools) : undefined;
  if ((snapshot.version !== 3 && ("selectedSkills" in snapshot || "selectedExtensionTools" in snapshot))
    || (snapshot.version === 3 && ((selectedSkills !== undefined && loadSkills !== (selectedSkills.length > 0))
      || (selectedExtensionTools !== undefined && loadExtensions !== (selectedExtensionTools.length > 0))))) {
    throw new Error("Invalid selected resources in subagent snapshot");
  }
  const orchestration = (snapshot.version === 2 || snapshot.version === 3) && snapshot.orchestration !== undefined
    ? snapshot.orchestration
    : undefined;
  const children = isRecord(orchestration) ? allowedChildren(orchestration.allowedChildren) : null;
  const pins = isRecord(orchestration) && children !== null
    ? childProfileFingerprints(orchestration.childProfiles, children)
    : null;
  const dependencies = isRecord(orchestration) && children !== null
    && Object.prototype.hasOwnProperty.call(orchestration, "dependencies")
    ? dependencyGraph(orchestration.dependencies, children)
    : undefined;
  const contextProviders = isRecord(orchestration) && children !== null
    && Object.prototype.hasOwnProperty.call(orchestration, "contextProviders")
    ? contextProviderGraph(orchestration.contextProviders, children, dependencies ?? undefined)
    : undefined;
  if (
    (snapshot.version === 1 && "orchestration" in snapshot)
    || ((snapshot.version === 2 || snapshot.version === 3) && "orchestration" in snapshot && (
      !isRecord(orchestration)
      || children === null
      || pins === null
      || dependencies === null
      || contextProviders === null
      || typeof data.profile !== "string"
      || children?.some((child) => child.toLowerCase() === (data.profile as string).toLowerCase())
      || typeof orchestration.rootSessionId !== "string"
      || !orchestration.rootSessionId.trim()
      || !Number.isSafeInteger(orchestration.depth)
      || (orchestration.depth as number) < 1
    ))
  ) {
    throw new Error("Invalid subagent orchestration snapshot");
  }
  const tools = snapshot.tools as unknown[];
  const controlTools = tools.filter((tool): tool is string =>
    typeof tool === "string" && SUBAGENT_CONTROL_TOOLS.has(tool));
  if (
    !tools.every((tool) =>
      typeof tool === "string"
      && tool.length > 0
      && (BUILTIN_TOOLS.has(tool) || (loadExtensions && !SUBAGENT_CONTROL_TOOLS.has(tool)) || SUBAGENT_CONTROL_TOOLS.has(tool)))
    || (orchestration
      ? loadExtensions || (loadSkills && (snapshot.version !== 3 || selectedSkills === undefined))
        || tools.length !== SUBAGENT_CONTROL_TOOL_NAMES.length
        || controlTools.length !== SUBAGENT_CONTROL_TOOL_NAMES.length
        || SUBAGENT_CONTROL_TOOL_NAMES.some((name) => !controlTools.includes(name))
      : controlTools.length > 0)
  ) {
    throw new Error("Invalid subagent resource tools");
  }
  return {
    appendSystemPrompt: [...snapshot.appendSystemPrompt],
    tools: [...new Set(tools as string[])],
    loadSkills,
    loadExtensions,
    fastMode: snapshot.fastMode === true,
    ...(typeof snapshot.maxTurns === "number" ? { maxTurns: snapshot.maxTurns } : {}),
    ...(selectedSkills !== undefined ? { selectedSkills } : {}),
    ...(selectedExtensionTools !== undefined ? { selectedExtensionTools } : {}),
    ...(typeof snapshot.exactSystemPrompt === "string" ? { exactSystemPrompt: snapshot.exactSystemPrompt } : {}),
    ...(isRecord(orchestration) && children !== null && pins !== null
      ? { orchestration: {
          allowedChildren: children,
          ...(dependencies !== undefined && dependencies !== null ? { dependencies } : {}),
          ...(contextProviders !== undefined && contextProviders !== null ? { contextProviders } : {}),
          rootSessionId: orchestration.rootSessionId as string,
          depth: orchestration.depth as number,
          childProfiles: pins,
        } }
      : {}),
  };
}

export function withSubagentExtensionTools(
  profileTools: readonly string[],
  extensionToolNames: Iterable<string>,
): string[] {
  return [...new Set([
    ...profileTools,
    ...[...extensionToolNames].filter((name) => !SUBAGENT_CONTROL_TOOLS.has(name)),
  ])];
}

export function selectSubagentExtensionTools(
  extensions: Iterable<{ path: string; sourceInfo?: { source?: string }; tools: Map<string, unknown> }>,
  selectors: readonly string[],
): string[] {
  const wanted = selectors.map((selector) => selector.slice(4).toLowerCase());
  return [...extensions].flatMap((extension) => {
    const pathName = extension.path.replaceAll("\\", "/").split("/").at(-2) ?? extension.path;
    const sourceName = (extension.sourceInfo?.source ?? "").replace(/^npm:/, "");
    const extensionNames = new Set([pathName.toLowerCase(), sourceName.toLowerCase()]);
    const selected = wanted.some((selector) => {
      if (selector === "*") return true;
      const [extensionName, toolName] = selector.split("/", 2);
      return extensionNames.has(extensionName) && (!toolName || extension.tools.has(toolName));
    });
    if (!selected) return [];
    return [...extension.tools.keys()].filter((toolName) => wanted.some((selector) => {
      if (selector === "*" || selector.endsWith("/*")) return selector === "*" || extensionNames.has(selector.slice(0, -2));
      const [extensionName, selectedTool] = selector.split("/", 2);
      return extensionNames.has(extensionName) && (!selectedTool || selectedTool === toolName);
    }));
  });
}

export function readSubagentRun(entries: readonly SessionEntry[], sessionId: string, sessionPath: string): SubagentRunInfo | null {
  const data = subagentMetadataData(entries);
  if (!data) return null;
  if ((typeof data.contextFor === "string") !== (typeof data.contextForResultId === "string")
    || (typeof data.contextFor === "string" && (!data.contextFor || !data.contextForResultId))) {
    throw new Error("Invalid pinned context requester metadata");
  }
  const lifecycleEntry = [...entries].reverse().find((entry) =>
    entry.type === "custom" && (entry.customType === SUBAGENT_RESULT_TYPE || entry.customType === SUBAGENT_STATUS_TYPE)
  );
  const resultEntry = lifecycleEntry?.type === "custom" && lifecycleEntry.customType === SUBAGENT_RESULT_TYPE
    ? lifecycleEntry
    : undefined;
  const result = resultEntry?.type === "custom" && isRecord(resultEntry.data) ? resultEntry.data : undefined;
  if (result && ((result.contextFor !== undefined && result.contextFor !== data.contextFor)
    || (result.contextForResultId !== undefined && result.contextForResultId !== data.contextForResultId))) {
    throw new Error("Context requester changed in subagent result");
  }
  const statusEntry = lifecycleEntry?.type === "custom" && lifecycleEntry.customType === SUBAGENT_STATUS_TYPE
    ? lifecycleEntry
    : undefined;
  const statusData = statusEntry?.type === "custom" && isRecord(statusEntry.data) ? statusEntry.data : undefined;
  const persistedStatus = result && (result.status === "completed" || result.status === "failed" || result.status === "aborted" || result.status === "needs_context")
    ? result.status
    : statusData?.version === 1 && (statusData.status === "queued" || statusData.status === "running")
      ? statusData.status
      : "interrupted";
  // The first marker identifies the session; later status/result entries identify
  // the latest invocation when a failed or interrupted child is resumed.
  const invocation = result ?? statusData;
  const contextRequest = persistedStatus === "needs_context" ? pendingContextRequest(entries)?.request : undefined;
  if (persistedStatus === "needs_context" && !contextRequest) throw new Error("Invalid stored needs_context request");
  return {
    sessionId,
    sessionPath,
    parentSessionId: data.parentSessionId,
    parentToolCallId: typeof invocation?.parentToolCallId === "string"
      ? invocation.parentToolCallId
      : typeof data.parentToolCallId === "string" ? data.parentToolCallId : "",
    profile: typeof data.profile === "string" ? data.profile : "general-purpose",
    description: typeof invocation?.description === "string"
      ? invocation.description
      : typeof data.description === "string" ? data.description : "Subagent",
    task: typeof invocation?.task === "string"
      ? invocation.task
      : typeof data.task === "string" ? data.task : "",
    runInBackground: typeof invocation?.runInBackground === "boolean"
      ? invocation.runInBackground
      : data.runInBackground === true,
    status: persistedStatus,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    ...(result && typeof result.completedAt === "string" ? { completedAt: result.completedAt } : {}),
    ...(result && typeof result.result === "string" ? { result: result.result } : {}),
    ...(contextRequest ? { contextRequest } : {}),
    ...(typeof data.contextFor === "string" ? { contextFor: data.contextFor } : {}),
    ...(typeof data.contextForResultId === "string" ? { contextForResultId: data.contextForResultId } : {}),
    ...(result && typeof result.error === "string" ? { error: result.error } : {}),
    ...(typeof data.worktreePath === "string" ? { worktreePath: data.worktreePath } : {}),
    ...(typeof data.worktreeBranch === "string" ? { worktreeBranch: data.worktreeBranch } : {}),
    ...(result && typeof result.worktreeCleanupError === "string" ? { worktreeCleanupError: result.worktreeCleanupError } : {}),
  };
}
