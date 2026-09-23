import assert from "node:assert/strict";
import test from "node:test";
import {
  MAIN_NODE_ID, MAP_NODE_HEIGHT, MAP_NODE_WIDTH, buildOrchestrationGraph, centerOrchestrationMapNode,
  changeChildLink, changeDependencyLink, changeContextProviderLink,
  effectiveMapProfiles, filterOrchestrationEdges, fitOrchestrationMap, mainPolicyForMap, mapOwnersForAgent, mapPathFromMain,
  readableOrchestrationMap,
} from "./orchestration-map.ts";

const agent = (name, orchestration = undefined, scope = "global", enabled = true) => ({
  name, displayName: name, scope, enabled, orchestration, description: "",
});

test("Main and an agent literally named main remain distinct nodes and links", () => {
  const profiles = [agent("main", { allowedChildren: ["reader"] }), agent("reader")];
  const graph = buildOrchestrationGraph({ profiles, main: { allowedChildren: ["main"] }, ownerId: null, layer: "delegation" });
  assert.notEqual(MAIN_NODE_ID, "main");
  assert.equal(graph.nodes.filter((node) => node.id === MAIN_NODE_ID).length, 1);
  assert.equal(graph.nodes.filter((node) => node.id === "main").length, 1);
  assert.deepEqual(graph.edges.map(({ ownerId, source, target }) => [ownerId, source, target]), [
    [MAIN_NODE_ID, MAIN_NODE_ID, "main"], ["main", "main", "reader"],
  ]);
  assert.deepEqual(mapPathFromMain("reader", profiles, { allowedChildren: ["main"] }), [MAIN_NODE_ID, "main", "reader"]);
});

test("legacy Main materializes only effective enabled profiles, while explicit empty policy has no links", () => {
  const profiles = [agent("reader"), agent("writer"), agent("reader", undefined, "project", false)];
  assert.deepEqual(effectiveMapProfiles(profiles).find((profile) => profile.name === "reader")?.scope, "project");
  assert.deepEqual(mainPolicyForMap(profiles, null).allowedChildren, ["writer"]);
  assert.deepEqual(buildOrchestrationGraph({ profiles, main: null, ownerId: MAIN_NODE_ID, layer: "delegation" }).edges.map((edge) => edge.target), ["writer"]);
  assert.deepEqual(buildOrchestrationGraph({ profiles, main: { allowedChildren: [] }, ownerId: MAIN_NODE_ID, layer: "delegation" }).edges, []);
  const changed = changeChildLink(MAIN_NODE_ID, mainPolicyForMap(profiles, null), "writer", false, profiles);
  assert.deepEqual(changed, { ok: true, next: { allowedChildren: [] } });
});

test("map distinguishes shared repository profiles from stronger local overrides", () => {
  const sources = [agent("reviewer", undefined, "roster"), agent("reviewer", undefined, "global")];
  assert.equal(effectiveMapProfiles(sources)[0].scope, "global");
  assert.equal(effectiveMapProfiles([sources[0], agent("reviewer", undefined, "project")])[0].scope, "project");
  assert.equal(effectiveMapProfiles([agent("reviewer", undefined, "builtin"), sources[0]])[0].scope, "roster");
});

test("dependency links remain local to their owner when agents occur in multiple branches", () => {
  const children = [agent("reader"), agent("writer")];
  const profiles = [
    agent("one", { allowedChildren: ["reader", "writer"], dependencies: { writer: ["reader"] } }),
    agent("two", { allowedChildren: ["reader", "writer"], dependencies: { reader: ["writer"] } }),
    ...children,
  ];
  const one = buildOrchestrationGraph({ profiles, main: { allowedChildren: ["one", "two"] }, ownerId: "one", layer: "dependencies" });
  const two = buildOrchestrationGraph({ profiles, main: { allowedChildren: ["one", "two"] }, ownerId: "two", layer: "dependencies" });
  assert.deepEqual(one.edges.map((edge) => [edge.ownerId, edge.source, edge.target]), [["one", "reader", "writer"]]);
  assert.deepEqual(two.edges.map((edge) => [edge.ownerId, edge.source, edge.target]), [["two", "writer", "reader"]]);
});

test("one canvas distinguishes delegation, prerequisites, and on-demand providers under the chosen coordinator", () => {
  const profiles = [
    agent("coordinator", { allowedChildren: ["reader", "analyst"],
      dependencies: { analyst: ["reader"] }, contextProviders: { analyst: ["reader"] } }),
    agent("reader"), agent("analyst"),
  ];
  const graph = buildOrchestrationGraph({ profiles, main: { allowedChildren: ["coordinator"] }, ownerId: "coordinator", layer: "all" });
  assert.deepEqual(graph.edges.map((edge) => [edge.kind, edge.ownerId, edge.source, edge.target]), [
    ["delegation", "coordinator", "coordinator", "reader"],
    ["delegation", "coordinator", "coordinator", "analyst"],
    ["dependencies", "coordinator", "reader", "analyst"],
    ["contextProviders", "coordinator", "reader", "analyst"],
  ]);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.ok(byId.get("reader").x < byId.get("analyst").x);
});

test("a non-orchestrator analyst exposes its actual parent policies, including shared parents", () => {
  const profiles = [
    agent("coordinator", { allowedChildren: ["reader", "analyst"] }),
    agent("another", { allowedChildren: ["reader", "analyst"] }),
    agent("reader"), agent("analyst"),
  ];
  assert.deepEqual(mapOwnersForAgent("analyst", profiles, { allowedChildren: ["coordinator"] }), ["another", "coordinator"]);
  assert.deepEqual(mapOwnersForAgent("analyst", profiles, null), [MAIN_NODE_ID, "another", "coordinator"]);
  assert.deepEqual(mapOwnersForAgent("reader", profiles, { allowedChildren: ["coordinator", "reader"] }), [MAIN_NODE_ID, "another", "coordinator"]);
});

test("a focused analyst branch still shows sibling readers before a link exists and exposes its draft coordinator", () => {
  const profiles = [agent("coordinator", { allowedChildren: ["reader"] }), agent("reader"), agent("analyst")];
  const draft = { allowedChildren: ["reader", "analyst"] };
  const graph = buildOrchestrationGraph({ profiles, main: { allowedChildren: ["coordinator"] },
    ownerId: "coordinator", draft, layer: "all" });
  assert.deepEqual(new Set(graph.nodes.map((node) => node.id)), new Set(["coordinator", "reader", "analyst"]));
  assert.deepEqual(mapOwnersForAgent("analyst", profiles, { allowedChildren: ["coordinator"] }, "coordinator", draft), ["coordinator"]);
  assert.deepEqual(mapOwnersForAgent("analyst", profiles, { allowedChildren: ["coordinator"] }), []);
});

test("on-demand provider links stay in owner policy and combined cycles are rejected", () => {
  const original = { allowedChildren: ["reader", "analyst"], dependencies: { analyst: ["reader"] } };
  const updated = changeContextProviderLink(original, "reader", "analyst", true);
  assert.deepEqual(updated, { ok: true, next: {
    allowedChildren: ["reader", "analyst"], dependencies: { analyst: ["reader"] }, contextProviders: { analyst: ["reader"] },
  } });
  assert.deepEqual(changeContextProviderLink(original, "analyst", "reader", true),
    { ok: false, error: "This link creates a dependency cycle." });
  assert.deepEqual(changeDependencyLink(updated.next, "analyst", "reader", true),
    { ok: false, error: "This link creates a dependency cycle." });
  assert.deepEqual(changeChildLink("coordinator", updated.next, "reader", false, []),
    { ok: true, next: { allowedChildren: ["analyst"] } });
  assert.deepEqual(original, { allowedChildren: ["reader", "analyst"], dependencies: { analyst: ["reader"] } });
});

test("two connection types share the same eight-source limit", () => {
  const sources = Array.from({ length: 9 }, (_, index) => `reader-${index}`);
  const policy = {
    allowedChildren: ["analyst", ...sources],
    dependencies: { analyst: sources.slice(0, 5) },
    contextProviders: { analyst: sources.slice(5, 8) },
  };
  assert.deepEqual(changeContextProviderLink(policy, sources[8], "analyst", true),
    { ok: false, error: "An agent may have at most 8 prerequisites." });
  assert.deepEqual(changeContextProviderLink(policy, sources[0], "analyst", true), {
    ok: true, next: { ...policy, contextProviders: { analyst: [...sources.slice(5, 8), sources[0]] } },
  });
});

test("search in the combined graph retains the Main path and relevant sibling providers", () => {
  const profiles = [agent("coordinator", { allowedChildren: ["reader", "analyst"],
    contextProviders: { analyst: ["reader"] } }), agent("reader"), agent("analyst"), agent("unused")];
  const graph = buildOrchestrationGraph({ profiles, main: { allowedChildren: ["coordinator"] }, ownerId: null,
    layer: "all", query: "analyst" });
  assert.deepEqual(new Set(graph.nodes.map((node) => node.id)), new Set([MAIN_NODE_ID, "coordinator", "analyst", "reader"]));
  assert.ok(graph.edges.some((edge) => edge.kind === "contextProviders" && edge.source === "reader" && edge.target === "analyst"));
  assert.ok(graph.edges.some((edge) => edge.kind === "delegation" && edge.source === MAIN_NODE_ID && edge.target === "coordinator"));
});

test("dependent steps appear after producers in a focused branch", () => {
  const profiles = [agent("orchestrator", {
    allowedChildren: ["reader", "analyst", "writer"],
    dependencies: { analyst: ["reader"], writer: ["analyst"] },
  }), agent("reader"), agent("analyst"), agent("writer")];
  const graph = buildOrchestrationGraph({ profiles, main: null, ownerId: "orchestrator", layer: "dependencies" });
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  assert.ok(byId.get("orchestrator").x < byId.get("reader").x);
  assert.ok(byId.get("reader").x < byId.get("analyst").x);
  assert.ok(byId.get("analyst").x < byId.get("writer").x);
});

test("link edits block cycles and self-dependencies before invoking persistence", () => {
  const original = { allowedChildren: ["reader", "analyst", "writer"], dependencies: { analyst: ["reader"], writer: ["analyst"] } };
  assert.deepEqual(changeDependencyLink(original, "writer", "reader", true), { ok: false, error: "This link creates a dependency cycle." });
  assert.deepEqual(changeDependencyLink(original, "writer", "writer", true), { ok: false, error: "An agent cannot depend on itself." });
  assert.deepEqual(original, { allowedChildren: ["reader", "analyst", "writer"], dependencies: { analyst: ["reader"], writer: ["analyst"] } });
});

test("removing a child removes both incoming and outgoing requirements, without mutating existing policy", () => {
  const original = { allowedChildren: ["reader", "analyst", "writer"], dependencies: { analyst: ["reader"], writer: ["analyst", "reader"] } };
  assert.deepEqual(changeChildLink("coordinator", original, "analyst", false, []), {
    ok: true, next: { allowedChildren: ["reader", "writer"], dependencies: { writer: ["reader"] } },
  });
  assert.deepEqual(original.dependencies.writer, ["analyst", "reader"]);
});

test("cycle in delegated roster cannot hang breadcrumb search or auto layout", () => {
  const profiles = [agent("a", { allowedChildren: ["b"] }), agent("b", { allowedChildren: ["a"] })];
  const graph = buildOrchestrationGraph({ profiles, main: { allowedChildren: ["a"] }, ownerId: null, layer: "delegation" });
  assert.deepEqual(mapPathFromMain("b", profiles, { allowedChildren: ["a"] }), [MAIN_NODE_ID, "a", "b"]);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 3);
  assert.ok(graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
});

test("search keeps an agent's delegation path across nested orchestrators", () => {
  const profiles = [
    agent("first", { allowedChildren: ["second"] }),
    agent("second", { allowedChildren: ["reader", "writer"] }),
    agent("reader"), agent("writer"),
  ];
  const graph = buildOrchestrationGraph({ profiles, main: { allowedChildren: ["first"] }, ownerId: null,
    layer: "delegation", query: "writer" });
  assert.equal(graph.matchCount, 1);
  assert.deepEqual(graph.nodes.map((node) => node.id), [MAIN_NODE_ID, "first", "second", "writer"]);
  assert.deepEqual(graph.edges.map(({ source, target }) => [source, target]), [
    [MAIN_NODE_ID, "first"], ["first", "second"], ["second", "writer"],
  ]);
});

test("dependency search shows connected agents and owners without restoring unrelated branches", () => {
  const profiles = [
    agent("one", { allowedChildren: ["reader", "writer", "other"], dependencies: { writer: ["reader"] } }),
    agent("two", { allowedChildren: ["reader", "writer"], dependencies: { writer: ["reader"] } }),
    agent("reader"), agent("writer"), agent("other"),
  ];
  const graph = buildOrchestrationGraph({ profiles, main: { allowedChildren: ["one", "two"] }, ownerId: null,
    layer: "dependencies", query: "writer" });
  assert.equal(graph.matchCount, 1);
  assert.deepEqual(graph.nodes.map((node) => node.id), [MAIN_NODE_ID, "one", "reader", "two", "writer"]);
  assert.deepEqual(graph.edges.map(({ ownerId }) => ownerId), ["one", "two"]);
  const focused = buildOrchestrationGraph({ profiles, main: null, ownerId: "one", layer: "dependencies", query: "writer" });
  assert.deepEqual(focused.nodes.map((node) => node.id), ["one", "reader", "writer"]);
  assert.deepEqual(focused.edges.map(({ source, target }) => [source, target]), [["reader", "writer"]]);
});

test("unmatched search retains the scope root and reports no match", () => {
  const profiles = [agent("one", { allowedChildren: ["reader"] }), agent("reader")];
  const overview = buildOrchestrationGraph({ profiles, main: { allowedChildren: ["one"] }, ownerId: null,
    layer: "delegation", query: "does-not-exist" });
  assert.equal(overview.matchCount, 0);
  assert.deepEqual(overview.nodes.map((node) => node.id), [MAIN_NODE_ID]);
  assert.deepEqual(overview.edges, []);
  const branch = buildOrchestrationGraph({ profiles, main: null, ownerId: "one", layer: "delegation", query: "does-not-exist" });
  assert.equal(branch.matchCount, 0);
  assert.deepEqual(branch.nodes.map((node) => node.id), ["one"]);
});

test("search narrows a 200-agent roster to the target and its actual delegation link", () => {
  const profiles = Array.from({ length: 200 }, (_, index) => agent(`agent-${index}`));
  const graph = buildOrchestrationGraph({ profiles, main: { allowedChildren: profiles.map((profile) => profile.name) },
    ownerId: null, layer: "delegation", query: "agent-199" });
  assert.equal(graph.matchCount, 1);
  assert.deepEqual(graph.nodes.map((node) => node.id), [MAIN_NODE_ID, "agent-199"]);
  assert.deepEqual(graph.edges.map(({ source, target }) => [source, target]), [[MAIN_NODE_ID, "agent-199"]]);
});

test("Fit all includes every node in a 200-agent graph while small graphs remain centered", () => {
  const profiles = Array.from({ length: 200 }, (_, index) => agent(`agent-${index}`));
  const graph = buildOrchestrationGraph({ profiles, main: { allowedChildren: profiles.map((profile) => profile.name) },
    ownerId: null, layer: "delegation" });
  const root = graph.nodes.find((node) => node.id === MAIN_NODE_ID);
  const view = fitOrchestrationMap(graph.nodes, 1000, 700, MAIN_NODE_ID);
  assert.ok(view.scale < 0.22);
  for (const node of graph.nodes) {
    assert.ok(node.x * view.scale + view.x >= 36 - 1e-8);
    assert.ok((node.x + MAP_NODE_WIDTH) * view.scale + view.x <= 1000 - 36 + 1e-8);
    assert.ok(node.y * view.scale + view.y >= 36 - 1e-8);
    assert.ok((node.y + MAP_NODE_HEIGHT) * view.scale + view.y <= 700 - 36 + 1e-8);
  }
  assert.ok(root.x * view.scale + view.x > 0);

  const selected = graph.nodes.at(-1);
  const centered = centerOrchestrationMapNode(selected, 1000, 700, 0.9);
  assert.equal((selected.x + MAP_NODE_WIDTH / 2) * centered.scale + centered.x, 500);
  assert.equal((selected.y + MAP_NODE_HEIGHT / 2) * centered.scale + centered.y, 350);

  const small = fitOrchestrationMap(graph.nodes.slice(0, 2), 1000, 700, MAIN_NODE_ID);
  assert.equal(small.scale, 1);
  assert.ok(root.y + small.y > 200);
  assert.ok(root.x + small.x > 100);
});

test("a branch with 16 direct agents opens legibly; Fit all remains a distinct overview action", () => {
  const profiles = Array.from({ length: 16 }, (_, index) => agent(`agent-${index}`));
  const graph = buildOrchestrationGraph({ profiles, main: { allowedChildren: profiles.map((profile) => profile.name) },
    ownerId: MAIN_NODE_ID, layer: "all" });
  const readable = readableOrchestrationMap(graph.nodes, 1000, 700, MAIN_NODE_ID);
  const fitted = fitOrchestrationMap(graph.nodes, 1000, 700, MAIN_NODE_ID);
  const root = graph.nodes.find((node) => node.id === MAIN_NODE_ID);
  assert.equal(readable.scale, 0.75);
  assert.ok(fitted.scale < readable.scale);
  assert.equal(root.y * readable.scale + readable.y, 36);
  assert.ok(root.x * readable.scale + readable.x > 0);
});

test("connection filters change only visible edges, preserving their owner and source policy", () => {
  const policy = { allowedChildren: ["reader", "analyst"], dependencies: { analyst: ["reader"] },
    contextProviders: { analyst: ["reader"] } };
  const graph = buildOrchestrationGraph({ profiles: [agent("reader"), agent("analyst")], main: policy,
    ownerId: MAIN_NODE_ID, layer: "all" });
  const original = structuredClone(graph.edges);
  for (const kind of ["delegation", "dependencies", "contextProviders"]) {
    const shown = filterOrchestrationEdges(graph.edges, kind);
    assert.ok(shown.length > 0);
    assert.ok(shown.every((edge) => edge.kind === kind && edge.ownerId === MAIN_NODE_ID));
  }
  assert.deepEqual(filterOrchestrationEdges(graph.edges, "all"), original);
  assert.deepEqual(graph.edges, original);
  assert.deepEqual(policy, { allowedChildren: ["reader", "analyst"], dependencies: { analyst: ["reader"] },
    contextProviders: { analyst: ["reader"] } });
});
