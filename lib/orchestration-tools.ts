import { getAgentDir, defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { OrchestrationEvidenceStore } from "./orchestration-evidence";
import { resolveProjectContext } from "./project-context";
import { collectChanges, disposeChangeSnapshotArtifacts, type ChangeManifest, type ChangeSnapshot, type ChangedFile } from "./orchestration-changes";
import { runExactCheck, type CheckResult } from "./orchestration-checks";
import { applyBoundedPatch } from "./orchestration-patch";
import { assessTaskAcceptance, type CandidateCheck, type CandidateReview } from "./orchestration-acceptance";
import { readTaskEnvelope } from "./orchestration-task";
import type { SessionEntry } from "./types";

const evidenceDirectory = (taskId: string) => {
  if (!TASK_ID_RE.test(taskId)) throw new Error("Invalid orchestration task ID");
  return join(getAgentDir(), "orchestration", "evidence", taskId);
};
const MAX_HYDRATED_REFS = 4;
const MAX_HYDRATED_BYTES_PER_REF = 4_096;
const ARTIFACT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_RE = ARTIFACT_ID_RE;
const MAX_MANIFEST_PAGE = 16_384;
type ReviewCoverage = Record<string, Array<[number, number]>>;

type TaskArtifact =
  | { type: "baseline"; taskId: string; snapshot: ChangeSnapshot }
  | { type: "candidate"; taskId: string; snapshot: ChangeSnapshot; manifest: ChangeManifest; criteriaVersion: string; mainTurnDigest: string }
  | { type: "check"; taskId: string; checkId: string; required: boolean; result: CheckResult }
  | { type: "review"; taskId: string; review: CandidateReview; reviewerSessionId: string }
  | { type: "acceptance"; taskId: string; candidateRef: string; snapshotId: string; criteriaVersion: string; acceptedAt: string };

function artifactDirectory(taskId: string, privateRoot = join(getAgentDir(), "orchestration", "tasks")): string {
  if (!TASK_ID_RE.test(taskId)) throw new Error("Invalid orchestration task ID");
  const dir = join(privateRoot, taskId);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  return dir;
}

function saveTaskArtifact(artifact: TaskArtifact, privateRoot?: string): string {
  const id = randomUUID();
  writeFileSync(join(artifactDirectory(artifact.taskId, privateRoot), `${id}.json`), JSON.stringify(artifact), { mode: 0o600, flag: "wx", flush: true });
  return id;
}

function readTaskArtifact(taskId: string, id: string, privateRoot?: string): TaskArtifact {
  if (!ARTIFACT_ID_RE.test(id)) throw new Error("Invalid task artifact reference");
  const data = JSON.parse(readFileSync(join(artifactDirectory(taskId, privateRoot), `${id}.json`), "utf8")) as TaskArtifact;
  if (!data || data.taskId !== taskId) throw new Error("Task artifact belongs to a different task");
  return data;
}

function taskArtifacts(taskId: string, privateRoot?: string): TaskArtifact[] {
  return readdirSync(artifactDirectory(taskId, privateRoot))
    .filter((name) => name.endsWith(".json") && ARTIFACT_ID_RE.test(name.slice(0, -5)))
    .map((name) => readTaskArtifact(taskId, name.slice(0, -5), privateRoot));
}

function artifactOf<T extends TaskArtifact["type"]>(taskId: string, id: string, type: T, privateRoot?: string): Extract<TaskArtifact, { type: T }> {
  const artifact = readTaskArtifact(taskId, id, privateRoot);
  if (artifact.type !== type) throw new Error(`Expected ${type} task artifact`);
  return artifact as Extract<TaskArtifact, { type: T }>;
}

function startupBaseline(taskId: string, privateRoot?: string): { ref: string; snapshot: ChangeSnapshot } | null {
  try {
    const marker = JSON.parse(readFileSync(join(artifactDirectory(taskId, privateRoot), "startup-baseline.json"), "utf8")) as {ref: string};
    return { ref: marker.ref, snapshot: artifactOf(taskId, marker.ref, "baseline", privateRoot).snapshot };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Called before an opt-in task owner is allowed to run; its baseline cannot be moved after a write. */
export async function ensureTaskBaseline(options: { taskId: string; cwd: string; artifactRoot?: string }): Promise<{ref: string; snapshotId: string}> {
  const existing = startupBaseline(options.taskId, options.artifactRoot);
  if (existing) {
    if (existing.snapshot.repositoryRoot !== options.cwd) throw new Error("Task baseline belongs to another worktree");
    return { ref: existing.ref, snapshotId: existing.snapshot.id };
  }
  const captured = await collectChanges(options.cwd, undefined, { blobRoot: artifactDirectory(options.taskId, options.artifactRoot) });
  if (captured.snapshot.repositoryRoot !== options.cwd) throw new Error("Task baseline worktree mismatch");
  const ref = saveTaskArtifact({ type: "baseline", taskId: options.taskId, snapshot: captured.snapshot }, options.artifactRoot);
  writeFileSync(join(artifactDirectory(options.taskId, options.artifactRoot), "startup-baseline.json"),
    JSON.stringify({ ref }), { mode: 0o600, flag: "wx", flush: true });
  return { ref, snapshotId: captured.snapshot.id };
}

/** Once a task's sessions are deleted, its private literal evidence is no longer needed. */
export async function disposeOrchestrationTaskArtifacts(taskId: string): Promise<void> {
  if (!TASK_ID_RE.test(taskId)) throw new Error("Invalid orchestration task ID");
  await Promise.all([
    rm(join(getAgentDir(), "orchestration", "tasks", taskId), { recursive: true, force: true }),
    rm(evidenceDirectory(taskId), { recursive: true, force: true }),
  ]);
}

interface MainTurn { id: string; text: string; hasNonTextContent: boolean; complete: boolean; digest: string }

function turnText(content: string | Array<{type: string; text?: string}>): string {
  return typeof content === "string" ? content
    : content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

async function mainUserTurns(options: Pick<OrchestrationToolOptions,
  "mainSessionId" | "mainSessionPath" | "mainEntriesReader">, entries: readonly SessionEntry[]): Promise<MainTurn[]> {
  const envelope = readTaskEnvelope(entries);
  const mainId = options.mainSessionId ?? envelope?.mainSessionId;
  const mainPath = options.mainSessionPath ?? envelope?.mainSessionPath;
  if (!mainId || !mainPath || !envelope?.originalUserMessageId) {
    throw new Error("Main session identity or original user entry is unavailable");
  }
  let mainEntries: readonly SessionEntry[];
  if (options.mainEntriesReader) mainEntries = options.mainEntriesReader();
  else {
    const { getRpcSession } = await import("./rpc-manager");
    const live = getRpcSession(mainId);
    const manager = live?.isAlive() ? live.inner.sessionManager : (await import("./session-reader")).openSessionManager(mainPath);
    if (manager.getSessionId() !== mainId) throw new Error("Main session identity changed");
    mainEntries = manager.getEntries() as SessionEntry[];
  }
  const sourceIndex = mainEntries.findIndex((entry) => entry.type === "message" && entry.id === envelope.originalUserMessageId
    && entry.message.role === "user");
  if (sourceIndex < 0) throw new Error("Original user entry is missing from Main");
  return mainEntries.slice(sourceIndex + 1).flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const content = entry.message.content;
    const text = turnText(content);
    const hasNonTextContent = Array.isArray(content) && content.some((part) => part.type !== "text");
    return [{ id: entry.id, text: text.slice(0, 32_768), hasNonTextContent,
      complete: !hasNonTextContent && text.length <= 32_768,
      digest: createHash("sha256").update(JSON.stringify(content)).digest("hex") }];
  });
}

function mainTurnDigest(turns: readonly MainTurn[]): string {
  return createHash("sha256").update(JSON.stringify(turns.map(({ id, digest }) => [id, digest]))).digest("hex");
}

function steeringSeenPath(taskId: string, sessionId: string, privateRoot?: string): string {
  return join(artifactDirectory(taskId, privateRoot), `steering-${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

function steeringWasRead(options: OrchestrationToolOptions, sessionId: string, turns: readonly MainTurn[]): boolean {
  if (!turns.length) return true;
  if (turns.some((turn) => !turn.complete)) return false;
  try {
    const parsed = JSON.parse(readFileSync(steeringSeenPath(options.taskId, sessionId, options.artifactRoot), "utf8")) as {digest?:string};
    return parsed.digest === mainTurnDigest(turns);
  } catch { return false; }
}

/** Original Main turns, later Main follow-ups and owner steering define the criteria revision. */
function criteriaVersion(entries: readonly SessionEntry[], mainTurns: readonly MainTurn[]): string {
  const envelope = readTaskEnvelope(entries);
  if (!envelope) throw new Error("Task envelope is unavailable; cannot establish acceptance criteria");
  const userTurns = entries.flatMap((entry) => entry.type === "message" && entry.message.role === "user"
    ? [{ id: entry.id, content: entry.message.content }] : []);
  return createHash("sha256").update(JSON.stringify({ original: envelope.originalUserRequest,
    sourceMessage: envelope.originalUserMessageId, revision: envelope.revision, userTurns,
    mainTurns: mainTurns.map(({ id, digest }) => [id, digest]) })).digest("hex");
}

function manifestWithoutPrivatePaths(manifest: ChangeManifest): ChangeManifest {
  const safe = (file: ChangedFile): ChangedFile => {
    return { ...file, contentArtifactPath: undefined };
  };
  return { ...manifest,
    preexisting: manifest.preexisting.map(safe),
    candidateDirty: manifest.candidateDirty.map(safe),
    changed: manifest.changed.map((entry) => ({ ...entry,
      before: entry.before ? safe(entry.before) : null, after: entry.after ? safe(entry.after) : null,
    })),
  };
}

function boundedPage(source: string, offset: number, limit: number): { text: string; offset: number; nextOffset: number | null; totalCharacters: number; truncated: boolean } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) throw new Error("Invalid page offset");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MANIFEST_PAGE) throw new Error("Invalid page limit");
  const next = Math.min(source.length, offset + limit);
  return { text: source.slice(offset, next), offset, nextOffset: next < source.length ? next : null,
    totalCharacters: source.length, truncated: next < source.length };
}

function reviewCoveragePath(taskId: string, candidateRef: string, sessionId: string, privateRoot?: string): string {
  const reviewerId = createHash("sha256").update(sessionId).digest("hex");
  if (!ARTIFACT_ID_RE.test(candidateRef)) throw new Error("Invalid candidate reference");
  return join(artifactDirectory(taskId, privateRoot), `coverage-${candidateRef}-${reviewerId}.json`);
}

function readCoverage(path: string): ReviewCoverage {
  try { return JSON.parse(readFileSync(path, "utf8")) as ReviewCoverage; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function recordCoverage(path: string, key: string, offset: number, length: number): void {
  const coverage = readCoverage(path);
  (coverage[key] ??= []).push([offset, offset + length]);
  writeFileSync(path, JSON.stringify(coverage), { mode: 0o600 });
}

function fullyRead(coverage: ReviewCoverage, key: string, length: number): boolean {
  let end = 0;
  for (const [start, next] of [...(coverage[key] ?? [])].sort((a, b) => a[0] - b[0])) {
    if (start > end) return false;
    end = Math.max(end, next);
    if (end >= length) return true;
  }
  return length === 0;
}

function necessaryLiteralSides(manifest: ChangeManifest): Array<{path: string; side: "before" | "after"; file: ChangedFile}> {
  return manifest.changed.flatMap((change) => (["before", "after"] as const).flatMap((side) => {
    const file = change[side];
    return file?.indexStatus === "?" ? [{ path: change.path, side, file }] : [];
  }));
}

function literalKey(path: string, side: "before" | "after"): string { return `${side}:${path}`; }

function binaryLogPage(filePath: string, offset: number, limit: number) {
  const totalBytes = statSync(filePath).size;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) throw new Error("Invalid check log offset");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MANIFEST_PAGE) throw new Error("Invalid check log limit");
  const fd = openSync(filePath, "r");
  try {
    const bytes = Buffer.allocUnsafe(Math.min(totalBytes - offset, limit));
    const count = readSync(fd, bytes, 0, bytes.length, offset);
    const nextOffset = offset + count < totalBytes ? offset + count : null;
    return { data: bytes.subarray(0, count).toString("base64"), encoding: "base64",
      offset, nextOffset, totalBytes, truncated: nextOffset !== null };
  } finally { closeSync(fd); }
}

function changedFileForSide(manifest: ChangeManifest, filePath: string, side: "before" | "after"): ChangedFile {
  const entry = manifest.changed.find((item) => item.path === filePath || item.previousPath === filePath);
  const file = entry?.[side] ?? (side === "before"
    ? manifest.preexisting.find((item) => item.path === filePath)
    : manifest.candidateDirty.find((item) => item.path === filePath));
  if (!file) throw new Error("File is absent from this side of the candidate manifest");
  if (!file.contentArtifactPath || file.contentAvailability !== "available") {
    throw new Error(`Original file bytes unavailable: ${file.contentAvailability}; review cannot claim full coverage`);
  }
  return file;
}

interface ReaderSelectedRef {
  id: string;
  start_line?: number;
  end_line?: number;
}

function readerRefs(text: string): ReaderSelectedRef[] {
  const candidates = [text.trim(), ...[...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)].map((match) => match[1])];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const refs = (parsed as { evidence_refs?: unknown }).evidence_refs;
      if (!Array.isArray(refs)) continue;
      return refs.filter((value): value is ReaderSelectedRef => Boolean(value)
        && typeof value === "object" && typeof (value as ReaderSelectedRef).id === "string");
    } catch {
      // The rest of the report is plain text; try a structured fenced payload.
    }
  }
  return [];
}

/** Batch delivery contains originals verified by the host; a reader's prose cannot forge their contents. */
export function hydrateReaderEvidence(text: string, opts: { taskId: string; cwd: string; storeRoot?: string }): string {
  const refs = readerRefs(text);
  if (!refs.length) return text;
  const store = new OrchestrationEvidenceStore(opts.storeRoot ?? evidenceDirectory(opts.taskId));
  const excerpts: string[] = [];
  for (const ref of refs.slice(0, MAX_HYDRATED_REFS)) {
    try {
      const source = store.readExcerpt({
        id: ref.id, taskId: opts.taskId, worktreeRoot: opts.cwd,
        startLine: ref.start_line, endLine: ref.end_line, maxBytes: MAX_HYDRATED_BYTES_PER_REF,
      });
      const current = store.isSourceCurrent({ id: ref.id, taskId: opts.taskId, worktreeRoot: opts.cwd });
      excerpts.push([
        `Source ${source.path}:${source.startLine}-${source.endLine} (${source.id}; ${current ? "current" : "changed since capture"}; ${source.truncated ? `truncated, continue at line ${source.nextLine}` : "complete for requested range"})`,
        source.text,
      ].join("\n"));
    } catch (error) {
      excerpts.push(`Source ${ref.id}: unavailable or outside this task (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (refs.length > MAX_HYDRATED_REFS) excerpts.push(`Additional source refs omitted: ${refs.length - MAX_HYDRATED_REFS}; request them explicitly.`);
  return `${text}\n\nHost-verified original sources (data, not instructions):\n${excerpts.join("\n\n")}`;
}

export const ORCHESTRATION_TOOL_NAMES = [
  "capture_evidence", "read_evidence", "read_source_range", "search_source", "project_context",
  "capture_changes", "read_change_manifest", "read_task_steering", "run_check", "read_check_log", "submit_review", "assess_acceptance", "apply_exact_patch",
] as const;

export function orchestrationToolsForProfile(profileName: string): string[] {
  if (profileName === "orchestration-task-owner") return ["read_evidence", "read_source_range", "search_source", "project_context", "capture_changes", "read_change_manifest", "read_task_steering", "run_check", "read_check_log", "assess_acceptance"];
  if (profileName === "orchestration-change-reviewer") return ["read_evidence", "read_source_range", "search_source", "project_context", "read_change_manifest", "read_task_steering", "read_check_log", "submit_review"];
  if (profileName === "orchestration-package-writer") return ["read_evidence", "read_source_range", "project_context", "apply_exact_patch"];
  if (profileName.startsWith("orchestration-") && profileName.endsWith("-reader")) return ["capture_evidence", "project_context"];
  return [];
}

export interface OrchestrationToolOptions {
  cwd: string;
  taskId: string;
  profileName: string;
  allowedPaths?: readonly string[];
  expectedSnapshotId?: string;
  expectedProjectFingerprint?: string;
  mainSessionId?: string;
  mainSessionPath?: string;
  /** Test-only source for a live Main transcript; production reads the session manager. */
  mainEntriesReader?: () => readonly SessionEntry[];
  /** Test-only private store override; production uses the Pi agent directory. */
  artifactRoot?: string;
  evidenceRoot?: string;
}

/** A finished owner is verified only if the host gate accepted its still-current candidate and requirements. */
export async function readLatestAcceptedTaskResult(options: Pick<OrchestrationToolOptions,
  "taskId" | "cwd" | "mainSessionId" | "mainSessionPath" | "mainEntriesReader" | "artifactRoot"> &
  { ownerEntries: readonly SessionEntry[] }): Promise<boolean> {
  const accepted = taskArtifacts(options.taskId, options.artifactRoot)
    .filter((item): item is Extract<TaskArtifact, {type: "acceptance"}> => item.type === "acceptance")
    .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt))[0];
  if (!accepted) return false;
  const candidate = artifactOf(options.taskId, accepted.candidateRef, "candidate", options.artifactRoot);
  if (candidate.snapshot.repositoryRoot !== options.cwd || candidate.snapshot.id !== accepted.snapshotId) return false;
  const turns = await mainUserTurns(options, options.ownerEntries);
  if (criteriaVersion(options.ownerEntries, turns) !== accepted.criteriaVersion
    || candidate.mainTurnDigest !== mainTurnDigest(turns)) return false;
  const current = (await collectChanges(options.cwd)).snapshot;
  try { return current.id === accepted.snapshotId; }
  finally { await disposeChangeSnapshotArtifacts(current); }
}

export function createOrchestrationToolsExtension(options: OrchestrationToolOptions): InlineExtension {
  return {
    name: "pi-web-orchestration-evidence",
    hidden: true,
    factory: (pi) => {
      const enabled = new Set(orchestrationToolsForProfile(options.profileName));
      const privateRoot = options.artifactRoot;
      const store = new OrchestrationEvidenceStore(options.evidenceRoot ?? evidenceDirectory(options.taskId));
      const capture = (path: string) => store.captureFile({ taskId: options.taskId, worktreeRoot: options.cwd, snapshotId: options.taskId, path });
      const output = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: undefined });
      if (enabled.has("capture_evidence")) pi.registerTool(defineTool({
        name: "capture_evidence", label: "Capture original source",
        description: "Save exact bytes of a known source; return a host-issued reference for an evidence_refs final report. Limit claims to inspected scope.",
        parameters: Type.Object({ path: Type.String() }),
        async execute(_id, params) { return output(capture(params.path)); },
      }));
      if (enabled.has("read_evidence")) pi.registerTool(defineTool({
        name: "read_evidence", label: "Read verified evidence",
        description: "Read an exact saved original source for this task, including after context compaction; inspect changed-since-capture status.",
        parameters: Type.Object({ id: Type.String(), start_line: Type.Optional(Type.Number()), end_line: Type.Optional(Type.Number()) }),
        async execute(_id, params) {
          const excerpt = store.readExcerpt({ id: params.id, taskId: options.taskId, worktreeRoot: options.cwd, startLine: params.start_line, endLine: params.end_line });
          const sourceCurrent = store.isSourceCurrent({ id: params.id, taskId: options.taskId, worktreeRoot: options.cwd });
          return output({ ...excerpt, sourceCurrent });
        },
      }));
      if (enabled.has("read_source_range")) pi.registerTool(defineTool({
        name: "read_source_range", label: "Read precise original source",
        description: "Directly inspect a known source range when a reader missed a decisive condition. Captures exact bytes for later rehydration.",
        parameters: Type.Object({ path: Type.String(), start_line: Type.Number(), end_line: Type.Number() }),
        async execute(_id, params) {
          return output(store.readFileRange({ taskId: options.taskId, worktreeRoot: options.cwd, snapshotId: options.taskId,
            path: params.path, startLine: params.start_line, endLine: params.end_line }));
        },
      }));
      if (enabled.has("search_source")) pi.registerTool(defineTool({
        name: "search_source", label: "Search a known source",
        description: "Search exact text in a named source file; for broader exploration delegate to a reader. Result is bounded and reports truncation.",
        parameters: Type.Object({ path: Type.String(), query: Type.String() }),
        async execute(_id, params) {
          return output(store.searchFile({ taskId: options.taskId, worktreeRoot: options.cwd, snapshotId: options.taskId,
            path: params.path, query: params.query }));
        },
      }));
      if (enabled.has("project_context")) pi.registerTool(defineTool({
        name: "project_context", label: "Read applicable project rules",
        description: "Load literal root and nested AGENTS.md for the target paths in this task's worktree; the target scope affects applicable rules.",
        parameters: Type.Object({ target_paths: Type.Array(Type.String()) }),
        async execute(_id, params) {
          return output(resolveProjectContext({ worktreeRoot: options.cwd, targetPaths: params.target_paths }));
        },
      }));
      if (enabled.has("read_task_steering")) pi.registerTool(defineTool({
        name: "read_task_steering", label: "Read real Main user follow-ups",
        description: "Read literal user messages since this task started in Main. A message with attachments or excessive length remains an explicit blocker.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
          const turns = await mainUserTurns(options, ctx.sessionManager.getEntries() as SessionEntry[]);
          const complete = turns.every((turn) => turn.complete);
          if (complete) {
            writeFileSync(steeringSeenPath(options.taskId, ctx.sessionManager.getSessionId(), privateRoot),
              JSON.stringify({ digest: mainTurnDigest(turns) }), { mode: 0o600 });
          }
          return output({ turns, complete,
            ...(complete ? {} : { blocker: "A user attachment or oversized follow-up needs direct handling before acceptance" }) });
        },
      }));
      if (enabled.has("capture_changes")) pi.registerTool(defineTool({
        name: "capture_changes", label: "Capture worktree changes",
        description: "Create a literal Git/index/dirty-file snapshot. Capture baseline before writing, then a candidate with its baseline_ref after writing. Review uses the returned candidate_ref.",
        parameters: Type.Object({ mode: Type.Union([Type.Literal("baseline"), Type.Literal("candidate")]),
          baseline_ref: Type.Optional(Type.String()) }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          if ((params.mode === "baseline") === Boolean(params.baseline_ref)) {
            throw new Error("Supply baseline_ref only when capturing a candidate");
          }
          if (params.mode === "baseline") {
            const baseline = startupBaseline(options.taskId, privateRoot);
            if (!baseline || baseline.snapshot.repositoryRoot !== options.cwd) {
              throw new Error("Task startup baseline is missing or belongs to another worktree");
            }
            return output({ mode: "baseline", ref: baseline.ref, snapshotId: baseline.snapshot.id,
              preexistingPaths: baseline.snapshot.dirty.map((file) => file.path) });
          }
          const baseline = params.baseline_ref ? artifactOf(options.taskId, params.baseline_ref, "baseline", privateRoot) : undefined;
          if (!baseline || baseline.snapshot.id !== startupBaseline(options.taskId, privateRoot)?.snapshot.id) {
            throw new Error("Candidate must use this task's pinned startup baseline");
          }
          const ownerEntries = ctx.sessionManager.getEntries() as SessionEntry[];
          const mainTurns = await mainUserTurns(options, ownerEntries);
          if (!steeringWasRead(options, ctx.sessionManager.getSessionId(), mainTurns)) {
            throw new Error("Owner must read all new Main user messages before capturing a candidate");
          }
          const captured = await collectChanges(options.cwd, baseline?.snapshot,
            { blobRoot: artifactDirectory(options.taskId, privateRoot) });
          const artifact: TaskArtifact = { type: "candidate", taskId: options.taskId, snapshot: captured.snapshot,
            manifest: captured.manifest, criteriaVersion: criteriaVersion(ownerEntries, mainTurns),
            mainTurnDigest: mainTurnDigest(mainTurns) };
          const ref = saveTaskArtifact(artifact, privateRoot);
          return output({ mode: "candidate", ref, snapshotId: captured.snapshot.id,
            criteriaVersion: artifact.criteriaVersion,
              changedPaths: captured.manifest.changed.map((entry) => entry.path),
              preexistingPaths: captured.manifest.preexisting.map((entry) => entry.path),
              unavailableBytes: captured.manifest.changed.filter((entry) => [entry.before, entry.after]
                .some((side) => side?.contentAvailability === "too_large" || side?.contentAvailability === "unsupported"))
                .map((entry) => entry.path),
          });
        },
      }));
      if (enabled.has("read_change_manifest")) pi.registerTool(defineTool({
        name: "read_change_manifest", label: "Inspect exact change manifest",
        description: "Page the complete manifest, including staged/unstaged Git patches and untracked records. Optionally page saved literal bytes of a dirty file; an unavailable side is an explicit review blocker.",
        parameters: Type.Object({ candidate_ref: Type.String(), offset: Type.Optional(Type.Number()),
          limit: Type.Optional(Type.Number()), file_path: Type.Optional(Type.String()),
          side: Type.Optional(Type.Union([Type.Literal("before"), Type.Literal("after")])) }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const candidate = artifactOf(options.taskId, params.candidate_ref, "candidate", privateRoot);
          if (candidate.snapshot.repositoryRoot !== options.cwd) throw new Error("Candidate belongs to another worktree");
          const offset = params.offset ?? 0;
          const limit = params.limit ?? MAX_MANIFEST_PAGE;
          if (params.file_path) {
            const file = changedFileForSide(candidate.manifest, params.file_path, params.side ?? "after");
            const bytes = readFileSync(file.contentArtifactPath!);
            if (bytes.byteLength !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
              throw new Error("Saved manifest file failed integrity check");
            }
            const side = params.side ?? "after";
            const page = boundedPage(file.binary ? bytes.toString("base64")
              : new TextDecoder("utf-8", { fatal: true }).decode(bytes), offset, limit);
            if (options.profileName === "orchestration-change-reviewer") {
              recordCoverage(reviewCoveragePath(options.taskId, params.candidate_ref,
                ctx.sessionManager.getSessionId(), privateRoot), literalKey(params.file_path, side), offset, page.text.length);
            }
            return output({ path: file.path, side, binary: file.binary, ...page,
              encoding: file.binary ? "base64" : "utf8" });
          }
          const manifest = JSON.stringify(manifestWithoutPrivatePaths(candidate.manifest));
          const page = boundedPage(manifest, offset, limit);
          if (options.profileName === "orchestration-change-reviewer") {
            recordCoverage(reviewCoveragePath(options.taskId, params.candidate_ref,
              ctx.sessionManager.getSessionId(), privateRoot), "manifest", offset, page.text.length);
          }
          return output({ candidateRef: params.candidate_ref, snapshotId: candidate.snapshot.id,
            criteriaVersion: candidate.criteriaVersion, ...page, encoding: "json" });
        },
      }));
      if (enabled.has("run_check")) pi.registerTool(defineTool({
        name: "run_check", label: "Run exact project check",
        description: "Run exact argv without a shell; record full output privately and a bounded preview. The check is tied to the observed worktree snapshot, not a claimed pass.",
        parameters: Type.Object({ check_id: Type.String(), argv: Type.Array(Type.String(), { minItems: 1 }),
          required: Type.Boolean(), timeout_ms: Type.Optional(Type.Number()), not_run_reason: Type.Optional(Type.String()) }),
        async execute(_id, params) {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(params.check_id)) throw new Error("Invalid check ID");
          const before = (await collectChanges(options.cwd)).snapshot;
          const result = await runExactCheck({ cwd: options.cwd, argv: params.argv, snapshotId: before.id,
            logRoot: artifactDirectory(options.taskId, privateRoot),
            ...(params.timeout_ms !== undefined ? { timeoutMs: params.timeout_ms } : {}),
            ...(params.not_run_reason ? { notRunReason: params.not_run_reason } : {}) });
          await disposeChangeSnapshotArtifacts(before);
          const ref = saveTaskArtifact({ type: "check", taskId: options.taskId, checkId: params.check_id,
            required: params.required, result }, privateRoot);
          return output({ checkRef: ref, checkId: params.check_id, required: params.required,
            status: result.status, snapshotId: result.snapshotId, exitCode: result.exitCode,
            reason: result.reason, stdoutPreview: result.stdoutPreview, stderrPreview: result.stderrPreview,
            stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated });
        },
      }));
      if (enabled.has("read_check_log")) pi.registerTool(defineTool({
        name: "read_check_log", label: "Page full check output",
        description: "Inspect a previously run check's complete private output in bounded pages; the initial preview can be truncated.",
        parameters: Type.Object({ check_ref: Type.String(), stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]),
          offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
        async execute(_id, params) {
          const check = artifactOf(options.taskId, params.check_ref, "check", privateRoot);
          if (check.result.cwd !== options.cwd) throw new Error("Check belongs to another worktree");
          const logPath = params.stream === "stdout" ? check.result.stdoutPath : check.result.stderrPath;
          if (!logPath) throw new Error("Check output was not captured");
          return output({ checkId: check.checkId, stream: params.stream,
            ...binaryLogPage(logPath, params.offset ?? 0, params.limit ?? MAX_MANIFEST_PAGE) });
        },
      }));
      if (enabled.has("submit_review")) pi.registerTool(defineTool({
        name: "submit_review", label: "Submit independent review",
        description: "Reviewer-only attestation for the exact unchanged candidate and criteria. Declare all checks needed before acceptance, even if none.",
        parameters: Type.Object({ candidate_ref: Type.String(), snapshot_id: Type.String(), criteria_version: Type.String(),
          verdict: Type.Union([Type.Literal("approved"), Type.Literal("changes_requested"), Type.Literal("needs_context")]),
          blocking_findings: Type.Array(Type.String()), required_check_ids: Type.Array(Type.String()) }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const candidate = artifactOf(options.taskId, params.candidate_ref, "candidate", privateRoot);
          if (candidate.snapshot.repositoryRoot !== options.cwd || candidate.snapshot.id !== params.snapshot_id
            || candidate.criteriaVersion !== params.criteria_version) throw new Error("Review is for another candidate or criteria revision");
          const mainTurns = await mainUserTurns(options, ctx.sessionManager.getEntries() as SessionEntry[]);
          if (candidate.mainTurnDigest !== mainTurnDigest(mainTurns)) throw new Error("Main user requirements changed after candidate capture");
          if (!steeringWasRead(options, ctx.sessionManager.getSessionId(), mainTurns)) {
            throw new Error("Reviewer must read all Main user follow-ups before submitting review");
          }
          const current = (await collectChanges(options.cwd)).snapshot;
          try {
            if (current.id !== candidate.snapshot.id) throw new Error("Candidate changed while under review");
          } finally { await disposeChangeSnapshotArtifacts(current); }
          if (params.verdict === "approved") {
            const coverage = readCoverage(reviewCoveragePath(options.taskId, params.candidate_ref,
              ctx.sessionManager.getSessionId(), privateRoot));
            const manifestText = JSON.stringify(manifestWithoutPrivatePaths(candidate.manifest));
            if (!fullyRead(coverage, "manifest", manifestText.length)) {
              throw new Error("Reviewer must read every page of the change manifest before approving");
            }
            for (const { path, side, file } of necessaryLiteralSides(candidate.manifest)) {
              if (!file.contentArtifactPath || file.contentAvailability !== "available") {
                throw new Error(`Review needs unavailable literal bytes for ${path} (${side})`);
              }
              const bytes = readFileSync(file.contentArtifactPath);
              const length = file.binary ? bytes.toString("base64").length
                : new TextDecoder("utf-8", { fatal: true }).decode(bytes).length;
              if (!fullyRead(coverage, literalKey(path, side), length)) {
                throw new Error(`Reviewer must read every page of ${path} (${side}) before approving`);
              }
            }
          }
          const review: CandidateReview = { verdict: params.verdict, snapshotId: params.snapshot_id,
            criteriaVersion: params.criteria_version, blockingFindings: params.blocking_findings,
            requiredCheckIds: [...new Set(params.required_check_ids)] };
          if (params.verdict === "approved" && params.blocking_findings.length) throw new Error("An approval cannot contain blocking findings");
          const reviewRef = saveTaskArtifact({ type: "review", taskId: options.taskId,
            reviewerSessionId: ctx.sessionManager.getSessionId(), review }, privateRoot);
          return output({ reviewRef, ...review });
        },
      }));
      if (enabled.has("assess_acceptance")) pi.registerTool(defineTool({
        name: "assess_acceptance", label: "Check task acceptance",
        description: "Host gate for unchanged candidate, reviewer approval on current requirements, and all reviewer-required checks. A child completion alone is not acceptance.",
        parameters: Type.Object({ candidate_ref: Type.String(), review_ref: Type.String(), criteria_version: Type.String(),
          open_blockers: Type.Array(Type.String()) }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const candidate = artifactOf(options.taskId, params.candidate_ref, "candidate", privateRoot);
          const reviewArtifact = artifactOf(options.taskId, params.review_ref, "review", privateRoot);
          const ownerSessionId = ctx.sessionManager.getSessionId();
          const ownerEntries = ctx.sessionManager.getEntries() as SessionEntry[];
          const mainTurns = await mainUserTurns(options, ownerEntries);
          const currentCriteria = criteriaVersion(ownerEntries, mainTurns);
          const current = (await collectChanges(options.cwd)).snapshot;
          const candidateChecks = taskArtifacts(options.taskId, privateRoot)
            .filter((artifact): artifact is Extract<TaskArtifact, {type: "check"}> => artifact.type === "check")
            .filter((artifact) => artifact.result.cwd === options.cwd)
            .sort((a, b) => a.result.completedAt.localeCompare(b.result.completedAt));
          const checksById = new Map<string, CandidateCheck>();
          for (const check of candidateChecks) checksById.set(check.checkId, {
            id: check.checkId, required: check.required, status: check.result.status,
            snapshotId: check.result.snapshotId ?? "unrecorded",
          });
          const unavailable = candidate.manifest.changed
            .filter((entry) => [entry.before, entry.after].some((side) => side?.contentAvailability === "too_large" || side?.contentAvailability === "unsupported"))
            .map((entry) => `Original bytes unavailable for ${entry.path}`);
          const reasons = [
            ...(candidate.snapshot.repositoryRoot !== options.cwd ? ["Candidate belongs to another worktree"] : []),
            ...(current.id !== candidate.snapshot.id ? ["Worktree changed after candidate capture"] : []),
            ...(currentCriteria !== candidate.criteriaVersion || params.criteria_version !== currentCriteria ? ["User requirements changed after candidate capture"] : []),
            ...(candidate.mainTurnDigest !== mainTurnDigest(mainTurns) ? ["Main user messages changed after candidate capture"] : []),
            ...(!steeringWasRead(options, ownerSessionId, mainTurns) ? ["Main user follow-ups were not reconciled by task owner"] : []),
            ...(reviewArtifact.reviewerSessionId === ownerSessionId ? ["Review must come from an independent agent"] : []),
            ...unavailable,
          ];
          await disposeChangeSnapshotArtifacts(current);
          const result = assessTaskAcceptance({ snapshotId: candidate.snapshot.id, criteriaVersion: currentCriteria,
            requireReview: true, review: reviewArtifact.review, checks: [...checksById.values()],
            openBlockers: [...params.open_blockers, ...reasons] });
          if (result.accepted) saveTaskArtifact({ type: "acceptance", taskId: options.taskId,
            candidateRef: params.candidate_ref, snapshotId: candidate.snapshot.id,
            criteriaVersion: currentCriteria, acceptedAt: new Date().toISOString() }, privateRoot);
          return output({ ...result, candidateSnapshotId: candidate.snapshot.id, criteriaVersion: currentCriteria,
            reviewerSessionId: reviewArtifact.reviewerSessionId, checks: [...checksById.values()] });
        },
      }));
      if (enabled.has("apply_exact_patch")) pi.registerTool(defineTool({
        name: "apply_exact_patch", label: "Apply bounded patch",
        description: "Writer-only atomic, exact-path Git patch with immutable dispatch snapshot and applicable project-rule fingerprint.",
        parameters: Type.Object({ patch: Type.String() }),
        async execute(_id, params) {
          if (!options.allowedPaths?.length || !options.expectedSnapshotId || !options.expectedProjectFingerprint) {
            throw new Error("Writer lacks host-pinned paths, snapshot, or project rules");
          }
          return output(await applyBoundedPatch({ cwd: options.cwd, patch: params.patch,
            allowedPaths: options.allowedPaths, expectedSnapshotId: options.expectedSnapshotId,
            expectedProjectFingerprint: options.expectedProjectFingerprint }));
        },
      }));
    },
  };
}
