import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { MAIN_RESOURCE_META_TYPE, readMainSessionResources } = await createJiti(import.meta.url).import("./main-agent-snapshot.ts");
const marker = (data) => [{ type: "custom", customType: MAIN_RESOURCE_META_TYPE, data }];

test("Main snapshot keeps an explicit empty child list and validates child fingerprints", () => {
  assert.equal(readMainSessionResources([]), null);
  const blocked = readMainSessionResources(marker({ version: 1,
    selectedSkills: [], selectedExtensionTools: [],
    orchestration: { allowedChildren: [], childProfiles: {} },
  }));
  assert.deepEqual(blocked.orchestration.allowedChildren, []);
  assert.deepEqual(blocked.selectedSkills, []);
  assert.throws(() => readMainSessionResources(marker({ version: 1,
    orchestration: { allowedChildren: ["reader"], childProfiles: {} },
  })), /Invalid Main child profile snapshot/);
  assert.throws(() => readMainSessionResources(marker({ version: 1,
    selectedSkills: [{ filePath: "/tmp/skill.md", content: "forged" }],
  })), /Invalid selected skill snapshot/);
});
