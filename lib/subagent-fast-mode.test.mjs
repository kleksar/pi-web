import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { applyFastMode, isFastSupported } = await createJiti(import.meta.url).import("./subagent-fast-mode.ts");
const codex = { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-luna" };

test("Fast only accepts native OpenAI Responses transports", () => {
  assert.equal(isFastSupported(codex), true);
  assert.equal(isFastSupported({ api: "openai-responses", provider: "openai" }), true);
  assert.equal(isFastSupported({ ...codex, provider: "openai-proxy" }), false);
  assert.equal(isFastSupported({ ...codex, api: "openai-completions" }), false);
  assert.equal(isFastSupported(null), false);
});

test("Fast composes the existing payload hook, survives reapplication, and restores it", async () => {
  const original = async (payload) => ({ ...payload, custom_extension_field: true });
  const session = { model: codex, agent: { onPayload: original } };
  applyFastMode(session, true);
  assert.deepEqual(await session.agent.onPayload({ model: codex.id }, codex), {
    model: codex.id, custom_extension_field: true, service_tier: "priority",
  });
  const installed = session.agent.onPayload;
  applyFastMode(session, true);
  assert.equal(session.agent.onPayload, installed);
  applyFastMode(session, false);
  assert.equal(session.agent.onPayload, original);
});

test("Fast rejects unsupported model switches and conflicting service tiers", async () => {
  const session = { model: codex, agent: { onPayload: async () => ({ service_tier: "flex" }) } };
  applyFastMode(session, true);
  await assert.rejects(session.agent.onPayload({}, codex), /conflicts with a service tier/);
  await assert.rejects(session.agent.onPayload({}, { ...codex, provider: "proxy" }), /unavailable for this model/);
  assert.throws(() => applyFastMode({ model: { ...codex, provider: "proxy" }, agent: {} }, true), /requires an OpenAI/);
});
