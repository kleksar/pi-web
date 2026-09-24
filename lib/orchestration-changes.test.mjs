import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createJiti } from "jiti";

const { collectChanges, collectChangesWhileLocked, disposeChangeSnapshotArtifacts, readChangeBlob, verifyChangeSnapshot, withOrchestrationWorktreeLock, MAX_CHANGE_BLOB_BYTES, StaleChangeSnapshotError } = await createJiti(import.meta.url).import("./orchestration-changes.ts");
const exec = promisify(execFile);

async function git(cwd, ...args) {
  return exec("git", ["-C", cwd, ...args]);
}

async function repo(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-task-changes-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await git(cwd, "init", "-q");
  await git(cwd, "config", "user.email", "test@example.com");
  await git(cwd, "config", "user.name", "Pi Web Test");
  await writeFile(join(cwd, "clean.txt"), "clean\n");
  await writeFile(join(cwd, "prior.txt"), "original\n");
  await writeFile(join(cwd, "rename-me.txt"), "renamed\n");
  await writeFile(join(cwd, "remove-me.txt"), "removed\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", "initial");
  return cwd;
}

async function changes(t, cwd, baseline) {
  const value = await collectChanges(cwd, baseline);
  t.after(() => disposeChangeSnapshotArtifacts(value.snapshot));
  return value;
}

test("clean to dirty at the same HEAD changes snapshot and task manifest", async (t) => {
  const cwd = await repo(t);
  const { snapshot: baseline } = await changes(t, cwd);
  const { snapshot: repeated } = await changes(t, cwd);
  assert.equal(baseline.id, repeated.id);
  assert.deepEqual(baseline.dirty, []);

  await writeFile(join(cwd, "clean.txt"), "changed\n");
  const { snapshot, manifest } = await changes(t, cwd, baseline);
  assert.notEqual(snapshot.id, baseline.id);
  assert.equal(snapshot.head, baseline.head);
  assert.deepEqual(manifest.preexisting, []);
  assert.deepEqual(manifest.changed.map(({ path, change }) => [path, change]), [["clean.txt", "modified"]]);
  assert.match(manifest.candidateUnstagedPatch, /\+changed/);
  await verifyChangeSnapshot(snapshot);
});

test("preexisting dirty changes remain separate; staged, unstaged and binary untracked files are visible", async (t) => {
  const cwd = await repo(t);
  await writeFile(join(cwd, "prior.txt"), "existing user edit\n");
  await writeFile(join(cwd, "existing.bin"), Buffer.from([0, 1, 2, 3]));
  const { snapshot: baseline } = await changes(t, cwd);
  assert.deepEqual(baseline.dirty.map((file) => file.path), ["existing.bin", "prior.txt"]);

  await writeFile(join(cwd, "clean.txt"), "staged\n");
  await git(cwd, "add", "clean.txt");
  await writeFile(join(cwd, "clean.txt"), "unstaged\n");
  await writeFile(join(cwd, "fresh.bin"), Buffer.from([0, 255, 7]));
  const { snapshot, manifest } = await changes(t, cwd, baseline);
  assert.deepEqual(manifest.preexisting.map((file) => file.path), ["existing.bin", "prior.txt"]);
  assert.deepEqual(manifest.changed.map((file) => file.path), ["clean.txt", "fresh.bin"]);
  assert.equal(manifest.candidateDirty.find((file) => file.path === "fresh.bin")?.binary, true);
  assert.deepEqual(await readFile(baseline.dirty.find((file) => file.path === "existing.bin").contentArtifactPath), Buffer.from([0, 1, 2, 3]));
  assert.deepEqual(await readFile(manifest.candidateDirty.find((file) => file.path === "fresh.bin").contentArtifactPath), Buffer.from([0, 255, 7]));
  assert.equal(manifest.candidateDirty.find((file) => file.path === "fresh.bin")?.indexStatus, "?");
  assert.match(manifest.candidateStagedPatch, /\+staged/);
  assert.match(manifest.candidateUnstagedPatch, /\+unstaged/);
  assert.equal(manifest.candidateDirty.find((file) => file.path === "prior.txt")?.sha256, baseline.dirty.find((file) => file.path === "prior.txt")?.sha256);
  await verifyChangeSnapshot(snapshot);

  await writeFile(join(cwd, "prior.txt"), "overwritten user edit\n");
  await assert.rejects(verifyChangeSnapshot(snapshot), StaleChangeSnapshotError);
});

test("rename, deletion and removal of a preexisting untracked file are represented without resetting worktree", async (t) => {
  const cwd = await repo(t);
  await writeFile(join(cwd, "previous-untracked.txt"), "before\n");
  const { snapshot: baseline } = await changes(t, cwd);
  await rm(join(cwd, "previous-untracked.txt"));
  await git(cwd, "mv", "rename-me.txt", "renamed.txt");
  await rm(join(cwd, "remove-me.txt"));
  const { snapshot, manifest } = await changes(t, cwd, baseline);
  assert.deepEqual(manifest.changed.map(({ path, change }) => [path, change]), [
    ["previous-untracked.txt", "removed"],
    ["remove-me.txt", "modified"],
    ["renamed.txt", "renamed"],
  ]);
  assert.equal(manifest.changed.find((file) => file.path === "renamed.txt")?.previousPath, "rename-me.txt");
  assert.equal(manifest.candidateDirty.find((file) => file.path === "remove-me.txt")?.kind, "missing");
  assert.match(manifest.candidateStagedPatch, /rename from rename-me\.txt/);
  assert.match(manifest.candidateUnstagedPatch, /remove-me\.txt/);
  assert.equal(await readFile(join(cwd, "prior.txt"), "utf8"), "original\n");
  await verifyChangeSnapshot(snapshot);
});

test("index-only edits change snapshot identity and reject stale baseline on another branch", async (t) => {
  const cwd = await repo(t);
  await writeFile(join(cwd, "clean.txt"), "candidate\n");
  const { snapshot: unstaged } = await changes(t, cwd);
  await git(cwd, "add", "clean.txt");
  const { snapshot: staged } = await changes(t, cwd, unstaged);
  assert.notEqual(staged.id, unstaged.id);
  assert.equal(staged.dirty[0].sha256, unstaged.dirty[0].sha256);
  assert.equal(staged.dirty[0].indexStatus, "M");
  assert.equal(staged.dirty[0].worktreeStatus, " ");
  await assert.rejects(verifyChangeSnapshot(unstaged), StaleChangeSnapshotError);
  await git(cwd, "checkout", "-qb", "another-branch");
  await assert.rejects(collectChanges(cwd, staged), /another worktree, HEAD or branch/);
});

test("writer can collect before and after under one worktree lock", async (t) => {
  const cwd = await repo(t);
  const changed = await withOrchestrationWorktreeLock(cwd, async () => {
    const before = (await collectChangesWhileLocked(cwd)).snapshot;
    t.after(() => disposeChangeSnapshotArtifacts(before));
    await writeFile(join(cwd, "clean.txt"), "new contents\n");
    const { snapshot, manifest } = await collectChangesWhileLocked(cwd, before);
    t.after(() => disposeChangeSnapshotArtifacts(snapshot));
    return manifest;
  });
  assert.equal(changed.changed.length, 1);
  assert.equal(changed.changed[0].path, "clean.txt");
});

test("literal before and after of an edited user untracked file stay inspectable", async (t) => {
  const cwd = await repo(t);
  await writeFile(join(cwd, "user-untracked.txt"), "user value\n");
  const { snapshot: before } = await changes(t, cwd);
  await writeFile(join(cwd, "user-untracked.txt"), "task value\n");
  const { manifest } = await changes(t, cwd, before);
  const delta = manifest.changed.find((entry) => entry.path === "user-untracked.txt");
  assert.equal(delta.before.contentAvailability, "available");
  assert.equal((await readChangeBlob(delta.before)).toString("utf8"), "user value\n");
  assert.equal((await readChangeBlob(delta.after)).toString("utf8"), "task value\n");
  assert.notEqual(delta.before.sha256, delta.after.sha256);
  await writeFile(delta.before.contentArtifactPath, "tampered original\n");
  await assert.rejects(readChangeBlob(delta.before), StaleChangeSnapshotError);
});

test("oversize initial dirty bytes explicitly block literal before-content review", async (t) => {
  const cwd = await repo(t);
  await writeFile(join(cwd, "large-untracked.bin"), Buffer.alloc(MAX_CHANGE_BLOB_BYTES + 1));
  const { snapshot } = await changes(t, cwd);
  const file = snapshot.dirty.find((entry) => entry.path === "large-untracked.bin");
  assert.equal(file.contentAvailability, "too_large");
  assert.equal(file.contentArtifactPath, undefined);
  assert.equal(file.bytes, MAX_CHANGE_BLOB_BYTES + 1);
  assert.equal(file.binary, true);
  await assert.rejects(readChangeBlob(file), /not available/);
});

test("task-owned private artifact directory receives literal blobs", async (t) => {
  const cwd = await repo(t);
  const blobRoot = await mkdtemp(join(tmpdir(), "pi-web-task-artifacts-"));
  t.after(() => rm(blobRoot, { recursive: true, force: true }));
  await writeFile(join(cwd, "new-file.txt"), "source truth\n");
  const { snapshot } = await collectChanges(cwd, undefined, { blobRoot });
  t.after(() => disposeChangeSnapshotArtifacts(snapshot));
  const file = snapshot.dirty.find((entry) => entry.path === "new-file.txt");
  assert.equal(dirname(snapshot.blobDirectory), blobRoot);
  assert.equal(await readFile(file.contentArtifactPath, "utf8"), "source truth\n");
  assert.equal((await readChangeBlob(file)).toString("utf8"), "source truth\n");
});
