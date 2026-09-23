import type { SimpleStreamOptions } from "@earendil-works/pi-ai";

type PayloadHook = NonNullable<SimpleStreamOptions["onPayload"]>;

type FastModeModel = {
  api: string;
  provider: string;
};

/** The native OpenAI endpoints support a priority service tier. Other providers using
 * an OpenAI-compatible wire format may not, so their requests must not be changed. */
export function isFastSupported(model: unknown): model is FastModeModel {
  if (!model || typeof model !== "object") return false;
  const candidate = model as Partial<FastModeModel>;
  return (candidate.provider === "openai" && candidate.api === "openai-responses")
    || (candidate.provider === "openai-codex" && candidate.api === "openai-codex-responses");
}

const originalHooks = new WeakMap<object, PayloadHook | undefined>();

/**
 * Enable Fast mode only for this child session. Pi 0.87.1 does not expose a
 * service-tier option on AgentSession, and its simple-stream adapter discards
 * serviceTier. Its onPayload callback runs after the provider has built the
 * request and before either the HTTP or WebSocket transport sends it.
 *
 * Keep the SDK's callback: extensions also use it to transform requests.
 * Install this on both initial child creation and persisted-session reopen,
 * using the saved child resource snapshot for the latter.
 *
 * Billing note: when a provider's response reports its service tier, the SDK
 * applies that tier's cost. If it omits the tier (or Codex reports "default"),
 * the SDK's displayed cost can understate priority billing because its
 * simple-stream adapter does not receive serviceTier. Provider billing is
 * authoritative; the UI must describe its cost as an estimate.
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
