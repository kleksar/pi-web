import assert from "node:assert/strict";
import test from "node:test";
import {
  MAIN_NODE_ID, buildOrchestrationGraph, changeChildLink, changeDependencyLink,
  effectiveMapProfiles, fitOrchestrationMap, mainPolicyForMap, mapPathFromMain,
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

test("fit centers a small graph but leaves the root visible when 200 agents overflow the minimum zoom", () => {
  const profiles = Array.from({ length: 200 }, (_, index) => agent(`agent-${index}`));
  const graph = buildOrchestrationGraph({ profiles, main: { allowedChildren: profiles.map((profile) => profile.name) },
    ownerId: null, layer: "delegation" });
  const root = graph.nodes.find((node) => node.id === MAIN_NODE_ID);
  const view = fitOrchestrationMap(graph.nodes, 1000, 700, MAIN_NODE_ID);
  assert.equal(view.scale, 0.22);
  assert.equal(root.y * view.scale + view.y, 36);
  assert.ok(root.x * view.scale + view.x > 0);

  const small = fitOrchestrationMap(graph.nodes.slice(0, 2), 1000, 700, MAIN_NODE_ID);
  assert.equal(small.scale, 1);
  assert.ok(root.y + small.y > 200);
  assert.ok(root.x + small.x > 100);
});
