import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "./pi-types";
import {
  createSubagentExtension,
  preferPiWebSubagentExtension,
  subagentNotificationText,
  subagentToolDetails,
  type ResumeSubagentRequest,
  type StartSubagentRequest,
  type SubagentExecution,
  type SubagentExtensionRuntime,
} from "./subagent-extension";
import {
  listSubagentProfiles,
  readSubagentRun,
  readSubagentSessionResources,
  resolveSubagentProfile,
  SUBAGENT_CONTROL_TOOL_NAMES,
  SUBAGENT_META_TYPE,
  SUBAGENT_STATUS_TYPE,
  SUBAGENT_RESULT_TYPE,
  selectSubagentExtensionTools,
  withSubagentExtensionTools,
  type SubagentMetadata,
  type SubagentOrchestration,
  type SubagentProfile,
  type SubagentResultMetadata,
  type SubagentRunInfo,
} from "./subagents";
import type { SessionEntry } from "./types";
import { buildSubagentPromptPlan } from "./subagent-prompt";
import { applyFastMode, isFastSupported } from "./subagent-fast-mode";
import { readMainSessionResources } from "./main-agent-snapshot";
import { createExactSystemPromptExtension } from "./exact-system-prompt";
import {
  filterPinnedSkills,
  pinSelectedSkills,
  pinSelectedExtensionTools,
  pinnedResourceIntegrityExtension,
  selectedResourceSourceFingerprint,
  pinnedSkillsPrompt,
  type PinnedSkill,
  type PinnedExtensionTool,
} from "./agent-resource-selection";
import { appendSubagentInputFiles, loadSubagentInputFiles } from "./subagent-input";
import { projectTrustReloadOptions } from "./project-trust";
import { getRepositorySkillPaths } from "./repository-roster";
import { resolveShellTools } from "./powershell-settings";
import { isBuiltInSubagentsEnabled, readSubagentSettings } from "./subagent-settings";
import { SubagentQueue } from "./subagent-queue";
import { addWorktree, removeWorktree } from "./worktree";
import { createHash, randomUUID } from "node:crypto";
import {
  admitDependencyChild,
  currentDependencyEpoch,
  dependencyInputsStillCurrent,
  dependencyRefsStillCurrent,
  MAX_DEPENDENCY_ARTIFACT_BYTES,
  profileProducesDependencyOutput,
  recordDependencyArtifact,
  reserveDependencyProfile,
  resolveDependencyInputs,
  type DependencyAdmission,
} from "./subagent-dependencies";
import {
  childParentIdentity,
  contextHandoffFor,
  contextResultHash,
  latestSubagentResult,
  MAX_CONTEXT_RESULT_BYTES,
  parseSubagentContextRequest,
  pendingContextRequest,
  SUBAGENT_CONTEXT_CONSUMED_TYPE,
  SUBAGENT_CONTEXT_HANDOFF_TYPE,
  type ContextHandoff,
} from "./subagent-context-handoff";

interface HostSession {
  readonly inner: AgentSessionLike;
  readonly sessionFile: string;
  readonly cwd: string;
  isAlive(): boolean;
  isRunning(): boolean;
  isChatOnly?(): boolean;
  waitUntilReady(): Promise<void>;
}

export interface SubagentRuntimeDependencies {
  getSession(sessionId: string): HostSession | undefined;
  registerSession(
    inner: AgentSessionLike,
    options?: { exactSystemPrompt?: string; chatOnly?: boolean },
  ): void;
  reopenSession(sessionId: string, sessionFile: string): Promise<HostSession>;
  resolveSessionPath(sessionId: string): Promise<string | null>;
  invalidateSessionList(): void;
  isBuiltInSubagentsEnabled?(): boolean;
  /** Deterministic tests can exercise the actual admission/runtime path without a model provider. */
  createServices?: typeof createAgentSessionServices;
  createFromServices?: typeof createAgentSessionFromServices;
  createWorktree?: typeof addWorktree;
  removeWorktree?: typeof removeWorktree;
}

export interface SubagentController {
  readonly extensionRuntime: SubagentExtensionRuntime;
  get(sessionId: string): Promise<SubagentRunInfo | null>;
  steer(sessionId: string, message: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  abortDescendants(parentSessionId: string): Promise<void>;
  allowDescendantStarts(parentSessionId: string): void;
  forgetSession(sessionId: string): void;
}

type StoredSubagentExecution = {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  abortRequested: boolean;
  cancelQueued?: () => boolean;
  releaseAdmission?: () => void;
};

declare global {
  var __piSubagentContextClaims: Set<string> | undefined;
  var __piSubagentRuns: Map<string, StoredSubagentExecution> | undefined;
  var __piSubagentQueue: SubagentQueue<SubagentRunInfo> | undefined;
  var __piSubagentConsumedResults: Set<string> | undefined;
  var __piSubagentRootAdmissions: Map<string, number> | undefined;
  var __piSubagentBranchAdmissions: Map<string, number> | undefined;
  var __piSubagentStoppedParents: Set<string> | undefined;
  var __piSubagentPendingNotifications: Map<string, string> | undefined;
  var __piSubagentSuppressedNotifications: Set<string> | undefined;
  var __piSubagentResumeReservations: Set<string> | undefined;
}
const SUBAGENT_CONTEXT_LIMIT = 50_000;
const PARENT_IDLE_POLL_MS = 200;
const MAX_SUBAGENT_DEPTH = 3;
const MAX_ROOT_ACTIVE_DESCENDANTS = 32;
const TURN_LIMIT_ERROR = "Subagent exceeded its turn limit without finishing";
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function rootAdmissions(): Map<string, number> {
  return globalThis.__piSubagentRootAdmissions ??= new Map();
}

function branchAdmissions(): Map<string, number> {
  return globalThis.__piSubagentBranchAdmissions ??= new Map();
}

function reserveBranchAdmission(cwd: string): () => void {
  const admissions = branchAdmissions();
  admissions.set(cwd, (admissions.get(cwd) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (admissions.get(cwd) ?? 1) - 1;
    if (remaining > 0) admissions.set(cwd, remaining);
    else admissions.delete(cwd);
  };
}

function stoppedParents(): Set<string> {
  return globalThis.__piSubagentStoppedParents ??= new Set();
}

function pendingNotifications(): Map<string, string> {
  return globalThis.__piSubagentPendingNotifications ??= new Map();
}

function suppressedNotifications(): Set<string> {
  return globalThis.__piSubagentSuppressedNotifications ??= new Set();
}

function resumeReservations(): Set<string> {
  return globalThis.__piSubagentResumeReservations ??= new Set();
}

function notificationKey(run: Pick<SubagentRunInfo, "sessionId" | "parentToolCallId">): string {
  return JSON.stringify([run.sessionId, run.parentToolCallId]);
}

function reportSubagentUpdate(callback: ((run: SubagentRunInfo) => void) | undefined, run: SubagentRunInfo): void {
  try {
    callback?.(run);
  } catch (error) {
    console.error("[pi-web] failed to report subagent progress:", error);
  }
}

/** Reserve synchronously, before even creating a worktree or loading extensions. */
function reserveRootAdmission(rootSessionId: string): () => void {
  const admissions = rootAdmissions();
  const active = admissions.get(rootSessionId) ?? 0;
  if (active >= MAX_ROOT_ACTIVE_DESCENDANTS) {
    throw new Error(`Root session ${rootSessionId} already has ${MAX_ROOT_ACTIVE_DESCENDANTS} active subagents`);
  }
  admissions.set(rootSessionId, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (admissions.get(rootSessionId) ?? 1) - 1;
    if (remaining > 0) admissions.set(rootSessionId, remaining);
    else admissions.delete(rootSessionId);
  };
}

/** Pin the effective profile, including scope and every field affecting its runtime behavior. */
export function profileAuthorityPin(profile: SubagentProfile) {
  const authority = {
    name: profile.name,
    displayName: profile.displayName,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    tools: profile.tools,
    extensionTools: profile.extensionTools,
    selectedSkills: profile.selectedSkills,
    selectedExtensionTools: profile.selectedExtensionTools,
    selectedSkillSources: profile.selectedSkills?.map((path) => selectedResourceSourceFingerprint(path)),
    selectedExtensionSources: profile.selectedExtensionTools?.map((tool) => selectedResourceSourceFingerprint(tool.extensionPath)),
    loadSkills: profile.loadSkills,
    loadExtensions: profile.loadExtensions,
    model: profile.model,
    thinking: profile.thinking,
    // Missing/false were the same behavior before Fast mode existed; keep old
    // session child pins valid when a legacy profile acquires its default.
    ...(profile.fastMode ? { fastMode: true } : {}),
    maxTurns: profile.maxTurns,
    inheritContext: profile.inheritContext,
    runInBackground: profile.runInBackground,
    promptMode: profile.promptMode,
    color: profile.color,
    isolation: profile.isolation,
    persistSession: profile.persistSession,
    orchestration: profile.orchestration,
    enabled: profile.enabled,
    scope: profile.scope,
    filePath: profile.filePath,
  };
  return {
    scope: profile.scope,
    ...(profile.filePath ? { filePath: profile.filePath } : {}),
    sha256: createHash("sha256").update(JSON.stringify(authority)).digest("hex"),
  };
}

function sameProfilePin(
  actual: ReturnType<typeof profileAuthorityPin>,
  expected: ReturnType<typeof profileAuthorityPin> | undefined,
): boolean {
  return expected !== undefined
    && actual.scope === expected.scope
    && actual.filePath === expected.filePath
    && actual.sha256 === expected.sha256;
}

function pinAllowedChildren(cwd: string, allowedChildren: readonly string[]) {
  const profiles = listSubagentProfiles(cwd);
  return Object.fromEntries(allowedChildren.map((name) => {
    const profile = profiles.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase() && candidate.enabled);
    if (!profile) throw new Error(`Allowed subagent profile is unavailable: ${name}`);
    return [name.toLowerCase(), profileAuthorityPin(profile)];
  }));
}

function assertDependencyProvidersPinned(
  cwd: string,
  childName: string,
  orchestration: { dependencies?: SubagentOrchestration["dependencies"];
    childProfiles: Record<string, ReturnType<typeof profileAuthorityPin>> } | undefined,
): void {
  if (!orchestration) return;
  const checked = new Set<string>();
  function check(name: string): void {
    const key = name.toLowerCase();
    if (checked.has(key)) return;
    checked.add(key);
    for (const [consumer, providers] of Object.entries(orchestration!.dependencies ?? {})) {
      if (consumer.toLowerCase() !== key) continue;
      for (const provider of providers) {
        const expected = orchestration!.childProfiles[provider.toLowerCase()];
        const actual = resolveSubagentProfile(cwd, provider);
        if (!actual || !sameProfilePin(profileAuthorityPin(actual), expected)) {
          throw new Error(`Subagent dependency profile changed since orchestrator start: ${provider}`);
        }
        check(provider);
      }
    }
  }
  check(childName);
}

type PinnedOrchestration = {
  allowedChildren: string[];
  dependencies?: SubagentOrchestration["dependencies"];
  contextProviders?: SubagentOrchestration["contextProviders"];
  childProfiles: Record<string, ReturnType<typeof profileAuthorityPin>>;
};

function contextProviderAllowed(policy: PinnedOrchestration | undefined, consumer: string, provider: string): boolean {
  return Object.entries(policy?.contextProviders ?? {}).some(([name, providers]) =>
    name.toLowerCase() === consumer.toLowerCase()
      && providers.some((item) => item.toLowerCase() === provider.toLowerCase()));
}

function assertParentMayStart(
  parent: HostSession,
  parentSessionId: string,
  childProfileName: string,
  getSession: SubagentRuntimeDependencies["getSession"],
) {
  if (stoppedParents().has(parentSessionId)) throw new Error("Parent session was stopped");
  if (parent.isChatOnly?.()) throw new Error("Chat-only Main cannot delegate without Agent tools");
  const entries = parent.inner.sessionManager.getEntries() as unknown as SessionEntry[];
  // Throws on a corrupt subagent marker. A legacy v1 specialist cannot delegate.
  const resources = readSubagentSessionResources(entries, parent.inner.sessionManager.getHeader?.()?.parentSession);
  if (!resources) {
    const rootPolicy = readMainSessionResources(entries);
    if (!rootPolicy) {
      // A session created before Main configuration support stays legacy even
      // after the global policy is edited; new sessions always persist a marker.
      return { rootSessionId: parentSessionId, depth: 1 };
    }
    const orchestration = rootPolicy.orchestration;
    if (orchestration) {
      if (!orchestration.allowedChildren.some((name) => name.toLowerCase() === childProfileName.toLowerCase())) {
        throw new Error(`Main is not allowed to delegate to ${childProfileName}`);
      }
      const actual = resolveSubagentProfile(parent.cwd, childProfileName);
      const expected = orchestration.childProfiles[childProfileName.toLowerCase()];
      if (!actual || !sameProfilePin(profileAuthorityPin(actual), expected)) {
        throw new Error(`Subagent profile changed since Main session start: ${childProfileName}`);
      }
    }
    return { rootSessionId: parentSessionId, depth: 1 };
  }
  const permission = resources.orchestration;
  if (!permission?.allowedChildren.some((name) => name.toLowerCase() === childProfileName.toLowerCase())) {
    throw new Error(`Subagent ${parentSessionId} is not allowed to delegate to ${childProfileName}`);
  }
  const actualProfile = resolveSubagentProfile(parent.cwd, childProfileName);
  const expectedPin = permission.childProfiles[childProfileName.toLowerCase()];
  if (!actualProfile || !sameProfilePin(profileAuthorityPin(actualProfile), expectedPin)) {
    throw new Error(`Subagent profile changed since orchestrator start: ${childProfileName}`);
  }
  const depth = permission.depth + 1;
  if (depth > MAX_SUBAGENT_DEPTH) throw new Error(`Subagent depth cannot exceed ${MAX_SUBAGENT_DEPTH}`);

  // A configured graph can reuse an orchestrator profile in several branches, but a
  // profile must not invoke itself or one of its ancestors within a single branch.
  let ancestorEntries = entries;
  const visited = new Set<string>([parentSessionId]);
  for (let index = 0; index < MAX_SUBAGENT_DEPTH; index += 1) {
    const marker = ancestorEntries.find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
    if (!marker || marker.type !== "custom" || !marker.data || typeof marker.data !== "object") break;
    const metadata = marker.data as Partial<SubagentMetadata>;
    if (typeof metadata.profile !== "string" || typeof metadata.parentSessionId !== "string" || typeof metadata.parentSessionPath !== "string") {
      throw new Error("Invalid subagent ancestry");
    }
    if (metadata.profile.toLowerCase() === childProfileName.toLowerCase()) {
      throw new Error(`Recursive subagent profile is not allowed: ${childProfileName}`);
    }
    if (stoppedParents().has(metadata.parentSessionId)) throw new Error("Ancestor session was stopped");
    if (metadata.parentSessionId === permission.rootSessionId) break;
    if (visited.has(metadata.parentSessionId)) throw new Error("Cyclic subagent ancestry");
    visited.add(metadata.parentSessionId);
    const activeAncestor = getSession(metadata.parentSessionId);
    ancestorEntries = activeAncestor?.isAlive()
      ? activeAncestor.inner.sessionManager.getEntries() as unknown as SessionEntry[]
      : SessionManager.open(metadata.parentSessionPath).getEntries() as unknown as SessionEntry[];
    if (!readSubagentSessionResources(ancestorEntries)) throw new Error("Invalid subagent ancestry");
  }
  return { rootSessionId: permission.rootSessionId, depth };
}

/** pi's agent loop records provider failures as an assistant message with `stopReason: "error"` and resolves `prompt()` normally; surface that as a failed run. */
function lastAssistantError(sessionManager: { getEntries?: () => unknown }): string | undefined {
  const entries = sessionManager.getEntries?.();
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message.stopReason !== "error") return undefined;
    return typeof entry.message.errorMessage === "string" && entry.message.errorMessage ? entry.message.errorMessage : "Provider returned an error";
  }
  return undefined;
}

/** Count turns from this invocation only; a reopened session retains its cap but not its old counter. */
function monitorSubagentTurns(inner: AgentSessionLike, turnLimit: number | undefined) {
  let count = 0;
  let reached = false;
  const unsubscribe = turnLimit === undefined ? () => {} : inner.subscribe((event) => {
    // SDK emits turn_end before agent_end even on a complete final answer.
    // A finished Nth turn is valid; abort only if an (N+1)th turn actually starts.
    if (event.type === "turn_start" && !reached && count >= turnLimit) {
      reached = true;
      void inner.abort().catch((error) => console.error("[pi-web] failed to stop subagent at turn limit:", error));
    } else if (event.type === "turn_end") {
      count += 1;
      const needsAnotherTurn = event.message.role === "assistant"
        && event.message.content.some((part) => part.type === "toolCall");
      if (count === turnLimit - 1 && needsAnotherTurn) {
        void inner.steer("One turn remains. Wrap up and provide your final answer on the next turn.")
          .catch((error) => console.error("[pi-web] failed to steer subagent at turn limit:", error));
      }
    }
  });
  return { get reached() { return reached; }, unsubscribe };
}

/** Fields shared by the start and resume result records. Their extra fields differ. */
function subagentResultMetadata(run: SubagentRunInfo): SubagentResultMetadata {
  return {
    version: 1,
    status: run.status as SubagentResultMetadata["status"],
    completedAt: run.completedAt!,
    ...(run.result ? { result: run.result } : {}),
    ...(run.contextRequest ? { contextRequest: run.contextRequest } : {}),
    ...(run.contextFor ? { contextFor: run.contextFor } : {}),
    ...(run.contextForResultId ? { contextForResultId: run.contextForResultId } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

function getSubagentRuns(): Map<string, StoredSubagentExecution> {
  if (!globalThis.__piSubagentRuns) globalThis.__piSubagentRuns = new Map();
  return globalThis.__piSubagentRuns;
}

function getSubagentQueue(): SubagentQueue<SubagentRunInfo> {
  if (!globalThis.__piSubagentQueue) globalThis.__piSubagentQueue = new SubagentQueue();
  return globalThis.__piSubagentQueue;
}

/**
 * Session IDs whose terminal result the parent already collected with `get_subagent_result`.
 * Only background runs are recorded: a foreground run never notifies, so nothing would ever
 * clear its entry. `notifyParent` consumes the mark, so the set stays bounded by the
 * background results still waiting to be delivered.
 */
function getConsumedSubagentResults(): Set<string> {
  if (!globalThis.__piSubagentConsumedResults) globalThis.__piSubagentConsumedResults = new Set();
  return globalThis.__piSubagentConsumedResults;
}

function markResultConsumed(sessionId: string, callerSessionId?: string): void {
  const pending = [...pendingNotifications()].filter(([key, owner]) =>
    JSON.parse(key)[0] === sessionId && (!callerSessionId || owner === callerSessionId)
  );
  const latest = pending.at(-1);
  // Compatibility for callers/tests that manually deliver a background run
  // without starting it through the controller. Live runs always have a key.
  if (latest) getConsumedSubagentResults().add(latest[0]);
  else if (!callerSessionId) getConsumedSubagentResults().add(sessionId);
}

function takeResultConsumed(run: SubagentRunInfo): boolean {
  const consumed = getConsumedSubagentResults();
  return consumed.delete(notificationKey(run)) || consumed.delete(run.sessionId);
}

function parseSubagentModel(runtime: ModelRuntime, value: string | undefined) {
  if (!value?.trim()) return undefined;
  const requested = value.trim();
  const slash = requested.indexOf("/");
  if (slash > 0) {
    const provider = requested.slice(0, slash);
    const modelId = requested.slice(slash + 1);
    const model = runtime.getModel(provider, modelId);
    if (!model) throw new Error(`Subagent model not found: ${requested}`);
    return model;
  }
  const matches = runtime.getModels().filter((model) => model.id === requested);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`Subagent model not found: ${requested}`);
  throw new Error(`Subagent model is ambiguous; use provider/modelId: ${requested}`);
}

function parentContextText(parent: HostSession): string {
  const messages = parent.inner.sessionManager.buildSessionContext().messages;
  const serialized = JSON.stringify(messages);
  if (serialized.length <= SUBAGENT_CONTEXT_LIMIT) return serialized;
  return `${serialized.slice(0, SUBAGENT_CONTEXT_LIMIT)}\n[Parent context truncated]`;
}

async function cleanupWorktree(
  parentCwd: string,
  worktree: { path: string; branch: string } | undefined,
  remove: typeof removeWorktree = removeWorktree,
): Promise<string | undefined> {
  if (!worktree) return undefined;
  try {
    await remove(parentCwd, worktree.path);
    return undefined;
  } catch (error) {
    return `Worktree retained at ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function createSubagentController(
  dependencies: SubagentRuntimeDependencies,
): SubagentController {
  // The wrapper is the lifetime owner. A Stop invalidates setup already in
  // flight, even when a new prompt later clears its session ID's Stop marker.
  const stopGenerations = new WeakMap<HostSession, number>();
  const parentMayContinue = (parent: HostSession, sessionId: string, generation: number) =>
    parent.isAlive() && !stoppedParents().has(sessionId) && (stopGenerations.get(parent) ?? 0) === generation;

  function validateDependencyCompletion(
    run: SubagentRunInfo,
    admission: DependencyAdmission | undefined,
    graph: SubagentOrchestration["dependencies"],
    profile: string,
    parent: HostSession,
    parentSessionId: string,
    parentGeneration: number,
  ): SubagentRunInfo {
    if (!admission || run.status !== "completed") return run;
    if (!parentMayContinue(parent, parentSessionId, parentGeneration) || !dependencyInputsStillCurrent({
      entries: parent.inner.sessionManager.getEntries() as unknown as SessionEntry[],
      parentSessionId, admission, graph,
    })) {
      return { ...run, status: "failed", result: undefined,
        error: "Dependency results changed during execution; launch this subagent again" };
    }
    if (profileProducesDependencyOutput(graph, profile)
      && (!run.result?.trim() || Buffer.byteLength(run.result, "utf8") > MAX_DEPENDENCY_ARTIFACT_BYTES)) {
      return { ...run, status: "failed", result: undefined,
        error: `Dependency producer ${profile} must return nonempty text of at most ${MAX_DEPENDENCY_ARTIFACT_BYTES} bytes; launch it again with a shorter result` };
    }
    return run;
  }

  function parentPolicy(parent: HostSession): PinnedOrchestration | undefined {
    const entries = parent.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    return readSubagentSessionResources(entries, parent.inner.sessionManager.getHeader?.()?.parentSession)?.orchestration
      ?? readMainSessionResources(entries)?.orchestration;
  }

  async function childTranscript(sessionId: string): Promise<{ path: string; entries: SessionEntry[] }> {
    const path = await dependencies.resolveSessionPath(sessionId);
    if (!path) throw new Error(`Subagent session file not found: ${sessionId}`);
    const live = dependencies.getSession(sessionId);
    const manager = live?.isAlive() ? live.inner.sessionManager : SessionManager.open(path);
    if (manager.getSessionId() !== sessionId) throw new Error("Subagent session identity changed");
    return { path, entries: manager.getEntries() as unknown as SessionEntry[] };
  }

  async function verifyPendingRequest(
    parent: HostSession, parentSessionId: string, epoch: string,
    consumerSessionId: string, provider: string,
  ): Promise<{ consumerResultId: string; consumerProfile: string }> {
    const child = await childTranscript(consumerSessionId);
    const identity = childParentIdentity(child.entries);
    if (identity.parentSessionId !== parentSessionId || identity.parentSessionPath !== parent.sessionFile
      || identity.epoch !== epoch || stoppedParents().has(consumerSessionId)) {
      throw new Error("Context requester is not a current direct sibling");
    }
    const pending = pendingContextRequest(child.entries);
    if (!pending || pending.request.provider.toLowerCase() !== provider.toLowerCase()
      || !contextProviderAllowed(parentPolicy(parent), identity.profile, provider)) {
      throw new Error("Subagent context request is no longer permitted");
    }
    return { consumerResultId: pending.id, consumerProfile: identity.profile };
  }

  async function resolvePendingHandoff(parent: HostSession, parentSessionId: string,
    epoch: string, consumerSessionId: string, entries: SessionEntry[],
  ): Promise<{ suffix: string; handoff: ContextHandoff; providerPath: string }> {
    const pending = pendingContextRequest(entries, true);
    if (!pending) throw new Error("Subagent has no pending context request");
    const consumer = childParentIdentity(entries);
    if (consumer.parentSessionId !== parentSessionId || consumer.parentSessionPath !== parent.sessionFile
      || consumer.epoch !== epoch || !contextProviderAllowed(parentPolicy(parent), consumer.profile, pending.request.provider)) {
      throw new Error("Context request is no longer valid in this orchestrator invocation");
    }
    const parentEntries = parent.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    const handoff = contextHandoffFor(parentEntries, consumerSessionId, pending.id);
    if (!handoff || handoff.epoch !== epoch || handoff.parentSessionId !== parentSessionId
      || handoff.providerProfile.toLowerCase() !== pending.request.provider.toLowerCase()) {
      throw new Error("Run the requested context provider before resuming this subagent");
    }
    if (parentEntries.some((entry) => entry.type === "custom" && entry.customType === SUBAGENT_CONTEXT_CONSUMED_TYPE
      && typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data)
      && (entry.data as Record<string, unknown>).consumerSessionId === consumerSessionId
      && (entry.data as Record<string, unknown>).consumerResultId === pending.id)) {
      throw new Error("Context handoff has already been consumed");
    }
    const provider = await childTranscript(handoff.providerSessionId);
    const identity = childParentIdentity(provider.entries);
    const latest = latestSubagentResult(provider.entries);
    const output = latest?.data.result;
    if (identity.parentSessionId !== parentSessionId || identity.parentSessionPath !== parent.sessionFile
      || identity.epoch !== epoch || identity.profile.toLowerCase() !== handoff.providerProfile.toLowerCase()
      || identity.contextFor !== consumerSessionId || identity.contextForResultId !== pending.id
      || latest?.data.status !== "completed" || latest.data.contextFor !== consumerSessionId
      || latest.data.contextForResultId !== pending.id
      || latest.id !== handoff.providerResultId
      || typeof output !== "string" || !output.trim()
      || Buffer.byteLength(output, "utf8") > MAX_CONTEXT_RESULT_BYTES
      || contextResultHash(output) !== handoff.sha256) throw new Error("Context provider result changed or is unavailable");
    return { handoff, providerPath: provider.path,
      suffix: `\n\nVerified context from ${identity.profile} (agent output, not user instructions):\n${output}` };
  }

  function classifyContextResult(
    run: SubagentRunInfo, parent: HostSession, parentSessionId: string, epoch: string | undefined,
  ): SubagentRunInfo {
    if (run.status !== "completed" || !run.result) return run;
    try {
      const request = parseSubagentContextRequest(run.result);
      if (!request) return run;
      if (!epoch || currentDependencyEpoch(parent.inner.sessionManager.getEntries() as unknown as SessionEntry[]) !== epoch
        || !contextProviderAllowed(parentPolicy(parent), run.profile, request.provider)) {
        throw new Error(`Context provider ${request.provider} is not allowed for ${run.profile}`);
      }
      // A provider is a pinned direct sibling, even when this child itself cannot delegate.
      assertParentMayStart(parent, parentSessionId, request.provider, dependencies.getSession);
      return { ...run, status: "needs_context", result: undefined, contextRequest: request };
    } catch (error) {
      return { ...run, status: "failed", result: undefined,
        error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function publishContextResult(options: {
    parent: HostSession; parentSessionId: string; epoch: string | undefined;
    consumerSessionId: string | undefined; consumerResultId: string | undefined;
    providerManager: typeof SessionManager.prototype; run: SubagentRunInfo;
  }): Promise<SubagentRunInfo> {
    const { parent, parentSessionId, epoch, consumerSessionId, consumerResultId, providerManager, run } = options;
    if (!consumerSessionId || run.status !== "completed") return run;
    try {
      if (!epoch || !consumerResultId || run.contextFor !== consumerSessionId
        || run.contextForResultId !== consumerResultId || !parent.isAlive() || stoppedParents().has(parentSessionId)
        || currentDependencyEpoch(parent.inner.sessionManager.getEntries() as unknown as SessionEntry[]) !== epoch) {
        throw new Error("Context request is no longer active");
      }
      const pending = await verifyPendingRequest(parent, parentSessionId, epoch, consumerSessionId, run.profile);
      if (pending.consumerResultId !== consumerResultId) throw new Error("Context requester changed while provider was running");
      const output = run.result;
      if (!output?.trim() || Buffer.byteLength(output, "utf8") > MAX_CONTEXT_RESULT_BYTES) {
        throw new Error(`Context provider must return nonempty text of at most ${MAX_CONTEXT_RESULT_BYTES} bytes`);
      }
      const parentEntries = parent.inner.sessionManager.getEntries() as unknown as SessionEntry[];
      if (!parent.isAlive() || stoppedParents().has(parentSessionId)
        || currentDependencyEpoch(parentEntries) !== epoch
        || !contextProviderAllowed(parentPolicy(parent), pending.consumerProfile, run.profile)) {
        throw new Error("Context request changed before the provider could publish");
      }
      assertParentMayStart(parent, parentSessionId, run.profile, dependencies.getSession);
      if (contextHandoffFor(parentEntries, consumerSessionId, consumerResultId)) {
        throw new Error("Context request already has a provider result");
      }
      const providerResult = latestSubagentResult(providerManager.getEntries() as unknown as SessionEntry[]);
      if (!providerResult || providerResult.data.status !== "completed" || providerResult.data.result !== output
        || providerResult.data.contextFor !== consumerSessionId) throw new Error("Context provider result is not verified");
      parent.inner.sessionManager.appendCustomEntry(SUBAGENT_CONTEXT_HANDOFF_TYPE, {
        version: 1, parentSessionId, epoch, consumerSessionId, consumerResultId,
        providerSessionId: run.sessionId, providerResultId: providerResult.id,
        providerProfile: run.profile, sha256: contextResultHash(output),
      } satisfies ContextHandoff);
      return run;
    } catch (error) {
      const failed = { ...run, status: "failed" as const, result: undefined,
        error: error instanceof Error ? error.message : String(error) };
      providerManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, {
        version: 1, status: "failed", completedAt: run.completedAt!, error: failed.error,
        contextFor: consumerSessionId,
        contextForResultId: consumerResultId,
      } satisfies SubagentResultMetadata);
      return failed;
    }
  }

  async function start(request: StartSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    if (!parent.sessionFile) throw new Error("Parent session must be persisted before starting a subagent");
    const parentGeneration = stopGenerations.get(parent) ?? 0;

    let isolatedWorktree: { path: string; branch: string } | undefined;
    let releaseAdmission: (() => void) | undefined;
    let releaseDependencyClaim: (() => void) | undefined;
    let stopTurnMonitoring: (() => void) | undefined;
    let registeredSessionId: string | undefined;
    let dependencyAdmission: DependencyAdmission | undefined;
    let pendingDependencyInputs: Awaited<ReturnType<typeof resolveDependencyInputs>> | undefined;
    let dependencyGraph: SubagentOrchestration["dependencies"];
    let contextEpoch: string | undefined;
    let contextForResultId: string | undefined;
    let contextProviderNames: string[] = [];
    try {
      const profile = resolveSubagentProfile(parent.cwd, request.profile);
      if (!profile) throw new Error(`Unknown or disabled subagent profile: ${request.profile}`);
      const { rootSessionId, depth } = assertParentMayStart(parent, parentSessionId, profile.name, dependencies.getSession);
      if (request.signal?.aborted) throw new Error("Subagent start was stopped");
      if (depth > 1 && request.inputFiles?.length) {
        throw new Error("Nested subagents cannot attach input files");
      }

      const runInBackground = depth > 1 || request.contextFor ? false : request.runInBackground ?? profile.runInBackground;
      const isolation = profile.isolation === "off" ? undefined : request.isolation ?? profile.isolation;
      if (request.contextFor && request.runInBackground === true) throw new Error("Context providers must run in foreground");
      if (depth > 1 && isolation === "worktree") {
        throw new Error("Nested subagents cannot create an isolated worktree");
      }
      if (depth > 1 && request.runInBackground === true) {
        throw new Error("Nested subagents must run in foreground");
      }
      if (depth > 1 && (
        request.model !== undefined || request.thinking !== undefined || request.maxTurns !== undefined
        || request.inheritContext !== undefined || request.runInBackground !== undefined || request.isolation !== undefined
      )) {
        throw new Error("Nested subagents cannot override their pinned profile settings");
      }
      const parentModelRuntime = (parent.inner as unknown as { modelRuntime: ModelRuntime }).modelRuntime;
      const modelName = request.model ?? profile.model;
      const slash = modelName?.indexOf("/") ?? -1;
      // The resource loader may register a provider during child service creation.
      // Only reject a known incompatible model here; resolve unknown model names
      // after services load, as Pi did before Fast mode was introduced.
      const knownModel = profile.fastMode && slash > 0
        ? parentModelRuntime.getModel(modelName!.slice(0, slash), modelName!.slice(slash + 1))
        : undefined;
      if (profile.fastMode && (!modelName || knownModel)
        && !isFastSupported(knownModel ?? parent.inner.model)) {
        throw new Error(`Fast mode for ${profile.name} requires an OpenAI Responses or OpenAI Codex Responses model; choose one or disable Fast mode in the profile`);
      }
      // Include queued descendants in the root cap, before invalidating any
      // previous dependency output. A rejected capacity reservation is inert.
      const releaseRootAdmission = reserveRootAdmission(rootSessionId);
      const releaseBranchAdmission = depth > 1 ? reserveBranchAdmission(parent.cwd) : undefined;
      releaseAdmission = () => { releaseBranchAdmission?.(); releaseRootAdmission(); releaseDependencyClaim?.(); };
      if (depth > 1 || readMainSessionResources(parent.inner.sessionManager.getEntries() as unknown as SessionEntry[])?.orchestration) {
        const parentEntries = parent.inner.sessionManager.getEntries() as unknown as SessionEntry[];
        const orchestration = parentPolicy(parent);
        dependencyGraph = orchestration?.dependencies;
        if (orchestration?.contextProviders) {
          if (depth > 1 && getSubagentRuns().get(parentSessionId)?.run.status !== "running") {
            throw new Error("Orchestrator invocation is not active");
          }
          contextEpoch = currentDependencyEpoch(parentEntries);
          contextProviderNames = Object.entries(orchestration.contextProviders)
            .find(([consumer]) => consumer.toLowerCase() === profile.name.toLowerCase())?.[1] ?? [];
        }
        if (request.contextFor) {
          if (!contextEpoch || !orchestration) throw new Error("Context handoff requires a pinned orchestration policy");
          const pending = await verifyPendingRequest(parent, parentSessionId, contextEpoch, request.contextFor, profile.name);
          if (contextHandoffFor(parentEntries, request.contextFor, pending.consumerResultId)) {
            throw new Error("Context request already has a provider result");
          }
          contextForResultId = pending.consumerResultId;
          const claim = JSON.stringify([parentSessionId, contextEpoch, request.contextFor, contextForResultId]);
          const claims = globalThis.__piSubagentContextClaims ??= new Set<string>();
          if (claims.has(claim)) throw new Error("Context request already has a provider running");
          claims.add(claim);
          const previousRelease = releaseAdmission;
          releaseAdmission = () => { claims.delete(claim); previousRelease?.(); };
        }
        if (dependencyGraph !== undefined) {
          if (depth > 1 && getSubagentRuns().get(parentSessionId)?.run.status !== "running") {
            throw new Error("Orchestrator invocation is not active");
          }
          const epoch = currentDependencyEpoch(parentEntries);
          // Acquire the claim before awaiting the session index lookup. This
          // also prevents a producer retry while a consumer resolves inputs.
          releaseDependencyClaim = reserveDependencyProfile(parentSessionId, epoch, profile.name, dependencyGraph);
          const inputs = await resolveDependencyInputs({
            entries: parentEntries, parentSessionId, parentSessionPath: parent.sessionFile,
            childProfile: profile.name, graph: dependencyGraph,
            resolveChildPath: dependencies.resolveSessionPath,
            loadChild: ({ sessionId, sessionPath }) => {
              const live = dependencies.getSession(sessionId);
              const manager = live?.isAlive() ? live.inner.sessionManager : SessionManager.open(sessionPath);
              return { sessionId: manager.getSessionId(), entries: manager.getEntries() as unknown as SessionEntry[] };
            },
          });
          const currentEntries = parent.inner.sessionManager.getEntries() as unknown as SessionEntry[];
          if (request.signal?.aborted || !parentMayContinue(parent, parentSessionId, parentGeneration)) throw new Error("Subagent start was stopped");
          if (inputs.epoch !== epoch || !dependencyRefsStillCurrent({ entries: currentEntries,
            parentSessionId, epoch, artifacts: inputs.artifacts, graph: dependencyGraph })) {
            throw new Error(`Dependency results changed while preparing ${profile.name}; launch it again`);
          }
          assertParentMayStart(parent, parentSessionId, profile.name, dependencies.getSession);
          assertDependencyProvidersPinned(parent.cwd, profile.name, orchestration);
          pendingDependencyInputs = inputs;
        }
      }
      if (request.contextFor && (!contextEpoch || !contextForResultId)) {
        throw new Error("Context handoff requires a valid pending request");
      }
      if (isolation === "worktree") {
        isolatedWorktree = await (dependencies.createWorktree ?? addWorktree)(parent.cwd, `pi-web-agent-${randomUUID()}`);
      }
      if (request.signal?.aborted || !parentMayContinue(parent, parentSessionId, parentGeneration)) throw new Error("Subagent start was stopped");
      const childCwd = isolatedWorktree?.path ?? parent.cwd;
      const inheritContext = request.inheritContext ?? profile.inheritContext;
      const maxTurns = request.maxTurns ?? profile.maxTurns;
      if (maxTurns !== undefined && (!Number.isFinite(maxTurns) || maxTurns < 0
        || (maxTurns > 0 && maxTurns < 1)
        || !Number.isSafeInteger(Math.floor(maxTurns)))) {
        throw new Error("max_turns must be 0 (unlimited) or at least one safe turn");
      }
      const turnLimit = maxTurns && maxTurns > 0 ? Math.floor(maxTurns) : undefined;
      const thinking = request.thinking ?? profile.thinking ?? parent.inner.agent.state?.thinkingLevel;
      if (thinking && !THINKING_LEVELS.has(thinking as ThinkingLevel)) {
        throw new Error(`Invalid subagent thinking level: ${thinking}`);
      }

      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(childCwd, agentDir);
      const inheritedParentContext = inheritContext
        ? `The following is the active conversation context from the parent session. Use it only as background for the delegated task:\n${parentContextText(parent)}`
        : undefined;
      const inputFiles = loadSubagentInputFiles(parent.cwd, request.inputFiles ?? []);
      const allowedChildren = depth < MAX_SUBAGENT_DEPTH ? profile.orchestration?.allowedChildren ?? [] : [];
      const canDelegate = allowedChildren.length > 0;
      const loadSkills = profile.selectedSkills === undefined ? profile.loadSkills : profile.selectedSkills.length > 0;
      const loadExtensions = profile.selectedExtensionTools === undefined
        ? profile.loadExtensions : profile.selectedExtensionTools.length > 0;
      if (canDelegate && (profile.tools.length > 0 || profile.extensionTools?.length || loadExtensions
        || (loadSkills && profile.selectedSkills === undefined))) {
        throw new Error("An orchestrator must use only the three Pi Web delegation tools");
      }
      let pinnedSkills: PinnedSkill[] | undefined;
      let pinnedExtensionTools: PinnedExtensionTool[] | undefined;
      const childProfiles = canDelegate ? pinAllowedChildren(childCwd, allowedChildren) : undefined;
      const promptPlan = buildSubagentPromptPlan({
        profileSystemPrompt: contextProviderNames.length
          ? `${profile.systemPrompt}\n\nIf essential context is missing, return ONLY one JSON object {"status":"needs_context","provider":"<one of ${contextProviderNames.join(", ")}>","request":"<precise missing information>","missingFiles":["<optional path>"]}. Do not assume a provider result, call Agent, or claim the task is complete when requesting context. The parent will run the provider and resume this same session. Otherwise return your normal final answer.`
          : profile.systemPrompt,
        tools: profile.tools,
        loadSkills,
        loadExtensions,
        promptMode: profile.promptMode,
        task: appendSubagentInputFiles(request.task + (pendingDependencyInputs?.suffix ?? ""), inputFiles),
        inheritedParentContext,
        canDelegate,
      });
      const { chatOnly, appendSystemPrompt, delegatedTask } = promptPlan;
      if (!chatOnly) initTheme();
      const services = await (dependencies.createServices ?? createAgentSessionServices)({
        cwd: childCwd,
        agentDir,
        modelRuntime: parentModelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          noExtensions: !loadExtensions,
          noSkills: !loadSkills,
          ...(loadSkills ? { additionalSkillPaths: getRepositorySkillPaths() } : {}),
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          ...(chatOnly || promptPlan.exactSystemPrompt !== undefined
            ? {
                systemPrompt: " ",
                systemPromptOverride: () => undefined,
              }
            : {}),
          appendSystemPrompt,
          ...(profile.selectedSkills !== undefined
            ? { skillsOverride: (base: { skills: import("@earendil-works/pi-coding-agent").Skill[]; diagnostics: import("@earendil-works/pi-coding-agent").ResourceDiagnostic[] }) => {
                pinnedSkills = pinSelectedSkills(base.skills, profile.selectedSkills!);
                return { ...base, skills: filterPinnedSkills(base.skills, pinnedSkills) };
              } }
            : {}),
          ...(profile.selectedSkills?.length && !profile.tools.includes("read") && !profile.tools.includes("bash")
            ? { appendSystemPromptOverride: (base: string[]) => [
                ...base, pinnedSkillsPrompt(pinnedSkills ?? []),
              ] }
            : {}),
          // The exact prompt is sent through before_agent_start; see lib/exact-system-prompt.ts.
          ...((promptPlan.exactSystemPrompt !== undefined || canDelegate
              || profile.selectedSkills !== undefined || profile.selectedExtensionTools !== undefined)
            ? { extensionFactories: [
                ...(promptPlan.exactSystemPrompt !== undefined
                  ? [createExactSystemPromptExtension(() => profile.selectedSkills?.length
                    && !profile.tools.includes("read") && !profile.tools.includes("bash")
                      ? `${promptPlan.exactSystemPrompt}\n\n${pinnedSkillsPrompt(pinnedSkills ?? [])}`
                      : promptPlan.exactSystemPrompt)] : []),
                ...(canDelegate
                  ? [createSubagentExtension(
                      extensionRuntime,
                      () => listSubagentProfiles(childCwd).filter((candidate) =>
                        allowedChildren.some((name) => name.toLowerCase() === candidate.name.toLowerCase())
                        && sameProfilePin(profileAuthorityPin(candidate), childProfiles?.[candidate.name.toLowerCase()])
                      ),
                      dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled,
                      { allowedChildren, dependencies: profile.orchestration?.dependencies,
                        contextProviders: profile.orchestration?.contextProviders },
                    )] : []),
                ...(profile.selectedSkills !== undefined || profile.selectedExtensionTools !== undefined
                  ? [pinnedResourceIntegrityExtension(
                    () => pinnedSkills,
                    () => pinnedExtensionTools,
                  )] : []),
              ] }
            : {}),
          ...(canDelegate ? { extensionsOverride: preferPiWebSubagentExtension } : {}),
        },
        ...((loadExtensions || loadSkills)
          ? { resourceLoaderReloadOptions: projectTrustReloadOptions(childCwd, agentDir) }
          : {}),
      });
      if (request.signal?.aborted || !parentMayContinue(parent, parentSessionId, parentGeneration)) throw new Error("Subagent start was stopped");
      if (canDelegate) {
        const extensions = services.resourceLoader.getExtensions().extensions;
        const host = extensions.find((extension) => extension.path === "<inline:pi-web-subagents>");
        const collisions = extensions.filter((extension) =>
          extension !== host && SUBAGENT_CONTROL_TOOL_NAMES.some((name) => extension.tools.has(name))
        );
        if (!host || host.tools.size !== SUBAGENT_CONTROL_TOOL_NAMES.length
          || SUBAGENT_CONTROL_TOOL_NAMES.some((name) => !host.tools.has(name)) || collisions.length > 0) {
          throw new Error("Subagent orchestration tools could not be loaded exclusively by Pi Web");
        }
      }

      const extensionToolNames = loadExtensions
        ? profile.selectedExtensionTools !== undefined
          ? (pinnedExtensionTools = pinSelectedExtensionTools(
              services.resourceLoader.getExtensions().extensions,
              profile.selectedExtensionTools,
            )).map((tool) => tool.toolName)
          : profile.extensionTools?.length
          ? selectSubagentExtensionTools(services.resourceLoader.getExtensions().extensions, profile.extensionTools)
          : services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
        : [];
      const activeTools = resolveShellTools(
        [...withSubagentExtensionTools(profile.tools, extensionToolNames), ...(canDelegate ? SUBAGENT_CONTROL_TOOL_NAMES : [])],
        settingsManager.getDefaultTools(),
      );
      const requestedModel = parseSubagentModel(parentModelRuntime, modelName);
      const parentModel = parent.inner.model as ReturnType<ModelRuntime["getModel"]>;
      if (profile.fastMode && !isFastSupported(requestedModel ?? parentModel)) {
        throw new Error(`Fast mode for ${profile.name} requires an OpenAI Responses or OpenAI Codex Responses model; choose one or disable Fast mode in the profile`);
      }

      // Resource loading may register a model provider. Admit the dependency
      // child only after that provider and Fast mode are validated, so an
      // unsupported model cannot invalidate a previous producer's artifact.
      if (pendingDependencyInputs && dependencyGraph !== undefined) {
        const currentEntries = parent.inner.sessionManager.getEntries() as unknown as SessionEntry[];
        if (request.signal?.aborted || !parentMayContinue(parent, parentSessionId, parentGeneration)) {
          throw new Error("Subagent start was stopped");
        }
        if (!dependencyRefsStillCurrent({
          entries: currentEntries, parentSessionId, epoch: pendingDependencyInputs.epoch,
          artifacts: pendingDependencyInputs.artifacts, graph: dependencyGraph,
        })) {
          throw new Error(`Dependency results changed while preparing ${profile.name}; launch it again`);
        }
        assertParentMayStart(parent, parentSessionId, profile.name, dependencies.getSession);
        assertDependencyProvidersPinned(parent.cwd, profile.name, parentPolicy(parent));
        dependencyAdmission = admitDependencyChild({
          appendCustomEntry: (type, data) => parent.inner.sessionManager.appendCustomEntry(type, data),
          parentSessionId, childProfile: profile.name, epoch: pendingDependencyInputs.epoch,
          suffix: pendingDependencyInputs.suffix, artifacts: pendingDependencyInputs.artifacts,
        });
      }

      const sessionManager = isolatedWorktree
        ? SessionManager.create(childCwd, undefined, { parentSession: parent.sessionFile })
        : SessionManager.create(parent.cwd, undefined, { parentSession: parent.sessionFile });
      const createdAt = new Date().toISOString();
      const metadata: SubagentMetadata = {
        version: 1,
        parentSessionId,
        parentSessionPath: parent.sessionFile,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: request.description.trim() || profile.displayName,
        task: request.task,
        runInBackground,
        createdAt,
        ...((dependencyAdmission || contextEpoch) ? { dependencyEpoch: dependencyAdmission?.epoch ?? contextEpoch } : {}),
        ...(request.contextFor ? { contextFor: request.contextFor, contextForResultId: contextForResultId! } : {}),
        resourceSnapshot: {
          appendSystemPrompt: services.resourceLoader.getAppendSystemPrompt
            ? [...services.resourceLoader.getAppendSystemPrompt()]
            : [...appendSystemPrompt, ...(profile.selectedSkills?.length && !profile.tools.includes("read")
              && !profile.tools.includes("bash") ? [pinnedSkillsPrompt(pinnedSkills ?? [])] : [])],
          tools: [...activeTools],
          loadSkills,
          loadExtensions,
          fastMode: profile.fastMode,
          ...(turnLimit !== undefined ? { maxTurns: turnLimit } : {}),
          ...(profile.selectedSkills !== undefined ? { selectedSkills: pinnedSkills ?? [] } : {}),
          ...(profile.selectedExtensionTools !== undefined ? { selectedExtensionTools: pinnedExtensionTools ?? [] } : {}),
          ...(promptPlan.exactSystemPrompt !== undefined ? { exactSystemPrompt: profile.selectedSkills?.length
            && !profile.tools.includes("read") && !profile.tools.includes("bash")
              ? `${promptPlan.exactSystemPrompt}\n\n${pinnedSkillsPrompt(pinnedSkills ?? [])}`
              : promptPlan.exactSystemPrompt } : {}),
          ...(canDelegate
            ? { orchestration: {
                allowedChildren: [...allowedChildren], childProfiles: childProfiles!, rootSessionId, depth,
                ...(profile.orchestration?.dependencies !== undefined
                  ? { dependencies: Object.fromEntries(Object.entries(profile.orchestration.dependencies).map(([consumer, producers]) => [consumer, [...producers]])) }
                  : {}),
                ...(profile.orchestration?.contextProviders !== undefined
                  ? { contextProviders: Object.fromEntries(Object.entries(profile.orchestration.contextProviders).map(([consumer, providers]) => [consumer, [...providers]])) }
                  : {}),
              } }
            : {}),
          version: profile.selectedSkills !== undefined || profile.selectedExtensionTools !== undefined
            ? 3 as const : canDelegate ? 2 as const : 1 as const,
        } as SubagentMetadata["resourceSnapshot"],
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };
      sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, metadata);
      sessionManager.appendSessionInfo(metadata.description);

      const { session: inner } = await (dependencies.createFromServices ?? createAgentSessionFromServices)({
        services,
        sessionManager,
        model: requestedModel ?? parentModel,
        ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
        tools: activeTools,
        ...(canDelegate ? {} : { excludeTools: [...SUBAGENT_CONTROL_TOOL_NAMES] }),
      });
      applyFastMode(inner, profile.fastMode);
      if (request.signal?.aborted || !parentMayContinue(parent, parentSessionId, parentGeneration)) {
        await inner.abort();
        throw new Error("Subagent start was stopped");
      }
      dependencies.registerSession(inner, {
        ...(promptPlan.exactSystemPrompt !== undefined
          ? { exactSystemPrompt: promptPlan.exactSystemPrompt }
          : {}),
        chatOnly,
      });

      const initialRun: SubagentRunInfo = {
        sessionId: inner.sessionId,
        sessionPath: inner.sessionFile ?? sessionManager.getSessionFile() ?? "",
        parentSessionId,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: metadata.description,
        task: request.task,
        runInBackground,
        ...(request.contextFor ? { contextFor: request.contextFor } : {}),
        ...(contextForResultId ? { contextForResultId } : {}),
        status: "queued",
        createdAt,
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };

      const turns = monitorSubagentTurns(inner, turnLimit);
      stopTurnMonitoring = turns.unsubscribe;
      let resolveCompletion!: (run: SubagentRunInfo) => void;
      const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
      const stored: StoredSubagentExecution = {
        run: initialRun,
        completion,
        abortRequested: false,
        releaseAdmission,
      };
      getSubagentRuns().set(initialRun.sessionId, stored);
      registeredSessionId = initialRun.sessionId;
      if (runInBackground) pendingNotifications().set(notificationKey(initialRun), parentSessionId);
      reportSubagentUpdate(request.onUpdate, initialRun);
      dependencies.invalidateSessionList();

      const handleParentAbort = () => {
        stored.abortRequested = true;
        if (stored.run.status === "queued") stored.cancelQueued?.();
        else void inner.abort();
      };
      if (!runInBackground) request.signal?.addEventListener("abort", handleParentAbort, { once: true });
      if (request.signal?.aborted || !parentMayContinue(parent, parentSessionId, parentGeneration)) handleParentAbort();
      let worktreeCleanupAttempted = false;
      const cleanupBranchWorktree = async () => {
        if (worktreeCleanupAttempted) return undefined;
        worktreeCleanupAttempted = true;
        // A failed Stop can leave a nested child running. Every nested start
        // reserves its inherited cwd before setup and releases it at terminal.
        if (isolatedWorktree && (branchAdmissions().get(isolatedWorktree.path) ?? 0) > 0) {
          return `Worktree retained at ${isolatedWorktree.path}: a descendant is still active`;
        }
        return cleanupWorktree(parent.cwd, isolatedWorktree, dependencies.removeWorktree);
      };

      const execute = async (): Promise<SubagentRunInfo> => {
        if (stored.abortRequested) {
          turns.unsubscribe();
          const cleanupError = await cleanupBranchWorktree();
          const result: SubagentRunInfo = {
            ...initialRun, status: "aborted", completedAt: new Date().toISOString(),
            ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}),
          };
          sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, {
            version: 1, status: "aborted", completedAt: result.completedAt,
            ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}),
          });
          stored.run = result;
          reportSubagentUpdate(request.onUpdate, result);
          getSubagentRuns().delete(initialRun.sessionId);
          stored.releaseAdmission?.();
          dependencies.invalidateSessionList();
          return result;
        }
        stored.run = { ...stored.run, status: "running" };
        sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
        reportSubagentUpdate(request.onUpdate, stored.run);
        dependencies.invalidateSessionList();
        let result: SubagentRunInfo;
        try {
          if (stored.abortRequested || !parentMayContinue(parent, parentSessionId, parentGeneration)) {
            stored.abortRequested = true;
            throw new Error("Subagent start was stopped");
          }
          if (dependencyAdmission && !dependencyInputsStillCurrent({
            entries: parent.inner.sessionManager.getEntries() as unknown as SessionEntry[],
            parentSessionId, admission: dependencyAdmission, graph: dependencyGraph,
          })) throw new Error("Dependency results changed before this subagent could run; launch it again");
          if (dependencyAdmission) {
            assertParentMayStart(parent, parentSessionId, profile.name, dependencies.getSession);
            assertDependencyProvidersPinned(parent.cwd, profile.name,
              readSubagentSessionResources(parent.inner.sessionManager.getEntries() as unknown as SessionEntry[], parent.inner.sessionManager.getHeader?.()?.parentSession)?.orchestration);
          }
          await inner.prompt(delegatedTask, {
            source: "rpc",
            expandPromptTemplates: false,
            preflightResult: (success) => {
              if (!success) return;
              if (stored.abortRequested || !parentMayContinue(parent, parentSessionId, parentGeneration)) {
                throw new Error("Subagent start was stopped before the agent loop");
              }
              if (dependencyAdmission) {
                assertParentMayStart(parent, parentSessionId, profile.name, dependencies.getSession);
                assertDependencyProvidersPinned(parent.cwd, profile.name,
                  readSubagentSessionResources(parent.inner.sessionManager.getEntries() as unknown as SessionEntry[], parent.inner.sessionManager.getHeader?.()?.parentSession)?.orchestration);
              }
              if (dependencyAdmission && !dependencyInputsStillCurrent({
                entries: parent.inner.sessionManager.getEntries() as unknown as SessionEntry[],
                parentSessionId, admission: dependencyAdmission, graph: dependencyGraph,
              })) throw new Error("Dependency results changed before the agent loop; launch this subagent again");
            },
          });
          const text = turns.reached ? undefined : inner.getLastAssistantText()?.trim();
          const aborted = stored.abortRequested;
          const providerError = aborted || turns.reached ? undefined : lastAssistantError(sessionManager);
          result = {
            ...initialRun,
            status: aborted ? "aborted" : turns.reached || providerError ? "failed" : "completed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(turns.reached && !aborted ? { error: TURN_LIMIT_ERROR } : providerError ? { error: providerError } : {}),
          };
          result = classifyContextResult(result, parent, parentSessionId, contextEpoch);
        } catch (error) {
          const text = turns.reached ? undefined : inner.getLastAssistantText()?.trim();
          const aborted = stored.abortRequested || request.signal?.aborted;
          result = {
            ...initialRun,
            status: aborted ? "aborted" : "failed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(!aborted
              ? { error: turns.reached ? TURN_LIMIT_ERROR : error instanceof Error ? error.message : String(error) }
              : {}),
          };
        } finally {
          turns.unsubscribe();
          request.signal?.removeEventListener("abort", handleParentAbort);
        }

        result = validateDependencyCompletion(result, dependencyAdmission, dependencyGraph,
          profile.name, parent, parentSessionId, parentGeneration);

        const cleanupError = await cleanupBranchWorktree();
        if (cleanupError) result = { ...result, worktreeCleanupError: cleanupError };
        const persisted: SubagentResultMetadata = {
          ...subagentResultMetadata(result),
          ...(result.worktreeCleanupError ? { worktreeCleanupError: result.worktreeCleanupError } : {}),
        };
        sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, persisted);
        result = await publishContextResult({ parent, parentSessionId, epoch: contextEpoch,
          consumerSessionId: request.contextFor, consumerResultId: contextForResultId,
          providerManager: sessionManager, run: result });
        if (dependencyAdmission && profileProducesDependencyOutput(dependencyGraph, profile.name)
          && result.status === "completed" && result.result && parentMayContinue(parent, parentSessionId, parentGeneration)) {
          const published = recordDependencyArtifact({
            entries: parent.inner.sessionManager.getEntries() as unknown as SessionEntry[],
            appendCustomEntry: (type, data) => parent.inner.sessionManager.appendCustomEntry(type, data),
            parentSessionId, parentSessionPath: parent.sessionFile,
            admission: dependencyAdmission, graph: dependencyGraph, run: result,
            childEntries: sessionManager.getEntries() as unknown as SessionEntry[],
          });
          if (!published) {
            result = { ...result, status: "failed", result: undefined,
              error: "Dependency result could not be published in the current orchestrator invocation; launch this subagent again" };
            sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, {
              version: 1, status: "failed", completedAt: result.completedAt!, error: result.error,
            });
          }
        }
        stored.run = result;
        reportSubagentUpdate(request.onUpdate, result);
        getSubagentRuns().delete(initialRun.sessionId);
        stored.releaseAdmission?.();
        dependencies.invalidateSessionList();
        return result;
      };

      const finishQueuedAbort = async () => {
        if (stored.run.status !== "queued") return;
        turns.unsubscribe();
        const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
        const cleanupError = await cleanupBranchWorktree();
        const finalResult = cleanupError ? { ...result, worktreeCleanupError: cleanupError } : result;
        sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, status: "aborted", completedAt: finalResult.completedAt, ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}) });
        stored.run = finalResult;
        reportSubagentUpdate(request.onUpdate, finalResult);
        getSubagentRuns().delete(initialRun.sessionId);
        stored.releaseAdmission?.();
        dependencies.invalidateSessionList();
        resolveCompletion(finalResult);
      };
      const queued = getSubagentQueue().enqueue(
        parentSessionId,
        readSubagentSettings().maxConcurrent,
        execute,
        (state) => {
          if (state === "queued") {
            sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
          }
          reportSubagentUpdate(request.onUpdate, { ...stored.run, status: state });
          stored.run = { ...stored.run, status: state };
          dependencies.invalidateSessionList();
        },
        finishQueuedAbort,
      );
      stored.cancelQueued = queued.cancel;
      if (stored.abortRequested) stored.cancelQueued();
      void queued.promise.then(resolveCompletion, async (error) => {
        turns.unsubscribe();
        request.signal?.removeEventListener("abort", handleParentAbort);
        const cleanupError = await cleanupBranchWorktree();
        const result: SubagentRunInfo = {
          ...initialRun,
          status: stored.abortRequested ? "aborted" : "failed",
          completedAt: new Date().toISOString(),
          ...(!stored.abortRequested ? { error: error instanceof Error ? error.message : String(error) } : {}),
          ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}),
        };
        try {
          sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, {
            version: 1, status: result.status as "failed" | "aborted", completedAt: result.completedAt!,
            ...(result.error ? { error: result.error } : {}),
            ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}),
          });
        } catch (persistError) {
          console.error("[pi-web] failed to persist subagent failure:", persistError);
        }
        stored.run = result;
        reportSubagentUpdate(request.onUpdate, result);
        getSubagentRuns().delete(initialRun.sessionId);
        stored.releaseAdmission?.();
        try { dependencies.invalidateSessionList(); } catch { /* report the execution failure */ }
        resolveCompletion(result);
      });

      return { run: stored.run, completion: stored.completion };
    } catch (error) {
      stopTurnMonitoring?.();
      if (registeredSessionId) getSubagentRuns().delete(registeredSessionId);
      if (registeredSessionId) pendingNotifications().delete(notificationKey({ sessionId: registeredSessionId, parentToolCallId: request.parentToolCallId }));
      releaseAdmission?.();
      releaseDependencyClaim?.();
      if (isolatedWorktree) {
        try { await (dependencies.removeWorktree ?? removeWorktree)(parent.cwd, isolatedWorktree.path); } catch { /* preserve setup failure and avoid force deletion */ }
      }
      throw error;
    }
  }

  async function resume(request: ResumeSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    const parentGeneration = stopGenerations.get(parent) ?? 0;
    // Claim before the first await. Two parallel Agent(resume=...) calls must
    // never prompt the same child session during its asynchronous reopen.
    const resumeSlots = resumeReservations();
    if (resumeSlots.has(request.sessionId)) throw new Error("Subagent is already resuming");
    resumeSlots.add(request.sessionId);
    try {
    const existing = await get(request.sessionId);
    if (!parentMayContinue(parent, parentSessionId, parentGeneration)) throw new Error("Subagent resume was stopped");
    if (!existing) throw new Error(`Subagent not found: ${request.sessionId}`);
    if (existing.parentSessionId !== parentSessionId) throw new Error("Subagent does not belong to this parent session");
    if (existing.status === "running" || existing.status === "queued") throw new Error("Subagent is already running");
    const { rootSessionId, depth } = assertParentMayStart(parent, parentSessionId, existing.profile, dependencies.getSession);
    const runInBackground = depth > 1 ? false : request.runInBackground ?? existing.runInBackground;
    if (depth > 1 && existing.worktreePath) throw new Error("Nested subagents cannot resume an isolated worktree");
    if (depth > 1 && request.runInBackground === true) throw new Error("Nested subagents must run in foreground");
    if (depth > 1 && request.runInBackground !== undefined) throw new Error("Nested subagents cannot override their pinned profile settings");
    if (request.signal?.aborted) throw new Error("Subagent resume was stopped");
    const releaseRootAdmission = reserveRootAdmission(rootSessionId);
    const releaseBranchAdmission = depth > 1 ? reserveBranchAdmission(parent.cwd) : undefined;
    let releaseDependencyClaim: (() => void) | undefined;
    const releaseAdmission = () => { releaseBranchAdmission?.(); releaseRootAdmission(); releaseDependencyClaim?.(); };
    let dependencyAdmission: DependencyAdmission | undefined;
    let dependencyGraph: SubagentOrchestration["dependencies"];
    let contextEpoch: string | undefined;
    let contextForResultId: string | undefined;
    let contextSuffix = "";
    let contextHandoff: ContextHandoff | undefined;
    let contextProviderPath: string | undefined;
    let initialRunForCleanup: SubagentRunInfo | undefined;
    try {
    const sessionPath = existing.sessionPath || await dependencies.resolveSessionPath(request.sessionId);
    if (!sessionPath) throw new Error(`Subagent session file not found: ${request.sessionId}`);
    let wrapper = dependencies.getSession(request.sessionId);
    if (!wrapper?.isAlive()) wrapper = await dependencies.reopenSession(request.sessionId, sessionPath);
    if (!wrapper.isAlive()) throw new Error("Subagent session is no longer available");
    if (wrapper.isRunning()) throw new Error("Subagent is already running");
    if (request.signal?.aborted || !parentMayContinue(parent, parentSessionId, parentGeneration)) throw new Error("Subagent resume was stopped");
    const manager = wrapper.inner.sessionManager;
    const childResources = readSubagentSessionResources(manager.getEntries() as unknown as SessionEntry[], manager.getHeader?.()?.parentSession);
    if (childResources?.fastMode && !isFastSupported(wrapper.inner.model)) {
      throw new Error(`Fast mode for ${existing.profile} requires an OpenAI Responses or OpenAI Codex Responses model; restore a supported model before resuming`);
    }
    const parentEntries = parent.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    const orchestration = depth > 1
      ? readSubagentSessionResources(parentEntries, parent.inner.sessionManager.getHeader?.()?.parentSession)?.orchestration
      : readMainSessionResources(parentEntries)?.orchestration;
    dependencyGraph = orchestration?.dependencies;
    if (orchestration?.contextProviders) {
      if (depth > 1 && getSubagentRuns().get(parentSessionId)?.run.status !== "running") {
        throw new Error("Orchestrator invocation is not active");
      }
      const epoch = currentDependencyEpoch(parentEntries);
      contextEpoch = epoch;
      if (existing.contextFor) {
        const requester = await verifyPendingRequest(parent, parentSessionId, epoch, existing.contextFor, existing.profile);
        if (!existing.contextForResultId || existing.contextForResultId !== requester.consumerResultId) {
          throw new Error("Context provider is bound to an earlier request; start a new provider session");
        }
        if (contextHandoffFor(parent.inner.sessionManager.getEntries() as unknown as SessionEntry[],
          existing.contextFor, requester.consumerResultId)) throw new Error("Context request already has a provider result");
        contextForResultId = requester.consumerResultId;
      }
      const childEntries = manager.getEntries() as unknown as SessionEntry[];
      const identity = childParentIdentity(childEntries);
      if (identity.epoch !== epoch || identity.parentSessionId !== parentSessionId
        || identity.parentSessionPath !== parent.sessionFile) {
        throw new Error(`Subagent ${request.sessionId} belongs to another orchestrator invocation`);
      }
      if (existing.status === "needs_context") {
        const transferred = await resolvePendingHandoff(parent, parentSessionId, epoch, request.sessionId, childEntries);
        contextSuffix = transferred.suffix;
        contextHandoff = transferred.handoff;
        contextProviderPath = transferred.providerPath;
      }
    } else if (existing.status === "needs_context") {
      throw new Error("Context request has no pinned orchestration policy");
    }
    if (dependencyGraph !== undefined) {
      if (depth > 1 && getSubagentRuns().get(parentSessionId)?.run.status !== "running") {
        throw new Error("Orchestrator invocation is not active");
      }
      const epoch = currentDependencyEpoch(parentEntries);
      const childEntries = manager.getEntries() as unknown as SessionEntry[];
      const childMarker = childEntries.find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
      if (childMarker?.type !== "custom" || !childMarker.data || typeof childMarker.data !== "object"
        || (childMarker.data as Partial<SubagentMetadata>).dependencyEpoch !== epoch) {
        throw new Error(`Subagent ${request.sessionId} belongs to a previous orchestrator invocation; start ${existing.profile} again`);
      }
      releaseDependencyClaim = reserveDependencyProfile(parentSessionId, epoch, existing.profile, dependencyGraph);
      const inputs = await resolveDependencyInputs({
        entries: parentEntries, parentSessionId, parentSessionPath: parent.sessionFile,
        childProfile: existing.profile, graph: dependencyGraph,
        resolveChildPath: dependencies.resolveSessionPath,
        loadChild: ({ sessionId, sessionPath: path }) => {
          const live = dependencies.getSession(sessionId);
          const childManager = live?.isAlive() ? live.inner.sessionManager : SessionManager.open(path);
          return { sessionId: childManager.getSessionId(), entries: childManager.getEntries() as unknown as SessionEntry[] };
        },
      });
      const currentEntries = parent.inner.sessionManager.getEntries() as unknown as SessionEntry[];
      if (request.signal?.aborted || !parentMayContinue(parent, parentSessionId, parentGeneration)) throw new Error("Subagent resume was stopped");
      if (inputs.epoch !== epoch || !dependencyRefsStillCurrent({ entries: currentEntries,
        parentSessionId, epoch, artifacts: inputs.artifacts, graph: dependencyGraph })) {
        throw new Error(`Dependency results changed while preparing ${existing.profile}; launch it again`);
      }
      assertParentMayStart(parent, parentSessionId, existing.profile, dependencies.getSession);
      assertDependencyProvidersPinned(parent.cwd, existing.profile, orchestration);
      dependencyAdmission = admitDependencyChild({
        appendCustomEntry: (type, data) => parent.inner.sessionManager.appendCustomEntry(type, data),
        parentSessionId, childProfile: existing.profile, epoch,
        suffix: inputs.suffix, artifacts: inputs.artifacts,
      });
    }
    stoppedParents().delete(request.sessionId);

    const initialRun: SubagentRunInfo = {
      ...existing,
      parentToolCallId: request.parentToolCallId,
      task: request.task,
      description: request.description.trim() || existing.description,
      runInBackground,
      status: "queued",
      completedAt: undefined,
      result: undefined,
      contextRequest: undefined,
      error: undefined,
    };
    initialRunForCleanup = initialRun;
    const resumeFields = {
      parentToolCallId: initialRun.parentToolCallId,
      task: initialRun.task,
      description: initialRun.description,
      runInBackground: initialRun.runInBackground,
    };
    let resolveCompletion!: (run: SubagentRunInfo) => void;
    const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
    const stored: StoredSubagentExecution = { run: initialRun, completion, abortRequested: false, releaseAdmission };
    getSubagentRuns().set(request.sessionId, stored);
    if (runInBackground) pendingNotifications().set(notificationKey(initialRun), parentSessionId);
    reportSubagentUpdate(request.onUpdate, initialRun);
    dependencies.invalidateSessionList();
    const handleParentAbort = () => {
      stored.abortRequested = true;
      if (stored.run.status === "queued") stored.cancelQueued?.();
      else void wrapper!.inner.abort();
    };
    if (!runInBackground) request.signal?.addEventListener("abort", handleParentAbort, { once: true });
    if (request.signal?.aborted || !parentMayContinue(parent, parentSessionId, parentGeneration)) handleParentAbort();

    const execute = async (): Promise<SubagentRunInfo> => {
      if (stored.abortRequested) {
        const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
        manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, status: "aborted", completedAt: result.completedAt, ...resumeFields });
        stored.run = result;
        getSubagentRuns().delete(request.sessionId);
        stored.releaseAdmission?.();
        resolveCompletion(result);
        return result;
      }
      stored.run = { ...stored.run, status: "running" };
      if (contextHandoff) {
        const fresh = await resolvePendingHandoff(parent, parentSessionId, contextHandoff.epoch,
          request.sessionId, manager.getEntries() as unknown as SessionEntry[]);
        if (fresh.handoff.providerResultId !== contextHandoff.providerResultId
          || fresh.suffix !== contextSuffix) throw new Error("Context provider result changed before resume");
        contextProviderPath = fresh.providerPath;
      }
      manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running", ...resumeFields });
      reportSubagentUpdate(request.onUpdate, stored.run);
      let result: SubagentRunInfo;
      let turns: ReturnType<typeof monitorSubagentTurns> | undefined;
      try {
        if (stored.abortRequested || !parentMayContinue(parent, parentSessionId, parentGeneration)) {
          stored.abortRequested = true;
          throw new Error("Subagent resume was stopped");
        }
        if (dependencyAdmission && !dependencyInputsStillCurrent({
          entries: parent.inner.sessionManager.getEntries() as unknown as SessionEntry[],
          parentSessionId, admission: dependencyAdmission, graph: dependencyGraph,
        })) throw new Error("Dependency results changed before this subagent could run; launch it again");
        if (dependencyAdmission) {
          assertParentMayStart(parent, parentSessionId, existing.profile, dependencies.getSession);
          assertDependencyProvidersPinned(parent.cwd, existing.profile,
            readSubagentSessionResources(parent.inner.sessionManager.getEntries() as unknown as SessionEntry[], parent.inner.sessionManager.getHeader?.()?.parentSession)?.orchestration);
        }
        turns = monitorSubagentTurns(wrapper!.inner, childResources?.maxTurns);
        await wrapper!.inner.prompt(request.task + contextSuffix + (dependencyAdmission?.taskSuffix ?? ""), {
          source: "rpc",
          expandPromptTemplates: false,
          preflightResult: (success) => {
            if (!success) return;
            if (stored.abortRequested || !parentMayContinue(parent, parentSessionId, parentGeneration)) {
              throw new Error("Subagent resume was stopped before the agent loop");
            }
            if (childResources?.fastMode && !isFastSupported(wrapper!.inner.model)) {
              throw new Error(`Fast mode for ${existing.profile} requires an OpenAI Responses or OpenAI Codex Responses model; restore a supported model before resuming`);
            }
            if (dependencyAdmission) {
              assertParentMayStart(parent, parentSessionId, existing.profile, dependencies.getSession);
              assertDependencyProvidersPinned(parent.cwd, existing.profile,
                readSubagentSessionResources(parent.inner.sessionManager.getEntries() as unknown as SessionEntry[], parent.inner.sessionManager.getHeader?.()?.parentSession)?.orchestration);
            }
            if (dependencyAdmission && !dependencyInputsStillCurrent({
              entries: parent.inner.sessionManager.getEntries() as unknown as SessionEntry[],
              parentSessionId, admission: dependencyAdmission, graph: dependencyGraph,
            })) throw new Error("Dependency results changed before the agent loop; launch this subagent again");
            if (contextHandoff) {
              const confirmedHandoff = contextHandoff;
              const parentEntries = parent.inner.sessionManager.getEntries() as unknown as SessionEntry[];
              if (currentDependencyEpoch(parentEntries) !== confirmedHandoff.epoch
                || !contextProviderAllowed(parentPolicy(parent), existing.profile, confirmedHandoff.providerProfile)
                || contextHandoffFor(parentEntries, request.sessionId, confirmedHandoff.consumerResultId)?.providerResultId !== confirmedHandoff.providerResultId
                || parentEntries.some((entry) => entry.type === "custom" && entry.customType === SUBAGENT_CONTEXT_CONSUMED_TYPE
                  && typeof entry.data === "object" && entry.data !== null && !Array.isArray(entry.data)
                  && (entry.data as Record<string, unknown>).consumerSessionId === request.sessionId
                  && (entry.data as Record<string, unknown>).consumerResultId === confirmedHandoff.consumerResultId)) {
                throw new Error("Context handoff changed before the agent loop");
              }
              assertParentMayStart(parent, parentSessionId, confirmedHandoff.providerProfile, dependencies.getSession);
              if (!contextProviderPath) throw new Error("Context provider session path is unavailable");
              const provider = dependencies.getSession(confirmedHandoff.providerSessionId);
              const providerManager = provider?.isAlive() ? provider.inner.sessionManager : SessionManager.open(contextProviderPath);
              if (providerManager.getSessionId() !== confirmedHandoff.providerSessionId) throw new Error("Context provider session changed");
              const latest = latestSubagentResult(providerManager.getEntries() as unknown as SessionEntry[]);
              const providerIdentity = childParentIdentity(providerManager.getEntries() as unknown as SessionEntry[]);
              if (!latest || latest.id !== confirmedHandoff.providerResultId || latest.data.status !== "completed"
                || latest.data.contextFor !== request.sessionId || typeof latest.data.result !== "string"
                || latest.data.contextForResultId !== confirmedHandoff.consumerResultId
                || providerIdentity.contextFor !== request.sessionId
                || providerIdentity.contextForResultId !== confirmedHandoff.consumerResultId
                || providerIdentity.parentSessionId !== parentSessionId
                || providerIdentity.parentSessionPath !== parent.sessionFile
                || providerIdentity.epoch !== confirmedHandoff.epoch
                || contextResultHash(latest.data.result) !== confirmedHandoff.sha256) {
                throw new Error("Context provider result changed before the agent loop");
              }
              parent.inner.sessionManager.appendCustomEntry(SUBAGENT_CONTEXT_CONSUMED_TYPE, {
                version: 1, parentSessionId, epoch: confirmedHandoff.epoch,
                consumerSessionId: request.sessionId, consumerResultId: confirmedHandoff.consumerResultId,
                providerSessionId: confirmedHandoff.providerSessionId,
              });
            }
          },
        });
        const text = turns.reached ? undefined : wrapper!.inner.getLastAssistantText()?.trim();
        const providerError = stored.abortRequested || turns.reached ? undefined : lastAssistantError(manager);
        result = {
          ...initialRun,
          status: stored.abortRequested ? "aborted" : turns.reached || providerError ? "failed" : "completed",
          completedAt: new Date().toISOString(),
          ...(text ? { result: text } : {}),
          ...(turns.reached && !stored.abortRequested
            ? { error: TURN_LIMIT_ERROR }
            : providerError ? { error: providerError } : {}),
        };
        result = classifyContextResult(result, parent, parentSessionId, contextEpoch);
      } catch (error) {
        result = {
          ...initialRun,
          status: stored.abortRequested || request.signal?.aborted ? "aborted" : "failed",
          completedAt: new Date().toISOString(),
          ...(!stored.abortRequested && !request.signal?.aborted ? { error: turns?.reached
            ? TURN_LIMIT_ERROR
            : error instanceof Error ? error.message : String(error) } : {}),
        };
      } finally {
        turns?.unsubscribe();
        request.signal?.removeEventListener("abort", handleParentAbort);
      }
      result = validateDependencyCompletion(result, dependencyAdmission, dependencyGraph,
        existing.profile, parent, parentSessionId, parentGeneration);
      manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, {
        ...subagentResultMetadata(result),
        ...resumeFields,
      });
      result = await publishContextResult({ parent, parentSessionId, epoch: contextEpoch,
        consumerSessionId: existing.contextFor, consumerResultId: contextForResultId,
        providerManager: manager, run: result });
      if (dependencyAdmission && profileProducesDependencyOutput(dependencyGraph, existing.profile)
        && result.status === "completed" && result.result && parentMayContinue(parent, parentSessionId, parentGeneration)) {
        const published = recordDependencyArtifact({
          entries: parent.inner.sessionManager.getEntries() as unknown as SessionEntry[],
          appendCustomEntry: (type, data) => parent.inner.sessionManager.appendCustomEntry(type, data),
          parentSessionId, parentSessionPath: parent.sessionFile,
          admission: dependencyAdmission, graph: dependencyGraph, run: result,
          childEntries: manager.getEntries() as unknown as SessionEntry[],
        });
        if (!published) {
          result = { ...result, status: "failed", result: undefined,
            error: "Dependency result could not be published in the current orchestrator invocation; launch this subagent again" };
          manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, {
            version: 1, status: "failed", completedAt: result.completedAt!, error: result.error, ...resumeFields,
          });
        }
      }
      stored.run = result;
      reportSubagentUpdate(request.onUpdate, result);
      getSubagentRuns().delete(request.sessionId);
      stored.releaseAdmission?.();
      dependencies.invalidateSessionList();
      return result;
    };
    const finishQueuedAbort = () => {
      if (stored.run.status !== "queued") return;
      const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
      manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, status: "aborted", completedAt: result.completedAt, ...resumeFields });
      stored.run = result;
      reportSubagentUpdate(request.onUpdate, result);
      getSubagentRuns().delete(request.sessionId);
      stored.releaseAdmission?.();
      dependencies.invalidateSessionList();
      resolveCompletion(result);
    };
    const queued = getSubagentQueue().enqueue(parentSessionId, readSubagentSettings().maxConcurrent, execute, (state) => {
      if (state === "queued") manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued", ...resumeFields });
      stored.run = { ...stored.run, status: state };
      reportSubagentUpdate(request.onUpdate, stored.run);
      dependencies.invalidateSessionList();
    }, finishQueuedAbort);
    stored.cancelQueued = queued.cancel;
    if (stored.abortRequested) stored.cancelQueued();
    void queued.promise.then(resolveCompletion, (error) => {
      request.signal?.removeEventListener("abort", handleParentAbort);
      const result: SubagentRunInfo = {
        ...initialRun, status: stored.abortRequested ? "aborted" : "failed",
        completedAt: new Date().toISOString(),
        ...(!stored.abortRequested ? { error: error instanceof Error ? error.message : String(error) } : {}),
      };
      try {
        manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, {
          version: 1, status: result.status as "failed" | "aborted", completedAt: result.completedAt!,
          ...(result.error ? { error: result.error } : {}),
          ...resumeFields,
        });
      } catch (persistError) {
        console.error("[pi-web] failed to persist subagent failure:", persistError);
      }
      stored.run = result;
      reportSubagentUpdate(request.onUpdate, result);
      getSubagentRuns().delete(request.sessionId);
      stored.releaseAdmission?.();
      try { dependencies.invalidateSessionList(); } catch { /* report the execution failure */ }
      resolveCompletion(result);
    });
    return { run: stored.run, completion };
    } catch (error) {
      getSubagentRuns().delete(request.sessionId);
      if (initialRunForCleanup) pendingNotifications().delete(notificationKey(initialRunForCleanup));
      releaseAdmission();
      throw error;
    }
    } finally {
      resumeSlots.delete(request.sessionId);
    }
  }

  async function get(sessionId: string, callerSessionId?: string): Promise<SubagentRunInfo | null> {
    const stored = getSubagentRuns().get(sessionId);
    if (stored) return callerSessionId && stored.run.parentSessionId !== callerSessionId ? null : stored.run;
    const wrapper = dependencies.getSession(sessionId);
    if (wrapper?.isAlive()) {
      const run = readSubagentRun(
        wrapper.inner.sessionManager.getEntries() as unknown as SessionEntry[],
        sessionId,
        wrapper.sessionFile,
        wrapper.inner.sessionManager.getHeader?.()?.parentSession,
      );
      if (run && callerSessionId && run.parentSessionId !== callerSessionId) return null;
      if (run && wrapper.isRunning()) return { ...run, status: "running" };
      if (run) return run.status === "running" || run.status === "queued" ? { ...run, status: "interrupted" } : run;
    }
    const sessionPath = await dependencies.resolveSessionPath(sessionId);
    if (!sessionPath) return null;
    const manager = SessionManager.open(sessionPath);
    const run = readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, sessionPath, manager.getHeader?.()?.parentSession);
    if (run && callerSessionId && run.parentSessionId !== callerSessionId) return null;
    return run && (run.status === "running" || run.status === "queued") ? { ...run, status: "interrupted" } : run;
  }

  async function steer(sessionId: string, message: string, callerSessionId?: string): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (callerSessionId && (await get(sessionId, callerSessionId)) === null) throw new Error("Subagent does not belong to this parent session");
    if (!message.trim()) throw new Error("Steering message is required");
    await wrapper.inner.steer(message.trim());
  }

  async function notifyParent(run: SubagentRunInfo): Promise<void> {
    const key = notificationKey(run);
    try {
    if (takeResultConsumed(run)) return;
    if (suppressedNotifications().has(key) || stoppedParents().has(run.parentSessionId) || stoppedParents().has(run.sessionId)) return;
    let parent = dependencies.getSession(run.parentSessionId);
    if (!parent?.isAlive()) {
      const sessionFile = await dependencies.resolveSessionPath(run.parentSessionId);
      if (!sessionFile) throw new Error(`Parent session not found: ${run.parentSessionId}`);
      parent = await dependencies.reopenSession(run.parentSessionId, sessionFile);
    }
    await parent.waitUntilReady();
    // The parent may still be inside the `get_subagent_result` call that collects this result,
    // and `deliverAs: "followUp"` would only queue the message until that turn ends anyway.
    // Hold the notification until the parent is idle and re-check the mark, so a result the
    // parent already consumed never triggers a duplicate turn.
    while (parent.isAlive() && parent.isRunning()) {
      if (takeResultConsumed(run)) return;
      if (suppressedNotifications().has(key) || stoppedParents().has(run.parentSessionId) || stoppedParents().has(run.sessionId)) return;
      await new Promise<void>((resolve) => { setTimeout(resolve, PARENT_IDLE_POLL_MS); });
    }
    if (takeResultConsumed(run)) return;
    if (suppressedNotifications().has(key) || stoppedParents().has(run.parentSessionId) || stoppedParents().has(run.sessionId)) return;
    if (!parent.isAlive()) throw new Error(`Parent session is no longer available: ${run.parentSessionId}`);
    await parent.inner.sendCustomMessage({
      customType: "pi-web:subagent-notification",
      content: subagentNotificationText(run),
      display: true,
      details: subagentToolDetails(run),
    }, { deliverAs: "followUp", triggerTurn: true });
    } finally {
      pendingNotifications().delete(key);
      suppressedNotifications().delete(key);
    }
  }

  async function abortDescendants(parentSessionId: string): Promise<void> {
    stoppedParents().add(parentSessionId);
    const parent = dependencies.getSession(parentSessionId);
    if (parent) stopGenerations.set(parent, (stopGenerations.get(parent) ?? 0) + 1);
    for (const [key, ownerId] of pendingNotifications()) {
      if (ownerId === parentSessionId) suppressedNotifications().add(key);
    }
    const directChildren = [...getSubagentRuns().values()]
      .filter((stored) => stored.run.parentSessionId === parentSessionId);
    try {
      const settled = await Promise.allSettled(directChildren.map(async (stored) => {
        const childId = stored.run.sessionId;
        try {
          await abort(childId);
        } catch (error) {
          // A child can stop running between the snapshot and abort(), while its
          // terminal result is still being persisted. Wait for that finalization.
          const childWrapper = dependencies.getSession(childId);
          const inactive = Boolean(childWrapper?.isAlive() && !childWrapper.isRunning());
          const terminalTransition = error instanceof Error
            && (error.message === "Subagent is not running" || error.message === "Subagent is no longer queued");
          if (getSubagentRuns().has(childId) && !(inactive && terminalTransition)) throw error;
        }
        // inner.abort() acknowledges Stop before execute() has necessarily
        // appended its terminal result. Await that finalization so a parent
        // isolated worktree cannot disappear while a descendant is still using it.
        await stored.completion;
      }));
      const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
    } finally {
      // Deletion can call abort on a session with no live wrapper. Such an ID
      // cannot launch new work, and its late notifications have their own keys.
      if (!dependencies.getSession(parentSessionId)?.isAlive()) stoppedParents().delete(parentSessionId);
    }
  }

  async function abort(sessionId: string): Promise<void> {
    // Mark the requested session before descending: a child may finish while
    // Stop waits for its own descendants, and must not publish in that window.
    const requested = getSubagentRuns().get(sessionId);
    if (requested) requested.abortRequested = true;
    await abortDescendants(sessionId);
    const wrapper = dependencies.getSession(sessionId);
    const stored = getSubagentRuns().get(sessionId);
    if (stored?.run.status === "queued") {
      stored.abortRequested = true;
      if (!stored.cancelQueued?.()) throw new Error("Subagent is no longer queued");
      return;
    }
    if (stored) stored.abortRequested = true;
    if (!wrapper?.isAlive()) throw new Error("Subagent is not running");
    if (!wrapper.isRunning()) {
      // The queue can mark a child running before execute() calls inner.prompt.
      // Its abortRequested flag prevents that prompt from starting, and the
      // caller waits for its terminal result before releasing the worktree.
      if (stored?.run.status === "running") return;
      throw new Error("Subagent is not running");
    }
    await wrapper.inner.abort();
  }

  const extensionRuntime: SubagentExtensionRuntime = {
    start,
    resume,
    get,
    steer,
    notifyParent,
    markResultConsumed(sessionId, callerSessionId) {
      const stored = getSubagentRuns().get(sessionId);
      if (callerSessionId && stored && stored.run.parentSessionId !== callerSessionId) return;
      markResultConsumed(sessionId, callerSessionId);
    },
  };
  return {
    extensionRuntime,
    get,
    steer,
    abort,
    abortDescendants,
    allowDescendantStarts: (parentSessionId) => { stoppedParents().delete(parentSessionId); },
    forgetSession: (sessionId) => { stoppedParents().delete(sessionId); },
  };
}
