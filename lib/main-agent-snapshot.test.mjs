import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const { MAIN_RESOURCE_META_TYPE, readMainSessionResources } = await createJiti(import.meta.url).import("./main-agent-snapshot.ts");
const marker = (data) => [{ type: "custom", customType: MAIN_RESOURCE_META_TYPE, data }];

test("Main snapshot keeps an explicit empty child list and validates child fingerprints", () => {
  assert.equal(readMainSessionResources([]), null);
  const blocked = readMainSessionResources(marker({ version: 1,
    selectedSkills: [], selectedExtensionTools: [],
    allowedBuiltInTools: [],
    orchestration: { allowedChildren: [], childProfiles: {} },
  }));
  assert.deepEqual(blocked.orchestration.allowedChildren, []);
  assert.deepEqual(blocked.selectedSkills, []);
  assert.deepEqual(blocked.allowedBuiltInTools, []);
  assert.throws(() => readMainSessionResources(marker({ version: 1,
    allowedBuiltInTools: ["bash", "unknown"],
  })), /unknown tool/);
  assert.throws(() => readMainSessionResources(marker({ version: 1,
    orchestration: { allowedChildren: ["reader"], childProfiles: {} },
  })), /Invalid Main child profile snapshot/);
  for (const pin of [
    { scope: "roster", filePath: " ", sha256: "a".repeat(64) },
    { scope: "builtin", filePath: "/tmp/reader.md", sha256: "a".repeat(64) },
  ]) {
    assert.throws(() => readMainSessionResources(marker({ version: 1,
      orchestration: { allowedChildren: ["reader"], childProfiles: { reader: pin } },
    })), /Invalid Main child profile snapshot/);
  }
  assert.throws(() => readMainSessionResources(marker({ version: 1,
    selectedSkills: [{ filePath: "/tmp/skill.md", content: "forged" }],
  })), /Invalid selected skill snapshot/);
});

test("a Git roster child remains authorized after Main's session is reopened", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-main-roster-snapshot-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const pin = { scope: "roster", filePath: join(cwd, "orchestration", "agents", "coordinator.md"), sha256: "a".repeat(64) };
  manager.appendCustomEntry(MAIN_RESOURCE_META_TYPE, { version: 1,
    orchestration: { allowedChildren: ["coordinator"], childProfiles: { coordinator: pin } },
  });
  manager.appendMessage({ role: "user", content: "Start the task", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Task started" }],
    provider: "test", model: "test", api: "test", stopReason: "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

  const restored = SessionManager.open(manager.getSessionFile());
  const snapshot = readMainSessionResources(restored.getEntries());
  assert.deepEqual(snapshot.orchestration.childProfiles.coordinator, pin);
  assert.deepEqual(snapshot.orchestration.allowedChildren, ["coordinator"]);
});
