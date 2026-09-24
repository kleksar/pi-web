import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { projectTreeForResponse, toSummaryTree } from "../lib/project-tree.ts";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { BranchNavigator, buildActivePath, compressChain, hasSessionBranches, selectTopLevelBranches } = await jiti.import("./BranchNavigator.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

const msg = (id, role, text) => ({ type: "message", id, parentId: null, timestamp: "t", message: { role, content: text } });
const info = (id) => ({ type: "session_info", id, parentId: null, timestamp: "t", name: "x" });
const model = (id) => ({ type: "model_change", id, parentId: null, timestamp: "t", provider: "test", modelId: "test" });
const node = (entry, children = []) => ({ entry, children });

test("branch navigation hides terminal fork-cost markers but keeps their SDK lineage", () => {
  const baseline = (id, parentId) => ({
    type: "custom", customType: "pi-web:fork-cost-baseline", id, parentId, timestamp: "t", data: {},
  });
  const marker = node(baseline("baseline", "a1"));
  const root = node(msg("root", "user", "root"), [
    node(msg("a1", "assistant", "first"), [marker, node(msg("u2", "user", "continuation"))]),
    node(msg("u3", "user", "separate branch")),
  ]);
  const summary = toSummaryTree(projectTreeForResponse([root]));
  assert.equal(summary[0].children[0].children[0].entry.id, "baseline", "the SDK marker remains in the tree");
  assert.equal(buildActivePath(summary, "baseline").has("a1"), true, "its parent remains on the active path");
  assert.equal(hasSessionBranches(summary), true);
  assert.deepEqual(selectTopLevelBranches(summary).map((branch) => branch.entry.id), ["a1", "u3"]);
  assert.equal(compressChain(selectTopLevelBranches(summary)[0]).node.entry.id, "u2");
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(BranchNavigator, {
      tree: summary, activeLeafId: "baseline", onLeafChange: () => {}, open: true, hasSession: true,
    }),
  ));
  assert.equal(html.includes(">custom<"), false, "no empty internal-marker row is rendered");
  assert.equal(html.includes("first"), true);
  assert.equal(html.includes("separate branch"), true);

  const loneFork = toSummaryTree(projectTreeForResponse([node(msg("root", "user", "root"), [
    marker, node(msg("u2", "user", "continuation")),
  ])]));
  assert.equal(hasSessionBranches(loneFork), false, "marker is not a second dialogue branch");
  assert.deepEqual(selectTopLevelBranches(loneFork), []);

  const markerWithChildren = node(baseline("internal-marker", "root"), [
    node(msg("u4", "user", "child one")), node(msg("u5", "user", "child two")),
  ]);
  const navigable = toSummaryTree(projectTreeForResponse([node(msg("root", "user", "root"), [
    markerWithChildren, node(msg("u3", "user", "separate branch")),
  ])]));
  assert.deepEqual(selectTopLevelBranches(navigable).map((branch) => branch.entry.id), ["internal-marker", "u3"],
    "a marker with descendants must retain its navigation structure");
});

test("terminal cost marker does not block a later branch point", () => {
  const marker = node({
    type: "custom", customType: "pi-web:fork-cost-baseline", id: "baseline", parentId: "A", timestamp: "t", data: {},
  });
  const tree = toSummaryTree(projectTreeForResponse([node(msg("A", "assistant", "answer"), [
    marker,
    node(msg("B", "user", "follow-up"), [
      node(msg("C", "assistant", "first branch")),
      node(msg("D", "assistant", "second branch")),
    ]),
  ])]));
  assert.equal(hasSessionBranches(tree), true);
  assert.deepEqual(selectTopLevelBranches(tree).map((branch) => branch.entry.id), ["C", "D"]);
});

test("compressChain labels a chain by its first message entry", () => {
  const chain = node(msg("u1", "user", "原问题"), [node(msg("a1", "assistant", "回答"))]);
  const { labelEntry, node: rep } = compressChain(chain);
  assert.equal(labelEntry.id, "u1");
  assert.equal(rep.entry.id, "a1");
});

test("compressChain skips non-message entries such as session_info", () => {
  const chain = node(info("s1"), [node(msg("u1", "user", "原始问题"), [node(msg("a1", "assistant", "答"))])]);
  const { labelEntry, node: rep, skipped } = compressChain(chain);
  assert.equal(labelEntry.id, "u1");
  assert.equal(rep.entry.id, "a1");
  assert.equal(skipped, 2);
});

test("compressChain labels a projected chain by its preview but selects its representative", () => {
  const representative = {
    entry: msg("a1", "assistant", "回答"),
    children: [],
    compressedEntryIds: ["u1"],
    branchPreview: { role: "user", text: "原始问题" },
  };
  const chain = node(info("s1"), [representative]);
  const { branchPreview, node: rep, skipped } = compressChain(chain);
  assert.deepEqual(branchPreview, { role: "user", text: "原始问题" });
  assert.equal(rep.entry.id, "a1");
  assert.equal(skipped, 2);
});

test("compressChain falls back to the chain end when no message entry exists", () => {
  const chain = node(info("s1"), [node(info("s2"))]);
  const { labelEntry } = compressChain(chain);
  assert.equal(labelEntry.id, "s2");
});

test("selectTopLevelBranches returns all roots for multi-root trees", () => {
  const r1 = node(msg("u1", "user", "第一问"));
  const r2 = node(msg("u1b", "user", "第一问改"));
  assert.deepEqual(selectTopLevelBranches([r1, r2]).map((n) => n.entry.id), ["u1", "u1b"]);
});

test("selectTopLevelBranches returns children of the first branching node", () => {
  const b1 = node(msg("u2", "user", "分支一"));
  const b2 = node(msg("u2b", "user", "分支二"));
  const root = node(msg("u1", "user", "第一问"), [node(msg("a1", "assistant", "答"), [b1, b2])]);
  assert.deepEqual(selectTopLevelBranches([root]).map((n) => n.entry.id), ["u2", "u2b"]);
});

test("selectTopLevelBranches returns empty for a linear session", () => {
  const root = node(msg("u1", "user", "第一问"), [node(msg("a1", "assistant", "答"))]);
  assert.deepEqual(selectTopLevelBranches([root]), []);
});

test("hasSessionBranches distinguishes linear sessions from branched sessions", () => {
  const linear = node(msg("u1", "user", "第一问"), [node(msg("a1", "assistant", "答"))]);
  const branched = node(msg("u1", "user", "第一问"), [
    node(msg("a1", "assistant", "答"), [
      node(msg("u2", "user", "分支一")),
      node(msg("u2b", "user", "分支二")),
    ]),
  ]);

  assert.equal(hasSessionBranches([]), false);
  assert.equal(hasSessionBranches([linear]), false);
  assert.equal(hasSessionBranches([branched]), true);
  assert.equal(hasSessionBranches([linear, branched]), true);
});

test("selectTopLevelBranches works on preview-only server projections", () => {
  const arm1 = {
    entry: msg("a2", "assistant", "答一"),
    children: [],
    compressedEntryIds: ["s1", "u2"],
    branchPreview: { role: "user", text: "分支一" },
  };
  const arm2 = {
    entry: msg("a2b", "assistant", "答二"),
    children: [],
    compressedEntryIds: ["u2b"],
    branchPreview: { role: "user", text: "分支二" },
  };
  const branchPoint = { entry: msg("a1", "assistant", "答"), children: [arm1, arm2] };
  const root = { entry: msg("u1", "user", "第一问"), children: [branchPoint] };
  const topLevel = selectTopLevelBranches([root]);
  assert.deepEqual(topLevel.map((n) => n.entry.id), ["a2", "a2b"]);
  assert.deepEqual(compressChain(topLevel[0]).branchPreview, { role: "user", text: "分支一" });
  assert.equal(compressChain(topLevel[0]).node.entry.id, "a2");
});

test("multi-root metadata chains use their user previews and assistant representatives", () => {
  const r1 = node(model("m1"), [{
    entry: msg("a1", "assistant", "回答一"),
    children: [],
    compressedEntryIds: ["u1"],
    branchPreview: { role: "user", text: "第一问" },
  }]);
  const r2 = node(info("s2"), [{
    entry: msg("a2", "assistant", "回答二"),
    children: [],
    compressedEntryIds: ["u2"],
    branchPreview: { role: "user", text: "第二问" },
  }]);
  const topLevel = selectTopLevelBranches([r1, r2]);
  assert.deepEqual(topLevel.map((n) => compressChain(n).branchPreview.text), ["第一问", "第二问"]);
  assert.deepEqual(topLevel.map((n) => compressChain(n).node.entry.id), ["a1", "a2"]);
});

// --- #509 regression: recursive tree consumption overflowed the stack on a
// linear session (depth == entry count). The iterative rewrite must survive a
// chain far deeper than V8's call-stack limit.

// Build a linear chain of `n` nodes (each child is the previous one).
function linearTree(n) {
  const nodes = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const entry = { type: "message", id: `e${i}`, parentId: prev, timestamp: "t", message: { role: "user", content: `m${i}` } };
    nodes.push({ entry, children: [] });
    if (prev) nodes[nodes.length - 2].children = [nodes[nodes.length - 1]];
    prev = `e${i}`;
  }
  return nodes[0];
}

test("buildActivePath finds the leaf on a 6000-deep linear chain without a stack overflow", () => {
  const root = linearTree(6000);
  const path = buildActivePath([root], "e5999");
  assert.equal(path.size, 6000);
  assert.ok(path.has("e0"));
  assert.ok(path.has("e5999"));
});

test("hasSessionBranches reports false for a linear chain (no branching) and true otherwise", () => {
  assert.equal(hasSessionBranches([linearTree(5000)]), false);
  const root = linearTree(3);
  root.children[0].children[0].children = [
    { entry: { type: "message", id: "b1", parentId: "e2", timestamp: "t", message: { role: "user", content: "x" } }, children: [] },
    { entry: { type: "message", id: "b2", parentId: "e2", timestamp: "t", message: { role: "user", content: "y" } }, children: [] },
  ];
  assert.equal(hasSessionBranches([root]), true);
  assert.equal(hasSessionBranches([root]), true);
});

test("hasSessionBranches reports true for multiple root nodes (a branch from the first message)", () => {
  // Each root has a single child, so no node.children.length > 1 — only the
  // multiple-root shape makes this a branch.
  const r1 = { entry: { type: "message", id: "r1", parentId: null, timestamp: "t", message: { role: "user", content: "a" } }, children: [] };
  const r2 = { entry: { type: "message", id: "r2", parentId: null, timestamp: "t", message: { role: "user", content: "b" } }, children: [] };
  assert.equal(hasSessionBranches([r1, r2]), true);
});

test("compressChain never labels a branch with a transcript system message", () => {
  // Pi >= 0.86 roots new sessions at a system message holding the prompt.
  const system = { type: "message", id: "sys", parentId: null, timestamp: "t", message: { role: "system", content: "", sections: { preamble: "You are an expert coding assistant." } } };
  const chain = node(system, [node(msg("u1", "user", "原始问题"), [node(msg("a1", "assistant", "答"))])]);
  const { labelEntry, node: rep, skipped } = compressChain(chain);
  assert.equal(labelEntry.id, "u1");
  assert.equal(rep.entry.id, "a1");
  assert.equal(skipped, 2);
});
