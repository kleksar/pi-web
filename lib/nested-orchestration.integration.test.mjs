import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { createSubagentExtension } = await jiti.import("./subagent-extension.ts");
const { setRpcSessionTools } = await jiti.import("./rpc-manager.ts");
const {
  listSubagentProfiles,
  readSubagentSessionResources,
  SUBAGENT_CONTROL_TOOL_NAMES,
} = await jiti.import("./subagents.ts");

const CONTROL_TOOLS = [...SUBAGENT_CONTROL_TOOL_NAMES];

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

function profile(name, tools, extra = "") {
  return `---\nname: ${name}\ndescription: ${name}\ntools: ${tools}\nload_skills: false\nload_extensions: ${name === "worker"}\nrun_in_background: false\n${extra}---\nPerform only the delegated task.\n`;
}

test("nested delegation keeps its allow-list and tools across a persisted reopen and resume", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-nested-integration-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent-home");
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  });

  const profilesDir = join(cwd, ".pi", "agents");
  await mkdir(profilesDir, { recursive: true });
  const coordinatorFile = join(profilesDir, "coordinator.md");
  const workerFile = join(profilesDir, "worker.md");
  await writeFile(coordinatorFile, profile("coordinator", "none", "pi_web_orchestration:\n  kind: orchestrator\n  allowed_children:\n    - worker\n"));
  await writeFile(workerFile, profile("worker", "read"));

  const parentManager = SessionManager.create(cwd, join(cwd, "parent-sessions"));
  parentManager.appendMessage({ role: "user", content: "delegate work", timestamp: Date.now() });
  parentManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "delegating" }], timestamp: Date.now(), stopReason: "stop" });
  const rootId = parentManager.getSessionId();
  const fakeModel = { provider: "local-test", id: "no-provider-called" };
  const sessions = new Map();
  const created = [];
  const serviceCalls = [];
  const reopenSnapshots = [];
  const denied = [];
  let controller;

  const root = {
    cwd,
    sessionFile: parentManager.getSessionFile(),
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
    inner: {
      sessionManager: parentManager,
      modelRuntime: { getModel: () => undefined, getModels: () => [] },
      model: fakeModel,
      agent: { state: { thinkingLevel: "off" } },
    },
  };
  sessions.set(rootId, root);

  function makeInner(manager, activeTools, excludedTools, registeredTools) {
    const resources = readSubagentSessionResources(manager.getEntries());
    const ownProfile = manager.getEntries().find((entry) => entry.customType === "pi-web:subagent").data.profile;
    let lastText = "";
    let running = false;
    const inner = {
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      sessionManager: manager,
      agent: { state: { thinkingLevel: "off" } },
      model: fakeModel,
      getActiveToolNames: () => activeTools.filter((name) => !excludedTools.includes(name)),
      subscribe: () => () => {},
      getLastAssistantText: () => lastText,
      abort: async () => {},
      async prompt() {
        running = true;
        try {
          if (ownProfile === "coordinator") {
            const agentTool = registeredTools.get("Agent");
            assert.ok(agentTool, "orchestrator exposes the actual Agent extension tool");
            assert.match(agentTool.description, /worker:/);
            assert.doesNotMatch(agentTool.description, /general-purpose:/);
            const context = { sessionManager: manager };
            const before = serviceCalls.length;
            const forbidden = await agentTool.execute("blocked-tool-call", {
              subagent_type: "general-purpose", prompt: "outside the allow-list", description: "Blocked",
            }, undefined, undefined, context);
            assert.equal(forbidden.isError, true);
            assert.match(forbidden.content[0].text, /not allowed/);
            assert.equal(serviceCalls.length, before, "denied tool call creates no session or services");
            denied.push(forbidden.content[0].text);

            // A caller can bypass the tool's catalog; the controller must enforce it too.
            await assert.rejects(controller.extensionRuntime.start({
              parentContext: context, parentToolCallId: "blocked-direct-call",
              profile: "general-purpose", task: "bypass catalog", description: "Blocked",
            }), /not allowed/);
            assert.equal(serviceCalls.length, before, "denied direct call creates no session or services");

            const child = await agentTool.execute("worker-call", {
              subagent_type: "worker", prompt: "inspect", description: "Inspect",
            }, undefined, undefined, context);
            assert.equal(child.isError, undefined);
            assert.match(child.content[0].text, /worker completed/);
            lastText = "coordinator completed";
          } else {
            assert.equal(ownProfile, "worker");
            assert.equal(resources.orchestration, undefined);
            lastText = "worker completed";
          }
          // Pi persists a new session after an assistant reply; the mock prompt
          // must record one too, so reopen reads a real JSONL transcript.
          manager.appendMessage({ role: "assistant", content: [{ type: "text", text: lastText }], timestamp: Date.now(), stopReason: "stop" });
        } finally {
          running = false;
        }
      },
    };
    const wrapper = {
      cwd, sessionFile: manager.getSessionFile(), inner,
      isAlive: () => true,
      isRunning: () => running,
      waitUntilReady: async () => {},
    };
    return wrapper;
  }

  controller = createSubagentController({
    getSession: (id) => sessions.get(id),
    registerSession(inner) {
      const tools = inner.__testTools;
      const wrapper = {
        cwd, sessionFile: inner.sessionFile, inner,
        isAlive: () => true,
        isRunning: () => inner.__testIsRunning(),
        waitUntilReady: async () => {},
      };
      sessions.set(inner.sessionId, wrapper);
      created.push({ id: inner.sessionId, sessionFile: inner.sessionFile, profile: inner.__testProfile, active: inner.__testActive, excluded: inner.__testExcluded, tools });
    },
    async reopenSession(id, sessionFile) {
      // Recover from the real JSONL, using the saved policy rather than the edited profile.
      const manager = SessionManager.open(sessionFile);
      assert.equal(manager.getSessionId(), id);
      const resources = readSubagentSessionResources(manager.getEntries());
      reopenSnapshots.push(resources);
      const extension = resources.orchestration && createSubagentExtension(
        controller.extensionRuntime,
        () => listSubagentProfiles(cwd),
        () => true,
        { allowedChildren: resources.orchestration.allowedChildren },
      );
      const registeredTools = extension ? toolMap([extension]) : new Map();
      const reopened = makeInner(manager, resources.tools, resources.orchestration ? [] : CONTROL_TOOLS, registeredTools);
      reopened.inner.__testTools = registeredTools;
      sessions.set(id, reopened);
      return reopened;
    },
    resolveSessionPath: async (id) => created.find((entry) => entry.id === id)?.sessionFile ?? null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
    async createServices(options) {
      serviceCalls.push(options);
      const inline = options.resourceLoaderOptions.extensionFactories ?? [];
      const registeredTools = toolMap(inline);
      const extensions = [];
      if (registeredTools.has("Agent")) {
        extensions.push({ path: "<inline:pi-web-subagents>", tools: registeredTools });
      }
      if (!options.resourceLoaderOptions.noExtensions) {
        // Simulate a third-party extension trying to register reserved control tools.
        extensions.push({ path: "/fake/foreign/index.js", tools: new Map([
          ...CONTROL_TOOLS.map((name) => [name, {}]), ["check", {}],
        ]) });
      }
      return { resourceLoader: { getExtensions: () => ({ extensions }) }, __testTools: registeredTools };
    },
    async createFromServices(options) {
      const marker = options.sessionManager.getEntries().find((entry) => entry.customType === "pi-web:subagent").data;
      const selected = [...options.tools];
      const excluded = options.excludeTools ?? [];
      const wrapped = makeInner(options.sessionManager, selected, excluded, options.services.__testTools);
      const inner = Object.assign(wrapped.inner, {
        __testProfile: marker.profile,
        __testTools: options.services.__testTools,
        __testActive: selected,
        __testExcluded: excluded,
        __testIsRunning: wrapped.isRunning,
      });
      return { session: inner };
    },
  });

  const rootAgent = toolMap([createSubagentExtension(
    controller.extensionRuntime, () => listSubagentProfiles(cwd), () => true,
  )]).get("Agent");
  const rootContext = { sessionManager: parentManager };
  const first = await rootAgent.execute("root-call", {
    subagent_type: "coordinator", prompt: "inspect with worker", description: "Coordinate",
  }, undefined, undefined, rootContext);
  assert.equal(first.isError, undefined, first.content[0]?.text);
  assert.equal(first.details.status, "completed");
  assert.deepEqual(created.map(({ profile }) => profile), ["coordinator", "worker"]);
  assert.equal(denied.length, 1);

  const coordinator = created[0];
  const worker = created[1];
  assert.deepEqual(coordinator.active, CONTROL_TOOLS, "no file tools on a control-only orchestrator");
  assert.deepEqual(coordinator.excluded, []);
  assert.deepEqual([...coordinator.tools.keys()], CONTROL_TOOLS);
  assert.equal(serviceCalls[0].resourceLoaderOptions.noExtensions, true);
  assert.equal(serviceCalls[0].resourceLoaderOptions.noSkills, true);
  assert.deepEqual(worker.active, ["read", "check"], "foreign reserved tools are filtered");
  assert.deepEqual(worker.excluded, CONTROL_TOOLS, "SDK excludes reserved tools even if loaded by an extension");
  assert.equal(worker.tools.has("Agent"), false);

  const coordinatorSessionFile = coordinator.sessionFile;
  const onDisk = JSON.parse((await readFile(coordinatorSessionFile, "utf8")).split("\n").find((line) => line.includes('"customType":"pi-web:subagent"')));
  assert.deepEqual(onDisk.data.resourceSnapshot.orchestration.allowedChildren, ["worker"]);
  assert.equal(onDisk.data.resourceSnapshot.orchestration.rootSessionId, rootId);
  assert.equal(onDisk.data.resourceSnapshot.orchestration.depth, 1);
  await assert.rejects(
    setRpcSessionTools(coordinator.id, coordinatorSessionFile, ["read"]),
    /Subagent tool selection is fixed by its profile/,
  );

  // The author can edit the profile while this existing session is closed.
  await writeFile(coordinatorFile, profile("coordinator", "none", "pi_web_orchestration:\n  kind: orchestrator\n  allowed_children:\n    - general-purpose\n"));
  sessions.delete(coordinator.id);
  const resumed = await rootAgent.execute("root-resume", {
    resume: coordinator.id, prompt: "inspect once more", description: "Resume",
  }, undefined, undefined, rootContext);
  assert.equal(resumed.isError, undefined, resumed.content[0]?.text);
  assert.equal(resumed.details.sessionId, coordinator.id);
  assert.equal(resumed.details.status, "completed");
  assert.equal(reopenSnapshots.length, 1);
  assert.deepEqual(reopenSnapshots[0].orchestration.allowedChildren, ["worker"]);
  assert.deepEqual(created.map(({ profile }) => profile), ["coordinator", "worker", "worker"]);
  assert.equal(denied.length, 2);

  // A name is not a stable identity: replacing the worker's effective profile
  // cannot silently alter what this already-running coordinator may invoke.
  await writeFile(workerFile, `${profile("worker", "read")}A changed instruction.\n`);
  const reopenedCoordinator = sessions.get(coordinator.id);
  const beforeChangedProfile = serviceCalls.length;
  const changedWorker = await reopenedCoordinator.inner.__testTools.get("Agent").execute("changed-worker", {
    subagent_type: "worker", prompt: "inspect changed profile", description: "Changed worker",
  }, undefined, undefined, { sessionManager: reopenedCoordinator.inner.sessionManager });
  assert.equal(changedWorker.isError, true);
  assert.match(changedWorker.content[0].text, /profile changed since orchestrator start: worker/i);
  assert.equal(serviceCalls.length, beforeChangedProfile, "stale profile is rejected before SDK services are created");
  assert.deepEqual(created.map(({ profile }) => profile), ["coordinator", "worker", "worker"]);
});
