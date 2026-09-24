import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dump as stringifyYaml } from "js-yaml";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { parseFrontmatter } from "./frontmatter";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isExistingPathWithinRoots } from "./path-security";
import { disabledBuiltInSubagents } from "./subagent-settings";
import { PRESET_READ_ONLY } from "./tool-presets";
import type { SessionEntry, SubagentSessionStatus } from "./types";

export const SUBAGENT_META_TYPE = "pi-web:subagent";
export const SUBAGENT_STATUS_TYPE = "pi-web:subagent-status";
export const SUBAGENT_RESULT_TYPE = "pi-web:subagent-result";
export const SUBAGENT_CONTROL_TOOL_NAMES = ["Agent", "get_subagent_result", "get_subagent_results", "steer_subagent"] as const;

export type SubagentStatus = SubagentSessionStatus;
export type SubagentScope = "builtin" | "global" | "workspace" | "project";
export type SubagentWritableScope = Extract<SubagentScope, "global" | "project">;

export interface SubagentProfile {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  extensionTools?: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  model?: string;
  thinking?: ThinkingLevel;
  /** Native OpenAI priority service tier; unsupported providers fail explicitly. */
  fastMode: boolean;
  /** Explicit Pi Web delegation permission; third-party allowed_subagents is not authoritative. */
  allowedSubagents?: string[];
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  promptMode: "replace" | "append";
  color?: string;
  isolation?: "worktree" | "off";
  persistSession?: boolean;
  enabled: boolean;
  scope: SubagentScope;
  filePath?: string;
}

export interface SubagentMetadata {
  version: 1;
  parentSessionId: string;
  parentSessionPath: string;
  /** Distinguishes a real child session from a fork containing copied metadata. */
  subagentSessionId?: string;
  parentToolCallId: string;
  profile: string;
  description: string;
  task: string;
  runInBackground: boolean;
  createdAt: string;
  resourceSnapshot: SubagentResourceSnapshot;
  /** Root session is depth 0; direct owner is 1, its children are 2. */
  subagentDepth?: number;
  orchestrationEnabled?: boolean;
  rootTaskId?: string;
  writerAllowedPaths?: string[];
  writerProjectFingerprint?: string;
  writerExpectedSnapshotId?: string;
  worktreeRoot?: string;
  worktreePath?: string;
  worktreeBranch?: string;
}

export interface SubagentResourceSnapshot {
  version: 1;
  appendSystemPrompt: string[];
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  exactSystemPrompt?: string;
  fastMode?: boolean;
  allowedSubagents?: string[];
  writerAllowedPaths?: string[];
  writerProjectFingerprint?: string;
  writerExpectedSnapshotId?: string;
}

export interface SubagentSessionResources {
  appendSystemPrompt: string[];
  tools: string[];
  loadSkills: boolean;
  loadExtensions: boolean;
  exactSystemPrompt?: string;
  fastMode?: boolean;
  allowedSubagents?: string[];
  writerAllowedPaths?: string[];
  writerProjectFingerprint?: string;
  writerExpectedSnapshotId?: string;
}

export interface SubagentResultMetadata {
  version: 1;
  status: Exclude<SubagentStatus, "starting" | "running" | "queued" | "interrupted">;
  completedAt: string;
  result?: string;
  error?: string;
  worktreeCleanupError?: string;
}

export interface SubagentStatusMetadata {
  version: 1;
  status: Extract<SubagentStatus, "queued" | "running">;
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
  error?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeCleanupError?: string;
  rootTaskId?: string;
  worktreeRoot?: string;
}

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const BUILTIN_TOOLS = new Set(DEFAULT_TOOLS);
const SUBAGENT_CONTROL_TOOLS = new Set<string>(SUBAGENT_CONTROL_TOOL_NAMES);
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WRITER_HOST_TOOLS = new Set(["apply_exact_patch"]);
const OWNER_HOST_TOOLS = new Set([
  "read_evidence", "read_source_range", "search_source", "project_context",
  "capture_changes", "read_change_manifest", "read_task_steering", "run_check", "read_check_log", "assess_acceptance",
]);
const REVIEW_HOST_TOOLS = new Set([
  "read_evidence", "read_source_range", "search_source", "project_context",
  "read_change_manifest", "read_task_steering", "read_check_log", "submit_review",
]);
const READER_HOST_TOOLS = new Set(["capture_evidence", "project_context"]);
const WRITER_READ_HOST_TOOLS = new Set(["read_evidence", "read_source_range", "project_context"]);

function isPermittedOrchestrationTool(profile: unknown, tool: string): boolean {
  if (profile === "orchestration-task-owner") return OWNER_HOST_TOOLS.has(tool);
  if (profile === "orchestration-change-reviewer") return REVIEW_HOST_TOOLS.has(tool);
  if (profile === "orchestration-package-writer") return WRITER_READ_HOST_TOOLS.has(tool);
  if (typeof profile === "string" && ORCHESTRATION_READER_NAMES.some((reader) =>
    profile === `${ORCHESTRATION_PREFIX}${reader}`)) return READER_HOST_TOOLS.has(tool);
  return false;
}

function validWriterAllowedPaths(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0 && value.length <= 64
    && value.every((path) => typeof path === "string"
      && path.length > 0 && path.length <= 512
      && !/[\\:*?\[\]]/.test(path)
      && path.split("/").every((part: string) => part !== "" && part !== "." && part !== ".."));
}

/**
 * Frontmatter keys the web UI owns. Everything else in a profile file belongs to
 * whichever runtime reads it (pi-subagents and friends), so a save from this app must
 * carry those keys through untouched. Dropping them silently changed behaviour:
 * `allowed_subagents` belongs to another runtime and must survive UI saves,
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
  "model",
  "thinking",
  "pi_web_fast_mode",
  "orchestration_children",
  "max_turns",
  "prompt_mode",
  "color",
  "isolation",
  "persist_session",
]);

const FRONTMATTER_OPEN_RE = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\n|\r)/;

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

/** Applied only by the host when a new root session explicitly opts into dispatcher mode. */
export const ORCHESTRATION_MAIN_ROLE = {
  model: "openai-codex/gpt-6-luna",
  thinking: "high" as ThinkingLevel,
  fastMode: true,
  systemPrompt: [
    "You are the dispatcher for this user session. Keep task identity, the original request, user corrections, and statuses.",
    "For an unknown engineering task, delegate to orchestration-task-owner (Astra High). Do not classify an unknown change as bounded yourself.",
    "Do not inspect or edit source files, run shell commands, make technical decisions, or summarize a writer's unchecked claims as a finished result.",
    "Pass material user corrections to the same active owner; a status question does not restart a task. Deliver the owner's accepted answer and report blockers accurately.",
  ].join("\n"),
} as const;

const ORCHESTRATION_PREFIX = "orchestration-";
const ORCHESTRATION_READER_NAMES = [
  "project-reader", "docs-reader", "code-reader", "tests-reader",
  "dependencies-reader", "external-reader", "runtime-reader",
] as const;
const ORCHESTRATION_CHILDREN = [
  ...ORCHESTRATION_READER_NAMES.map((name) => `${ORCHESTRATION_PREFIX}${name}`),
  "orchestration-package-writer", "orchestration-change-reviewer",
];

function orchestrationProfile(
  name: string,
  description: string,
  systemPrompt: string,
  options: {
    tools: string[];
    model: string;
    thinking: ThinkingLevel;
    fastMode: boolean;
    allowedSubagents?: string[];
  },
): SubagentProfile {
  return {
    name: `${ORCHESTRATION_PREFIX}${name}`,
    displayName: name.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
    description,
    systemPrompt,
    tools: options.tools,
    loadSkills: false,
    loadExtensions: false,
    model: options.model,
    thinking: options.thinking,
    fastMode: options.fastMode,
    ...(options.allowedSubagents ? { allowedSubagents: [...options.allowedSubagents] } : {}),
    promptMode: "replace",
    inheritContext: false,
    runInBackground: name !== "task-owner",
    enabled: true,
    scope: "builtin",
  };
}

const LUNA_MODEL = "openai-codex/gpt-6-luna";
const ASTRA_MODEL = "openai-codex/gpt-6-astra";
const READER_TOOLS = [...PRESET_READ_ONLY];
const READER_OUTPUT = [
  "After locating each decisive original source, call capture_evidence. Return concise JSON with evidence_refs [{id,start_line,end_line}], claim, coverage, unknown, and truncated.",
  "Do not retype source code; the host attaches the original lines. Report conflicts and absent or truncated coverage. Do not invent evidence or modify files.",
].join(" ");

/** These app-owned profiles are visible only in an explicitly opted-in dispatcher session and its task owner. */
const ORCHESTRATION_PROFILES: SubagentProfile[] = [
  orchestrationProfile("task-owner", "Own one engineering task, its evidence, implementation, and acceptance", [
    "Own this task from original user requirements through independent review. Preserve user constraints and applicable project rules.",
    "For unknown engineering decisions use your own judgment; assign independent broad searches to the relevant readers in parallel, and inspect exact original evidence yourself when completeness matters.",
    "Read the host-pinned startup baseline with capture_changes before a write. Define behavior, invariants, exact allowed paths, and checks. A writer Agent call must supply allowed_paths and expected_snapshot_id; the host pins the applicable project-rule fingerprint at dispatch.",
    "Use read_task_steering to inspect new literal user messages in Main before capturing a candidate. Capture the candidate with capture_changes after writing. Run required checks on that final candidate, and ask an independent reviewer to inspect its candidate_ref, snapshot_id, and criteria_version. Then use assess_acceptance; repeat affected gates after any later edit.",
    "Treat a completed writer run as unverified until review and required checks pass.",
    "For limited known classes Sol High may replace this Astra High binding only after explicit routing or evaluation. Reassess blockers before retrying; stop on an unresolved required check.",
  ].join("\n"), {
    tools: READER_TOOLS, model: ASTRA_MODEL, thinking: "high", fastMode: false,
    allowedSubagents: ORCHESTRATION_CHILDREN,
  }),
  orchestrationProfile("project-reader", "Locate applicable project rules and source bindings", `Find relevant project instructions, Knowledge locations, tracker bindings and workflow rules. Quote conflicting rules and report an ambiguous source rather than guessing. ${READER_OUTPUT}`, {
    tools: READER_TOOLS, model: LUNA_MODEL, thinking: "high", fastMode: true,
  }),
  orchestrationProfile("docs-reader", "Find requirements, Knowledge entries, and architecture decisions", `Read the assigned documentation and requirements sources. Keep the original wording for material constraints. ${READER_OUTPUT}`, {
    tools: READER_TOOLS, model: LUNA_MODEL, thinking: "high", fastMode: true,
  }),
  orchestrationProfile("code-reader", "Trace definitions, callers, invariants, and nearby code", `Locate the code relevant to the assigned question, including callers and boundary conditions. ${READER_OUTPUT}`, {
    tools: READER_TOOLS, model: LUNA_MODEL, thinking: "high", fastMode: true,
  }),
  orchestrationProfile("tests-reader", "Find tests, fixtures, and behavioral gaps", `Locate tests and fixtures for the delegated behavior. Distinguish a missing test from a confirmed absence of behavior. ${READER_OUTPUT}`, {
    tools: READER_TOOLS, model: LUNA_MODEL, thinking: "high", fastMode: true,
  }),
  orchestrationProfile("dependencies-reader", "Locate dependency versions and relevant API contracts", `Inspect manifests, lockfiles and assigned official dependency sources. Distinguish installed versions from assumptions. ${READER_OUTPUT}`, {
    tools: READER_TOOLS, model: LUNA_MODEL, thinking: "high", fastMode: true,
  }),
  orchestrationProfile("external-reader", "Investigate a specified external tracker or source", `Use only the explicitly bound external source and available tools; report when it cannot be reached or the source is ambiguous. ${READER_OUTPUT}`, {
    tools: READER_TOOLS, model: LUNA_MODEL, thinking: "high", fastMode: true,
  }),
  orchestrationProfile("runtime-reader", "Filter supplied logs, traces, and reproduction outputs", `Inspect only the assigned runtime evidence. Preserve exact errors, timestamps, and command outcomes; distinguish an unrun check from a passed check. ${READER_OUTPUT}`, {
    tools: READER_TOOLS, model: LUNA_MODEL, thinking: "high", fastMode: true,
  }),
  orchestrationProfile("package-writer", "Implement one bounded work package", [
    "Implement the assigned work package using apply_exact_patch only within allowed_paths, expected_snapshot_id, and expected_project_fingerprint passed by the host. Do not use broad shell, edit, or write tools.",
    "Return the patch application result and blockers; the owner runs checks. Do not enlarge the scope or declare review passed.",
    "If a design decision or conflicting requirement is missing, return needs_decision to the owner instead of guessing.",
  ].join("\n"), {
    tools: READER_TOOLS, model: LUNA_MODEL, thinking: "high", fastMode: true,
  }),
  orchestrationProfile("change-reviewer", "Independently examine a change against the original task", [
    "Review the actual change, including added, deleted and untracked files, against the original requirements, applicable project rules and check results.",
    "Read the host change manifest and any Main user follow-ups with read_task_steering for the delegated candidate_ref, snapshot_id, and criteria_version. Send your own verdict through submit_review. The owner cannot submit your approval.",
    "Ask for exact surrounding source when a diff omits relevant behavior. Distinguish passing checks, failing checks, and checks not run.",
    "Report actionable blocking findings with location and evidence. A writer's summary alone is not proof of correctness.",
  ].join("\n"), {
    tools: READER_TOOLS, model: ASTRA_MODEL, thinking: "high", fastMode: false,
  }),
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

/** Empty or malformed lists grant no delegation. This key is Pi Web specific. */
function parseOrchestrationChildren(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const names = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(names) || names.length > 32) return [];
  if (names.some((name) => typeof name !== "string" || !PROFILE_NAME_RE.test(name.trim()))) return [];
  const deduplicated = new Map<string, string>();
  for (const name of names) deduplicated.set(name.trim().toLowerCase(), name.trim());
  return [...deduplicated.values()];
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

/** Read existing frontmatter without allowing malformed metadata to be overwritten. */
function readStoredFrontmatter(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  const source = readFileSync(filePath, "utf8");
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
function parseProfileFile(filePath: string, scope: SubagentScope): SubagentProfile | null {
  try {
    const source = readFileSync(filePath, "utf8");
    const { data, rest } = parseFrontmatter(source);
    const name = stringValue(data?.name) ?? basename(filePath, ".md");
    if (!PROFILE_NAME_RE.test(name)) return null;
    const thinkingValue = stringValue(data?.thinking) as ThinkingLevel | undefined;
    const maxTurnsValue = typeof data?.max_turns === "number" ? Math.floor(data.max_turns) : undefined;
    const tools = parseTools(data?.tools, DEFAULT_TOOLS);
    const allowedSubagents = parseOrchestrationChildren(data?.orchestration_children);
    const disallowedTools = new Set(parseTools(data?.disallowed_tools, []));
    const disallowedExtensionTools = new Set(parseExtensionToolSelectors(data?.disallowed_tools).map((tool) => tool.toLowerCase()));
    const extensionTools = parseExtensionToolSelectors(data?.tools)
      .filter((tool) => !disallowedExtensionTools.has(tool.toLowerCase()));
    return {
      name,
      displayName: stringValue(data?.display_name) ?? name,
      description: stringValue(data?.description) ?? name,
      systemPrompt: rest.trim(),
      tools: tools.filter((tool) => !disallowedTools.has(tool)),
      ...(extensionTools.length > 0 ? { extensionTools } : {}),
      loadSkills: resourceBoolean(data?.load_skills ?? data?.skills, false),
      loadExtensions: resourceBoolean(data?.load_extensions ?? data?.extensions, extensionTools.length > 0),
      ...(stringValue(data?.model) ? { model: stringValue(data?.model) } : {}),
      ...(thinkingValue && THINKING_LEVELS.has(thinkingValue) ? { thinking: thinkingValue } : {}),
      fastMode: booleanValue(data?.pi_web_fast_mode, false),
      ...(allowedSubagents.length > 0 ? { allowedSubagents } : {}),
      ...(maxTurnsValue && maxTurnsValue > 0 ? { maxTurns: maxTurnsValue } : {}),
      inheritContext: booleanValue(data?.inherit_context, false),
      runInBackground: booleanValue(data?.run_in_background, false),
      promptMode: data?.prompt_mode === "replace" ? "replace" : "append",
      ...(stringValue(data?.color) ? { color: stringValue(data?.color) } : {}),
      ...(data?.isolation === "worktree" || data?.isolation === "off" ? { isolation: data.isolation } : {}),
      ...(typeof data?.persist_session === "boolean" ? { persistSession: data.persist_session } : {}),
      enabled: booleanValue(data?.enabled, true),
      scope,
      filePath,
    };
  } catch {
    return null;
  }
}

function isProjectProfilePathAllowed(cwd: string, target: string): boolean {
  return isExistingPathWithinRoots(target, new Set([cwd]));
}

function readProfileDirectory(dir: string, scope: SubagentScope, cwd: string): SubagentProfile[] {
  if (!existsSync(dir)) return [];
  if (scope !== "global" && !isProjectProfilePathAllowed(cwd, dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => parseProfileFile(join(dir, entry.name), scope))
    .filter((profile): profile is SubagentProfile => profile !== null);
}

function profileDirectories(cwd: string): Array<[string, Exclude<SubagentScope, "builtin">]> {
  return [
    [join(getAgentDir(), "agents"), "global"],
    [join(resolve(cwd), ".agents", "agents"), "workspace"],
    [join(resolve(cwd), ".pi", "agents"), "project"],
  ];
}

/**
 * A built-in has no file, so `enabled: false` cannot be written next to it the way
 * it is for a profile on disk. Its off state is a name in `agents/settings.json`
 * instead of a copied-out override file, which would otherwise freeze the built-in
 * prompt at the version it was copied from.
 */
function builtInProfiles(orchestrationEnabled = false): SubagentProfile[] {
  const disabled = disabledBuiltInSubagents();
  return [...BUILTIN_PROFILES, ...(orchestrationEnabled ? ORCHESTRATION_PROFILES : [])].map((profile) => ({
    ...profile,
    tools: [...profile.tools],
    ...(profile.allowedSubagents ? { allowedSubagents: [...profile.allowedSubagents] } : {}),
    enabled: !disabled.has(profile.name.toLowerCase()),
  }));
}

/** Every configured source, including profiles shadowed by a higher-precedence scope. */
export function listSubagentProfileSources(cwd: string, options: { orchestrationEnabled?: boolean } = {}): SubagentProfile[] {
  const profiles = builtInProfiles(options.orchestrationEnabled);
  for (const [dir, scope] of profileDirectories(cwd)) {
    profiles.push(...readProfileDirectory(dir, scope, cwd));
  }
  return profiles.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function listSubagentProfiles(cwd: string, options: { orchestrationEnabled?: boolean } = {}): SubagentProfile[] {
  // A same-name file replaces the built-in outright, its own `enabled` included.
  const byName = new Map(builtInProfiles().map((profile) => [profile.name.toLowerCase(), profile]));
  for (const [dir, scope] of profileDirectories(cwd)) {
    for (const profile of readProfileDirectory(dir, scope, cwd)) byName.set(profile.name.toLowerCase(), profile);
  }
  // The opt-in orchestration contract is owned by the host. A project profile
  // with the same name cannot silently replace its model, prompt or permissions.
  if (options.orchestrationEnabled) {
    for (const profile of builtInProfiles(true).filter((item) => item.name.startsWith(ORCHESTRATION_PREFIX))) {
      byName.set(profile.name.toLowerCase(), profile);
    }
  }
  return [...byName.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function resolveSubagentProfile(cwd: string, name: string, options: { orchestrationEnabled?: boolean } = {}): SubagentProfile | undefined {
  return listSubagentProfiles(cwd, options).find((profile) => profile.name.toLowerCase() === name.trim().toLowerCase() && profile.enabled);
}

function assertProfileName(name: string): string {
  const normalized = name.trim();
  if (!PROFILE_NAME_RE.test(normalized)) {
    throw new Error("Agent name may contain only letters, numbers, dots, underscores, and hyphens");
  }
  return normalized;
}

function writableProfileDirectory(cwd: string, scope: SubagentWritableScope): string {
  if (scope === "global") return join(getAgentDir(), "agents");
  if (scope === "project") return join(resolve(cwd), ".pi", "agents");
  throw new Error("Agent scope must be global or project");
}

function assertWritableProfileDirectory(cwd: string, scope: SubagentWritableScope): string {
  const dir = writableProfileDirectory(cwd, scope);
  if (scope === "global") return dir;

  let existingAncestor = dir;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error("Agent profile directory is outside the project root");
    existingAncestor = parent;
  }
  if (!isProjectProfilePathAllowed(cwd, existingAncestor)) {
    throw new Error("Agent profile directory is outside the project root");
  }
  return dir;
}

export function saveSubagentProfile(
  cwd: string,
  scope: SubagentWritableScope,
  profile: Omit<SubagentProfile, "scope" | "filePath">,
): SubagentProfile {
  const name = assertProfileName(profile.name);
  const tools = [...new Set(profile.tools.filter((tool) => BUILTIN_TOOLS.has(tool)))];
  const extensionTools = [...new Set(profile.extensionTools ?? [])];
  if (profile.thinking && !THINKING_LEVELS.has(profile.thinking)) {
    throw new Error(`Invalid thinking level: ${profile.thinking}`);
  }
  if (profile.maxTurns !== undefined && (!Number.isFinite(profile.maxTurns) || profile.maxTurns < 0)) {
    throw new Error("Max turns must be a non-negative number");
  }
  const maxTurns = profile.maxTurns && profile.maxTurns > 0
    ? Math.floor(profile.maxTurns)
    : undefined;
  const displayName = profile.displayName.trim() || name;
  const description = profile.description.trim() || name;
  const systemPrompt = profile.systemPrompt.trim();
  const model = profile.model?.trim() || undefined;
  if (profile.fastMode !== undefined && typeof profile.fastMode !== "boolean") {
    throw new Error("Fast mode must be a boolean");
  }
  const fastMode = profile.fastMode ?? false;
  if (profile.allowedSubagents !== undefined && (
    !Array.isArray(profile.allowedSubagents)
    || profile.allowedSubagents.length > 32
    || profile.allowedSubagents.some((item) => typeof item !== "string" || !PROFILE_NAME_RE.test(item.trim()))
  )) throw new Error("Orchestration children must be a list of valid agent names");
  const allowedSubagents = parseOrchestrationChildren(profile.allowedSubagents);
  const loadSkills = profile.loadSkills === true;
  const loadExtensions = profile.loadExtensions === true;
  const promptMode = profile.promptMode === "replace" ? "replace" : "append";
  const dir = assertWritableProfileDirectory(cwd, scope);
  mkdirSync(dir, { recursive: true });
  if (scope === "project" && !isProjectProfilePathAllowed(cwd, dir)) {
    throw new Error("Agent profile directory is outside the project root");
  }
  const filePath = join(dir, `${name}.md`);
  const stored = readStoredFrontmatter(filePath);
  const managed: Record<string, unknown> = {
    description,
    display_name: displayName,
    tools: composeToolsField([...tools, ...extensionTools], stored.tools),
    load_skills: loadSkills,
    load_extensions: loadExtensions,
    enabled: profile.enabled,
    inherit_context: profile.inheritContext,
    run_in_background: profile.runInBackground,
    prompt_mode: promptMode,
  };
  syncFlagAlias(managed, "skills", stored.skills, loadSkills);
  syncFlagAlias(managed, "extensions", stored.extensions, loadExtensions);
  if (model) managed.model = model;
  if (profile.thinking) managed.thinking = profile.thinking;
  if (fastMode) managed.pi_web_fast_mode = true;
  if (allowedSubagents.length > 0) managed.orchestration_children = allowedSubagents;
  if (maxTurns) managed.max_turns = maxTurns;
  if (profile.color?.trim()) managed.color = profile.color.trim();
  if (profile.isolation) managed.isolation = profile.isolation;
  if (profile.persistSession !== undefined) managed.persist_session = profile.persistSession;
  // Managed keys win; keys this app does not own follow in their original order.
  const frontmatter: Record<string, unknown> = { ...managed };
  for (const [key, value] of Object.entries(unmanagedFrontmatter(stored))) {
    if (!(key in frontmatter)) frontmatter[key] = value;
  }
  const yaml = stringifyYaml(frontmatter, { noRefs: true, lineWidth: 1000 }).trimEnd();
  writePrivateFileAtomicSync(filePath, `---\n${yaml}\n---\n\n${systemPrompt}\n`);
  return {
    ...profile,
    name,
    displayName,
    description,
    systemPrompt,
    tools,
    ...(extensionTools.length > 0 ? { extensionTools } : {}),
    loadSkills,
    loadExtensions,
    ...(model ? { model } : { model: undefined }),
    fastMode,
    ...(allowedSubagents.length > 0 ? { allowedSubagents } : { allowedSubagents: undefined }),
    ...(maxTurns ? { maxTurns } : { maxTurns: undefined }),
    promptMode,
    ...(profile.color ? { color: profile.color } : {}),
    ...(profile.isolation ? { isolation: profile.isolation } : {}),
    ...(profile.persistSession !== undefined ? { persistSession: profile.persistSession } : {}),
    scope,
    filePath,
  };
}

export function deleteSubagentProfile(cwd: string, scope: SubagentWritableScope, name: string): void {
  const safeName = assertProfileName(name);
  const filePath = join(assertWritableProfileDirectory(cwd, scope), `${safeName}.md`);
  if (existsSync(filePath)) unlinkSync(filePath);
}

export function saveProjectSubagentProfile(cwd: string, profile: Omit<SubagentProfile, "scope" | "filePath">): SubagentProfile {
  return saveSubagentProfile(cwd, "project", profile);
}

export function deleteProjectSubagentProfile(cwd: string, name: string): void {
  deleteSubagentProfile(cwd, "project", name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const data = subagentMetadataData(entries);
  if (!data) return null;
  const snapshot = data.resourceSnapshot;
  if (data.orchestrationEnabled === true && (typeof data.subagentSessionId !== "string" || !data.subagentSessionId)) {
    throw new Error("Invalid persisted subagent session identity");
  }
  const loadSkills = isRecord(snapshot) && snapshot.loadSkills === true;
  const loadExtensions = isRecord(snapshot) && snapshot.loadExtensions === true;
  const writerPolicy = isRecord(snapshot) && snapshot.writerAllowedPaths !== undefined;
  if (isRecord(snapshot) && (
    (snapshot.fastMode !== undefined && typeof snapshot.fastMode !== "boolean")
    || (snapshot.allowedSubagents !== undefined && (
      !Array.isArray(snapshot.allowedSubagents)
      || snapshot.allowedSubagents.length > 32
      || snapshot.allowedSubagents.some((item) => typeof item !== "string" || !PROFILE_NAME_RE.test(item))
    ))
    || (writerPolicy && (
      data.profile !== "orchestration-package-writer"
      || data.orchestrationEnabled !== true
      || !validWriterAllowedPaths(snapshot.writerAllowedPaths)
      || typeof snapshot.writerProjectFingerprint !== "string"
      || snapshot.writerProjectFingerprint.length === 0
      || snapshot.writerProjectFingerprint.length > 256
      || typeof snapshot.writerExpectedSnapshotId !== "string"
      || snapshot.writerExpectedSnapshotId.length === 0
      || snapshot.writerExpectedSnapshotId.length > 256
    ))
    || ((snapshot.writerProjectFingerprint !== undefined || snapshot.writerExpectedSnapshotId !== undefined) && !writerPolicy)
  )) {
    // A malformed persisted delegation or speed policy must not reopen on an
    // unrestricted default resource set or silently drop the requested tier.
    throw new Error("Invalid persisted subagent resource policy");
  }
  const allowedSubagents = isRecord(snapshot)
    && data.orchestrationEnabled === true && data.profile === "orchestration-task-owner"
    ? parseOrchestrationChildren(snapshot.allowedSubagents)
    : [];
  const writerToolsEnabled = writerPolicy && validWriterAllowedPaths(snapshot.writerAllowedPaths)
    && data.profile === "orchestration-package-writer" && data.orchestrationEnabled === true;
  if (
    isRecord(snapshot)
    && snapshot.version === 1
    && Array.isArray(snapshot.appendSystemPrompt)
    && snapshot.appendSystemPrompt.every((item) => typeof item === "string")
    && Array.isArray(snapshot.tools)
    && snapshot.tools.every((item) =>
      typeof item === "string"
      && item.length > 0
      && (SUBAGENT_CONTROL_TOOLS.has(item)
        ? allowedSubagents.length > 0
        : WRITER_HOST_TOOLS.has(item)
          ? writerToolsEnabled
          : data.orchestrationEnabled === true && isPermittedOrchestrationTool(data.profile, item)
            ? true
          : BUILTIN_TOOLS.has(item) || loadExtensions)
    )
  ) {
    return {
      appendSystemPrompt: [...snapshot.appendSystemPrompt],
      tools: [...new Set(snapshot.tools)],
      loadSkills,
      loadExtensions,
      ...(snapshot.fastMode === true ? { fastMode: true } : {}),
      ...(allowedSubagents.length > 0 ? { allowedSubagents } : {}),
      ...(writerToolsEnabled ? {
        writerAllowedPaths: [...snapshot.writerAllowedPaths as string[]],
        writerProjectFingerprint: snapshot.writerProjectFingerprint as string,
        writerExpectedSnapshotId: snapshot.writerExpectedSnapshotId as string,
      } : {}),
      ...(typeof snapshot.exactSystemPrompt === "string" ? { exactSystemPrompt: snapshot.exactSystemPrompt } : {}),
    };
  }
  return null;
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

export function readSubagentRun(entries: readonly SessionEntry[], sessionId: string, sessionPath: string, parentSessionPath?: string): SubagentRunInfo | null {
  // Pi forks copy custom entries, including the source child's metadata. A
  // fork's own baseline marker wins even when the old parent path survives.
  if (entries.some((entry) => entry.type === "custom"
    && entry.customType === "pi-web:fork-cost-baseline"
    && isRecord(entry.data) && entry.data.version === 2 && entry.data.sessionId === sessionId)) return null;
  const data = subagentMetadataData(entries);
  if (!data) return null;
  if (data.orchestrationEnabled === true && (typeof data.subagentSessionId !== "string" || !data.subagentSessionId)) return null;
  if (typeof data.subagentSessionId === "string" && data.subagentSessionId !== sessionId) return null;
  if (parentSessionPath !== undefined && data.parentSessionPath !== parentSessionPath) return null;
  const lifecycleEntry = [...entries].reverse().find((entry) =>
    entry.type === "custom" && (entry.customType === SUBAGENT_RESULT_TYPE || entry.customType === SUBAGENT_STATUS_TYPE)
  );
  const resultEntry = lifecycleEntry?.type === "custom" && lifecycleEntry.customType === SUBAGENT_RESULT_TYPE
    ? lifecycleEntry
    : undefined;
  const result = resultEntry?.type === "custom" && isRecord(resultEntry.data) ? resultEntry.data : undefined;
  const statusEntry = lifecycleEntry?.type === "custom" && lifecycleEntry.customType === SUBAGENT_STATUS_TYPE
    ? lifecycleEntry
    : undefined;
  const statusData = statusEntry?.type === "custom" && isRecord(statusEntry.data) ? statusEntry.data : undefined;
  const persistedStatus = result && (result.status === "completed" || result.status === "failed" || result.status === "aborted")
    ? result.status
    : statusData?.version === 1 && (statusData.status === "queued" || statusData.status === "running")
      ? statusData.status
      : "interrupted";
  return {
    sessionId,
    sessionPath,
    parentSessionId: data.parentSessionId,
    parentToolCallId: typeof data.parentToolCallId === "string" ? data.parentToolCallId : "",
    profile: typeof data.profile === "string" ? data.profile : "general-purpose",
    description: typeof data.description === "string" ? data.description : "Subagent",
    task: typeof data.task === "string" ? data.task : "",
    runInBackground: data.runInBackground === true,
    status: persistedStatus,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    ...(typeof data.rootTaskId === "string" ? { rootTaskId: data.rootTaskId } : {}),
    ...(typeof data.worktreeRoot === "string" ? { worktreeRoot: data.worktreeRoot } : {}),
    ...(result && typeof result.completedAt === "string" ? { completedAt: result.completedAt } : {}),
    ...(result && typeof result.result === "string" ? { result: result.result } : {}),
    ...(result && typeof result.error === "string" ? { error: result.error } : {}),
    ...(typeof data.worktreePath === "string" ? { worktreePath: data.worktreePath } : {}),
    ...(typeof data.worktreeBranch === "string" ? { worktreeBranch: data.worktreeBranch } : {}),
    ...(result && typeof result.worktreeCleanupError === "string" ? { worktreeCleanupError: result.worktreeCleanupError } : {}),
  };
}
