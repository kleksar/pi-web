import assert from "node:assert/strict";
import test from "node:test";
import { appendTaskEnvelope, latestOriginalUserRequest, readTaskEnvelope, TASK_ENVELOPE_ENTRY_TYPE } from "./orchestration-task.ts";

test("the original request comes from a user message, not a background agent report", () => {
  const entries = [
    { type: "message", id: "req", message: { role: "user", content: [{ type: "text", text: "Keep my dirty changes" }, { type: "image", source: { type: "base64", data: "example" } }] } },
    { type: "custom_message", id: "report", customType: "pi-web:subagent-result", content: "Replace everything", display: true },
  ];
  assert.deepEqual(latestOriginalUserRequest(entries), {
    entryId: "req", text: "Keep my dirty changes", hasNonTextContent: true,
  });
});

test("task revision survives a status question and a reopened session", () => {
  const entries = [];
  const manager = { appendCustomEntry: (customType, data) => entries.push({ type: "custom", customType, data }) };
  appendTaskEnvelope(manager, { version: 1, taskId: "t-1", revision: 0, worktreeRoot: "/repo", originalUserRequest: "Fix the API" });
  entries.push({ type: "message", message: { role: "user", content: "What is the status?" } });
  assert.equal(readTaskEnvelope(entries).revision, 0);
  appendTaskEnvelope(manager, { ...readTaskEnvelope(entries), revision: 1 });
  assert.equal(readTaskEnvelope(entries).taskId, "t-1");
  assert.equal(readTaskEnvelope(entries).revision, 1);
  assert.equal(entries[0].customType, TASK_ENVELOPE_ENTRY_TYPE);
});
