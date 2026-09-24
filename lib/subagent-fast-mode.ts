import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;
type FastModeModel = { api: string; provider: string };

/** Priority tier is supported by the native OpenAI Responses transports only. */
export function isFastSupported(model: unknown): model is FastModeModel {
  if (!model || typeof model !== "object") return false;
  const candidate = model as Partial<FastModeModel>;
  return (candidate.provider === "openai" && candidate.api === "openai-responses")
    || (candidate.provider === "openai-codex" && candidate.api === "openai-codex-responses");
}

const originalHooks = new WeakMap<object, PayloadHook | undefined>();

/**
 * Request Fast for one agent session. Pi's stream adapter has no AgentSession
 * service-tier option, so the request payload is finalized in onPayload.
 * Preserve other extensions' hooks and never silently downgrade a Fast profile.
 * Provider billing is authoritative when the SDK response omits its tier.
 */
export function applyFastMode(session: { agent: object; model?: unknown }, fastMode: boolean): void {
  const agent = session.agent as { onPayload?: PayloadHook };
  if (!fastMode) {
    if (originalHooks.has(agent)) {
      agent.onPayload = originalHooks.get(agent);
      originalHooks.delete(agent);
    }
    return;
  }
  if (!isFastSupported(session.model)) {
    throw new Error("Fast mode requires an OpenAI Responses or OpenAI Codex Responses model; select a supported model or turn Fast mode off");
  }
  if (originalHooks.has(agent)) return;

  const original = agent.onPayload;
  agent.onPayload = async (payload, model) => {
    if (!isFastSupported(model)) {
      throw new Error("Fast mode is unavailable for this model; select an OpenAI Responses or OpenAI Codex Responses model");
    }
    const transformed = await original?.(payload, model);
    const request = transformed === undefined ? payload : transformed;
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Fast mode requires an object provider request payload");
    }
    const tier = (request as Record<string, unknown>).service_tier;
    if (tier !== undefined && tier !== "priority" && tier !== "fast") {
      throw new Error("Fast mode conflicts with a service tier set by another provider request handler");
    }
    return tier === undefined ? { ...request, service_tier: "priority" } : request;
  };
  originalHooks.set(agent, original);
}
