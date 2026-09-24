import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { runExactCheck } = await createJiti(import.meta.url).import("./orchestration-checks.ts");

test("records exact cwd/argv, exits and full logs without copying huge output to model context", async (t) => {
  const literal = "$(this-would-run-in-a-shell)";
  const result = await runExactCheck({
    cwd: ".",
    argv: [process.execPath, "-e", "process.stdout.write(process.argv[1] + 'x'.repeat(8000)); process.stderr.write('warning')", literal],
    snapshotId: "snapshot-123",
    env: { PI_CHECK_TEST_SECRET: "do-not-persist-this-value" },
  });
  t.after(() => rm(dirname(result.stdoutPath), { recursive: true, force: true }));
  assert.equal(result.status, "passed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.snapshotId, "snapshot-123");
  assert.equal(result.argv.at(-1), literal);
  assert.equal(result.stdoutBytes, literal.length + 8000);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stdoutPreview.length, 4096);
  assert.equal((await readFile(result.stdoutPath, "utf8")).length, literal.length + 8000);
  assert.equal(await readFile(result.stderrPath, "utf8"), "warning");
  assert.deepEqual(result.envProfile.overrideNames, ["PI_CHECK_TEST_SECRET"]);
  assert.ok(!JSON.stringify(result).includes("do-not-persist-this-value"));
});

test("nonzero exit is failed and a missing executable is environment_blocked", async (t) => {
  const failed = await runExactCheck({
    cwd: ".",
    argv: [process.execPath, "-e", "process.stderr.write('assertion failed'); process.exit(7)"],
  });
  t.after(() => rm(dirname(failed.stdoutPath), { recursive: true, force: true }));
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.stderrPreview, "assertion failed");

  const missing = await runExactCheck({ cwd: ".", argv: ["pi-web-command-does-not-exist-0d60218f"] });
  t.after(() => rm(dirname(missing.stdoutPath), { recursive: true, force: true }));
  assert.equal(missing.status, "environment_blocked");
  assert.equal(missing.exitCode, null);
  assert.match(missing.reason, /ENOENT/);

  const absentCwd = await runExactCheck({ cwd: "/pi-web-nonexistent-check-directory", argv: [process.execPath, "-v"] });
  assert.equal(absentCwd.status, "environment_blocked");
  assert.equal(absentCwd.startedAt, null);
  assert.equal(absentCwd.stdoutPath, null);
});

test("not_run never starts the command, and timeout cannot be reported as passed", async (t) => {
  const skipped = await runExactCheck({
    cwd: ".",
    argv: ["pi-web-command-does-not-exist-0d60218f"],
    notRunReason: "No configured integration environment",
  });
  assert.equal(skipped.status, "not_run");
  assert.equal(skipped.startedAt, null);
  assert.equal(skipped.stdoutPath, null);
  assert.equal(skipped.reason, "No configured integration environment");

  const timeout = await runExactCheck({
    cwd: ".",
    argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
    timeoutMs: 50,
  });
  t.after(() => rm(dirname(timeout.stdoutPath), { recursive: true, force: true }));
  assert.equal(timeout.status, "failed");
  assert.match(timeout.reason, /Timed out/);
  assert.equal(timeout.exitCode, null);
});

test("rejects malformed argv, environment and timeout before spawning", async () => {
  await assert.rejects(runExactCheck({ cwd: ".", argv: [] }), /argv/);
  await assert.rejects(runExactCheck({ cwd: ".", argv: [process.execPath], timeoutMs: -1 }), /timeoutMs/);
  await assert.rejects(runExactCheck({ cwd: ".", argv: [process.execPath], env: { "BROKEN=KEY": "value" } }), /env overrides/);
});

test("task-owned log root survives serialization of check metadata", async (t) => {
  const logRoot = await mkdtemp(join(tmpdir(), "pi-web-check-task-"));
  t.after(() => rm(logRoot, { recursive: true, force: true }));
  const result = await runExactCheck({ cwd: ".", argv: [process.execPath, "-e", "process.stdout.write('persistent output')"], logRoot });
  assert.equal(result.status, "passed");
  assert.equal(dirname(dirname(result.stdoutPath)), logRoot);
  const restored = JSON.parse(JSON.stringify(result));
  assert.equal(await readFile(restored.stdoutPath, "utf8"), "persistent output");

  const blocked = await runExactCheck({ cwd: ".", argv: [process.execPath, "-v"], logRoot: join(logRoot, "does-not-exist") });
  assert.equal(blocked.status, "environment_blocked");
  assert.equal(blocked.stdoutPath, null);
});
