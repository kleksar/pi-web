import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalGit } from "./git-read-extension.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });

test("local Git read confines patches to cwd, marks stages, and never reads untracked files", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-git-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  mkdirSync(join(root, "selected"));
  mkdirSync(join(root, "elsewhere"));
  writeFileSync(join(root, "selected", "tracked.txt"), "initial\n");
  writeFileSync(join(root, "elsewhere", "outside.txt"), "outside initial\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
  writeFileSync(join(root, "selected", "tracked.txt"), "STAGED_SECRET\n");
  git(root, "add", "selected/tracked.txt");
  writeFileSync(join(root, "selected", "tracked.txt"), "UNSTAGED_SECRET\n");
  writeFileSync(join(root, "selected", "new.txt"), "UNTRACKED_SECRET\n");
  writeFileSync(join(root, "selected", "intent.txt"), "INTENT_SECRET\n");
  git(root, "add", "-N", "selected/intent.txt");
  writeFileSync(join(root, "elsewhere", "outside.txt"), "OUTSIDE_SECRET\n");
  const selected = join(root, "selected");
  const status = await readLocalGit(selected, { action: "status" });
  assert.deepEqual(status.files.map((entry) => [entry.path, entry.index, entry.worktree, entry.untracked]),
    [["intent.txt", " ", "A", false], ["tracked.txt", "M", "M", false], ["new.txt", "?", "?", true]]);
  assert.doesNotMatch(JSON.stringify(status), /SECRET|outside/);
  const staged = await readLocalGit(selected, { action: "diff", stage: "staged" });
  assert.match(staged.patch, /STAGED_SECRET/);
  assert.doesNotMatch(staged.patch, /UNSTAGED_SECRET|UNTRACKED_SECRET|INTENT_SECRET|OUTSIDE_SECRET/);
  const unstaged = await readLocalGit(selected, { action: "diff", stage: "unstaged" });
  assert.match(unstaged.patch, /UNSTAGED_SECRET/);
  assert.doesNotMatch(unstaged.patch, /UNTRACKED_SECRET|INTENT_SECRET|OUTSIDE_SECRET/);
  symlinkSync(join(root, "elsewhere"), join(selected, "link"));
  assert.doesNotMatch(JSON.stringify(await readLocalGit(selected, { action: "status" })), /OUTSIDE_SECRET/);
  await assert.rejects(readLocalGit(selected, { action: "diff", stage: "both" }), /Invalid stage/);
  await assert.rejects(readLocalGit(selected, { action: "arbitrary" }), /Unsupported/);
});
