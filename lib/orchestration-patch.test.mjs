import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const exec = promisify(execFile);
const jiti = createJiti(import.meta.url);
const { applyBoundedPatch } = await jiti.import("./orchestration-patch.ts");
const { collectChanges, disposeChangeSnapshotArtifacts } = await jiti.import("./orchestration-changes.ts");
const { resolveProjectContext } = await jiti.import("./project-context.ts");

async function git(cwd, ...args) {
  return (await exec("git", ["-C", cwd, ...args])).stdout;
}

async function setupRepo() {
  const root = await mkdtemp(join(tmpdir(), "pi-web-bounded-patch-"));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Pi Web Test");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "AGENTS.md"), "Follow project rules.\n");
  await writeFile(join(root, "src", "target.txt"), "original\n");
  await writeFile(join(root, "src", "user.txt"), "user original\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "initial");
  return root;
}

test("bounded patch applies only the listed target and retains preexisting dirty and untracked work", async () => {
  const root = await setupRepo();
  try {
    const target = join(root, "src", "target.txt");
    await writeFile(target, "new behavior\n");
    const patch = await git(root, "diff", "--binary", "--", "src/target.txt");
    await writeFile(target, "original\n");
    await writeFile(join(root, "src", "user.txt"), "existing user edit\n");
    await writeFile(join(root, "src", "scratch.txt"), "existing untracked note\n");
    const baseline = (await collectChanges(root)).snapshot;
    const context = resolveProjectContext({ worktreeRoot: root, targetPaths: ["src/target.txt"] });
    const existingArtifacts = new Set(globalThis.__piOrchestrationChangeBlobs ?? []);
    const result = await applyBoundedPatch({
      cwd: root, patch, allowedPaths: ["src/target.txt"],
      expectedSnapshotId: baseline.id, expectedProjectFingerprint: context.fingerprint,
    });
    assert.equal(result.status, "applied");
    assert.deepEqual(result.affectedPaths, ["src/target.txt"]);
    assert.equal(result.beforeSnapshotId, baseline.id);
    assert.notEqual(result.afterSnapshotId, baseline.id);
    assert.deepEqual(new Set(globalThis.__piOrchestrationChangeBlobs ?? []), existingArtifacts,
      "the patch must dispose transient before and after snapshots while leaving caller-owned baseline intact");
    assert.equal(await readFile(target, "utf8"), "new behavior\n");
    assert.equal(await readFile(join(root, "src", "user.txt"), "utf8"), "existing user edit\n");
    assert.equal(await readFile(join(root, "src", "scratch.txt"), "utf8"), "existing untracked note\n");
    await assert.rejects(
      applyBoundedPatch({ cwd: root, patch, allowedPaths: ["src/target.txt"], expectedSnapshotId: baseline.id }),
      (error) => error.code === "stale_snapshot",
    );
    assert.deepEqual(new Set(globalThis.__piOrchestrationChangeBlobs ?? []), existingArtifacts,
      "failed patch must also dispose its transient snapshot");
    await disposeChangeSnapshotArtifacts(baseline);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded patch rejects unlisted, stale and newly changed project-rule scopes before writing", async () => {
  const root = await setupRepo();
  try {
    const target = join(root, "src", "target.txt");
    await writeFile(target, "changed\n");
    const patch = await git(root, "diff", "--", "src/target.txt");
    await writeFile(target, "original\n");
    const baseline = (await collectChanges(root)).snapshot;
    const context = resolveProjectContext({ worktreeRoot: root, targetPaths: ["src/target.txt"] });
    await assert.rejects(
      applyBoundedPatch({ cwd: root, patch, allowedPaths: ["src/user.txt"], expectedSnapshotId: baseline.id }),
      (error) => error.code === "outside_scope",
    );
    await writeFile(join(root, "src", "AGENTS.md"), "New nested requirement.\n");
    await assert.rejects(
      applyBoundedPatch({ cwd: root, patch, allowedPaths: ["src/target.txt"], expectedProjectFingerprint: context.fingerprint }),
      (error) => error.code === "changed_project_rules",
    );
    await assert.rejects(
      applyBoundedPatch({ cwd: root, patch, allowedPaths: ["src/target.txt"], expectedSnapshotId: baseline.id }),
      (error) => error.code === "stale_snapshot",
    );
    assert.equal(await readFile(target, "utf8"), "original\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rename and delete patches require explicit permission for the old path too", async () => {
  const root = await setupRepo();
  try {
    const oldPath = join(root, "src", "target.txt");
    const newPath = join(root, "src", "renamed.txt");
    await writeFile(newPath, await readFile(oldPath));
    await unlink(oldPath);
    await git(root, "add", "-A");
    const renamePatch = await git(root, "diff", "--cached", "-M");
    await git(root, "reset", "--hard", "HEAD"); // temp test repo only
    const baseline = (await collectChanges(root)).snapshot;
    await assert.rejects(
      applyBoundedPatch({ cwd: root, patch: renamePatch, allowedPaths: ["src/renamed.txt"] }),
      (error) => error.code === "outside_scope",
    );
    const result = await applyBoundedPatch({
      cwd: root, patch: renamePatch,
      allowedPaths: ["src/target.txt", "src/renamed.txt"], expectedSnapshotId: baseline.id,
    });
    assert.deepEqual(result.affectedPaths, ["src/renamed.txt", "src/target.txt"]);
    assert.equal(await readFile(newPath, "utf8"), "original\n");
    await assert.rejects(readFile(oldPath));

    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "rename in disposable test repository");
    await unlink(newPath);
    const deletionPatch = await git(root, "diff", "--", "src/renamed.txt");
    await writeFile(newPath, "original\n");
    const deleteResult = await applyBoundedPatch({ cwd: root, patch: deletionPatch, allowedPaths: ["src/renamed.txt"] });
    assert.deepEqual(deleteResult.affectedPaths, ["src/renamed.txt"]);
    await assert.rejects(readFile(newPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new file is within scope only when its intended path is listed", async () => {
  const root = await setupRepo();
  try {
    const added = join(root, "src", "new.txt");
    await writeFile(added, "brand new\n");
    await git(root, "add", "-N", "--", "src/new.txt");
    const patch = await git(root, "diff", "--binary", "--", "src/new.txt");
    await git(root, "reset", "--", "src/new.txt"); // disposable fixture index only
    await unlink(added);
    await assert.rejects(
      applyBoundedPatch({ cwd: root, patch, allowedPaths: ["src/target.txt"] }),
      (error) => error.code === "outside_scope",
    );
    const result = await applyBoundedPatch({ cwd: root, patch, allowedPaths: ["src/new.txt"] });
    assert.deepEqual(result.affectedPaths, ["src/new.txt"]);
    assert.equal(await readFile(added, "utf8"), "brand new\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quoted old Git path is decoded before checking rename scope", { skip: process.platform === "win32" }, async () => {
  const root = await setupRepo();
  try {
    const oldName = "src/old\nname.txt";
    const newName = "src/new-name.txt";
    await writeFile(join(root, oldName), "quoted source\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "quoted fixture");
    await writeFile(join(root, newName), await readFile(join(root, oldName)));
    await unlink(join(root, oldName));
    await git(root, "add", "-A");
    const patch = await git(root, "diff", "--cached", "-M");
    await git(root, "reset", "--hard", "HEAD"); // disposable fixture only
    assert.match(patch, /rename from "old\\nname\.txt"|rename from "src\/old\\nname\.txt"/);
    const result = await applyBoundedPatch({ cwd: root, patch, allowedPaths: [oldName, newName] });
    assert.deepEqual(result.affectedPaths, [newName, oldName].sort());
    assert.equal(await readFile(join(root, newName), "utf8"), "quoted source\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe path, symlink target and symlink file mode are refused without mutation", async () => {
  const root = await setupRepo();
  const outside = await mkdtemp(join(tmpdir(), "pi-web-patch-outside-"));
  try {
    await writeFile(join(outside, "victim.txt"), "untouched\n");
    await symlink(outside, join(root, "linked"), "dir");
    const traversal = "diff --git a/../victim.txt b/../victim.txt\n--- a/../victim.txt\n+++ b/../victim.txt\n@@ -1 +1 @@\n-old\n+new\n";
    await assert.rejects(
      applyBoundedPatch({ cwd: root, patch: traversal, allowedPaths: ["../victim.txt"] }),
      (error) => error.code === "outside_scope",
    );
    const linked = "diff --git a/linked/victim.txt b/linked/victim.txt\n--- a/linked/victim.txt\n+++ b/linked/victim.txt\n@@ -1 +1 @@\n-untouched\n+changed\n";
    await assert.rejects(
      applyBoundedPatch({ cwd: root, patch: linked, allowedPaths: ["linked/victim.txt"] }),
      (error) => error.code === "outside_scope",
    );
    const symlinkPatch = "diff --git a/newlink b/newlink\nnew file mode 120000\n--- /dev/null\n+++ b/newlink\n@@ -0,0 +1 @@\n+linked\n";
    await assert.rejects(
      applyBoundedPatch({ cwd: root, patch: symlinkPatch, allowedPaths: ["newlink"] }),
      (error) => error.code === "outside_scope",
    );
    assert.equal(await readFile(join(outside, "victim.txt"), "utf8"), "untouched\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("ignored target is blocked even when Git status omits the file from the snapshot", async () => {
  const root = await setupRepo();
  try {
    const target = join(root, "src", "ignored.txt");
    await writeFile(target, "newly generated\n");
    await git(root, "add", "-N", "--", "src/ignored.txt");
    const patch = await git(root, "diff", "--", "src/ignored.txt");
    await git(root, "reset", "--", "src/ignored.txt");
    await unlink(target);
    await writeFile(join(root, ".gitignore"), "src/ignored.txt\n");
    const before = (await collectChanges(root)).snapshot;
    assert.equal(before.dirty.some((file) => file.path === "src/ignored.txt"), false);
    await assert.rejects(
      applyBoundedPatch({ cwd: root, patch, allowedPaths: ["src/ignored.txt"], expectedSnapshotId: before.id }),
      (error) => error.code === "outside_scope" && /ignored/.test(error.message),
    );
    await assert.rejects(readFile(target));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assume-unchanged and skip-worktree targets cannot hide mutations from the task snapshot", async () => {
  const root = await setupRepo();
  try {
    const target = join(root, "src", "target.txt");
    await writeFile(target, "changed\n");
    const patch = await git(root, "diff", "--", "src/target.txt");
    await writeFile(target, "original\n");
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      await git(root, "update-index", flag, "--", "src/target.txt");
      const before = (await collectChanges(root)).snapshot;
      await assert.rejects(
        applyBoundedPatch({ cwd: root, patch, allowedPaths: ["src/target.txt"], expectedSnapshotId: before.id }),
        (error) => error.code === "outside_scope" && /index flags/.test(error.message),
        flag,
      );
      assert.equal(await readFile(target, "utf8"), "original\n");
      await git(root, "update-index", flag === "--assume-unchanged" ? "--no-assume-unchanged" : "--no-skip-worktree", "--", "src/target.txt");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
