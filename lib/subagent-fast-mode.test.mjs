import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { applyFastMode, isFastSupported } = await jiti.import("./subagent-fast-mode.ts");

const codex = { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.5" };
const openai = { api: "openai-responses", provider: "openai", id: "gpt-5.5" };

test("Fast mode is limited to native OpenAI Responses transports", () => {
  assert.equal(isFastSupported(codex), true);
  assert.equal(isFastSupported(openai), true);
  for (const model of [
    { ...codex, provider: "third-party" },
    { ...openai, api: "openai-completions" },
    { ...openai, provider: "github-copilot" },
    null,
  ]) assert.equal(isFastSupported(model), false);
});

test("Fast mode runs the SDK request hook first and sets priority on the final payload", async () => {
  const seen = [];
  const original = async (payload, model) => {
    seen.push({ payload, model });
    return { ...payload, custom_extension_field: "preserved" };
  };
  const session = { model: codex, agent: { onPayload: original } };
  applyFastMode(session, true);
  const transformed = await session.agent.onPayload({ model: codex.id }, codex);
  assert.deepEqual(transformed, { model: codex.id, custom_extension_field: "preserved", service_tier: "priority" });
  assert.deepEqual(seen, [{ payload: { model: codex.id }, model: codex }]);
  assert.equal(session.agent.onPayload === original, false);

  applyFastMode(session, true); // A resumed child must not stack wrappers.
  assert.equal((await session.agent.onPayload({ model: codex.id }, codex)).service_tier, "priority");
  assert.equal(seen.length, 2);
  applyFastMode(session, false);
  assert.equal(session.agent.onPayload, original);
});

test("Fast mode keeps in-place request mutations and honours an already-fast request", async () => {
  const session = { model: openai, agent: { onPayload: (payload) => { payload.extension_flag = true; } } };
  applyFastMode(session, true);
  const result = await session.agent.onPayload({ model: openai.id }, openai);
  assert.equal(result.extension_flag, true);
  assert.equal(result.service_tier, "priority");
  assert.equal((await session.agent.onPayload({ service_tier: "fast" }, openai)).service_tier, "fast");
});

test("disabled Fast mode leaves even an unsupported provider request untouched", async () => {
  const original = (payload) => ({ ...payload, extension_flag: true });
  const session = { model: { api: "anthropic-messages", provider: "anthropic" }, agent: { onPayload: original } };
  applyFastMode(session, false);
  assert.equal(session.agent.onPayload, original);
  assert.deepEqual(await session.agent.onPayload({ model: "claude" }, session.model), {
    model: "claude", extension_flag: true,
  });
});

test("unsupported models and conflicting provider transformations fail explicitly", async () => {
  const original = () => ({ service_tier: "flex" });
  const session = { model: openai, agent: { onPayload: original } };
  applyFastMode(session, true);
  await assert.rejects(session.agent.onPayload({}, openai), /conflicts with a service tier/);
  await assert.rejects(session.agent.onPayload({}, { ...openai, api: "anthropic-messages" }), /unavailable for this model/);
  assert.throws(() => applyFastMode({ model: { ...codex, provider: "proxy" }, agent: {} }, true), /requires an OpenAI/);
  assert.equal(session.agent.onPayload === original, false);
});
