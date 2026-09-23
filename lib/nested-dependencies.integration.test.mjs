import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { createSubagentExtension } = await jiti.import("./subagent-extension.ts");
const { listSubagentProfiles, readSubagentSessionResources } = await jiti.import("./subagents.ts");

function toolMap(extensions) {
  const tools = new Map();
  for (const extension of extensions) {
    extension.factory({
      on() {},
      registerTool(tool) { tools.set(tool.name, tool); },
    });
  }
  return tools;
}

function profile(name, orchestration = "") {
  return `---\nname: ${name}\ndescription: ${name}\ntools: none\nload_skills: false\nload_extensions: false\nrun_in_background: false\n${orchestration}---\nPerform the delegated task.\n`;
}

async function dependencyFixture(t, { readerChain = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-dependencies-integration-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-home");
  const profilesDir = join(cwd, ".pi", "agents");
  await mkdir(profilesDir, { recursive: true });
  await writeFile(join(profilesDir, "coordinator.md"), profile("coordinator", `pi_web_orchestration:\n  kind: orchestrator\n  allowed_children: [${readerChain ? "reader, " : ""}analyst, writer]\n  depends_on:\n${readerChain ? "    analyst: [reader]\n" : ""}    writer: [analyst]\n`));
  if (readerChain) await writeFile(join(profilesDir, "reader.md"), profile("reader"));
  await writeFile(join(profilesDir, "analyst.md"), profile("analyst"));
  await writeFile(join(profilesDir, "writer.md"), profile("writer"));

  const rootManager = SessionManager.create(cwd, join(cwd, "root-sessions"));
  rootManager.appendMessage({ role: "user", content: "Produce a report", timestamp: Date.now() });
  const rootId = rootManager.getSessionId();
  const fakeModel = { provider: "local-test", id: "never-called" };
  const fakeRuntime = { getModel: () => undefined, getModels: () => [] };
  const sessions = new Map([[rootId, {
    cwd, sessionFile: rootManager.getSessionFile(), isAlive: () => true, isRunning: () => false,
    waitUntilReady: async () => {},
    inner: { sessionManager: rootManager, modelRuntime: fakeRuntime, model: fakeModel, agent: { state: { thinkingLevel: "off" } } },
  }]]);
  const sessionPaths = new Map([[rootId, rootManager.getSessionFile()]]);
  const prompts = [];
  const waiters = new Set();
  const behavior = {
    reader: async ({ attempt }) => `READER_ARTIFACT_${attempt}`,
    analyst: async ({ attempt }) => `ANALYST_ARTIFACT_${attempt}`,
    writer: async () => "WRITER_DONE",
  };
  const preflight = { hook: null };
  const activeCoordinators = new Set();
  let serviceCalls = 0;
  let controller;

  function notifyWaiters() {
    for (const waiter of waiters) {
      if (prompts.filter((entry) => entry.profile === waiter.profile).length < waiter.count) continue;
      waiters.delete(waiter);
      waiter.resolve(prompts.filter((entry) => entry.profile === waiter.profile).at(-1));
    }
  }

  function waitForPrompt(profileName, count) {
    const matches = prompts.filter((entry) => entry.profile === profileName);
    if (matches.length >= count) return Promise.resolve(matches.at(-1));
    return new Promise((resolve, reject) => {
      const waiter = {
        profile: profileName, count,
        resolve(record) { clearTimeout(timer); resolve(record); },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`Timed out waiting for ${profileName} prompt ${count}`));
      }, 5000);
      waiters.add(waiter);
    });
  }

  controller = createSubagentController({
    getSession: (id) => sessions.get(id),
    registerSession(inner) {
      sessionPaths.set(inner.sessionId, inner.sessionFile);
      sessions.set(inner.sessionId, {
        cwd, sessionFile: inner.sessionFile, inner,
        isAlive: () => true, isRunning: () => inner.__testRunning(), waitUntilReady: async () => {},
      });
    },
    async reopenSession(id, sessionFile) {
      const manager = SessionManager.open(sessionFile);
      assert.equal(manager.getSessionId(), id);
      const resources = readSubagentSessionResources(manager.getEntries());
      const extension = resources.orchestration && createSubagentExtension(
        controller.extensionRuntime,
        () => listSubagentProfiles(cwd),
        () => true,
        { allowedChildren: resources.orchestration.allowedChildren },
      );
      const inner = createFakeInner(manager, extension ? toolMap([extension]) : new Map());
      const wrapper = {
        cwd, sessionFile, inner, isAlive: () => true, isRunning: () => inner.__testRunning(), waitUntilReady: async () => {},
      };
      sessions.set(id, wrapper);
      sessionPaths.set(id, sessionFile);
      return wrapper;
    },
    resolveSessionPath: async (id) => sessionPaths.get(id) ?? null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
    async createServices(options) {
      serviceCalls += 1;
      const tools = toolMap(options.resourceLoaderOptions.extensionFactories ?? []);
      const extensions = tools.has("Agent") ? [{ path: "<inline:pi-web-subagents>", tools }] : [];
      return { resourceLoader: { getExtensions: () => ({ extensions }) }, tools };
    },
    async createFromServices({ services, sessionManager }) {
      return { session: createFakeInner(sessionManager, services.tools) };
    },
  });

  function createFakeInner(manager, registeredTools) {
    const ownProfile = manager.getEntries().find((entry) => entry.customType === "pi-web:subagent").data.profile;
    let lastText = "";
    let running = false;
    let releaseCoordinator;
    const inner = {
      sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionManager: manager,
      agent: { state: { thinkingLevel: "off" } }, modelRuntime: fakeRuntime, model: fakeModel,
      subscribe: () => () => {}, getLastAssistantText: () => lastText,
      __testTools: registeredTools, __testRunning: () => running,
      abort: async () => { releaseCoordinator?.(); },
      async prompt(task, options = {}) {
        running = true;
        // The real Pi prompt records the user request, then an assistant tool
        // call before Agent executes. Pi buffers JSONL until that first assistant.
        manager.appendMessage({ role: "user", content: task, timestamp: Date.now() });
        if (ownProfile === "coordinator") {
          manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Delegating specialist tasks" }], timestamp: Date.now(), stopReason: "toolUse" });
        }
        const attempt = prompts.filter((entry) => entry.profile === ownProfile).length + 1;
        const record = { profile: ownProfile, sessionId: manager.getSessionId(), manager, tools: registeredTools, task, attempt };
        prompts.push(record);
        notifyWaiters();
        try {
          if (ownProfile === "coordinator") {
            assert.ok(registeredTools.get("Agent"), "orchestrator exposes the actual Agent host tool");
            await new Promise((resolve) => { releaseCoordinator = resolve; record.release = resolve; });
            lastText = "Coordinator finished";
          } else {
            await preflight.hook?.(record);
            options.preflightResult?.(true);
            lastText = await behavior[ownProfile](record);
          }
          manager.appendMessage({ role: "assistant", content: [{ type: "text", text: lastText }], timestamp: Date.now(), stopReason: "stop" });
        } finally {
          releaseCoordinator = undefined;
          running = false;
        }
      },
    };
    return inner;
  }

  const rootTool = toolMap([createSubagentExtension(
    controller.extensionRuntime, () => listSubagentProfiles(cwd), () => true,
  )]).get("Agent");
  let rootCall = 0;
  let childCall = 0;
  async function startCoordinator(resume) {
    const count = prompts.filter((entry) => entry.profile === "coordinator").length + 1;
    const completion = rootTool.execute(`root-${++rootCall}`, {
      ...(resume ? { resume } : { subagent_type: "coordinator" }),
      prompt: "Coordinate the report", description: "Coordinate",
    }, undefined, undefined, { sessionManager: rootManager });
    const record = await waitForPrompt("coordinator", count);
    const handle = { record, completion };
    activeCoordinators.add(handle);
    return handle;
  }

  async function callChild(coordinator, name, prompt = `Do ${name}`, resume) {
    return coordinator.record.tools.get("Agent").execute(`child-${++childCall}`, {
      ...(resume ? { resume } : { subagent_type: name }),
      prompt, description: name,
    }, undefined, undefined, { sessionManager: coordinator.record.manager });
  }

  t.after(async () => {
    for (const handle of activeCoordinators) handle.record.release?.();
    await Promise.all([...activeCoordinators].map((handle) => handle.completion));
    for (const id of sessions.keys()) controller.forgetSession(id);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  });

  return {
    cwd, sessions, rootId, rootManager, controller, prompts, behavior, preflight,
    startCoordinator, callChild, waitForPrompt,
    async finish(coordinator) {
      coordinator.record.release?.();
      const result = await coordinator.completion;
      activeCoordinators.delete(coordinator);
      return result;
    },
    get serviceCalls() { return serviceCalls; },
  };
}

test("a configured dependency gates Agent calls and supplies a persisted host result to the consumer", async (t) => {
  const fixture = await dependencyFixture(t);
  const coordinator = await fixture.startCoordinator();
  const before = fixture.serviceCalls;
  const denied = await fixture.callChild(coordinator, "writer", "Write the report without quoting the orchestrator");
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /Missing dependency result from analyst for writer/i);
  assert.equal(fixture.serviceCalls, before, "gate refuses before creating child services");

  await assert.rejects(fixture.controller.extensionRuntime.start({
    parentContext: { sessionManager: coordinator.record.manager }, parentToolCallId: "bypass",
    profile: "writer", task: "Bypass the Agent schema", description: "Bypass",
  }), /Missing dependency result from analyst for writer/i);
  assert.equal(fixture.serviceCalls, before, "controller enforces the dependency without the tool schema");

  const analyst = await fixture.callChild(coordinator, "analyst", "Analyze the data");
  assert.equal(analyst.isError, undefined, `${analyst.content[0]?.text}\n${JSON.stringify(coordinator.record.manager.getEntries()
    .filter((entry) => entry.type === "custom").map((entry) => ({ type: entry.customType, id: entry.id, data: entry.data })))}`);
  assert.equal(analyst.details.status, "completed");
  assert.match(analyst.content[0].text, /ANALYST_ARTIFACT_1/);
  const persistedParent = SessionManager.open(coordinator.record.manager.getSessionFile());
  assert.equal(persistedParent.getEntries().some((entry) => entry.type === "custom" && entry.customType === "pi-web:subagent-artifact"), true,
    `the host persists the artifact to the parent JSONL transcript: ${JSON.stringify(persistedParent.getEntries()
      .filter((entry) => entry.type === "custom").map((entry) => entry.customType))}`);
  fixture.sessions.delete(analyst.details.sessionId); // Force the gate to verify the producer's persisted transcript.

  const written = await fixture.callChild(coordinator, "writer", "Write the report without quoting the orchestrator");
  assert.equal(written.isError, undefined, written.content[0]?.text);
  const writerPrompt = fixture.prompts.find((entry) => entry.profile === "writer");
  assert.ok(writerPrompt);
  assert.match(writerPrompt.task, /ANALYST_ARTIFACT_1/);
  assert.match(writerPrompt.task, /analyst/i);
  assert.match(writerPrompt.task, new RegExp(analyst.details.sessionId));
  assert.equal(coordinator.record.manager.getEntries().some((entry) => entry.type === "custom" && /dependency|artifact/.test(entry.customType)), true,
    "the host persists a scoped result in the orchestrator's transcript");

  const completed = await fixture.finish(coordinator);
  assert.equal(completed.details.status, "completed");
});

test("a producer rerun invalidates its old result and the previous consumer result", async (t) => {
  let releaseAnalyst;
  t.after(() => { releaseAnalyst?.(); });
  const fixture = await dependencyFixture(t);
  const coordinator = await fixture.startCoordinator();
  const analyst = await fixture.callChild(coordinator, "analyst");
  assert.equal(analyst.isError, undefined);
  const writer = await fixture.callChild(coordinator, "writer");
  assert.equal(writer.isError, undefined);
  fixture.behavior.analyst = async ({ attempt }) => attempt === 2
    ? new Promise((resolve) => { releaseAnalyst = () => resolve("ANALYST_ARTIFACT_2"); })
    : `ANALYST_ARTIFACT_${attempt}`;

  const rerun = fixture.callChild(coordinator, "analyst", "Re-check the analysis", analyst.details.sessionId);
  await fixture.waitForPrompt("analyst", 2);
  const blocked = await fixture.callChild(coordinator, "writer", "Write with the previous analysis");
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /Missing dependency result from analyst for writer/i);
  assert.equal(fixture.prompts.filter((entry) => entry.profile === "writer").length, 1);

  releaseAnalyst();
  const revised = await rerun;
  assert.equal(revised.isError, undefined, revised.content[0]?.text);
  const fresh = await fixture.callChild(coordinator, "writer", "Rewrite with fresh analysis", writer.details.sessionId);
  assert.equal(fresh.isError, undefined, fresh.content[0]?.text);
  const newPrompt = fixture.prompts.filter((entry) => entry.profile === "writer").at(-1);
  assert.match(newPrompt.task, /ANALYST_ARTIFACT_2/);
  assert.doesNotMatch(newPrompt.task, /ANALYST_ARTIFACT_1/);
  await fixture.finish(coordinator);
});

test("rerunning Reader invalidates Analyst's result transitively before Writer can start", async (t) => {
  const fixture = await dependencyFixture(t, { readerChain: true });
  const coordinator = await fixture.startCoordinator();
  const reader = await fixture.callChild(coordinator, "reader", "Read source material");
  assert.equal(reader.isError, undefined, reader.content[0]?.text);
  const analyst = await fixture.callChild(coordinator, "analyst", "Analyze the source");
  assert.equal(analyst.isError, undefined, analyst.content[0]?.text);
  const firstAnalysis = fixture.prompts.find((entry) => entry.profile === "analyst");
  assert.match(firstAnalysis.task, /READER_ARTIFACT_1/);
  const firstWriter = await fixture.callChild(coordinator, "writer");
  assert.equal(firstWriter.isError, undefined, firstWriter.content[0]?.text);

  const revisedReader = await fixture.callChild(coordinator, "reader", "Read the corrected source");
  assert.equal(revisedReader.isError, undefined, revisedReader.content[0]?.text);
  const staleWriter = await fixture.callChild(coordinator, "writer", "Use old analysis");
  assert.equal(staleWriter.isError, true);
  assert.match(staleWriter.content[0].text, /Missing dependency result from analyst for writer/i);
  assert.equal(fixture.prompts.filter((entry) => entry.profile === "writer").length, 1);

  const revisedAnalyst = await fixture.callChild(coordinator, "analyst", "Re-analyze with new source");
  assert.equal(revisedAnalyst.isError, undefined, revisedAnalyst.content[0]?.text);
  const newAnalysis = fixture.prompts.filter((entry) => entry.profile === "analyst").at(-1);
  assert.match(newAnalysis.task, /READER_ARTIFACT_2/);
  assert.doesNotMatch(newAnalysis.task, /READER_ARTIFACT_1/);
  const finalWriter = await fixture.callChild(coordinator, "writer", "Write from fresh analysis");
  assert.equal(finalWriter.isError, undefined, finalWriter.content[0]?.text);
  const finalPrompt = fixture.prompts.filter((entry) => entry.profile === "writer").at(-1);
  assert.match(finalPrompt.task, /ANALYST_ARTIFACT_2/);
  assert.doesNotMatch(finalPrompt.task, /ANALYST_ARTIFACT_1/);
  await fixture.finish(coordinator);
});

test("a producer cannot be retried while its dependent is actively using its result", async (t) => {
  let releaseWriter;
  t.after(() => { releaseWriter?.(); });
  const fixture = await dependencyFixture(t);
  const coordinator = await fixture.startCoordinator();
  const analyst = await fixture.callChild(coordinator, "analyst");
  assert.equal(analyst.isError, undefined, analyst.content[0]?.text);
  fixture.behavior.writer = async () => new Promise((resolve) => { releaseWriter = () => resolve("WRITER_DONE"); });
  const activeWriter = fixture.callChild(coordinator, "writer", "Write a file using the verified analysis");
  await fixture.waitForPrompt("writer", 1);
  const priorEvents = coordinator.record.manager.getEntries().filter((entry) => entry.type === "custom"
    && entry.customType === "pi-web:subagent-artifact-invalidated").length;
  const rejectedRetry = await fixture.callChild(coordinator, "analyst", "Replace the analysis", analyst.details.sessionId);
  assert.equal(rejectedRetry.isError, true);
  assert.match(rejectedRetry.content[0].text, /Stop dependent subagent writer before rerunning analyst/i);
  assert.equal(coordinator.record.manager.getEntries().filter((entry) => entry.type === "custom"
    && entry.customType === "pi-web:subagent-artifact-invalidated").length, priorEvents,
  "a refused retry does not invalidate the input being used by the running writer");

  releaseWriter();
  const firstDraft = await activeWriter;
  assert.equal(firstDraft.isError, undefined, firstDraft.content[0]?.text);
  const revisedAnalyst = await fixture.callChild(coordinator, "analyst", "Replace the analysis", analyst.details.sessionId);
  assert.equal(revisedAnalyst.isError, undefined, revisedAnalyst.content[0]?.text);
  fixture.behavior.writer = async () => "REVISED_WRITER_DONE";
  const revisedDraft = await fixture.callChild(coordinator, "writer", "Write the updated draft");
  assert.equal(revisedDraft.isError, undefined, revisedDraft.content[0]?.text);
  const secondWriterPrompt = fixture.prompts.filter((entry) => entry.profile === "writer").at(-1);
  assert.match(secondWriterPrompt.task, /ANALYST_ARTIFACT_2/);
  assert.doesNotMatch(secondWriterPrompt.task, /ANALYST_ARTIFACT_1/);
  await fixture.finish(coordinator);
});

test("two concurrent resumes cannot prompt the same specialist twice", async (t) => {
  let releaseAnalyst;
  t.after(() => { releaseAnalyst?.(); });
  const fixture = await dependencyFixture(t);
  const coordinator = await fixture.startCoordinator();
  const analyst = await fixture.callChild(coordinator, "analyst");
  assert.equal(analyst.isError, undefined, analyst.content[0]?.text);
  fixture.behavior.analyst = async ({ attempt }) => attempt === 2
    ? new Promise((resolve) => { releaseAnalyst = () => resolve("ANALYST_ARTIFACT_2"); })
    : `ANALYST_ARTIFACT_${attempt}`;
  const first = fixture.callChild(coordinator, "analyst", "Review analysis", analyst.details.sessionId);
  await fixture.waitForPrompt("analyst", 2);
  const duplicate = await fixture.callChild(coordinator, "analyst", "Duplicate review", analyst.details.sessionId);
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /already (?:running|resuming|starting)/i);
  assert.equal(fixture.prompts.filter((entry) => entry.profile === "analyst").length, 2);
  releaseAnalyst();
  const completed = await first;
  assert.equal(completed.isError, undefined, completed.content[0]?.text);
  const written = await fixture.callChild(coordinator, "writer");
  assert.equal(written.isError, undefined, written.content[0]?.text);
  assert.match(fixture.prompts.find((entry) => entry.profile === "writer").task, /ANALYST_ARTIFACT_2/);
  await fixture.finish(coordinator);
});

test("Stop during asynchronous prompt setup prevents the model side effect and artifact", async (t) => {
  let releasePreflight;
  t.after(() => { releasePreflight?.(); });
  const fixture = await dependencyFixture(t);
  const coordinator = await fixture.startCoordinator();
  let modelSideEffects = 0;
  fixture.preflight.hook = async (record) => {
    if (record.profile === "analyst") await new Promise((resolve) => { releasePreflight = resolve; });
  };
  fixture.behavior.analyst = async () => {
    modelSideEffects += 1;
    return "This result must never be published";
  };
  const pending = fixture.callChild(coordinator, "analyst", "Analyze after slow hook");
  await fixture.waitForPrompt("analyst", 1);
  const stopped = fixture.controller.abortDescendants(coordinator.record.sessionId);
  releasePreflight();
  const result = await pending;
  await stopped;
  assert.equal(result.details.status, "aborted");
  assert.equal(modelSideEffects, 0, "the stopped child never reaches its model/work phase");
  assert.equal(coordinator.record.manager.getEntries().some((entry) => entry.type === "custom"
    && entry.customType === "pi-web:subagent-artifact" && entry.data.profile === "analyst"), false);
  await fixture.finish(coordinator);
});

test("results cannot cross orchestrator sessions or a resumed orchestrator attempt", async (t) => {
  const fixture = await dependencyFixture(t);
  const first = await fixture.startCoordinator();
  const analyst = await fixture.callChild(first, "analyst");
  assert.equal(analyst.isError, undefined);

  const second = await fixture.startCoordinator();
  const crossParent = await fixture.callChild(second, "writer");
  assert.equal(crossParent.isError, true);
  assert.match(crossParent.content[0].text, /Missing dependency result from analyst for writer/i);
  await fixture.finish(second);

  const firstResult = await fixture.finish(first);
  const resumed = await fixture.startCoordinator(firstResult.details.sessionId);
  const staleAttempt = await fixture.callChild(resumed, "writer");
  assert.equal(staleAttempt.isError, true);
  assert.match(staleAttempt.content[0].text, /Missing dependency result from analyst for writer/i);
  const staleProducer = await fixture.callChild(resumed, "analyst", "Resume old analysis", analyst.details.sessionId);
  assert.equal(staleProducer.isError, true);
  assert.match(staleProducer.content[0].text, /previous orchestrator invocation/i);
  const newProducer = await fixture.callChild(resumed, "analyst", "Analyze again for this invocation");
  assert.equal(newProducer.isError, undefined, newProducer.content[0]?.text);
  const newConsumer = await fixture.callChild(resumed, "writer", "Write for this invocation");
  assert.equal(newConsumer.isError, undefined, newConsumer.content[0]?.text);
  await fixture.finish(resumed);
});

test("failed and empty producer attempts do not satisfy a dependency", async (t) => {
  const fixture = await dependencyFixture(t);
  const coordinator = await fixture.startCoordinator();
  fixture.behavior.analyst = async () => "";
  const empty = await fixture.callChild(coordinator, "analyst");
  assert.equal(empty.details.status, "failed");
  assert.match(empty.content[0].text, /nonempty text/i);
  const afterEmpty = await fixture.callChild(coordinator, "writer");
  assert.equal(afterEmpty.isError, true);
  assert.match(afterEmpty.content[0].text, /Missing dependency result from analyst for writer/i);

  fixture.behavior.analyst = async () => { throw new Error("analysis failed"); };
  const failed = await fixture.callChild(coordinator, "analyst");
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /analysis failed/);
  const afterFailure = await fixture.callChild(coordinator, "writer");
  assert.equal(afterFailure.isError, true);
  assert.match(afterFailure.content[0].text, /Missing dependency result from analyst for writer/i);
  await fixture.finish(coordinator);
});
