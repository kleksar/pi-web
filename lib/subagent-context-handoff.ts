import { createHash } from "node:crypto";
import type { SessionEntry } from "./types";
import { SUBAGENT_META_TYPE, SUBAGENT_RESULT_TYPE, SUBAGENT_STATUS_TYPE, type SubagentContextRequest } from "./subagents";

export const SUBAGENT_CONTEXT_HANDOFF_TYPE = "pi-web:subagent-context-handoff";
export const SUBAGENT_CONTEXT_CONSUMED_TYPE = "pi-web:subagent-context-consumed";
export const MAX_CONTEXT_RESULT_BYTES = 64 * 1024;

type Fields = Record<string, unknown>;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const record = (value: unknown): value is Fields => value !== null && typeof value === "object" && !Array.isArray(value);

function validRequest(value: unknown): value is SubagentContextRequest {
  if (!record(value) || Object.keys(value).some((key) => !["status", "provider", "request", "missingFiles"].includes(key))
    || value.status !== "needs_context" || typeof value.provider !== "string" || !namePattern.test(value.provider)
    || typeof value.request !== "string" || !value.request.trim() || value.request !== value.request.trim()
    || Buffer.byteLength(value.request, "utf8") > 4096) return false;
  if (value.missingFiles === undefined) return true;
  return Array.isArray(value.missingFiles) && value.missingFiles.length <= 32
    && value.missingFiles.every((item) => typeof item === "string" && item.trim()
      && item === item.trim() && Buffer.byteLength(item, "utf8") <= 512);
}

/** A special result is one standalone JSON object, with no prose or markdown fence. */
export function parseSubagentContextRequest(text: string): SubagentContextRequest | null {
  const trimmed = text.trim();
  // Preserve ordinary prose, including discussion of the protocol in code.
  // A fenced protocol attempt fails closed instead of passing as final analysis.
  if (!trimmed.startsWith("{")) {
    if (trimmed.startsWith("```") && trimmed.includes("needs_context")) {
      throw new Error("Invalid needs_context response: return one JSON object without markdown");
    }
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch {
    throw new Error("Invalid needs_context response: return one JSON object without markdown");
  }
  if (record(parsed) && parsed.status !== "needs_context") return null;
  if (!validRequest(parsed)) throw new Error("Invalid needs_context response: status, provider and request are required");
  return parsed;
}

export function latestSubagentResult(entries: readonly SessionEntry[]): { id: string; data: Fields } | null {
  const lifecycle = [...entries].reverse().find((entry) => entry.type === "custom"
    && (entry.customType === SUBAGENT_RESULT_TYPE || entry.customType === SUBAGENT_STATUS_TYPE));
  if (lifecycle?.type !== "custom" || lifecycle.customType !== SUBAGENT_RESULT_TYPE
    || !record(lifecycle.data) || !lifecycle.id) return null;
  return { id: lifecycle.id, data: lifecycle.data };
}

export function pendingContextRequest(entries: readonly SessionEntry[], allowInFlight = false): { id: string; request: SubagentContextRequest } | null {
  let result = latestSubagentResult(entries);
  if (!result && allowInFlight) {
    const lifecycle = [...entries].reverse().find((entry) => entry.type === "custom"
      && (entry.customType === SUBAGENT_RESULT_TYPE || entry.customType === SUBAGENT_STATUS_TYPE));
    if (lifecycle?.type === "custom" && lifecycle.customType === SUBAGENT_STATUS_TYPE
      && record(lifecycle.data) && (lifecycle.data.status === "queued" || lifecycle.data.status === "running")) {
      const earlier = [...entries].reverse().find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_RESULT_TYPE);
      if (earlier?.type === "custom" && record(earlier.data) && earlier.id) result = { id: earlier.id, data: earlier.data };
    }
  }
  if (!result || result.data.status !== "needs_context") return null;
  if (!validRequest(result.data.contextRequest)) throw new Error("Invalid stored needs_context request");
  return { id: result.id, request: result.data.contextRequest };
}

export function childParentIdentity(entries: readonly SessionEntry[]): {
  parentSessionId: string; parentSessionPath: string; profile: string; epoch?: string;
  contextFor?: string; contextForResultId?: string;
} {
  const marker = entries.find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
  if (marker?.type !== "custom" || !record(marker.data) || typeof marker.data.parentSessionId !== "string"
    || typeof marker.data.parentSessionPath !== "string" || typeof marker.data.profile !== "string") {
    throw new Error("Invalid subagent parent identity");
  }
  if ((typeof marker.data.contextFor === "string") !== (typeof marker.data.contextForResultId === "string")
    || (marker.data.contextFor !== undefined && (!marker.data.contextFor || !marker.data.contextForResultId))) {
    throw new Error("Invalid pinned context requester identity");
  }
  return { parentSessionId: marker.data.parentSessionId, parentSessionPath: marker.data.parentSessionPath,
    profile: marker.data.profile, ...(typeof marker.data.dependencyEpoch === "string" ? { epoch: marker.data.dependencyEpoch } : {}),
    ...(typeof marker.data.contextFor === "string" ? { contextFor: marker.data.contextFor } : {}),
    ...(typeof marker.data.contextForResultId === "string" ? { contextForResultId: marker.data.contextForResultId } : {}) };
}

export function contextResultHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface ContextHandoff {
  version: 1;
  parentSessionId: string;
  epoch: string;
  consumerSessionId: string;
  consumerResultId: string;
  providerSessionId: string;
  providerResultId: string;
  providerProfile: string;
  sha256: string;
}

export function contextHandoffFor(entries: readonly SessionEntry[], consumerSessionId: string, consumerResultId: string): ContextHandoff | null {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "custom" || entry.customType !== SUBAGENT_CONTEXT_HANDOFF_TYPE) continue;
    const item = entry.data;
    if (!record(item)) throw new Error("Invalid context handoff marker");
    if (item.consumerSessionId !== consumerSessionId || item.consumerResultId !== consumerResultId) continue;
    if (item.version !== 1 || typeof item.parentSessionId !== "string" || typeof item.epoch !== "string"
      || typeof item.providerSessionId !== "string" || typeof item.providerProfile !== "string"
      || typeof item.providerResultId !== "string" || !item.providerResultId
      || typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256)) {
      throw new Error("Invalid context handoff marker");
    }
    return item as unknown as ContextHandoff;
  }
  return null;
}
