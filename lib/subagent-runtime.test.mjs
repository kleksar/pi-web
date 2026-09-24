import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const { createSubagentController, enforceOwnerAcceptance, scheduleSubagentRun, subagentRunsInBackground } = await jiti.import("./subagent-runtime.ts");
const { SUBAGENT_NOTIFICATION_PREFIX } = await jiti.import("./subagent-extension.ts");

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
  const parent = { inner: { sessionManager: { getSessionId: () => "parent" } }, sessionFile: "/tmp/parent.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
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
  const parent = { inner: { sessionManager: { getSessionId: () => "parent" } }, sessionFile: "/tmp/parent.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
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

test("dispatcher cannot delegate straight to a reader, or silently override its owner's model", async () => {
  const main = {
    cwd: "/tmp", sessionFile: "/tmp/main.jsonl", isAlive: () => true,
    inner: { sessionId: "main", sessionManager: {
      getSessionId: () => "main", getEntries: () => [{ type: "custom", customType: "pi-web:main-dispatcher", data: { version: 1, enabled: true } }],
    } },
  };
  const controller = createSubagentController({
    getSession: () => main, registerSession: () => {},
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null, invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  const request = { parentContext: main.inner, parentToolCallId: "call", task: "Investigate", description: "Investigate" };
  await assert.rejects(controller.extensionRuntime.start({ ...request, profile: "orchestration-code-reader" }),
    /only start the orchestration task owner/);
  await assert.rejects(controller.extensionRuntime.start({ ...request, profile: "orchestration-task-owner", model: "openai-codex/gpt-6-luna" }),
    /model, effort, context, and worktree are fixed/);
});

test("dispatcher rejects non-text original input before task owner creation", async () => {
  const main = {
    cwd: "/tmp", sessionFile: "/tmp/main-image.jsonl", isAlive: () => true,
    inner: { sessionId: "main-image", sessionManager: {
      getSessionId: () => "main-image", getEntries: () => [
        { type: "custom", customType: "pi-web:main-dispatcher", data: { version: 1, enabled: true } },
        { type: "message", id: "original-image", message: { role: "user", content: [
          { type: "text", text: "Please inspect this image" }, { type: "image", data: "AA", mimeType: "image/png" },
        ] } },
      ],
    } },
  };
  const controller = createSubagentController({
    getSession: () => main, registerSession: () => { throw new Error("must not start"); },
    reopenSession: async () => { throw new Error("unused"); }, resolveSessionPath: async () => null,
    invalidateSessionList: () => {}, isBuiltInSubagentsEnabled: () => true,
  });
  await assert.rejects(controller.extensionRuntime.start({
    parentContext: main.inner, parentToolCallId: "image-call", task: "inspect", description: "inspect",
    profile: "orchestration-task-owner",
  }), /cannot process a non-text original user request/);
});

test("dispatcher task owner always runs in background so Main can accept steering", () => {
  assert.equal(subagentRunsInBackground(true, "orchestration-task-owner", false, false), true);
  assert.equal(subagentRunsInBackground(true, "orchestration-code-reader", false, true), false);
  assert.equal(subagentRunsInBackground(false, "ordinary", false, true), false);
});

test("two concurrent owner starts for one real Main user entry are rejected before async setup", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-owner-dedup-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const repo = join(temp, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    process.env.PI_CODING_AGENT_DIR = join(temp, "agent-config");
    const main = {
      cwd: repo, sessionFile: join(temp, "main.jsonl"), isAlive: () => true,
      inner: { sessionId: "dedup-main", sessionManager: {
        getSessionId: () => "dedup-main", getEntries: () => [
          { type: "custom", customType: "pi-web:main-dispatcher", data: { version: 1, enabled: true } },
          { type: "message", id: "dedup-original", message: { role: "user", content: "Implement this task" } },
        ],
      } },
    };
    const controller = createSubagentController({
      getSession: () => main, registerSession: () => {}, reopenSession: async () => main,
      resolveSessionPath: async () => null, invalidateSessionList: () => {},
      isBuiltInSubagentsEnabled: () => true,
    });
    const request = { parentContext: main.inner, parentToolCallId: "owner-one", profile: "orchestration-task-owner",
      task: "Implement this task", description: "Implement" };
    const first = controller.extensionRuntime.start(request);
    await assert.rejects(controller.extensionRuntime.start({ ...request, parentToolCallId: "owner-two" }),
      /task owner is already active for this Main user request/);
    await assert.rejects(first, (error) => !/task owner is already active/.test(error.message));
    // Failure releases the claim; a retry may fail for another setup reason, never stale idempotency.
    await assert.rejects(controller.extensionRuntime.start(request), (error) => !/task owner is already active/.test(error.message));
  } finally {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(temp, { recursive: true, force: true });
  }
});

test("task-owner completion requires a current host acceptance artifact", async () => {
  const completed = { ...completedRun(), status: "completed", profile: "orchestration-task-owner" };
  const input = { taskId: "task", cwd: "/tmp", ownerEntries: [] };
  assert.equal((await enforceOwnerAcceptance(completed, input, async () => true)).status, "completed");
  const rejected = await enforceOwnerAcceptance(completed, input, async () => false);
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error, /without host acceptance/);
  const unavailable = await enforceOwnerAcceptance(completed, input, async () => { throw new Error("stale rules"); });
  assert.match(unavailable.error, /stale rules/);
  assert.equal((await enforceOwnerAcceptance({ ...completed, status: "aborted" }, input, async () => false)).status, "aborted");
});

test("background reports for independent readers in one task deliver one parent turn", async () => {
  const delivered = [];
  const controller = createSubagentController(idleParentDependencies(delivered));
  const first = { ...completedRun(), sessionId: "task-first", parentToolCallId: "call-one", rootTaskId: "task-batch", profile: "explore", result: "first" };
  const second = { ...first, sessionId: "task-second", parentToolCallId: "call-two", result: "second" };
  let finishSecond;
  const previousRuns = globalThis.__piSubagentRuns;
  globalThis.__piSubagentRuns = new Map([[second.sessionId, {
    run: { ...second, status: "running" },
    completion: new Promise((resolve) => { finishSecond = resolve; }),
    abortRequested: false,
  }]]);
  try {
    const firstNotification = controller.extensionRuntime.notifyParent(first);
    assert.equal(delivered.length, 0);
    finishSecond(second);
    await Promise.all([firstNotification, controller.extensionRuntime.notifyParent(second)]);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].message.content, /first/);
    assert.match(delivered[0].message.content, /second/);
    assert.deepEqual(delivered[0].options, { deliverAs: "followUp", triggerTurn: true });
    await controller.extensionRuntime.notifyParent(first);
    assert.equal(delivered.length, 1, "the same run may not wake the model twice");
  } finally {
    globalThis.__piSubagentRuns = previousRuns;
  }
});

test("batch timeout includes completed siblings and delivers a slow sibling later", async () => {
  const delivered = [];
  const controller = createSubagentController({ ...idleParentDependencies(delivered), batchWaitMs: 30 });
  const first = { ...completedRun(), sessionId: "mixed-first", parentToolCallId: "mixed-a", rootTaskId: "mixed-task", result: "result A" };
  const second = { ...first, sessionId: "mixed-second", parentToolCallId: "mixed-b", result: "result B" };
  const third = { ...first, sessionId: "mixed-third", parentToolCallId: "mixed-c", result: "result C" };
  let finishSecond;
  let finishThird;
  const previousRuns = globalThis.__piSubagentRuns;
  globalThis.__piSubagentRuns = new Map([
    [second.sessionId, { run: { ...second, status: "running" }, completion: new Promise((resolve) => { finishSecond = resolve; }), abortRequested: false }],
    [third.sessionId, { run: { ...third, status: "running" }, completion: new Promise((resolve) => { finishThird = resolve; }), abortRequested: false }],
  ]);
  try {
    const pendingFirst = controller.extensionRuntime.notifyParent(first);
    finishSecond(second);
    await controller.extensionRuntime.notifyParent(second).then(() => pendingFirst);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].message.content, /result A/);
    assert.match(delivered[0].message.content, /result B/);
    assert.doesNotMatch(delivered[0].message.content, /result C/);
    finishThird(third);
    await controller.extensionRuntime.notifyParent(third);
    assert.equal(delivered.length, 2);
    assert.match(delivered[1].message.content, /result C/);
  } finally {
    globalThis.__piSubagentRuns = previousRuns;
  }
});

test("batch collect waits for queued children and refuses a child owned by another parent", async () => {
  const controller = createSubagentController(idleParentDependencies([]));
  const queued = { ...completedRun(), sessionId: "collect-queued", parentToolCallId: "collect-a", status: "queued" };
  const done = { ...completedRun(), sessionId: "collect-done", parentToolCallId: "collect-b" };
  const outsider = { ...completedRun(), sessionId: "collect-outsider", parentSessionId: "other" };
  const previousRuns = globalThis.__piSubagentRuns;
  const entries = new Map([queued, done, outsider].map((run) => [run.sessionId, { run, completion: Promise.resolve(run), abortRequested: false }]));
  globalThis.__piSubagentRuns = entries;
  try {
    await assert.rejects(controller.extensionRuntime.collect([done.sessionId, outsider.sessionId], "parent-session", false),
      /does not belong/);
    const collecting = controller.extensionRuntime.collect([queued.sessionId, done.sessionId], "parent-session", true);
    setTimeout(() => { entries.get(queued.sessionId).run = { ...queued, status: "completed", result: "queue drained" }; }, 50);
    const results = await collecting;
    assert.deepEqual(results.map((run) => run.status), ["completed", "completed"]);
  } finally {
    globalThis.__piSubagentRuns = previousRuns;
  }
});

test("two tasks share a global model-call limit, reserve owner capacity, and cancel a queued call", async () => {
  const started = [];
  let releaseA;
  let releaseB;
  let releaseOwner;
  const create = (family, owner, execute, onCancel = () => {}) => {
    let current = { status: "queued" };
    const queued = scheduleSubagentRun(family, owner, true, execute,
      (state) => { current = { status: state }; },
      () => { current = { status: "aborted" }; onCancel(); },
      () => current, 4);
    return queued;
  };
  const first = create("shared-task-a:workers", false, () => new Promise((resolve) => {
    started.push("worker A"); releaseA = () => resolve({ status: "completed" });
  }));
  const second = create("shared-task-b:workers", false, () => new Promise((resolve) => {
    started.push("worker B"); releaseB = () => resolve({ status: "completed" });
  }));
  let cancelled = false;
  const waiting = create("shared-task-c:workers", false, async () => {
    started.push("unexpected worker C"); return { status: "completed" };
  }, () => { cancelled = true; });
  const owner = create("shared-task-c:owners", true, () => new Promise((resolve) => {
    started.push("owner C"); releaseOwner = () => resolve({ status: "completed" });
  }));
  assert.deepEqual(started, ["worker A", "worker B", "owner C"]);
  assert.equal(waiting.cancel(), true);
  assert.equal((await waiting.promise).status, "aborted");
  assert.equal(cancelled, true);
  releaseA(); releaseB(); releaseOwner();
  await Promise.all([first.promise, second.promise, owner.promise]);
  assert.deepEqual(started, ["worker A", "worker B", "owner C"]);
});
