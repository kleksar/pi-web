import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const { startRpcSession, setRpcSessionTools } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const { readMainSessionResources } = await createJiti(import.meta.url).import("./main-agent-snapshot.ts");
const CONTROL_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"].sort();

test("a new Main can delegate a project overview but cannot read it directly or regain file tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-main-coordinator-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldRoster = process.env.PI_WEB_ROSTER_ROOT;
  const agentDir = join(root, "agent-home");
  const project = join(root, "other-project");
  await mkdir(project);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WEB_ROSTER_ROOT = join(repo, "orchestration");
  t.after(async () => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldRoster === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = oldRoster;
    await rm(root, { recursive: true, force: true });
  });

  const { session, realSessionId } = await startRpcSession("coordinator-new", "", project);
  t.after(async () => { if (session.isAlive()) await session.shutdown(); });
  assert.equal(session.isChatOnly(), false, "delegation remains available without built-in tools");
  assert.deepEqual([...session.inner.getActiveToolNames()].sort(), CONTROL_TOOLS);
  const instructions = session.inner.resourceLoader.getAppendSystemPrompt().join("\n");
  assert.match(instructions, /Ты координатор/);
  assert.match(instructions, /Coordinate a task/);
  const snapshot = readMainSessionResources(session.inner.sessionManager.getEntries());
  assert.deepEqual(snapshot.allowedBuiltInTools, []);
  assert.deepEqual(snapshot.selectedExtensionTools, []);
  assert.ok(snapshot.orchestration.allowedChildren.includes("evidence-coordinator"));

  const selection = await setRpcSessionTools(realSessionId, session.sessionFile,
    ["read", "bash", "edit", "write"]);
  assert.equal(selection.recreated, false);
  assert.deepEqual([...selection.session.inner.getActiveToolNames()].sort(), CONTROL_TOOLS);
  await selection.session.send({ type: "reload" });
  assert.deepEqual([...selection.session.inner.getActiveToolNames()].sort(), CONTROL_TOOLS);

  // Pi only creates an on-disk session file when a message is saved. Persist a
  // user turn without calling a model so the reopening path uses that file.
  selection.session.inner.sessionManager.appendMessage({
    role: "user", content: "Tell me about the project", timestamp: Date.now(),
  });
  selection.session.inner.sessionManager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "I will ask a project reader." }],
    provider: "test", model: "test", api: "test", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const file = selection.session.sessionFile;
  assert.ok(file, "the Main session has a persisted file to reopen");
  await access(file);
  await selection.session.shutdown();
  await writeFile(join(agentDir, "main-agent-config.json"),
    JSON.stringify({ version: 1, allowedBuiltInTools: ["read", "bash"] }));
  const reopened = await startRpcSession(realSessionId, file);
  try {
    assert.deepEqual([...reopened.session.inner.getActiveToolNames()].sort(), CONTROL_TOOLS,
      "an existing session keeps its original policy after local defaults change");
  } finally {
    await reopened.session.shutdown();
  }
});
