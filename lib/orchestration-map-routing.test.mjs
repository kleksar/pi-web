import assert from "node:assert/strict";
import test from "node:test";
import {
  MAIN_NODE_ID, MAP_NODE_HEIGHT, MAP_NODE_WIDTH, autoLayoutGraph, buildOrchestrationGraph,
  filterOrchestrationEdges, fitOrchestrationMap, navigationOrchestrationGraph,
  orchestrationLayoutFingerprint, windowOrchestrationBranch,
} from "./orchestration-map.ts";
import { applyManualMapPositions, canPlaceMapNode, routeOrchestrationEdges } from "./orchestration-map-routing.ts";

const agent = (name, orchestration) => ({ name, displayName: name, scope: "roster", enabled: true, orchestration, description: "" });

function assertClear(nodes, routes) {
  for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
    const left = nodes[a];
    const right = nodes[b];
    assert.ok(left.x + MAP_NODE_WIDTH <= right.x || right.x + MAP_NODE_WIDTH <= left.x
      || left.y + MAP_NODE_HEIGHT <= right.y || right.y + MAP_NODE_HEIGHT <= left.y,
    `Cards overlap: ${left.id}, ${right.id}`);
  }
  for (const route of routes) for (const [index, point] of route.points.entries()) {
    if (!index) continue;
    const previous = route.points[index - 1];
    assert.ok(previous.x === point.x || previous.y === point.y, "Every segment is orthogonal");
    for (const node of nodes) {
      const insideHorizontal = point.y > node.y && point.y < node.y + MAP_NODE_HEIGHT
        && Math.max(previous.x, point.x) > node.x && Math.min(previous.x, point.x) < node.x + MAP_NODE_WIDTH;
      const insideVertical = point.x > node.x && point.x < node.x + MAP_NODE_WIDTH
        && Math.max(previous.y, point.y) > node.y && Math.min(previous.y, point.y) < node.y + MAP_NODE_HEIGHT;
      assert.ok(!(insideHorizontal || insideVertical),
        `Route ${route.edge.source} → ${route.edge.target} intersects ${node.id}`);
    }
  }
}

test("overview shows direct Main children only and reports every collapsed legacy child", () => {
  const profiles = [agent("coordinator", { allowedChildren: ["nested"] }), agent("nested"),
    ...Array.from({ length: 18 }, (_, index) => agent(`worker-${index}`))];
  const full = buildOrchestrationGraph({ profiles, main: null, ownerId: null, layer: "delegation", connectedOnly: true });
  const overview = navigationOrchestrationGraph(full, profiles.map((profile) => profile.name));
  assert.equal(overview.nodes.length, 13);
  assert.equal(overview.hiddenDirectCount, 8);
  assert.ok(overview.nodes.some((node) => node.id === "coordinator"));
  assert.ok(overview.edges.every((edge) => edge.ownerId === MAIN_NODE_ID && edge.source === MAIN_NODE_ID));
  assertClear(overview.nodes, routeOrchestrationEdges(overview.nodes, overview.edges));
  const search = buildOrchestrationGraph({ profiles, main: { allowedChildren: ["coordinator"] },
    ownerId: null, layer: "delegation", connectedOnly: true, query: "nested" });
  assert.deepEqual(search.nodes.map((node) => node.id), [MAIN_NODE_ID, "coordinator", "nested"]);
});

test("only strict prerequisites assign stages; on-demand providers retain independent rows", () => {
  const names = ["reader", "planner", "analyst", "writer"];
  const policy = { allowedChildren: names, dependencies: { analyst: ["reader"], writer: ["analyst"] },
    contextProviders: { reader: ["writer"], planner: ["analyst"] } };
  const graph = buildOrchestrationGraph({ profiles: [agent("owner", policy), ...names.map((name) => agent(name))],
    main: null, ownerId: "owner", layer: "all" });
  const prerequisites = filterOrchestrationEdges(graph.edges, "dependencies");
  const strict = autoLayoutGraph(graph.nodes, prerequisites, "owner");
  const byId = new Map(strict.map((node) => [node.id, node]));
  assert.ok(byId.get("reader").x < byId.get("analyst").x);
  assert.ok(byId.get("analyst").x < byId.get("writer").x);
  const onDemand = autoLayoutGraph(graph.nodes, filterOrchestrationEdges(graph.edges, "contextProviders"), "owner");
  assert.equal(new Set(onDemand.filter((node) => node.id !== "owner").map((node) => node.x)).size, 1);
  assert.deepEqual(autoLayoutGraph(graph.nodes, prerequisites, "owner"), strict);
  assertClear(strict, routeOrchestrationEdges(strict, prerequisites));
  assertClear(onDemand, routeOrchestrationEdges(onDemand, filterOrchestrationEdges(graph.edges, "contextProviders")));
  assertClear(autoLayoutGraph(graph.nodes, filterOrchestrationEdges(graph.edges, "delegation"), "owner"),
    routeOrchestrationEdges(autoLayoutGraph(graph.nodes, filterOrchestrationEdges(graph.edges, "delegation"), "owner"),
      filterOrchestrationEdges(graph.edges, "delegation")));
});

test("long, backward, and dense sibling links avoid card rectangles", () => {
  const names = Array.from({ length: 16 }, (_, index) => `agent-${index}`);
  const policy = { allowedChildren: names,
    dependencies: Object.fromEntries(names.slice(1).map((name, index) => [name, [names[index]]])),
    contextProviders: { [names[0]]: [names.at(-1)] } };
  const graph = buildOrchestrationGraph({ profiles: [agent("owner", policy), ...names.map((name) => agent(name))],
    main: null, ownerId: "owner", layer: "all" });
  for (const kind of ["delegation", "dependencies", "contextProviders"]) {
    const edges = filterOrchestrationEdges(graph.edges, kind);
    const nodes = autoLayoutGraph(graph.nodes, edges, "owner");
    const routes = routeOrchestrationEdges(nodes, edges);
    assertClear(nodes, routes);
    const routePoints = routes.flatMap((route) => route.points);
    const fitted = fitOrchestrationMap(nodes, 1100, 700, "owner", routePoints);
    for (const point of routePoints) {
      assert.ok(point.x * fitted.scale + fitted.x >= 36 - 1e-8);
      assert.ok(point.x * fitted.scale + fitted.x <= 1100 - 36 + 1e-8);
      assert.ok(point.y * fitted.scale + fitted.y >= 36 - 1e-8);
      assert.ok(point.y * fitted.scale + fitted.y <= 700 - 36 + 1e-8);
    }
  }
});

test("legacy self-links stay visible without routing through their own card", () => {
  const nodes = [{ id: "legacy", label: "legacy", kind: "orchestrator", enabled: true, x: 44, y: 40 }];
  const edges = [{ ownerId: "legacy", source: "legacy", target: "legacy", kind: "delegation" }];
  const routes = routeOrchestrationEdges(nodes, edges);
  assert.equal(routes.length, 1);
  assertClear(nodes, routes);
});

test("a 200-child branch reveals 24 at a time without losing its complete policy", () => {
  const profiles = Array.from({ length: 200 }, (_, index) => agent(`agent-${index}`));
  const policy = { allowedChildren: profiles.map((profile) => profile.name) };
  const full = buildOrchestrationGraph({ profiles, main: policy, ownerId: MAIN_NODE_ID, layer: "all" });
  const first = windowOrchestrationBranch(full, MAIN_NODE_ID, "delegation");
  assert.equal(first.nodes.length, 25);
  assert.equal(first.hiddenDirectCount, 176);
  assert.equal(first.edges.length, 24);
  assert.equal(full.edges.length, 200);
  const more = windowOrchestrationBranch(full, MAIN_NODE_ID, "delegation", 48);
  assert.equal(more.nodes.length, 49);
  assert.equal(more.hiddenDirectCount, 152);
  assertClear(first.nodes, routeOrchestrationEdges(first.nodes, first.edges));
});

test("a new long route refreshes fit even when strict stages and card positions stay unchanged", () => {
  const beforePolicy = { allowedChildren: ["a", "b", "c"], dependencies: { b: ["a"], c: ["b"] } };
  const afterPolicy = { allowedChildren: ["a", "b", "c"], dependencies: { b: ["a"], c: ["b", "a"] } };
  const profiles = [agent("owner", beforePolicy), ...["a", "b", "c"].map((name) => agent(name))];
  const create = (policy) => {
    const graph = buildOrchestrationGraph({ profiles, main: null, ownerId: "owner", draft: policy, layer: "all" });
    const edges = filterOrchestrationEdges(graph.edges, "dependencies");
    const nodes = autoLayoutGraph(graph.nodes, edges, "owner");
    const routes = routeOrchestrationEdges(nodes, edges);
    return { nodes, edges, routes };
  };
  const before = create(beforePolicy);
  const after = create(afterPolicy);
  assert.deepEqual(before.nodes, after.nodes);
  assert.notEqual(orchestrationLayoutFingerprint("branch:dependencies", before.nodes, before.edges),
    orchestrationLayoutFingerprint("branch:dependencies", after.nodes, after.edges));
  const longRoute = after.routes.find(({ edge }) => edge.source === "a" && edge.target === "c");
  assert.ok(longRoute.points.some((point) => point.y < Math.min(...after.nodes.map((node) => node.y))));
  const beforeFit = fitOrchestrationMap(before.nodes, 900, 600, "owner", before.routes.flatMap((route) => route.points));
  const afterFit = fitOrchestrationMap(after.nodes, 900, 600, "owner", after.routes.flatMap((route) => route.points));
  assert.notDeepEqual(beforeFit, afterFit);
  assertClear(after.nodes, after.routes);
});

test("a late sparse relation appears in the first page, and an inspected edge pins both endpoints", () => {
  const profiles = Array.from({ length: 200 }, (_, index) => agent(`agent-${index}`));
  const policy = { allowedChildren: profiles.map((profile) => profile.name),
    dependencies: { "agent-199": ["agent-198"] },
    contextProviders: { "agent-197": ["agent-196"],
      ...Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`agent-${100 + index}`, [`agent-${50 + index}`]])),
      "agent-1": ["agent-199"] } };
  const full = buildOrchestrationGraph({ profiles, main: policy, ownerId: MAIN_NODE_ID, layer: "all" });
  const window = windowOrchestrationBranch(full, MAIN_NODE_ID, "dependencies");
  const dependency = window.edges.find((edge) => edge.kind === "dependencies");
  assert.ok(dependency);
  assert.equal(dependency.source, "agent-198");
  assert.equal(dependency.target, "agent-199");
  assert.equal(window.nodes.length, 25);
  assert.equal(window.hiddenDirectCount, 176);
  assertClear(window.nodes, routeOrchestrationEdges(window.nodes, [dependency]));

  const provider = full.edges.find((edge) => edge.kind === "contextProviders" && edge.target === "agent-1");
  const providerWindow = windowOrchestrationBranch(full, MAIN_NODE_ID, "contextProviders");
  assert.ok(!providerWindow.nodes.some((node) => node.id === "agent-1"));
  const focused = windowOrchestrationBranch(full, MAIN_NODE_ID, "contextProviders", 24,
    { edge: provider, nodeId: "agent-1" });
  assert.equal(focused.nodes.length, 25);
  assert.ok(focused.nodes.some((node) => node.id === "agent-1"));
  assert.ok(focused.nodes.some((node) => node.id === "agent-199"));
  assert.ok(focused.edges.some((edge) => edge.kind === "contextProviders"
    && edge.source === "agent-199" && edge.target === "agent-1"));
  const directListFocus = windowOrchestrationBranch(full, MAIN_NODE_ID, "delegation", 24, { nodeId: "agent-1" });
  assert.equal(directListFocus.nodes.length, 25);
  assert.ok(directListFocus.nodes.some((node) => node.id === "agent-1"));
  assert.ok(directListFocus.edges.some((edge) => edge.kind === "delegation" && edge.target === "agent-1"));
  const broad = buildOrchestrationGraph({ profiles, main: policy, ownerId: MAIN_NODE_ID,
    layer: "all", query: "agent-1" });
  assert.equal(broad.matchCount, 111); // User search stays substring-based; inspector navigation uses the exact pinned edge.
  assert.ok(broad.nodes.length > focused.nodes.length);
  assertClear(focused.nodes, routeOrchestrationEdges(focused.nodes, filterOrchestrationEdges(focused.edges, "contextProviders")));
});

test("manual move into an edge corridor is rejected while safe drag positions remain usable", () => {
  const policy = { allowedChildren: ["a", "b", "c"], dependencies: { b: ["a"] } };
  const graph = buildOrchestrationGraph({ profiles: [agent("owner", policy), ...["a", "b", "c"].map((name) => agent(name))],
    main: null, ownerId: "owner", layer: "dependencies" });
  const nodes = graph.nodes;
  const path = graph.edges.find((edge) => edge.kind === "dependencies");
  const c = nodes.find((node) => node.id === "c");
  const a = nodes.find((node) => node.id === "a");
  const b = nodes.find((node) => node.id === "b");
  assert.equal(a.x, c.x);
  assert.ok(a.x + MAP_NODE_WIDTH + 24 < b.x);
  const corridor = { x: a.x + MAP_NODE_WIDTH + 12, y: a.y };
  assert.equal(canPlaceMapNode("c", corridor, nodes, [path]), false);
  assert.deepEqual(applyManualMapPositions(nodes, { c: corridor }, [path]), nodes);
  const safe = { x: c.x, y: c.y + 400 };
  assert.equal(canPlaceMapNode("c", safe, nodes, [path]), true);
  const moved = applyManualMapPositions(nodes, { c: safe }, [path]);
  assert.deepEqual(moved.find((node) => node.id === "c"), { ...c, ...safe });
  assertClear(moved, routeOrchestrationEdges(moved, [path]));
});

test("programmatic navigation to an unassigned agent uses an exact id while typed search stays broad", () => {
  const profiles = Array.from({ length: 200 }, (_, index) => agent(`agent-${index}`));
  const input = { profiles, main: { allowedChildren: [] }, ownerId: null, layer: "delegation", connectedOnly: true,
    query: "agent-1" };
  const exact = buildOrchestrationGraph({ ...input, exactQuery: true });
  const typed = buildOrchestrationGraph(input);
  assert.equal(exact.matchCount, 1);
  assert.deepEqual(exact.nodes.map((node) => node.id), [MAIN_NODE_ID, "agent-1"]);
  assert.equal(typed.matchCount, 111);
  assert.equal(typed.nodes.length, 112);
});
