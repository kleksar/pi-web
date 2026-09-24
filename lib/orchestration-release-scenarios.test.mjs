import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

import { MAIN_NODE_ID, buildOrchestrationGraph, mapPathFromMain } from "./orchestration-map.ts";
import { findOrchestrationLinkIssue } from "./orchestration-policy.ts";

const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
const { listSubagentProfiles } = await jiti.import("./subagents.ts");
const { readEffectiveMainAgentConfig } = await jiti.import("./main-agent-config.ts");
const { parseSubagentContextRequest } = await jiti.import("./subagent-context-handoff.ts");
const { resolveDependencyInputs, admitDependencyChild, recordDependencyArtifact } =
  await jiti.import("./subagent-dependencies.ts");
const { readSubagentSettings, MAX_SUBAGENT_MAX_CONCURRENT } = await jiti.import("./subagent-settings.ts");

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const rosterRoot = join(repo, "orchestration");

async function loadedRoster(t) {
  const oldRoster = process.env.PI_WEB_ROSTER_ROOT;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-release-scenarios-"));
  process.env.PI_WEB_ROSTER_ROOT = rosterRoot;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "empty-agent-home");
  t.after(async () => {
    if (oldRoster === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = oldRoster;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(cwd, { recursive: true, force: true });
  });
  const profiles = listSubagentProfiles(cwd).filter(({ scope }) => scope === "roster");
  return { profiles, byName: new Map(profiles.map((profile) => [profile.name, profile])),
    main: readEffectiveMainAgentConfig(cwd).config };
}

function requireAgent(byName, name) {
  const agent = byName.get(name);
  assert.ok(agent, `Expected versioned agent ${name}`);
  assert.equal(agent.enabled, true, `${name}: ${agent.configurationError ?? "disabled"}`);
  return agent;
}

function dependencyGate(profile, consumer) {
  const entries = [{ type: "custom", id: "invocation-1", customType: "pi-web:subagent-status",
    data: { status: "running" } }];
  return resolveDependencyInputs({ entries, parentSessionId: "coordinator-session",
    parentSessionPath: "/fixture/coordinator.jsonl", childProfile: consumer,
    graph: profile.orchestration?.dependencies,
    resolveChildPath: async () => null, loadChild: () => null });
}

test("tiny configuration typo with broad contract impact has a path to full review", async (t) => {
  const { profiles, byName, main } = await loadedRoster(t);
  const small = requireAgent(byName, "small-task-coordinator");
  const complex = requireAgent(byName, "complex-task-coordinator");
  const reviewer = requireAgent(byName, "architecture-reviewer");
  assert.ok(main.orchestration.allowedChildren.includes(small.name));
  assert.ok(main.orchestration.allowedChildren.includes(complex.name));
  assert.equal(small.orchestration.allowedChildren.includes(reviewer.name), false,
    "a public contract change must not be silently treated as a local typo");
  assert.ok(complex.orchestration.allowedChildren.includes(reviewer.name));
  const graph = buildOrchestrationGraph({ profiles, main: main.orchestration, ownerId: null,
    layer: "delegation" });
  assert.ok(graph.edges.some((edge) => edge.ownerId === MAIN_NODE_ID
    && edge.target === complex.name));
  assert.ok(graph.edges.some((edge) => edge.ownerId === complex.name
    && edge.target === reviewer.name));
  // Reviewer is shared with the medium path; breadcrumbs use its shortest
  // owner path, while the coordinator selected for this scenario is complex.
  assert.deepEqual(mapPathFromMain(reviewer.name, profiles, main.orchestration),
    [MAIN_NODE_ID, "task-coordinator", reviewer.name]);
  assert.deepEqual(complex.orchestration.dependencies["implementation-coordinator"],
    ["technical-analyst", reviewer.name]);
  await assert.rejects(dependencyGate(complex, "implementation-coordinator"),
    /Missing dependency result from technical-analyst/);
});

test("medium API and UI feature retrieves local requirements; missing design is a blocker, not inferred evidence", async (t) => {
  const { byName } = await loadedRoster(t);
  const coordinator = requireAgent(byName, "task-coordinator");
  const requirements = requireAgent(byName, "project-requirements-reader");
  const analyst = requireAgent(byName, "technical-analyst");
  const writer = requireAgent(byName, "bounded-writer");
  assert.ok(coordinator.orchestration.allowedChildren.includes(requirements.name));
  assert.ok(coordinator.orchestration.allowedChildren.includes(writer.name));
  assert.ok(coordinator.orchestration.contextProviders[analyst.name].includes(requirements.name));
  assert.deepEqual(requirements.tools, ["read", "grep", "find", "ls"]);
  assert.equal(requirements.loadExtensions, false,
    "a bare Figma or issue URL cannot be read by this file-only role");
  assert.deepEqual(coordinator.tools, [], "the coordinator must receive project evidence from readers");

  // This deliberately characterizes a release limitation: the medium writer
  // has no fixed analyst prerequisite because some changes do not need one.
  // The requirement to obtain evidence and user decisions is in its prompt,
  // not a conditional runtime approval gate.
  const admitted = await dependencyGate(coordinator, writer.name);
  assert.deepEqual(admitted.artifacts, []);
  assert.equal(admitted.suffix, "");
});

test("stale project docs and a schema migration route through evidence, two reviews, and later verification", async (t) => {
  const { profiles, byName, main } = await loadedRoster(t);
  const complex = requireAgent(byName, "complex-task-coordinator");
  const evidence = requireAgent(byName, "evidence-coordinator");
  const docs = requireAgent(byName, "project-docs-reader");
  const code = requireAgent(byName, "project-code-reader");
  const allPaths = buildOrchestrationGraph({ profiles, main: main.orchestration,
    ownerId: null, layer: "delegation" }).edges;
  for (const reader of [docs, code]) {
    assert.ok(evidence.orchestration.allowedChildren.includes(reader.name));
    assert.ok(allPaths.some((edge) => edge.ownerId === evidence.name && edge.target === reader.name));
  }
  assert.ok(allPaths.some((edge) => edge.ownerId === MAIN_NODE_ID && edge.target === complex.name));
  assert.ok(allPaths.some((edge) => edge.ownerId === complex.name && edge.target === evidence.name));
  for (const consumer of ["technical-analyst", "architecture-reviewer"]) {
    assert.deepEqual(complex.orchestration.contextProviders[consumer], [evidence.name]);
  }
  assert.deepEqual(complex.orchestration.dependencies["implementation-coordinator"],
    ["technical-analyst", "architecture-reviewer"]);
  assert.deepEqual(complex.orchestration.dependencies["verification-coordinator"],
    ["implementation-coordinator"]);
  await assert.rejects(dependencyGate(complex, "implementation-coordinator"),
    /Missing dependency result from technical-analyst/);
  await assert.rejects(dependencyGate(complex, "verification-coordinator"),
    /Missing dependency result from implementation-coordinator/);
  assert.equal(requireAgent(byName, "documentation-writer").tools.includes("bash"), false);
});

test("completed reviews requesting user approval still satisfy the technical dependency gate", async (t) => {
  const { byName } = await loadedRoster(t);
  const complex = requireAgent(byName, "complex-task-coordinator");
  const graph = complex.orchestration.dependencies;
  const parentSessionId = "complex-task-run";
  const parentSessionPath = "/fixture/complex.jsonl";
  const epoch = "invocation-1";
  const entries = [{ type: "custom", id: epoch, customType: "pi-web:subagent-status",
    data: { status: "running" } }];
  const children = new Map();
  const appendCustomEntry = (customType, data) => {
    entries.push({ type: "custom", customType, data, id: `event-${entries.length}` });
  };
  const dependencyOptions = (childProfile) => ({ entries, parentSessionId, parentSessionPath,
    childProfile, graph, resolveChildPath: async (sessionId) => children.get(sessionId)?.path ?? null,
    loadChild: ({ sessionId }) => children.get(sessionId) ?? null });

  for (const profile of ["technical-analyst", "architecture-reviewer"]) {
    const previous = await resolveDependencyInputs(dependencyOptions(profile));
    const admission = admitDependencyChild({ appendCustomEntry, parentSessionId,
      childProfile: profile, epoch: previous.epoch, suffix: previous.suffix,
      artifacts: previous.artifacts });
    const sessionId = `session-${profile}`;
    const path = `/fixture/${sessionId}.jsonl`;
    const text = `${profile}: API migration affects clients; user must approve a contract choice before implementation.`;
    const childEntries = [
      { type: "custom", customType: "pi-web:subagent",
        data: { parentSessionId, parentSessionPath, profile, dependencyEpoch: epoch } },
      { type: "custom", customType: "pi-web:subagent-result",
        data: { status: "completed", result: text } },
    ];
    children.set(sessionId, { sessionId, path, entries: childEntries });
    assert.equal(recordDependencyArtifact({ entries, appendCustomEntry, parentSessionId,
      parentSessionPath, admission, graph, run: { parentSessionId, sessionId,
        sessionPath: path, profile, status: "completed", result: text }, childEntries }), true);
  }

  const admitted = await resolveDependencyInputs(dependencyOptions("implementation-coordinator"));
  assert.equal(admitted.artifacts.length, 2);
  assert.match(admitted.suffix, /user must approve a contract choice/);
  // The runtime checks that reviews succeeded and their text is unmodified.
  // It does not know whether Main actually secured the user's decision.
});

test("Analyst requests an exact Reader through its parent; the link itself never runs a child", async (t) => {
  const { profiles, byName, main } = await loadedRoster(t);
  const coordinator = requireAgent(byName, "task-coordinator");
  const analyst = requireAgent(byName, "technical-analyst");
  const reader = requireAgent(byName, "project-code-reader");
  const request = parseSubagentContextRequest(JSON.stringify({ status: "needs_context",
    provider: reader.name, request: "Find the parser's public API and two direct call sites",
    missingFiles: ["src/parser.ts"] }));
  assert.equal(request.provider, reader.name);
  assert.deepEqual(analyst.tools, []);
  assert.ok(coordinator.orchestration.contextProviders[analyst.name].includes(reader.name));
  assert.ok(coordinator.orchestration.allowedChildren.includes(reader.name));
  assert.equal(coordinator.orchestration.dependencies?.[analyst.name], undefined,
    "Reader runs only when the Analyst asks, not before every analysis");
  const graph = buildOrchestrationGraph({ profiles, main: main.orchestration,
    ownerId: coordinator.name, layer: "contextProviders" });
  assert.ok(graph.edges.some((edge) => edge.ownerId === coordinator.name && edge.source === reader.name
    && edge.target === analyst.name));
});

test("200-agent catalog is navigable; catalog size is separate from active run limits", async (t) => {
  const { byName } = await loadedRoster(t);
  const syntheticCoordinators = Array.from({ length: 20 }, (_, index) => `coordinator-${index}`);
  const syntheticReaders = syntheticCoordinators.flatMap((_, group) =>
    Array.from({ length: 10 }, (_, index) => `reader-${group}-${index}`));
  const synthetic = [
    ...syntheticCoordinators.map((name, group) => ({ name, displayName: name, scope: "roster", enabled: true,
      description: "", orchestration: { allowedChildren: syntheticReaders.slice(group * 10, group * 10 + 10) } })),
    ...syntheticReaders.map((name) => ({ name, displayName: name, scope: "roster", enabled: true,
      description: "" })),
  ];
  const main = { allowedChildren: syntheticCoordinators };
  assert.equal(findOrchestrationLinkIssue(main.allowedChildren), null);
  const start = performance.now();
  const graph = buildOrchestrationGraph({ profiles: synthetic, main, ownerId: null, layer: "all" });
  const search = buildOrchestrationGraph({ profiles: synthetic, main, ownerId: null,
    layer: "all", query: "reader-17-5" });
  const elapsed = performance.now() - start;
  assert.equal(graph.nodes.length, 221); // Main + 20 coordinators + 200 specialists.
  assert.equal(graph.edges.length, 220);
  assert.deepEqual(mapPathFromMain("reader-17-5", synthetic, main),
    [MAIN_NODE_ID, "coordinator-17", "reader-17-5"]);
  assert.deepEqual(new Set(search.nodes.map((node) => node.id)),
    new Set([MAIN_NODE_ID, "coordinator-17", "reader-17-5"]));
  assert.ok(graph.nodes.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
  assert.equal(readSubagentSettings().maxConcurrent, 10);
  assert.equal(MAX_SUBAGENT_MAX_CONCURRENT, 32);
  t.diagnostic(`synthetic 220-agent graph and search: ${elapsed.toFixed(1)} ms (CPU/layout proxy; no model called)`);

  // The manifest is discoverable, but specialist prompts include selected
  // skills only. File sizes are a coarse payload proxy, not billed tokens.
  const selected = requireAgent(byName, "project-code-reader").selectedSkills;
  const selectedBytes = (await Promise.all(selected.map((path) => readFile(path)))).reduce((n, file) => n + file.length, 0);
  const allPaths = [...new Set([...byName.values()].flatMap(({ selectedSkills = [] }) => selectedSkills))];
  const allBytes = (await Promise.all(allPaths.map((path) => readFile(path)))).reduce((n, file) => n + file.length, 0);
  assert.ok(selectedBytes > 0 && selectedBytes < allBytes);
  t.diagnostic(`reader skill files ${selectedBytes} B; all selected roster skills ${allBytes} B (payload proxy)`);
});
