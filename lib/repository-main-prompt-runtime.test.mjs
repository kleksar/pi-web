import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "pi-web-repository-prompt-runtime-"));
const agentDir = join(root, "agent-home");
const roster = join(root, "orchestration");
const project = join(root, "project");
await Promise.all([
  mkdir(agentDir), mkdir(join(roster, "agents"), { recursive: true }),
  mkdir(join(roster, "skills"), { recursive: true }), mkdir(project),
]);
await writeFile(join(roster, "APPEND_SYSTEM.md"), "Main instructions from Git");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalRoster = process.env.PI_WEB_ROSTER_ROOT;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_ROSTER_ROOT = roster;
const { startRpcSession } = await createJiti(import.meta.url).import("./rpc-manager.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalRoster === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
  else process.env.PI_WEB_ROSTER_ROOT = originalRoster;
  await rm(root, { recursive: true, force: true });
});

test("repo Main addendum reaches both normal and chat-only resource loaders without a global file", async () => {
  for (const [sessionId, toolNames] of [["main-roster-normal", ["read"]], ["main-roster-chat", []]]) {
    const { session } = await startRpcSession(sessionId, "", project, { toolNames });
    try {
      assert.deepEqual(session.inner.resourceLoader.getAppendSystemPrompt(), ["Main instructions from Git"]);
      assert.equal(session.isChatOnly(), toolNames.length === 0);
      if (toolNames.length === 0) {
        const state = await session.send({ type: "get_state" });
        assert.match(state.systemPrompt, /Main instructions from Git/);
      }
    } finally {
      await session.shutdown();
    }
  }
});
