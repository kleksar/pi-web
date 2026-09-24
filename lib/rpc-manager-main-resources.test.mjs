import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const cwd = await mkdtemp(join(tmpdir(), "pi-web-main-runtime-"));
const agentDir = join(cwd, "agent-home");
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { startRpcSession } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const { writeMainAgentConfig } = await createJiti(import.meta.url).import("./main-agent-config.ts");
const { MAIN_RESOURCE_META_TYPE } = await createJiti(import.meta.url).import("./main-agent-snapshot.ts");
const { writeBuiltInSubagentsEnabled } = await createJiti(import.meta.url).import("./subagent-settings.ts");

function persistForReopen(manager) {
  manager.appendMessage({ role: "user", content: "Save this session", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Saved" }],
    provider: "test", model: "test", api: "test", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
}

after(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  await rm(cwd, { recursive: true, force: true });
});

test("explicit chat-only Main ignores assigned tools and skills across reopen", async () => {
  writeMainAgentConfig({
    selectedSkills: [join(cwd, "nonexistent-SKILL.md")],
    selectedExtensionTools: [{ extensionPath: join(cwd, "nonexistent-extension.ts"), toolName: "unavailable" }],
  });
  const { session } = await startRpcSession("new-main-chat-only", "", cwd, { toolNames: [] });
  const path = session.sessionFile;
  const id = session.sessionId;
  persistForReopen(session.inner.sessionManager);
  try {
    assert.equal(session.isChatOnly(), true);
    assert.deepEqual(session.inner.getActiveToolNames(), []);
    const snapshot = session.inner.sessionManager.getEntries().find((entry) => entry.customType === MAIN_RESOURCE_META_TYPE).data;
    assert.equal(snapshot.selectedSkills, undefined);
    assert.equal(snapshot.selectedExtensionTools, undefined);
  } finally {
    await session.shutdown();
  }
  assert.deepEqual(SessionManager.open(path).getEntries().filter((entry) => entry.type === "custom")
    .map((entry) => [entry.customType, entry.data]), [
      ["pi-web:tool-selection", { version: 1, tools: [] }],
      [MAIN_RESOURCE_META_TYPE, { version: 1 }],
    ]);
  const reopened = (await startRpcSession(id, path, undefined)).session;
  try {
    assert.equal(reopened.isChatOnly(), true);
    assert.deepEqual(reopened.inner.getActiveToolNames(), []);
  } finally {
    await reopened.shutdown();
  }
});

test("new standard Main pins its configured skill; missing or edited file fails closed", async () => {
  const skillDir = join(agentDir, "skills", "coordinator");
  await mkdir(skillDir, { recursive: true });
  const skill = join(skillDir, "SKILL.md");
  await writeFile(skill, "---\nname: coordinator\ndescription: Coordinate delegated work\n---\nUse the right agent.");
  writeMainAgentConfig({ selectedSkills: [skill], selectedExtensionTools: [],
    orchestration: { allowedChildren: ["explore"] } });
  writeBuiltInSubagentsEnabled(false);
  const disabled = (await startRpcSession("main-disabled-subagents", "", cwd, { toolNames: ["read"] })).session;
  try {
    assert.equal(disabled.inner.getActiveToolNames().includes("Agent"), false);
  } finally {
    await disabled.shutdown();
  }
  writeBuiltInSubagentsEnabled(true);
  const { session } = await startRpcSession("new-main-normal", "", cwd, { toolNames: ["read"] });
  const path = session.sessionFile;
  const id = session.sessionId;
  persistForReopen(session.inner.sessionManager);
  try {
    assert.equal(session.isChatOnly(), false);
    const snapshot = session.inner.sessionManager.getEntries().find((entry) => entry.customType === MAIN_RESOURCE_META_TYPE).data;
    assert.equal(snapshot.selectedSkills.length, 1);
    assert.match(snapshot.selectedSkills[0].content, /Use the right agent/);
    assert.deepEqual(snapshot.orchestration.allowedChildren, ["explore"]);
    await writeFile(skill, "---\nname: coordinator\ndescription: Coordinate delegated work\n---\nNew instructions.");
    await assert.rejects(session.send({ type: "reload" }), /Selected skill changed since session start/);
  } finally {
    await session.shutdown();
  }
  assert.ok(SessionManager.open(path).getEntries().some((entry) => entry.customType === MAIN_RESOURCE_META_TYPE));
  await assert.rejects(startRpcSession(id, path, undefined), /Selected skill changed since session start/);
  writeMainAgentConfig({ selectedSkills: [join(cwd, "missing-SKILL.md")] });
  await assert.rejects(startRpcSession("new-main-missing", "", cwd, { toolNames: ["read"] }),
    /Selected skill is no longer available/);
});

test("global Main config fails closed when a selected project skill is not discovered in another cwd", async () => {
  const projectA = join(cwd, "project-a");
  const projectB = join(cwd, "project-b");
  await mkdir(join(projectA, ".pi", "skills", "local-skill"), { recursive: true });
  await mkdir(projectB, { recursive: true });
  const localSkill = join(projectA, ".pi", "skills", "local-skill", "SKILL.md");
  await writeFile(localSkill, "---\nname: local-skill\ndescription: Only project A\n---\nUse locally.");
  writeMainAgentConfig({ selectedSkills: [localSkill] });
  await assert.rejects(startRpcSession("main-project-b", "", projectB, { toolNames: ["read"] }),
    /Selected skill is no longer available/);
});
