import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { parseSubagentContextRequest } = await jiti.import("./subagent-context-handoff.ts");
const { createSubagentController, profileAuthorityPin } = await jiti.import("./subagent-runtime.ts");
const { createSubagentExtension } = await jiti.import("./subagent-extension.ts");
const { validateMainAgentConfig } = await jiti.import("./main-agent-config.ts");
const { readMainSessionResources } = await jiti.import("./main-agent-snapshot.ts");
const { listSubagentProfiles, readSubagentSessionResources, resolveSubagentProfile, saveProjectSubagentProfile } = await jiti.import("./subagents.ts");

const REQUEST = {
  status: "needs_context", provider: "Reader", request: "Which files define the parser?",
  missingFiles: ["src/parser.ts"],
};
const DOCS_REQUEST = { status: "needs_context", provider: "DocsFinder", request: "Find the parser API reference" };
const READER_FULL = `READER_FULL_PRIVATE_SOURCE_${"source details ".repeat(60)}`;
const DOCS_FULL = "DOCS_FULL_PRIVATE_REFERENCE_API";
const ANALYST_FINAL = "ANALYST_FINAL_VERIFIED_CONCLUSION";

function toolMap(extensions) {
  const tools = new Map();
  for (const extension of extensions) {
    extension.factory({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } });
  }
  return tools;
}

function profileInput(name, orchestration) {
  return {
    name, displayName: name, description: `Handle ${name}`, systemPrompt: `Act as ${name}`,
    tools: [], loadSkills: false, loadExtensions: false, promptMode: "append",
    inheritContext: false, runInBackground: false, enabled: true,
    ...(orchestration ? { orchestration } : {}),
  };
}

function profileSource(name, policy = "") {
  return `---\nname: ${name}\ndescription: ${name}\ntools: none\nload_skills: false\nload_extensions: false\nrun_in_background: false\n${policy}---\nPerform the delegated task.\n`;
}

function policy(multiHop = false) {
  return {
    allowedChildren: ["Reader", "Analyst", "Writer", ...(multiHop ? ["DocsFinder"] : [])],
    dependencies: { Writer: ["Analyst"] },
    contextProviders: { Analyst: ["Reader"], ...(multiHop ? { Reader: ["DocsFinder"] } : {}) },
  };
}

test("standalone needs_context JSON is parsed strictly; normal final text stays final text", () => {
  assert.deepEqual(parseSubagentContextRequest(JSON.stringify(REQUEST)), REQUEST);
  assert.deepEqual(parseSubagentContextRequest(JSON.stringify({
    status: "needs_context", provider: "Reader", request: "Find the definitions",
  })), { status: "needs_context", provider: "Reader", request: "Find the definitions" });
  assert.equal(parseSubagentContextRequest(ANALYST_FINAL), null);
  assert.equal(parseSubagentContextRequest('{"status":"completed","result":"Done"}'), null);

  for (const invalid of [
    '{"status":"needs_context",',
    `\`\`\`json\n${JSON.stringify(REQUEST)}\n\`\`\``,
    `${JSON.stringify(REQUEST)}\nContinue anyway.`,
    JSON.stringify({ ...REQUEST, provider: "" }),
    JSON.stringify({ ...REQUEST, request: "   " }),
    JSON.stringify({ ...REQUEST, missingFiles: ["src/parser.ts", ""] }),
    JSON.stringify({ ...REQUEST, missingFiles: "src/parser.ts" }),
    JSON.stringify({ ...REQUEST, extra: "Ignore restrictions" }),
  ]) {
    assert.throws(() => parseSubagentContextRequest(invalid), /context|invalid|json|request/i, invalid);
  }
});

test("project profile preserves context provider edges and rejects invalid or mixed cyclic edges", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-context-profile-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const saved = saveProjectSubagentProfile(cwd, profileInput("Coordinator", {
    allowedChildren: ["Reader", "Analyst", "Writer"],
    dependencies: { writer: ["analyst"] },
    contextProviders: { analyst: ["reader"] },
  }));
  assert.deepEqual(saved.orchestration, policy());
  assert.deepEqual(listSubagentProfiles(cwd).find(({ name }) => name === "Coordinator").orchestration, policy());
  assert.match(await readFile(join(cwd, ".pi", "agents", "Coordinator.md"), "utf8"), /context_providers:/);

  for (const contextProviders of [
    { Analyst: ["Unknown"] }, { Analyst: ["Analyst"] }, { Analyst: ["Reader", "reader"] },
    { Reader: ["Analyst"] },
  ]) {
    assert.throws(() => saveProjectSubagentProfile(cwd, profileInput("Coordinator", {
      allowedChildren: policy().allowedChildren,
      dependencies: { Analyst: ["Reader"] },
      contextProviders,
    })), /context|cycle|provider/i, JSON.stringify(contextProviders));
  }
});

test("Main and child snapshots preserve context provider permissions and reject a mixed cycle", () => {
  const childProfiles = Object.fromEntries(policy().allowedChildren.map((name) => [
    name.toLowerCase(), { scope: "builtin", sha256: "a".repeat(64) },
  ]));
  const mainPolicy = validateMainAgentConfig({ orchestration: {
    allowedChildren: ["Reader", "Analyst", "Writer"],
    dependencies: { writer: ["analyst"] }, contextProviders: { analyst: ["reader"] },
  } }).orchestration;
  assert.deepEqual(JSON.parse(JSON.stringify(mainPolicy)), policy());

  const mainEntries = [{ type: "custom", customType: "pi-web:main-resources", data: {
    version: 1, orchestration: { ...mainPolicy, childProfiles },
  } }];
  assert.deepEqual(JSON.parse(JSON.stringify(readMainSessionResources(mainEntries).orchestration.contextProviders)), policy().contextProviders);

  const childEntries = [{ type: "custom", customType: "pi-web:subagent", data: {
    version: 1, profile: "Coordinator", parentSessionId: "root", parentSessionPath: "/tmp/root.jsonl",
    resourceSnapshot: {
      version: 2, tools: ["Agent", "get_subagent_result", "steer_subagent"],
      appendSystemPrompt: ["Coordinate"], loadSkills: false, loadExtensions: false,
      orchestration: { ...mainPolicy, childProfiles, rootSessionId: "root", depth: 1 },
    },
  } }];
  assert.deepEqual(readSubagentSessionResources(childEntries).orchestration.contextProviders, policy().contextProviders);

  const cycle = { ...mainPolicy, dependencies: { Reader: ["Analyst"] } };
  assert.throws(() => validateMainAgentConfig({ orchestration: cycle }), /cycle|context/i);
  assert.throws(() => readMainSessionResources([{ ...mainEntries[0], data: {
    version: 1, orchestration: { ...cycle, childProfiles },
  } }]), /cycle|context|snapshot/i);
  assert.throws(() => readSubagentSessionResources([{ ...childEntries[0], data: {
    ...childEntries[0].data,
    resourceSnapshot: { ...childEntries[0].data.resourceSnapshot,
      orchestration: { ...cycle, childProfiles, rootSessionId: "root", depth: 1 },
    },
  } }]), /orchestration|context|cycle/i);
});

async function handoffFixture(t, { mainPolicy = false, multiHop = false, behavior = {} } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-context-handoff-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-home");
  const profilesDir = join(cwd, ".pi", "agents");
  await mkdir(profilesDir, { recursive: true });
  await writeFile(join(profilesDir, "Coordinator.md"), profileSource("Coordinator", `pi_web_orchestration:\n  kind: orchestrator\n  allowed_children: [Reader, Analyst, Writer${multiHop ? ", DocsFinder" : ""}]\n  depends_on:\n    Writer: [Analyst]\n  context_providers:\n    Analyst: [Reader]\n${multiHop ? "    Reader: [DocsFinder]\n" : ""}`));
  for (const name of policy(multiHop).allowedChildren) {
    await writeFile(join(profilesDir, `${name}.md`), profileSource(name));
  }

  const rootManager = SessionManager.create(cwd, join(cwd, "root-sessions"));
  if (mainPolicy) {
    const childProfiles = Object.fromEntries(policy(multiHop).allowedChildren.map((name) => [
      name.toLowerCase(), profileAuthorityPin(resolveSubagentProfile(cwd, name)),
    ]));
    rootManager.appendCustomEntry("pi-web:main-resources", {
      version: 1, orchestration: { ...policy(multiHop), childProfiles },
    });
  }
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
  const activeCoordinators = new Set();
  let serviceCalls = 0;
  let call = 0;
  let controller;

  function waitForPrompt(profile, count) {
    const existing = prompts.filter((record) => record.profile === profile);
    if (existing.length >= count) return Promise.resolve(existing.at(-1));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`Timed out waiting for ${profile} prompt ${count}`)); }, 5000);
      const waiter = { profile, count, resolve(record) { clearTimeout(timer); resolve(record); } };
      waiters.add(waiter);
    });
  }
  const waiters = new Set();
  function notifyWaiters() {
    for (const waiter of waiters) {
      const matches = prompts.filter((record) => record.profile === waiter.profile);
      if (matches.length < waiter.count) continue;
      waiters.delete(waiter);
      waiter.resolve(matches.at(-1));
    }
  }

  function createFakeInner(manager, registeredTools) {
    const ownProfile = manager.getEntries().find((entry) => entry.customType === "pi-web:subagent").data.profile;
    let running = false;
    let lastText = "";
    let releaseCoordinator;
    return {
      sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionManager: manager,
      agent: { state: { thinkingLevel: "off" } }, modelRuntime: fakeRuntime, model: fakeModel,
      subscribe: () => () => {}, getLastAssistantText: () => lastText,
      __testTools: registeredTools, __testRunning: () => running,
      abort: async () => { releaseCoordinator?.(); },
      async prompt(task, options = {}) {
        running = true;
        manager.appendMessage({ role: "user", content: task, timestamp: Date.now() });
        if (ownProfile === "Coordinator") {
          manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Delegating specialists" }],
            timestamp: Date.now(), stopReason: "toolUse" });
        }
        const attempt = prompts.filter((record) => record.profile === ownProfile).length + 1;
        const record = { profile: ownProfile, manager, sessionId: manager.getSessionId(), task, attempt, tools: registeredTools };
        prompts.push(record);
        notifyWaiters();
        try {
          if (ownProfile === "Coordinator") {
            assert.ok(registeredTools.has("Agent"));
            await new Promise((resolve) => { releaseCoordinator = resolve; record.release = resolve; });
            lastText = "Coordinator finished";
          } else {
            options.preflightResult?.(true);
            lastText = behavior[ownProfile]
              ? await behavior[ownProfile](record)
              : ownProfile === "Analyst"
                ? attempt === 1 ? JSON.stringify(REQUEST) : ANALYST_FINAL
                : ownProfile === "Reader" ? READER_FULL
                  : ownProfile === "DocsFinder" ? DOCS_FULL : "WRITER_DONE";
          }
          manager.appendMessage({ role: "assistant", content: [{ type: "text", text: lastText }],
            timestamp: Date.now(), stopReason: "stop" });
        } finally {
          releaseCoordinator = undefined;
          running = false;
        }
      },
    };
  }

  controller = createSubagentController({
    getSession: (id) => sessions.get(id),
    registerSession(inner) {
      sessionPaths.set(inner.sessionId, inner.sessionFile);
      sessions.set(inner.sessionId, {
        cwd, sessionFile: inner.sessionFile, inner, isAlive: () => true,
        isRunning: () => inner.__testRunning(), waitUntilReady: async () => {},
      });
    },
    async reopenSession(id, sessionFile) {
      const manager = SessionManager.open(sessionFile);
      assert.equal(manager.getSessionId(), id);
      const resources = readSubagentSessionResources(manager.getEntries());
      const extension = resources.orchestration && createSubagentExtension(
        controller.extensionRuntime, () => listSubagentProfiles(cwd), () => true,
        { allowedChildren: resources.orchestration.allowedChildren,
          dependencies: resources.orchestration.dependencies,
          contextProviders: resources.orchestration.contextProviders },
      );
      const inner = createFakeInner(manager, extension ? toolMap([extension]) : new Map());
      const wrapper = { cwd, sessionFile, inner, isAlive: () => true,
        isRunning: () => inner.__testRunning(), waitUntilReady: async () => {} };
      sessions.set(id, wrapper);
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

  const rootTool = toolMap([createSubagentExtension(
    controller.extensionRuntime, () => listSubagentProfiles(cwd), () => true,
  )]).get("Agent");
  async function startCoordinator(resume) {
    const count = prompts.filter((record) => record.profile === "Coordinator").length + 1;
    const completion = rootTool.execute(`root-${++call}`, {
      ...(resume ? { resume } : { subagent_type: "Coordinator" }),
      prompt: "Coordinate the report", description: "Coordinate",
    }, undefined, undefined, { sessionManager: rootManager });
    const record = await waitForPrompt("Coordinator", count);
    const handle = { record, completion };
    activeCoordinators.add(handle);
    return handle;
  }
  async function callChild(coordinator, fields) {
    return coordinator.record.tools.get("Agent").execute(`child-${++call}`, {
      prompt: "Continue work", description: "Specialist", ...fields,
    }, undefined, undefined, { sessionManager: coordinator.record.manager });
  }
  async function callMain(fields) {
    return rootTool.execute(`main-${++call}`, { prompt: "Continue work", description: "Specialist", ...fields },
      undefined, undefined, { sessionManager: rootManager });
  }
  async function finish(coordinator) {
    coordinator.record.release?.();
    const result = await coordinator.completion;
    activeCoordinators.delete(coordinator);
    return result;
  }

  t.after(async () => {
    for (const handle of activeCoordinators) handle.record.release?.();
    await Promise.all([...activeCoordinators].map((handle) => handle.completion));
    for (const id of sessions.keys()) controller.forgetSession(id);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  });
  return { controller, sessions, prompts, rootManager, startCoordinator, callChild, callMain, finish,
    get serviceCalls() { return serviceCalls; } };
}

test("Reader handoff stores full context but gives the coordinator only a summary; resume injects it into Analyst", async (t) => {
  const fixture = await handoffFixture(t);
  const coordinator = await fixture.startCoordinator();
  const analyst = await fixture.callChild(coordinator, { subagent_type: "Analyst", prompt: "Analyze the report" });
  assert.equal(analyst.isError, undefined, analyst.content[0]?.text);
  assert.equal(analyst.details.status, "needs_context");
  assert.deepEqual(analyst.details.contextRequest, REQUEST);
  assert.doesNotMatch(analyst.content[0].text, /READER_FULL_PRIVATE_SOURCE/);

  const tooSoon = await fixture.callChild(coordinator, {
    resume: analyst.details.sessionId, prompt: "Continue before Reader returns",
  });
  assert.equal(tooSoon.isError, true);
  assert.match(tooSoon.content[0].text, /context|provider|requested|pending/i);

  const blocked = await fixture.callChild(coordinator, { subagent_type: "Writer" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /Missing dependency result from Analyst for Writer/i);
  const reader = await fixture.callChild(coordinator, {
    subagent_type: "Reader", context_for: analyst.details.sessionId,
    prompt: REQUEST.request,
  });
  assert.equal(reader.isError, undefined, reader.content[0]?.text);
  assert.equal(reader.details.status, "completed");
  assert.doesNotMatch(reader.content[0].text, /READER_FULL_PRIVATE_SOURCE/);
  assert.match(JSON.stringify(fixture.sessions.get(reader.details.sessionId).inner.sessionManager.getEntries()),
    /READER_FULL_PRIVATE_SOURCE/, "the Reader transcript keeps the full response");
  assert.doesNotMatch(JSON.stringify(coordinator.record.manager.getEntries()), /READER_FULL_PRIVATE_SOURCE/,
    "the coordinator transcript only keeps the handoff reference");
  const resultTool = coordinator.record.tools.get("get_subagent_result");
  const readAgain = await resultTool.execute("lookup", { agent_id: reader.details.sessionId }, undefined, undefined,
    { sessionManager: coordinator.record.manager });
  assert.doesNotMatch(readAgain.content[0].text, /READER_FULL_PRIVATE_SOURCE/);

  const beforeDuplicate = fixture.serviceCalls;
  const duplicate = await fixture.callChild(coordinator, {
    subagent_type: "Reader", context_for: analyst.details.sessionId,
  });
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.content[0].text, /context|provider|already/i);
  assert.equal(fixture.serviceCalls, beforeDuplicate, "a fulfilled request cannot launch another Reader");

  fixture.sessions.delete(analyst.details.sessionId); // Resume from the persisted Analyst session.
  const resumed = await fixture.callChild(coordinator, {
    resume: analyst.details.sessionId, prompt: "Continue with the Reader's answer",
  });
  assert.equal(resumed.isError, undefined, resumed.content[0]?.text);
  assert.equal(resumed.details.status, "completed");
  const resumedPrompt = fixture.prompts.filter((record) => record.profile === "Analyst").at(-1).task;
  assert.match(resumedPrompt, /READER_FULL_PRIVATE_SOURCE/);
  assert.match(resumed.content[0].text, /ANALYST_FINAL_VERIFIED_CONCLUSION/);
  assert.doesNotMatch(resumed.content[0].text, /READER_FULL_PRIVATE_SOURCE/);

  const writer = await fixture.callChild(coordinator, { subagent_type: "Writer", prompt: "Write final report" });
  assert.equal(writer.isError, undefined, writer.content[0]?.text);
  const writerPrompt = fixture.prompts.find((record) => record.profile === "Writer").task;
  assert.match(writerPrompt, /ANALYST_FINAL_VERIFIED_CONCLUSION/);
  assert.doesNotMatch(writerPrompt, /READER_FULL_PRIVATE_SOURCE|Which files define the parser/);

  const ordinaryContinuation = await fixture.callChild(coordinator, {
    resume: analyst.details.sessionId, prompt: "Answer an unrelated follow-up",
  });
  assert.equal(ordinaryContinuation.isError, undefined, ordinaryContinuation.content[0]?.text);
  const latestAnalystPrompt = fixture.prompts.filter((record) => record.profile === "Analyst").at(-1).task;
  assert.equal(latestAnalystPrompt, "Answer an unrelated follow-up",
    "a consumed handoff cannot be injected into an unrelated later Analyst turn");
  await fixture.finish(coordinator);
});

test("context_for rejects invalid handles, wrong providers, and an Analyst from an earlier orchestrator invocation", async (t) => {
  const fixture = await handoffFixture(t);
  const coordinator = await fixture.startCoordinator();
  const analyst = await fixture.callChild(coordinator, { subagent_type: "Analyst" });
  assert.equal(analyst.details.status, "needs_context");

  const otherCoordinator = await fixture.startCoordinator();
  const crossOwner = await fixture.callChild(otherCoordinator, {
    subagent_type: "Reader", context_for: analyst.details.sessionId,
  });
  assert.equal(crossOwner.isError, true);
  assert.match(crossOwner.content[0].text, /context|sibling|parent|not found/i);
  await fixture.finish(otherCoordinator);

  const before = fixture.serviceCalls;
  for (const fields of [
    { subagent_type: "Reader", context_for: "not-a-child" },
    { subagent_type: "Writer", context_for: analyst.details.sessionId },
    { subagent_type: "Reader", context_for: coordinator.record.sessionId },
  ]) {
    const denied = await fixture.callChild(coordinator, fields);
    assert.equal(denied.isError, true, JSON.stringify(fields));
    assert.match(denied.content[0].text, /context|provider|not found|analyst/i);
  }
  assert.equal(fixture.serviceCalls, before, "invalid links fail before launching a provider");
  assert.equal(fixture.prompts.filter((record) => record.profile === "Reader").length, 0);

  const completed = await fixture.finish(coordinator);
  const restarted = await fixture.startCoordinator(completed.details.sessionId);
  const stale = await fixture.callChild(restarted, {
    subagent_type: "Reader", context_for: analyst.details.sessionId,
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /context|previous|invocation|epoch|stale/i);
  assert.equal(fixture.prompts.filter((record) => record.profile === "Reader").length, 0);
  await fixture.finish(restarted);
});

test("Main snapshot authorizes handoff and restores full Reader context from disk", async (t) => {
  const fixture = await handoffFixture(t, { mainPolicy: true });
  const analyst = await fixture.callMain({ subagent_type: "Analyst" });
  assert.equal(analyst.details.status, "needs_context", analyst.content[0]?.text);
  const reader = await fixture.callMain({ subagent_type: "Reader", context_for: analyst.details.sessionId });
  assert.equal(reader.isError, undefined, reader.content[0]?.text);
  assert.doesNotMatch(reader.content[0].text, /READER_FULL_PRIVATE_SOURCE/);

  fixture.sessions.delete(analyst.details.sessionId);
  fixture.sessions.delete(reader.details.sessionId);
  const resumed = await fixture.callMain({ resume: analyst.details.sessionId });
  assert.equal(resumed.isError, undefined, resumed.content[0]?.text);
  assert.match(fixture.prompts.filter((record) => record.profile === "Analyst").at(-1).task, /READER_FULL_PRIVATE_SOURCE/);
  const writer = await fixture.callMain({ subagent_type: "Writer" });
  assert.equal(writer.isError, undefined, writer.content[0]?.text);
  assert.match(fixture.prompts.find((record) => record.profile === "Writer").task, /ANALYST_FINAL_VERIFIED_CONCLUSION/);
  assert.doesNotMatch(fixture.prompts.find((record) => record.profile === "Writer").task, /READER_FULL_PRIVATE_SOURCE/);
});

test("a Reader may itself request DocsFinder context before giving Analyst its final result", async (t) => {
  const fixture = await handoffFixture(t, {
    multiHop: true,
    behavior: {
      Reader: ({ attempt }) => attempt === 1 ? JSON.stringify(DOCS_REQUEST) : READER_FULL,
    },
  });
  const coordinator = await fixture.startCoordinator();
  const analyst = await fixture.callChild(coordinator, { subagent_type: "Analyst" });
  assert.equal(analyst.details.status, "needs_context", analyst.content[0]?.text);
  const reader = await fixture.callChild(coordinator, {
    subagent_type: "Reader", context_for: analyst.details.sessionId,
  });
  assert.equal(reader.details.status, "needs_context", reader.content[0]?.text);
  assert.deepEqual(reader.details.contextRequest, DOCS_REQUEST);
  const earlyAnalyst = await fixture.callChild(coordinator, { resume: analyst.details.sessionId });
  assert.equal(earlyAnalyst.isError, true);
  assert.match(earlyAnalyst.content[0].text, /context|provider|requested/i);

  const docs = await fixture.callChild(coordinator, {
    subagent_type: "DocsFinder", context_for: reader.details.sessionId,
    prompt: DOCS_REQUEST.request,
  });
  assert.equal(docs.isError, undefined, docs.content[0]?.text);
  assert.doesNotMatch(docs.content[0].text, /DOCS_FULL_PRIVATE_REFERENCE_API/);
  const continuedReader = await fixture.callChild(coordinator, {
    resume: reader.details.sessionId, prompt: "Continue after DocsFinder",
  });
  assert.equal(continuedReader.isError, undefined, continuedReader.content[0]?.text);
  assert.equal(continuedReader.details.status, "completed");
  assert.doesNotMatch(continuedReader.content[0].text, /READER_FULL_PRIVATE_SOURCE/);
  assert.match(fixture.prompts.filter((record) => record.profile === "Reader").at(-1).task,
    /DOCS_FULL_PRIVATE_REFERENCE_API/);

  const analystFinal = await fixture.callChild(coordinator, {
    resume: analyst.details.sessionId, prompt: "Finish the analysis",
  });
  assert.equal(analystFinal.isError, undefined, analystFinal.content[0]?.text);
  assert.equal(analystFinal.details.status, "completed");
  assert.match(fixture.prompts.filter((record) => record.profile === "Analyst").at(-1).task,
    /READER_FULL_PRIVATE_SOURCE/);
  const writer = await fixture.callChild(coordinator, { subagent_type: "Writer" });
  assert.equal(writer.isError, undefined, writer.content[0]?.text);
  assert.match(fixture.prompts.find((record) => record.profile === "Writer").task,
    /ANALYST_FINAL_VERIFIED_CONCLUSION/);
  assert.doesNotMatch(fixture.prompts.find((record) => record.profile === "Writer").task,
    /READER_FULL_PRIVATE_SOURCE|DOCS_FULL_PRIVATE_REFERENCE_API/);
  await fixture.finish(coordinator);
});

test("a Reader bound to Analyst request A cannot be rebound after request B", async (t) => {
  const laterRequest = { ...REQUEST, request: "Which file defines the new parser?", missingFiles: ["src/new-parser.ts"] };
  const fixture = await handoffFixture(t, {
    behavior: {
      Analyst: ({ attempt }) => JSON.stringify(attempt === 1 ? REQUEST : laterRequest),
      Reader: ({ attempt }) => {
        if (attempt === 1) throw new Error("Reader failed temporarily");
        return READER_FULL;
      },
    },
  });
  const coordinator = await fixture.startCoordinator();
  const analyst = await fixture.callChild(coordinator, { subagent_type: "Analyst" });
  assert.equal(analyst.details.status, "needs_context");
  const reader1 = await fixture.callChild(coordinator, {
    subagent_type: "Reader", context_for: analyst.details.sessionId,
  });
  assert.equal(reader1.isError, true);
  assert.equal(reader1.details.status, "failed");
  const reader2 = await fixture.callChild(coordinator, {
    subagent_type: "Reader", context_for: analyst.details.sessionId,
  });
  assert.equal(reader2.isError, undefined, reader2.content[0]?.text);
  const requestB = await fixture.callChild(coordinator, {
    resume: analyst.details.sessionId, prompt: "Continue; ask for anything else needed",
  });
  assert.equal(requestB.details.status, "needs_context", requestB.content[0]?.text);
  assert.deepEqual(requestB.details.contextRequest, laterRequest);

  const before = fixture.prompts.filter((record) => record.profile === "Reader").length;
  const rebound = await fixture.callChild(coordinator, {
    resume: reader1.details.sessionId, prompt: "Retry the old Reader for the new Analyst request",
  });
  assert.equal(rebound.isError, true);
  assert.match(rebound.content[0].text, /bound|earlier|previous|context|request/i);
  assert.equal(fixture.prompts.filter((record) => record.profile === "Reader").length, before,
    "the old Reader does not run against the later request");
  await fixture.finish(coordinator);
});

test("a new Main user turn cannot reuse an earlier Analyst context request", async (t) => {
  const fixture = await handoffFixture(t, { mainPolicy: true });
  const analyst = await fixture.callMain({ subagent_type: "Analyst" });
  assert.equal(analyst.details.status, "needs_context", analyst.content[0]?.text);
  fixture.rootManager.appendMessage({ role: "user", content: "A new task starts now", timestamp: Date.now() });
  const before = fixture.serviceCalls;
  const stale = await fixture.callMain({ subagent_type: "Reader", context_for: analyst.details.sessionId });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /context|sibling|epoch|invocation|previous|current/i);
  assert.equal(fixture.serviceCalls, before);
  assert.equal(fixture.prompts.filter((record) => record.profile === "Reader").length, 0);
});
