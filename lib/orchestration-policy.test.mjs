import assert from "node:assert/strict";
import test from "node:test";
import { findOrchestrationLinkIssue, withAllowedChildren } from "./orchestration-policy.ts";

test("mixed required and on-demand links cannot form a cycle", () => {
  const issue = findOrchestrationLinkIssue(
    ["Reader", "Analyst", "Writer"],
    { Writer: ["Analyst"] },
    { Analyst: ["Reader"], Reader: ["Writer"] },
  );
  assert.deepEqual(issue, { type: "cycle", names: ["Reader", "Writer", "Analyst", "Reader"] });
});

test("the combined source limit covers both link types", () => {
  const sources = Array.from({ length: 9 }, (_, index) => `reader-${index}`);
  assert.deepEqual(findOrchestrationLinkIssue(
    ["analyst", ...sources],
    { analyst: sources.slice(0, 5) },
    { analyst: sources.slice(5) },
  ), { type: "limit", name: "analyst" });
});

test("a missing child or source is reported before cycles", () => {
  assert.deepEqual(findOrchestrationLinkIssue(["reader"], { missing: ["reader"] }),
    { type: "unknown", names: ["missing"], firstKind: "child" });
  assert.deepEqual(findOrchestrationLinkIssue(["reader"], { reader: ["missing"] }),
    { type: "unknown", names: ["missing"], firstKind: "source" });
});

test("removing a child prunes incoming and outgoing links without mutating the draft", () => {
  const original = {
    allowedChildren: ["Reader", "Analyst", "Writer"],
    dependencies: { Analyst: ["Reader"], Writer: ["Analyst", "Reader"] },
    contextProviders: { Analyst: ["Writer"], Writer: ["Reader"] },
  };
  assert.deepEqual(withAllowedChildren(original, ["Reader", "Writer"]), {
    allowedChildren: ["Reader", "Writer"],
    dependencies: { Writer: ["Reader"] },
    contextProviders: { Writer: ["Reader"] },
  });
  assert.deepEqual(original.dependencies.Writer, ["Analyst", "Reader"]);
  assert.deepEqual(original.contextProviders.Analyst, ["Writer"]);
});
