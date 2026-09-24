import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { buildAgentRunTree, visibleAgentRunIds } = await createJiti(import.meta.url).import("./agent-run-tree.ts");

const root = { id: "main", modified: "2026-09-24T00:00:00Z" };
const child = (id, parentId, modified = "2026-09-24T00:01:00Z") => ({
  id, modified, relation: { kind: "subagent", parentSessionId: parentId, profile: "code-reader", description: id, status: "completed" },
});

test("nested runs retain parent and distinguish concurrent instances of the same profile", () => {
  const owner = child("owner", "main");
  const reader1 = child("reader-1", "owner", "2026-09-24T00:03:00Z");
  const reader2 = child("reader-2", "owner", "2026-09-24T00:02:00Z");
  const orphan = child("orphan", "missing");
  const rows = buildAgentRunTree(root, [orphan, reader2, owner, reader1], new Set(["reader-2"]));
  assert.deepEqual(rows.map(({ session, parentId, depth }) => [session.id, parentId, depth]), [
    ["owner", "main", 1], ["reader-2", "owner", 2], ["reader-1", "owner", 2],
  ]);
  assert.deepEqual([...visibleAgentRunIds(root.id, rows, new Set(["reader-1"]))], ["main", "reader-1", "owner"]);
});

test("malformed cycles cannot make the run tree loop or display unrelated sessions", () => {
  const owner = child("owner", "main");
  const recursive = child("owner", "owner");
  const cycle1 = child("cycle-1", "cycle-2");
  const cycle2 = child("cycle-2", "cycle-1");
  assert.deepEqual(buildAgentRunTree(root, [owner, recursive, cycle1, cycle2], new Set()).map((row) => row.session.id), ["owner"]);
});
