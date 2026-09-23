import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { SUBAGENT_NOTIFICATION_PREFIX } = await jiti.import("./subagent-extension.ts");
const { profileAuthorityPin } = await jiti.import("./subagent-runtime.ts");
const { resolveSubagentProfile } = await jiti.import("./subagents.ts");

function completedRun() {
  return {
    sessionId: "child-session",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent-session",
    parentToolCallId: "tool-call",
    profile: "Explore",
    description: "Inspect parser",
    task: "Find the parser",
    runInBackground: true,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: "Parser found",
  };
}

test("completion notification reopens an idle parent and uses its current session", async () => {
  const delivered = [];
  const reopened = [];
  let ready = false;
  let parent;
  const liveParent = {
    cwd: "/tmp",
    sessionFile: "/tmp/parent.jsonl",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => { ready = true; },
    inner: {
      sendCustomMessage: async (message, options) => delivered.push({ message, options }),
    },
  };
  const controller = createSubagentController({
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async (sessionId, sessionFile) => {
      reopened.push([sessionId, sessionFile]);
      parent = liveParent;
      return liveParent;
    },
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    invalidateSessionList: () => {},
  });

  await controller.extensionRuntime.notifyParent(completedRun());

  assert.deepEqual(reopened, [["parent-session", "/tmp/parent.jsonl"]]);
  assert.equal(ready, true);
  assert.equal(delivered.length, 1);
  assert.equal(
    delivered[0].message.content,
    `${SUBAGENT_NOTIFICATION_PREFIX}Subagent child-session completed.\n\nParser found`,
  );
  // Compaction reads custom messages as user turns, so the report must announce that it is not one (#875).
  assert.match(delivered[0].message.content, /^The following is a background subagent's report/);
  assert.equal(delivered[0].message.details.sessionId, "child-session");
  assert.deepEqual(delivered[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("disabled built-in subagents reject stale Agent calls before starting", async () => {
  const controller = createSubagentController({
    getSession: () => { throw new Error("must not inspect a parent"); },
    registerSession: () => {},
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => false,
  });

  await assert.rejects(
    controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent" } },
      parentToolCallId: "call",
      profile: "explore",
      task: "Inspect",
      description: "Inspect",
    }),
    /built-in sub-agents are disabled/,
  );
});

test("resume reuses the persisted child session and keeps its session id", async () => {
  const calls = [];
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "old-call",
      profile: "explore",
      description: "old task",
      task: "old",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "custom", customType: "pi-web:subagent-result", data: {
      version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z", result: "old result",
    } },
  ];
  const childInner = {
    sessionId: "child",
    sessionFile: "/tmp/child.jsonl",
    sessionManager: { getEntries: () => entries, appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }) },
    prompt: async (task) => { calls.push(task); },
    getLastAssistantText: () => "new result",
    abort: async () => {},
  };
  const child = { inner: childInner, sessionFile: childInner.sessionFile, cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const parent = { inner: { sessionManager: { getSessionId: () => "parent", getEntries: () => [] } }, sessionFile: "/tmp/parent.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const controller = createSubagentController({
    getSession: (id) => id === "child" ? child : parent,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  const execution = await controller.extensionRuntime.resume({
    parentContext: parent.inner,
    parentToolCallId: "new-call",
    sessionId: "child",
    task: "continue this",
    description: "Continue task",
  });
  const result = await execution.completion;
  assert.equal(execution.run.sessionId, "child");
  assert.equal(result.sessionId, "child");
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["continue this"]);
});

test("resume rejects a child owned by another parent", async () => {
  const controller = createSubagentController({
    getSession: (id) => id === "parent" ? { inner: { sessionManager: { getSessionId: () => "parent" } }, sessionFile: "/tmp/parent.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} } : undefined,
    registerSession: () => {},
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  await assert.rejects(controller.extensionRuntime.resume({
    parentContext: { sessionManager: { getSessionId: () => "parent" } },
    parentToolCallId: "call",
    sessionId: "missing",
    task: "continue",
    description: "Continue",
  }), /Subagent not found/);
});

test("a run whose last assistant message ended with a provider error is reported as failed, not completed", async () => {
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "old-call",
      profile: "builder",
      description: "old task",
      task: "old",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "custom", customType: "pi-web:subagent-result", data: { version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z" } },
  ];
  const childInner = {
    sessionId: "child",
    sessionFile: "/tmp/child.jsonl",
    sessionManager: { getEntries: () => entries, appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }) },
    // pi's agent loop records a provider stream error as an assistant message and resolves prompt() normally.
    prompt: async () => {
      entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "edit", arguments: {} }], stopReason: "error", errorMessage: "stream error: stream disconnected before completion" } });
    },
    getLastAssistantText: () => undefined,
    abort: async () => {},
  };
  const child = { inner: childInner, sessionFile: childInner.sessionFile, cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const parent = { inner: { sessionManager: { getSessionId: () => "parent", getEntries: () => [] } }, sessionFile: "/tmp/parent.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const controller = createSubagentController({
    getSession: (id) => id === "child" ? child : parent,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  const execution = await controller.extensionRuntime.resume({
    parentContext: parent.inner,
    parentToolCallId: "new-call",
    sessionId: "child",
    task: "continue this",
    description: "Continue task",
  });
  const result = await execution.completion;
  assert.equal(result.status, "failed");
  assert.match(result.error, /stream disconnected/);
  const persisted = entries.at(-1);
  assert.equal(persisted.customType, "pi-web:subagent-result");
  assert.equal(persisted.data.status, "failed");
  assert.match(persisted.data.error, /stream disconnected/);
});

function idleParentDependencies(delivered, overrides = {}) {
  const parent = {
    cwd: "/tmp",
    sessionFile: "/tmp/parent.jsonl",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
    inner: {
      sendCustomMessage: async (message, options) => delivered.push({ message, options }),
    },
    ...overrides,
  };
  return {
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async () => parent,
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    invalidateSessionList: () => {},
  };
}

test("a result already collected with get_subagent_result is never delivered again", async () => {
  const delivered = [];
  const controller = createSubagentController(idleParentDependencies(delivered));
  const run = { ...completedRun(), sessionId: "collected-child" };

  controller.extensionRuntime.markResultConsumed(run.sessionId);
  await controller.extensionRuntime.notifyParent(run);

  assert.equal(delivered.length, 0);

  // The mark is consumed, so a later run reusing that session ID still notifies.
  await controller.extensionRuntime.notifyParent(run);
  assert.equal(delivered.length, 1);
});

test("a notification waits for a busy parent and is dropped when that turn collects the result", async () => {
  const delivered = [];
  let running = true;
  const controller = createSubagentController(idleParentDependencies(delivered, { isRunning: () => running }));
  const run = { ...completedRun(), sessionId: "racing-child" };

  const notified = controller.extensionRuntime.notifyParent(run);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(delivered.length, 0, "must not deliver while the parent turn is still running");

  // The parent's in-flight get_subagent_result call returns the same result, then the turn ends.
  controller.extensionRuntime.markResultConsumed(run.sessionId);
  running = false;
  await notified;

  assert.equal(delivered.length, 0);
});

test("a notification held for a busy parent is delivered once that parent goes idle", async () => {
  const delivered = [];
  let running = true;
  const controller = createSubagentController(idleParentDependencies(delivered, { isRunning: () => running }));
  const run = { ...completedRun(), sessionId: "waiting-child" };

  const notified = controller.extensionRuntime.notifyParent(run);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(delivered.length, 0);

  running = false;
  await notified;

  assert.equal(delivered.length, 1);
  assert.equal(
    delivered[0].message.content,
    `${SUBAGENT_NOTIFICATION_PREFIX}Subagent waiting-child completed.\n\nParser found`,
  );
  assert.deepEqual(delivered[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("runtime result and steering access is limited to the direct parent", async () => {
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1, parentSessionId: "owner", parentSessionPath: "/tmp/owner.jsonl",
      profile: "reader", description: "Read", task: "read", runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, tools: [], appendSystemPrompt: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "custom", customType: "pi-web:subagent-status", data: { version: 1, status: "running" } },
  ];
  const steered = [];
  const child = {
    sessionFile: "/tmp/child-owner.jsonl", isAlive: () => true, isRunning: () => true,
    inner: { sessionManager: { getEntries: () => entries }, steer: async (message) => steered.push(message) },
  };
  const controller = createSubagentController({
    getSession: (id) => id === "child-owner" ? child : undefined,
    registerSession: () => {}, reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile, invalidateSessionList: () => {},
  });
  assert.equal(await controller.extensionRuntime.get("child-owner", "stranger"), null);
  assert.equal((await controller.extensionRuntime.get("child-owner", "owner")).parentSessionId, "owner");
  await assert.rejects(controller.extensionRuntime.steer("child-owner", "stop", "stranger"), /does not belong/);
  await controller.extensionRuntime.steer("child-owner", "continue", "owner");
  assert.deepEqual(steered, ["continue"]);
});

test("persisted running child with no live execution is interrupted and can be resumed", async () => {
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1, parentSessionId: "owner", parentSessionPath: "/tmp/owner.jsonl",
      profile: "reader", description: "Read", task: "read", runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, tools: [], appendSystemPrompt: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "custom", customType: "pi-web:subagent-status", data: { version: 1, status: "running" } },
  ];
  const child = {
    sessionFile: "/tmp/child-interrupted.jsonl", isAlive: () => true, isRunning: () => false,
    inner: {
      sessionManager: { getEntries: () => entries, appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }) },
      prompt: async () => {}, getLastAssistantText: () => "recovered", abort: async () => {},
    },
  };
  const parent = {
    sessionFile: "/tmp/owner.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false,
    inner: { sessionManager: { getSessionId: () => "owner", getEntries: () => [] } },
  };
  const controller = createSubagentController({
    getSession: (id) => id === "child-interrupted" ? child : parent,
    registerSession: () => {}, reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile, invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  assert.equal((await controller.get("child-interrupted")).status, "interrupted");
  const resumed = await controller.extensionRuntime.resume({
    parentContext: parent.inner, parentToolCallId: "again", sessionId: "child-interrupted",
    task: "continue", description: "Continue",
  });
  assert.equal((await resumed.completion).result, "recovered");
});

test("Stop cancels queued and running descendants and suppresses background notification", async () => {
  const childId = "stop-child";
  const grandchildId = "stop-grandchild";
  const order = [];
  const runs = globalThis.__piSubagentRuns ??= new Map();
  const pendingKey = JSON.stringify([childId, "tool-call"]);
  (globalThis.__piSubagentPendingNotifications ??= new Map()).set(pendingKey, "stop-root");
  const completed = (sessionId, parentSessionId, status) => ({
    ...completedRun(), sessionId, parentSessionId, status,
  });
  runs.set(childId, {
    run: completed(childId, "stop-root", "running"), completion: Promise.resolve(), abortRequested: false,
  });
  runs.set(grandchildId, {
    run: completed(grandchildId, childId, "queued"), completion: Promise.resolve(), abortRequested: false,
    cancelQueued: () => { order.push("queued grandchild"); runs.delete(grandchildId); return true; },
  });
  const child = {
    isAlive: () => true, isRunning: () => true,
    inner: { abort: async () => { order.push("running child"); runs.delete(childId); } },
  };
  const root = {
    sessionFile: "/tmp/stop-root.jsonl", cwd: "/tmp", isAlive: () => true,
    inner: { sessionManager: { getEntries: () => [] } },
  };
  const controller = createSubagentController({
    getSession: (id) => id === childId ? child : id === "stop-root" ? root : undefined,
    registerSession: () => {}, reopenSession: async () => { throw new Error("notification must be suppressed"); },
    resolveSessionPath: async () => null, invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  try {
    await controller.abortDescendants("stop-root");
    assert.deepEqual(order, ["queued grandchild", "running child"]);
    await assert.rejects(controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "stop-root" } },
      profile: "explore", parentToolCallId: "call", task: "read", description: "Read",
    }), /Parent session was stopped/);
    controller.allowDescendantStarts("stop-root");
    // This child completed before Stop and its notification was delayed. The
    // subsequent user turn must not receive it as a fresh instruction.
    await controller.extensionRuntime.notifyParent(completed(childId, "stop-root", "completed"));
    assert.deepEqual(order, ["queued grandchild", "running child"]);
  } finally {
    runs.delete(childId);
    runs.delete(grandchildId);
    for (const id of ["stop-root", childId, grandchildId]) globalThis.__piSubagentStoppedParents?.delete(id);
    globalThis.__piSubagentPendingNotifications?.delete(pendingKey);
    globalThis.__piSubagentSuppressedNotifications?.delete(pendingKey);
  }
});

test("Stop suppresses a just-completed background child after the next user turn starts", async () => {
  const id = "completed-before-stop";
  const parentId = "root-after-stop";
  const pendingKey = JSON.stringify([id, "tool-call"]);
  (globalThis.__piSubagentPendingNotifications ??= new Map()).set(pendingKey, parentId);
  const controller = createSubagentController({
    getSession: () => undefined,
    registerSession: () => {}, reopenSession: async () => { throw new Error("late notification must not reopen the parent"); },
    resolveSessionPath: async () => null, invalidateSessionList: () => {},
  });
  try {
    await controller.abortDescendants(parentId);
    controller.allowDescendantStarts(parentId);
    await controller.extensionRuntime.notifyParent({ ...completedRun(), sessionId: id, parentSessionId: parentId });
    assert.equal(globalThis.__piSubagentPendingNotifications.has(pendingKey), false);
  } finally {
    globalThis.__piSubagentStoppedParents?.delete(parentId);
    globalThis.__piSubagentPendingNotifications?.delete(pendingKey);
    globalThis.__piSubagentSuppressedNotifications?.delete(pendingKey);
  }
});

test("destroy clears the Stop marker while preserving suppression for an old background result", async () => {
  const parentId = "closed-after-stop";
  const run = { ...completedRun(), sessionId: "closed-child", parentSessionId: parentId };
  const pendingKey = JSON.stringify([run.sessionId, run.parentToolCallId]);
  (globalThis.__piSubagentPendingNotifications ??= new Map()).set(pendingKey, parentId);
  let alive = true;
  const controller = createSubagentController({
    getSession: (id) => id === parentId ? { isAlive: () => alive } : undefined,
    registerSession: () => {}, reopenSession: async () => { throw new Error("old result must not reopen the parent"); },
    resolveSessionPath: async () => null, invalidateSessionList: () => {},
  });
  try {
    await controller.abortDescendants(parentId);
    assert.equal(globalThis.__piSubagentStoppedParents.has(parentId), true);
    alive = false;
    controller.forgetSession(parentId);
    assert.equal(globalThis.__piSubagentStoppedParents.has(parentId), false);
    await controller.extensionRuntime.notifyParent(run);
    assert.equal(globalThis.__piSubagentPendingNotifications.has(pendingKey), false);
  } finally {
    globalThis.__piSubagentStoppedParents?.delete(parentId);
    globalThis.__piSubagentPendingNotifications?.delete(pendingKey);
    globalThis.__piSubagentSuppressedNotifications?.delete(pendingKey);
  }
});

test("stopping an absent session does not retain a root Stop marker", async () => {
  const parentId = "deleted-root-without-wrapper";
  const controller = createSubagentController({
    getSession: () => undefined,
    registerSession: () => {}, reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null, invalidateSessionList: () => {},
  });
  await controller.abortDescendants(parentId);
  assert.equal(globalThis.__piSubagentStoppedParents?.has(parentId), false);
});

test("old notification does not consume or erase a resumed run with the same session ID", async () => {
  const delivered = [];
  const controller = createSubagentController(idleParentDependencies(delivered));
  const old = { ...completedRun(), sessionId: "resumed-notification", parentToolCallId: "old-call" };
  const next = { ...old, parentToolCallId: "new-call", result: "new result" };
  const oldKey = JSON.stringify([old.sessionId, old.parentToolCallId]);
  const nextKey = JSON.stringify([next.sessionId, next.parentToolCallId]);
  const pending = globalThis.__piSubagentPendingNotifications ??= new Map();
  pending.set(oldKey, old.parentSessionId);
  try {
    await controller.abortDescendants(old.parentSessionId);
    controller.allowDescendantStarts(old.parentSessionId);
    pending.set(nextKey, next.parentSessionId);
    await controller.extensionRuntime.notifyParent(old);
    assert.equal(pending.has(nextKey), true);
    controller.extensionRuntime.markResultConsumed(next.sessionId, next.parentSessionId);
    await controller.extensionRuntime.notifyParent(next);
    assert.equal(delivered.length, 0);
    assert.equal(pending.has(nextKey), false);
  } finally {
    pending.delete(oldKey);
    pending.delete(nextKey);
    globalThis.__piSubagentSuppressedNotifications?.delete(oldKey);
    globalThis.__piSubagentSuppressedNotifications?.delete(nextKey);
    globalThis.__piSubagentStoppedParents?.delete(old.parentSessionId);
  }
});

test("a queue status persistence failure releases admission and permits a later resume", async () => {
  const sessionId = "resume-after-status-error";
  const parentId = "resume-owner";
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1, parentSessionId: parentId, parentSessionPath: "/tmp/resume-owner.jsonl",
      profile: "explore", description: "Explore", task: "read", runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, tools: [], appendSystemPrompt: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "custom", customType: "pi-web:subagent-result", data: {
      version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z",
    } },
  ];
  const rejectedStatuses = new Set(["queued", "running"]);
  let prompts = 0;
  const child = {
    sessionFile: "/tmp/resume-after-status-error.jsonl", isAlive: () => true, isRunning: () => false,
    inner: {
      sessionManager: { getEntries: () => entries, appendCustomEntry: (type, data) => {
        if (type === "pi-web:subagent-status" && rejectedStatuses.delete(data.status)) {
          throw new Error(`${data.status} status persistence failed`);
        }
        entries.push({ type: "custom", customType: type, data });
      } },
      prompt: async () => { prompts += 1; }, getLastAssistantText: () => "recovered", abort: async () => {},
    },
  };
  const parent = {
    sessionFile: "/tmp/resume-owner.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false,
    inner: { sessionManager: { getSessionId: () => parentId, getEntries: () => [] } },
  };
  const controller = createSubagentController({
    getSession: (id) => id === sessionId ? child : parent,
    registerSession: () => {}, reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile, invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  const request = {
    parentContext: parent.inner, parentToolCallId: "call", sessionId,
    task: "continue", description: "Continue",
  };
  await assert.rejects(controller.extensionRuntime.resume(request), /queued status persistence failed/);
  assert.equal(globalThis.__piSubagentRootAdmissions?.get(parentId), undefined);
  assert.equal(globalThis.__piSubagentRuns?.has(sessionId), false);
  const failedRun = await controller.extensionRuntime.resume({ ...request, parentToolCallId: "retry-running" });
  assert.equal((await failedRun.completion).status, "failed");
  assert.equal(globalThis.__piSubagentRootAdmissions?.get(parentId), undefined);
  assert.equal(globalThis.__piSubagentRuns?.has(sessionId), false);
  const next = await controller.extensionRuntime.resume({ ...request, parentToolCallId: "retry-success" });
  assert.equal((await next.completion).status, "completed");
  assert.equal(prompts, 1, "rolled-back queue item must not start later");
  assert.equal(globalThis.__piSubagentRootAdmissions?.get(parentId), undefined);
});

test("branch Stop waits for child finalization before parent worktree cleanup", async () => {
  const parentId = "worktree-parent";
  const childId = "worktree-child";
  const steps = [];
  let finalizeChild;
  const completion = new Promise((resolve) => { finalizeChild = resolve; });
  const runs = globalThis.__piSubagentRuns ??= new Map();
  runs.set(childId, {
    run: { ...completedRun(), sessionId: childId, parentSessionId: parentId, status: "running" },
    completion, abortRequested: false,
  });
  const wrapper = {
    isAlive: () => true, isRunning: () => true,
    inner: { abort: async () => { steps.push("abort acknowledged"); } },
  };
  const controller = createSubagentController({
    getSession: (id) => id === childId ? wrapper : undefined,
    registerSession: () => {}, reopenSession: async () => wrapper,
    resolveSessionPath: async () => null, invalidateSessionList: () => {},
  });
  try {
    let settled = false;
    const stopped = controller.abortDescendants(parentId).then(() => { settled = true; steps.push("parent can clean worktree"); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(steps, ["abort acknowledged"]);
    assert.equal(settled, false);
    runs.delete(childId);
    steps.push("child finalized");
    finalizeChild({ ...completedRun(), sessionId: childId, status: "aborted" });
    await stopped;
    assert.deepEqual(steps, ["abort acknowledged", "child finalized", "parent can clean worktree"]);
  } finally {
    runs.delete(childId);
    globalThis.__piSubagentStoppedParents?.delete(parentId);
    globalThis.__piSubagentStoppedParents?.delete(childId);
  }
});

test("Stop tolerates a child that stopped running but is still finalizing", async () => {
  const parentId = "terminal-transition-owner";
  const childId = "terminal-transition-child";
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const runs = globalThis.__piSubagentRuns ??= new Map();
  runs.set(childId, {
    run: { ...completedRun(), sessionId: childId, parentSessionId: parentId, status: "running" },
    completion, abortRequested: false,
  });
  const controller = createSubagentController({
    getSession: (id) => id === childId ? { isAlive: () => true, isRunning: () => false } : undefined,
    registerSession: () => {}, reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null, invalidateSessionList: () => {},
  });
  try {
    let settled = false;
    const stopped = controller.abortDescendants(parentId).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false);
    runs.delete(childId);
    resolveCompletion({ ...completedRun(), sessionId: childId, status: "completed" });
    await stopped;
    assert.equal(settled, true);
  } finally {
    runs.delete(childId);
    globalThis.__piSubagentStoppedParents?.delete(parentId);
    globalThis.__piSubagentStoppedParents?.delete(childId);
  }
});

async function liveControllerFixture(t, profiles = {}, fixtureOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-runtime-limits-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-home");
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  });
  const profilesDir = join(cwd, ".pi", "agents");
  await mkdir(profilesDir, { recursive: true });
  for (const [name, child] of Object.entries(profiles)) {
    await writeFile(join(profilesDir, `${name}.md`), `---\nname: ${name}\ndescription: ${name}\ntools: none\nload_skills: false\nload_extensions: false\nrun_in_background: false\npi_web_orchestration:\n  kind: orchestrator\n  allowed_children:\n    - ${child}\n---\nCoordinate the task.\n`);
  }
  const rootManager = SessionManager.create(cwd, join(cwd, "root-sessions"));
  rootManager.appendMessage({ role: "user", content: "delegate", timestamp: Date.now() });
  const rootId = rootManager.getSessionId();
  const fakeModel = { provider: "test", id: "no-network" };
  const sessions = new Map();
  const blockers = new Map();
  let serviceCalls = 0;
  const root = {
    cwd, sessionFile: rootManager.getSessionFile(), isAlive: () => true, isRunning: () => false,
    inner: {
      sessionManager: rootManager, modelRuntime: { getModel: () => undefined, getModels: () => [] },
      model: fakeModel, agent: { state: { thinkingLevel: "off" } },
    },
  };
  sessions.set(rootId, root);
  const controller = createSubagentController({
    getSession: (id) => sessions.get(id),
    registerSession(inner) {
      sessions.set(inner.sessionId, {
        cwd: inner.__testCwd, sessionFile: inner.sessionFile, inner,
        isAlive: () => true, isRunning: () => inner.__testRunning(),
      });
    },
    reopenSession: async () => { throw new Error("test sessions stay live"); },
    resolveSessionPath: async (id) => fixtureOptions.resolveSessionPath
      ? fixtureOptions.resolveSessionPath(id)
      : sessions.get(id)?.sessionFile ?? null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
    ...(fixtureOptions.createWorktree ? { createWorktree: fixtureOptions.createWorktree } : {}),
    ...(fixtureOptions.removeWorktree ? { removeWorktree: fixtureOptions.removeWorktree } : {}),
    async createServices(options) {
      serviceCalls += 1;
      await fixtureOptions.beforeServicesReturn?.();
      const extensions = options.resourceLoaderOptions.extensionsOverride
        ? [{ path: "<inline:pi-web-subagents>", tools: new Map(["Agent", "get_subagent_result", "steer_subagent"].map((name) => [name, {}])) }]
        : [];
      extensions.push(...(fixtureOptions.extensions ?? []));
      const baseSkills = fixtureOptions.discoveredSkills ?? [];
      const filtered = options.resourceLoaderOptions.skillsOverride?.({ skills: baseSkills, diagnostics: [] }) ?? { skills: baseSkills };
      const basePrompt = options.resourceLoaderOptions.appendSystemPrompt ?? [];
      const appendPrompt = options.resourceLoaderOptions.appendSystemPromptOverride?.(basePrompt) ?? basePrompt;
      return { __testCwd: options.cwd, resourceLoader: {
        getExtensions: () => ({ extensions }),
        getSkills: () => filtered,
        getAppendSystemPrompt: () => appendPrompt,
      } };
    },
    async createFromServices({ sessionManager, services }) {
      const id = sessionManager.getSessionId();
      const ownProfile = sessionManager.getEntries().find((entry) => entry.customType === "pi-web:subagent").data.profile;
      let running = false;
      let unblock = () => {};
      const inner = {
        sessionId: id, sessionFile: sessionManager.getSessionFile(), sessionManager,
        modelRuntime: root.inner.modelRuntime, model: fakeModel,
        agent: { state: { thinkingLevel: "off" } },
        subscribe: () => () => {}, getLastAssistantText: () => "done",
        __testRunning: () => running,
        __testCwd: services.__testCwd,
        prompt: async () => {
          running = true;
          await new Promise((resolve) => { unblock = resolve; blockers.set(id, resolve); });
          running = false;
        },
        abort: async () => {
          if (fixtureOptions.failAbortProfile === ownProfile) throw new Error(`abort failed: ${ownProfile}`);
          unblock();
        },
      };
      return { session: inner };
    },
  });
  const start = (parentId, profile, index = 0, overrides = {}) => controller.extensionRuntime.start({
    parentContext: sessions.get(parentId).inner, parentToolCallId: `call-${parentId}-${index}`,
    profile, task: "inspect", description: "Inspect", ...overrides,
  });
  return {
    cwd, rootId, rootManager, sessions, blockers, start, controller, get serviceCalls() { return serviceCalls; },
    async cleanup() {
      await controller.abortDescendants(rootId);
      for (const sessionId of sessions.keys()) controller.forgetSession(sessionId);
      assert.equal(globalThis.__piSubagentRootAdmissions?.get(rootId), undefined);
      assert.equal(globalThis.__piSubagentBranchAdmissions?.get(cwd), undefined);
    },
  };
}

test("a third-level orchestrator has no delegation tools and a fourth child is denied before services", async (t) => {
  const fixture = await liveControllerFixture(t, { coordinator1: "coordinator2", coordinator2: "coordinator3", coordinator3: "explore" });
  try {
    await writeFile(join(fixture.cwd, "task.txt"), "Root task attachment");
    const first = await fixture.start(fixture.rootId, "coordinator1", 1, { inputFiles: ["task.txt"] });
    const overrides = [
      [{ inputFiles: ["task.txt"] }, /cannot attach input files/],
      [{ model: "other/model" }, /cannot override their pinned profile/],
      [{ thinking: "max" }, /cannot override their pinned profile/],
      [{ maxTurns: 0 }, /cannot override their pinned profile/],
      [{ inheritContext: true }, /cannot override their pinned profile/],
      [{ isolation: "worktree" }, /cannot create an isolated worktree/],
      [{ runInBackground: true }, /must run in foreground/],
      [{ runInBackground: false }, /cannot override their pinned profile/],
    ];
    for (const [override, message] of overrides) {
      await assert.rejects(fixture.start(first.run.sessionId, "coordinator2", 10, override), message);
      assert.equal(fixture.serviceCalls, 1, "nested overrides must reject before services");
    }
    const second = await fixture.start(first.run.sessionId, "coordinator2", 2);
    const third = await fixture.start(second.run.sessionId, "coordinator3", 3);
    assert.equal(fixture.serviceCalls, 3);
    const marker = fixture.sessions.get(third.run.sessionId).inner.sessionManager.getEntries()
      .find((entry) => entry.customType === "pi-web:subagent").data;
    assert.equal(marker.resourceSnapshot.version, 1);
    assert.deepEqual(marker.resourceSnapshot.tools, []);
    await assert.rejects(fixture.start(third.run.sessionId, "explore", 4), /not allowed to delegate/);
    assert.equal(fixture.serviceCalls, 3);
  } finally {
    await fixture.cleanup();
  }
});

test("Main pins direct children while nested orchestrators receive only their own symlinked skill", async (t) => {
  const skillCwd = await mkdtemp(join(tmpdir(), "pi-web-shared-skill-"));
  t.after(async () => rm(skillCwd, { recursive: true, force: true }));
  const source = join(skillCwd, "coordinator-v1.md");
  const newSource = join(skillCwd, "coordinator-v2.md");
  const link = join(skillCwd, "SKILL.md");
  await writeFile(source, "---\nname: coordinator\ndescription: Coordinate agents\n---\nRoute each task to a specialist.");
  await writeFile(newSource, "---\nname: coordinator\ndescription: Coordinate agents\n---\nDifferent instructions.");
  await symlink(source, link);
  const fixture = await liveControllerFixture(t,
    { coordinator1: "coordinator2", coordinator2: "explore" },
    { discoveredSkills: [{ name: "coordinator", description: "Coordinate agents", filePath: link,
      baseDir: skillCwd, disableModelInvocation: false, sourceInfo: { source: "local", scope: "user" } }] });
  try {
    for (const name of ["coordinator1", "coordinator2"]) {
      await writeFile(join(fixture.cwd, ".pi", "agents", `${name}.md`),
        `---\nname: ${name}\ndescription: ${name}\ntools: none\nload_skills: false\nload_extensions: false\n` +
        `pi_web_selected_skills:\n  - ${link}\n` +
        `${name === "coordinator2" ? "prompt_mode: replace\n" : ""}` +
        `pi_web_orchestration:\n  kind: orchestrator\n  allowed_children: [${name === "coordinator1" ? "coordinator2" : "explore"}]\n---\nOnly route work.\n`);
    }
    const firstProfile = resolveSubagentProfile(fixture.cwd, "coordinator1");
    fixture.rootManager.appendCustomEntry("pi-web:main-resources", {
      version: 1,
      orchestration: {
        allowedChildren: ["coordinator1"],
        childProfiles: { coordinator1: profileAuthorityPin(firstProfile) },
      },
    });
    await assert.rejects(fixture.start(fixture.rootId, "explore", 1), /Main is not allowed/);
    assert.equal(fixture.serviceCalls, 0);
    const first = await fixture.start(fixture.rootId, "coordinator1", 2);
    const second = await fixture.start(first.run.sessionId, "coordinator2", 3);
    const worker = await fixture.start(second.run.sessionId, "explore", 4);
    for (const agent of [first, second]) {
      const snapshot = fixture.sessions.get(agent.run.sessionId).inner.sessionManager.getEntries()
        .find((entry) => entry.customType === "pi-web:subagent").data.resourceSnapshot;
      assert.equal(snapshot.version, 3);
      assert.deepEqual(snapshot.tools, ["Agent", "get_subagent_result", "steer_subagent"]);
      assert.equal(snapshot.selectedSkills[0].content.includes("Route each task to a specialist"), true);
      assert.equal(snapshot.selectedSkills[0].realPath, source);
      assert.equal(snapshot.appendSystemPrompt.some((part) => part.includes("Route each task to a specialist")), true);
      if (agent === second) assert.match(snapshot.exactSystemPrompt, /Route each task to a specialist/);
    }
    const workerSnapshot = fixture.sessions.get(worker.run.sessionId).inner.sessionManager.getEntries()
      .find((entry) => entry.customType === "pi-web:subagent").data.resourceSnapshot;
    assert.equal(workerSnapshot.selectedSkills, undefined, "workers do not inherit coordinator skills");
    assert.equal(workerSnapshot.tools.includes("Agent"), false);
    await rm(link);
    await symlink(newSource, link);
    await assert.rejects(fixture.start(fixture.rootId, "coordinator1", 5), /profile changed since Main session start/);
    await assert.rejects(fixture.start(first.run.sessionId, "coordinator2", 6), /profile changed since orchestrator start/);
  } finally {
    await fixture.cleanup();
  }
});

test("a specialist loads only a named extension tool with the legacy load-all switch off", async (t) => {
  const extensionCwd = await mkdtemp(join(tmpdir(), "pi-web-selected-extension-"));
  t.after(async () => rm(extensionCwd, { recursive: true, force: true }));
  const extensionPath = join(extensionCwd, "sentry.ts");
  await writeFile(extensionPath, "export const sentry_query = () => null");
  const fixture = await liveControllerFixture(t, {}, { extensions: [{ path: extensionPath,
    tools: new Map([["sentry_query", {}], ["unrelated_tool", {}]]) }] });
  try {
    await writeFile(join(fixture.cwd, ".pi", "agents", "sentry-worker.md"),
      `---\nname: sentry-worker\ndescription: Query Sentry\ntools: none\nload_skills: false\nload_extensions: false\n` +
      `pi_web_selected_extension_tools:\n  - extensionPath: ${extensionPath}\n    toolName: sentry_query\n---\nQuery the incidents.\n`);
    const worker = await fixture.start(fixture.rootId, "sentry-worker");
    const snapshot = fixture.sessions.get(worker.run.sessionId).inner.sessionManager.getEntries()
      .find((entry) => entry.customType === "pi-web:subagent").data.resourceSnapshot;
    assert.equal(snapshot.version, 3);
    assert.deepEqual(snapshot.tools, ["sentry_query"]);
    assert.equal(snapshot.selectedExtensionTools[0].extensionPath, extensionPath);
    assert.equal(snapshot.loadExtensions, true, "selected IDs activate only their own tools");
    assert.equal(snapshot.tools.includes("Agent"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("a markerless Main session retains legacy delegation when the global Main config is saved", async (t) => {
  const fixture = await liveControllerFixture(t);
  try {
    await mkdir(join(fixture.cwd, "agent-home"), { recursive: true });
    await writeFile(join(fixture.cwd, "agent-home", "main-agent-config.json"), JSON.stringify({
      version: 1, orchestration: { allowedChildren: [] },
    }));
    const legacyChild = await fixture.start(fixture.rootId, "explore");
    assert.equal(legacyChild.run.profile, "explore");
  } finally {
    await fixture.cleanup();
  }
});

test("an explicit allow-list cannot call an ancestor profile recursively", async (t) => {
  const fixture = await liveControllerFixture(t, { coordinator1: "coordinator2", coordinator2: "coordinator1" });
  try {
    const first = await fixture.start(fixture.rootId, "coordinator1", 1);
    const second = await fixture.start(first.run.sessionId, "coordinator2", 2);
    const metadata = fixture.sessions.get(second.run.sessionId).inner.sessionManager.getEntries()
      .find((entry) => entry.customType === "pi-web:subagent").data;
    assert.equal(metadata.parentSessionPath, first.run.sessionPath);
    await assert.rejects(fixture.start(second.run.sessionId, "coordinator1", 3), /Recursive subagent profile is not allowed/);
    assert.equal(fixture.serviceCalls, 2, "a recursive branch must fail before services");
  } finally {
    await fixture.cleanup();
  }
});

test("32 admitted descendants fail fast and release slots on completion and queued cancellation", async (t) => {
  const fixture = await liveControllerFixture(t);
  try {
    const executions = [];
    for (let index = 0; index < 32; index += 1) executions.push(await fixture.start(fixture.rootId, "explore", index));
    assert.equal(globalThis.__piSubagentRootAdmissions.get(fixture.rootId), 32);
    assert.equal(fixture.serviceCalls, 32);
    await assert.rejects(fixture.start(fixture.rootId, "explore", 33), /already has 32 active subagents/);
    assert.equal(fixture.serviceCalls, 32, "full admission must reject before creating services");

    // Complete an active child and confirm a new one can take the released slot.
    fixture.blockers.get(executions[0].run.sessionId)();
    await executions[0].completion;
    assert.equal(globalThis.__piSubagentRootAdmissions.get(fixture.rootId), 31);
    const replacement = await fixture.start(fixture.rootId, "explore", 34);
    assert.equal(fixture.serviceCalls, 33);

    // The final child remains queued under the parent's concurrency setting.
    const queued = executions.at(-1);
    assert.equal((await fixture.controller.get(queued.run.sessionId)).status, "queued");
    await fixture.controller.abort(queued.run.sessionId);
    assert.equal((await queued.completion).status, "aborted");
    assert.equal(globalThis.__piSubagentRootAdmissions.get(fixture.rootId), 31);
    await fixture.start(fixture.rootId, "explore", 35);
    assert.equal(fixture.serviceCalls, 34);
    assert.equal(replacement.run.status, "queued");
  } finally {
    await fixture.cleanup();
  }
});

test("Stop invalidates setup still in flight after the next prompt reopens delegation", async (t) => {
  let enteredServices;
  let releaseServices;
  const servicesEntered = new Promise((resolve) => { enteredServices = resolve; });
  const servicesReleased = new Promise((resolve) => { releaseServices = resolve; });
  const fixture = await liveControllerFixture(t, {}, {
    beforeServicesReturn: async () => { enteredServices(); await servicesReleased; },
  });
  try {
    const pending = fixture.start(fixture.rootId, "explore", 1);
    await servicesEntered;
    assert.equal(globalThis.__piSubagentRootAdmissions.get(fixture.rootId), 1);
    await fixture.controller.abortDescendants(fixture.rootId);
    fixture.controller.allowDescendantStarts(fixture.rootId);
    releaseServices();
    await assert.rejects(pending, /Subagent start was stopped/);
    assert.equal(globalThis.__piSubagentRootAdmissions?.get(fixture.rootId), undefined);
    assert.equal(fixture.sessions.size, 1, "stale setup must not register a child after Stop");
  } finally {
    releaseServices();
    await fixture.cleanup();
  }
});

test("Stop invalidates a resume still resolving its old session after a new prompt", async (t) => {
  let enteredResolve;
  let releaseResolve;
  const resolving = new Promise((resolve) => { enteredResolve = resolve; });
  const released = new Promise((resolve) => { releaseResolve = resolve; });
  let childPath;
  const fixture = await liveControllerFixture(t, {}, {
    resolveSessionPath: async () => { enteredResolve(); await released; return childPath; },
  });
  try {
    const childManager = SessionManager.create(fixture.cwd, join(fixture.cwd, "old-child-sessions"));
    childManager.appendCustomEntry("pi-web:subagent", {
      version: 1, parentSessionId: fixture.rootId,
      parentSessionPath: fixture.sessions.get(fixture.rootId).sessionFile,
      profile: "explore", description: "Old", task: "old", runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, tools: [], appendSystemPrompt: [], loadSkills: false, loadExtensions: false },
    });
    childManager.appendCustomEntry("pi-web:subagent-result", { version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z" });
    childPath = childManager.getSessionFile();
    const resuming = fixture.controller.extensionRuntime.resume({
      parentContext: fixture.sessions.get(fixture.rootId).inner,
      parentToolCallId: "old-call", sessionId: childManager.getSessionId(),
      task: "continue", description: "Continue",
    });
    await resolving;
    await fixture.controller.abortDescendants(fixture.rootId);
    fixture.controller.allowDescendantStarts(fixture.rootId);
    releaseResolve();
    await assert.rejects(resuming, /Subagent resume was stopped/);
    assert.equal(fixture.serviceCalls, 0);
    assert.equal(globalThis.__piSubagentRootAdmissions?.get(fixture.rootId), undefined);
  } finally {
    releaseResolve();
    await fixture.cleanup();
  }
});

test("failed child abort returns promptly and keeps its parent's isolated worktree", async (t) => {
  const removed = [];
  const fixture = await liveControllerFixture(t, { coordinator: "explore" }, {
    createWorktree: async (cwd) => ({ path: cwd, branch: "test-isolated" }),
    removeWorktree: async (_cwd, path) => { removed.push(path); },
    failAbortProfile: "explore",
  });
  let parent;
  let child;
  try {
    parent = await fixture.start(fixture.rootId, "coordinator", 1, { isolation: "worktree" });
    child = await fixture.start(parent.run.sessionId, "explore", 2);
    await assert.rejects(fixture.controller.abortDescendants(parent.run.sessionId), /abort failed: explore/);
    assert.equal((await fixture.controller.get(child.run.sessionId)).status, "running");

    // The parent finishes despite the failed abort. The worker still uses its
    // cwd, so cleanup must retain the branch and report the reason.
    fixture.blockers.get(parent.run.sessionId)();
    const result = await parent.completion;
    assert.match(result.worktreeCleanupError, /Worktree retained.*descendant is still active/);
    assert.deepEqual(removed, []);
    fixture.blockers.get(child.run.sessionId)();
    await child.completion;
  } finally {
    if (child) fixture.blockers.get(child.run.sessionId)?.();
    if (parent) fixture.blockers.get(parent.run.sessionId)?.();
    await fixture.cleanup();
  }
});

test("one isolated branch cleans up while an unrelated sibling stays active", async (t) => {
  let nextBranch = 0;
  const removed = [];
  const fixture = await liveControllerFixture(t, { coordinator: "explore" }, {
    createWorktree: async (cwd) => {
      const path = join(cwd, `branch-${++nextBranch}`);
      await mkdir(path);
      return { path, branch: `branch-${nextBranch}` };
    },
    removeWorktree: async (_cwd, path) => { removed.push(path); },
  });
  try {
    const first = await fixture.start(fixture.rootId, "coordinator", 1, { isolation: "worktree" });
    const second = await fixture.start(fixture.rootId, "coordinator", 2, { isolation: "worktree" });
    fixture.blockers.get(first.run.sessionId)();
    const completedFirst = await first.completion;
    assert.equal(completedFirst.worktreeCleanupError, undefined);
    assert.deepEqual(removed, [first.run.worktreePath]);
    fixture.blockers.get(second.run.sessionId)();
    await second.completion;
    assert.deepEqual(removed, [first.run.worktreePath, second.run.worktreePath]);
  } finally {
    await fixture.cleanup();
  }
});
