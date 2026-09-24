/** Acceptance is attached to a concrete candidate and criteria revision, never to an agent's prose. */
export interface CandidateReview {
  verdict: "approved" | "changes_requested" | "needs_context";
  snapshotId: string;
  criteriaVersion: string;
  blockingFindings?: readonly string[];
  /** Chosen independently by the reviewer for this exact candidate; [] is an explicit no-check decision. */
  requiredCheckIds?: readonly string[];
}

export interface CandidateCheck {
  id: string;
  required: boolean;
  status: "passed" | "failed" | "not_run" | "environment_blocked";
  snapshotId: string;
  /** A waiver is valid only when recorded as an explicit user decision for this criteria revision. */
  waivedForCriteriaVersion?: string;
}

export interface AcceptanceInput {
  snapshotId: string;
  criteriaVersion: string;
  requireReview: boolean;
  review?: CandidateReview;
  checks: readonly CandidateCheck[];
  openBlockers?: readonly string[];
  /** Work must not be accepted while new user steering has not been reconciled by its owner. */
  pendingSteering?: boolean;
}

export interface AcceptanceDecision {
  accepted: boolean;
  reasons: string[];
}

/** Keep the server-side gate intentionally small; task routing and project policy select required checks. */
export function assessTaskAcceptance(input: AcceptanceInput): AcceptanceDecision {
  const reasons: string[] = [];
  if (input.pendingSteering) reasons.push("New requirements are waiting for the task owner");
  for (const blocker of input.openBlockers ?? []) reasons.push(`Unresolved blocker: ${blocker}`);

  if (input.requireReview) {
    if (!input.review) reasons.push("Independent review has not completed");
    else {
      if (input.review.snapshotId !== input.snapshotId) reasons.push("Review applies to an older candidate");
      if (input.review.criteriaVersion !== input.criteriaVersion) reasons.push("Review applies to old requirements");
      if (input.review.verdict !== "approved") reasons.push(`Review verdict: ${input.review.verdict}`);
      if (!input.review.requiredCheckIds) reasons.push("Reviewer has not specified required checks");
      else for (const id of input.review.requiredCheckIds) {
        const check = input.checks.find((candidate) => candidate.id === id);
        if (!check || !check.required) reasons.push(`Reviewer-required check ${id} has not run`);
      }
      for (const finding of input.review.blockingFindings ?? []) reasons.push(`Blocking review finding: ${finding}`);
    }
  }

  for (const check of input.checks) {
    if (!check.required || check.waivedForCriteriaVersion === input.criteriaVersion) continue;
    if (check.snapshotId !== input.snapshotId) reasons.push(`Required check ${check.id} applies to an older candidate`);
    else if (check.status !== "passed") reasons.push(`Required check ${check.id}: ${check.status}`);
  }
  return { accepted: reasons.length === 0, reasons };
}
