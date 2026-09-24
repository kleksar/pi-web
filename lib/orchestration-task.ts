import type { SessionEntry, UserMessage } from "./types";

export const TASK_ENVELOPE_ENTRY_TYPE = "pi-web:orchestration-task";

export interface TaskEnvelope {
  version: 1;
  taskId: string;
  revision: number;
  worktreeRoot: string;
  /** The original user's text, not a paraphrase of the Agent tool prompt. */
  originalUserRequest: string;
  /** Points to the complete session entry when the request contains images or other content. */
  originalUserMessageId?: string;
  /** Persisted Main identity lets the owner/reviewer re-read later real user turns. */
  mainSessionId?: string;
  mainSessionPath?: string;
  sourceBindings?: Record<string, string>;
}

export interface OriginalUserRequest {
  entryId: string;
  text: string;
  hasNonTextContent: boolean;
}

/** Custom subagent notifications are stored separately and must never become user requirements. */
export function latestOriginalUserRequest(entries: readonly SessionEntry[]): OriginalUserRequest | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const content: UserMessage["content"] = entry.message.content;
    return {
      entryId: entry.id,
      text: typeof content === "string"
        ? content
        : content.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      hasNonTextContent: Array.isArray(content) && content.some((part) => part.type !== "text"),
    };
  }
  return null;
}

export function appendTaskEnvelope(
  manager: { appendCustomEntry(type: string, data: unknown): void },
  envelope: TaskEnvelope,
): void {
  if (envelope.version !== 1 || !envelope.taskId || !envelope.worktreeRoot || !Number.isSafeInteger(envelope.revision) || envelope.revision < 0) {
    throw new Error("Invalid orchestration task envelope");
  }
  manager.appendCustomEntry(TASK_ENVELOPE_ENTRY_TYPE, { ...envelope });
}

export function readTaskEnvelope(entries: readonly SessionEntry[]): TaskEnvelope | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== TASK_ENVELOPE_ENTRY_TYPE) continue;
    const data = entry.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const candidate = data as Partial<TaskEnvelope>;
    if (candidate.version !== 1 || typeof candidate.taskId !== "string" || !candidate.taskId
      || !Number.isSafeInteger(candidate.revision) || (candidate.revision ?? -1) < 0
      || typeof candidate.worktreeRoot !== "string" || !candidate.worktreeRoot
      || typeof candidate.originalUserRequest !== "string"
      || (candidate.mainSessionId !== undefined && (typeof candidate.mainSessionId !== "string" || !candidate.mainSessionId))
      || (candidate.mainSessionPath !== undefined && (typeof candidate.mainSessionPath !== "string" || !candidate.mainSessionPath))
      || Boolean(candidate.mainSessionId) !== Boolean(candidate.mainSessionPath)) continue;
    return candidate as TaskEnvelope;
  }
  return null;
}
