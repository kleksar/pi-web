import assert from "node:assert/strict";
import test from "node:test";
import { assessTaskAcceptance } from "./orchestration-acceptance.ts";

const ready = {
  snapshotId: "candidate-2",
  criteriaVersion: "criteria-2",
  requireReview: true,
  review: { verdict: "approved", snapshotId: "candidate-2", criteriaVersion: "criteria-2", requiredCheckIds: ["regression"] },
  checks: [{ id: "regression", required: true, status: "passed", snapshotId: "candidate-2" }],
};

test("a review of the old patch cannot accept a new candidate", () => {
  const decision = assessTaskAcceptance({
    ...ready,
    review: { ...ready.review, snapshotId: "candidate-1" },
  });
  assert.equal(decision.accepted, false);
  assert.match(decision.reasons.join("; "), /older candidate/);
});

test("new user steering invalidates prior approval until reconciled", () => {
  const decision = assessTaskAcceptance({ ...ready, pendingSteering: true });
  assert.equal(decision.accepted, false);
  assert.match(decision.reasons.join("; "), /requirements/);
});

test("an unavailable required check is not reported as passed", () => {
  const decision = assessTaskAcceptance({
    ...ready,
    checks: [{ ...ready.checks[0], status: "environment_blocked" }],
  });
  assert.equal(decision.accepted, false);
  assert.match(decision.reasons.join("; "), /environment_blocked/);
});

test("a waiver for old criteria cannot silently waive a new requirement", () => {
  const decision = assessTaskAcceptance({
    ...ready,
    checks: [{ ...ready.checks[0], status: "not_run", waivedForCriteriaVersion: "criteria-1" }],
  });
  assert.equal(decision.accepted, false);
});

test("the exact reviewed candidate with completed required checks can be accepted", () => {
  assert.deepEqual(assessTaskAcceptance(ready), { accepted: true, reasons: [] });
});

test("a reviewer-required check cannot disappear from the owner's acceptance request", () => {
  const decision = assessTaskAcceptance({ ...ready, checks: [] });
  assert.equal(decision.accepted, false);
  assert.match(decision.reasons.join("; "), /has not run/);
});
