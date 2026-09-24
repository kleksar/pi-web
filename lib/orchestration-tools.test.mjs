import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { OrchestrationEvidenceStore } = await jiti.import("./orchestration-evidence.ts");
const { hydrateReaderEvidence, orchestrationToolsForProfile, createOrchestrationToolsExtension,
  ensureTaskBaseline, readLatestAcceptedTaskResult } = await jiti.import("./orchestration-tools.ts");

function fakeTools(opts) {
  const registered = new Map();
  createOrchestrationToolsExtension(opts).factory({ registerTool(tool) { registered.set(tool.name, tool); } });
  return async (name, args, session) => {
    const tool = registered.get(name);
    assert.ok(tool, `Expected ${name} to be registered`);
    const result = await tool.execute("call", args, undefined, undefined,
      { sessionManager: { getEntries: () => session.entries, getSessionId: () => session.id } });
    return JSON.parse(result.content[0].text);
  };
}

test("batch reader delivery hydrates exact original, marks changed source, and checks task scope", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-hydration-"));
  try {
    const cwd = join(root, "repo");
    const storeRoot = join(root, "store");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "source.ts"), "const required = true;\n");
    const store = new OrchestrationEvidenceStore(storeRoot);
    const ref = store.captureFile({ taskId: "task-a", worktreeRoot: cwd, snapshotId: "first", path: "source.ts" });
    writeFileSync(join(cwd, "source.ts"), "const required = false;\n");
    const report = JSON.stringify({ findings: ["boundary"], evidence_refs: [{ id: ref.id, start_line: 1, end_line: 1 }] });
    const hydrated = hydrateReaderEvidence(report, { taskId: "task-a", cwd, storeRoot });
    assert.match(hydrated, /const required = true/);
    assert.match(hydrated, /changed since capture/);
    assert.doesNotMatch(hydrated, /const required = false/);
    const other = hydrateReaderEvidence(report, { taskId: "task-b", cwd, storeRoot });
    assert.doesNotMatch(other, /const required = true/);
    assert.match(other, /outside this task/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner gets direct evidence tools, reader gets capture, and writer cannot generate its own source refs", () => {
  assert.ok(orchestrationToolsForProfile("orchestration-task-owner").includes("read_source_range"));
  assert.deepEqual(orchestrationToolsForProfile("orchestration-code-reader"), ["capture_evidence", "project_context"]);
  assert.ok(!orchestrationToolsForProfile("orchestration-package-writer").includes("capture_evidence"));
});

test("host pins startup baseline and independently gates literal candidate, required check, review and new user steering", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-host-task-"));
  try {
    const cwd = join(root, "repo");
    mkdirSync(cwd);
    execFileSync("git", ["init", "-q", cwd]);
    execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", cwd, "config", "user.name", "Test"]);
    writeFileSync(join(cwd, "code.ts"), "const result = false;\n");
    execFileSync("git", ["-C", cwd, "add", "."]);
    execFileSync("git", ["-C", cwd, "commit", "-qm", "initial"]);
    const taskId = "6377a299-3ab1-4359-8dd6-2402c6a20958";
    const mainEntries = [{ id: "main-first", type: "message", message: { role: "user", content: "Change result to true" } }];
    const options = { cwd, taskId, artifactRoot: join(root, "artifacts"), evidenceRoot: join(root, "evidence"),
      mainSessionId: "main", mainSessionPath: join(root, "main.jsonl"), mainEntriesReader: () => mainEntries };
    const startup = await ensureTaskBaseline(options);
    const request = { type: "custom", customType: "pi-web:orchestration-task", data: {
      version: 1, taskId, revision: 0, worktreeRoot: cwd, originalUserRequest: "Change result to true",
      originalUserMessageId: "main-first", mainSessionId: "main", mainSessionPath: options.mainSessionPath } };
    const session = { id: "owner", entries: [request, { id: "first", type: "message", message: { role: "user", content: "Change result to true" } }] };
    const owner = fakeTools({ ...options, profileName: "orchestration-task-owner" });
    writeFileSync(join(cwd, "code.ts"), "const result = true;\n");
    writeFileSync(join(cwd, "new.ts"), "export const added = true;\n");
    const baseline = await owner("capture_changes", { mode: "baseline" }, session);
    assert.equal(baseline.snapshotId, startup.snapshotId, "baseline must remain pre-edit");
    const candidate = await owner("capture_changes", { mode: "candidate", baseline_ref: baseline.ref }, session);
    assert.deepEqual(candidate.changedPaths, ["code.ts", "new.ts"]);
    const reviewer = fakeTools({ ...options, profileName: "orchestration-change-reviewer" });
    const reviewerSession = { id: "reviewer", entries: [request] };
    const firstPage = await reviewer("read_change_manifest", { candidate_ref: candidate.ref, limit: 10 }, reviewerSession);
    assert.equal(firstPage.truncated, true);
    const reviewRequest = { candidate_ref: candidate.ref,
      snapshot_id: candidate.snapshotId, criteria_version: candidate.criteriaVersion,
      verdict: "approved", blocking_findings: [], required_check_ids: ["typecheck"] };
    await assert.rejects(reviewer("submit_review", reviewRequest, reviewerSession), /every page of the change manifest/);
    const manifest = await reviewer("read_change_manifest", { candidate_ref: candidate.ref }, reviewerSession);
    assert.match(manifest.text, /const result = true/);
    const check = await owner("run_check", { check_id: "typecheck", required: true,
      argv: [process.execPath, "-e", "process.stdout.write('passed')"] }, session);
    assert.equal(check.status, "passed");
    const log = await reviewer("read_check_log", { check_ref: check.checkRef, stream: "stdout" }, reviewerSession);
    assert.equal(Buffer.from(log.data, "base64").toString("utf8"), "passed");
    await assert.rejects(reviewer("submit_review", reviewRequest, reviewerSession), /every page of new\.ts/);
    const literal = await reviewer("read_change_manifest", { candidate_ref: candidate.ref,
      file_path: "new.ts", side: "after" }, reviewerSession);
    assert.equal(literal.text, "export const added = true;\n");
    const review = await reviewer("submit_review", reviewRequest, reviewerSession);
    const input = { candidate_ref: candidate.ref, review_ref: review.reviewRef,
      criteria_version: candidate.criteriaVersion, open_blockers: [] };
    assert.equal((await owner("assess_acceptance", input, session)).accepted, true);
    const verified = () => readLatestAcceptedTaskResult({ ...options, ownerEntries: session.entries });
    assert.equal(await verified(), true);
    mainEntries.push({ id: "main-followup", type: "message", message: { role: "user", content: "Also handle undefined" } });
    assert.equal(await verified(), false, "completed owner cannot reuse an approval after new Main input");
    const mainStale = await owner("assess_acceptance", input, session);
    assert.equal(mainStale.accepted, false);
    assert.match(mainStale.reasons.join("; "), /Main user messages changed/);
    await assert.rejects(owner("capture_changes", { mode: "candidate", baseline_ref: baseline.ref }, session),
      /read all new Main user messages/);
    const mainFollowups = await owner("read_task_steering", {}, session);
    assert.equal(mainFollowups.turns[0].text, "Also handle undefined");
    const recaptured = await owner("capture_changes", { mode: "candidate", baseline_ref: baseline.ref }, session);
    assert.notEqual(recaptured.criteriaVersion, candidate.criteriaVersion);
    await assert.rejects(reviewer("submit_review", { ...reviewRequest,
      candidate_ref: recaptured.ref, criteria_version: recaptured.criteriaVersion }, reviewerSession),
      /Reviewer must read all Main user follow-ups/);
    session.entries.push({ id: "steering", type: "message", message: { role: "user", content: "Also handle null" } });
    const stale = await owner("assess_acceptance", input, session);
    assert.equal(stale.accepted, false);
    assert.match(stale.reasons.join("; "), /requirements/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
