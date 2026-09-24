import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { getRepositoryRosterRoot } = await createJiti(import.meta.url).import("./repository-roster.ts");

test("a Git checkout exposes its bundled roster even when an extension changes cwd", async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), "pi-web-bundled-roster-"));
  const untracked = await mkdtemp(join(tmpdir(), "pi-web-untracked-roster-"));
  const linked = join(dirname(checkout), `${basename(checkout)}-linked`);
  const previousPackage = process.env.PI_WEB_PACKAGE_ROOT;
  const previousRoster = process.env.PI_WEB_ROSTER_ROOT;
  t.after(async () => {
    if (previousPackage === undefined) delete process.env.PI_WEB_PACKAGE_ROOT;
    else process.env.PI_WEB_PACKAGE_ROOT = previousPackage;
    if (previousRoster === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previousRoster;
    try { execFileSync("git", ["-C", checkout, "worktree", "remove", "--force", linked]); } catch { /* not created */ }
    await rm(checkout, { recursive: true, force: true });
    await rm(linked, { recursive: true, force: true });
    await rm(untracked, { recursive: true, force: true });
  });
  await mkdir(join(checkout, "orchestration", "agents"), { recursive: true });
  await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "@agegr/pi-web" }));
  execFileSync("git", ["init", "-q", checkout]);
  execFileSync("git", ["-C", checkout, "add", "package.json"]);
  await writeFile(join(checkout, "orchestration", "agents", ".gitkeep"), "");
  execFileSync("git", ["-C", checkout, "add", "orchestration/agents/.gitkeep"]);
  execFileSync("git", ["-C", checkout, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  delete process.env.PI_WEB_ROSTER_ROOT;
  process.env.PI_WEB_PACKAGE_ROOT = checkout;
  assert.equal(getRepositoryRosterRoot(), join(checkout, "orchestration"));

  // A linked Git worktree records its metadata in a .git file, not a directory.
  execFileSync("git", ["-C", checkout, "worktree", "add", "-qb", "linked", linked]);
  process.env.PI_WEB_PACKAGE_ROOT = linked;
  assert.equal(getRepositoryRosterRoot(), join(linked, "orchestration"));
  await mkdir(join(untracked, "orchestration", "agents"), { recursive: true });
  await writeFile(join(untracked, "package.json"), JSON.stringify({ name: "@agegr/pi-web" }));
  process.env.PI_WEB_PACKAGE_ROOT = untracked;
  assert.equal(getRepositoryRosterRoot(), undefined);
});

test("an agent-directory symlink cannot turn the repository scope into an external write", async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), "pi-web-roster-dir-symlink-"));
  const elsewhere = await mkdtemp(join(tmpdir(), "pi-web-roster-outside-"));
  const previousRoster = process.env.PI_WEB_ROSTER_ROOT;
  t.after(async () => {
    if (previousRoster === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previousRoster;
    await rm(checkout, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  });
  await mkdir(join(checkout, "orchestration"));
  await symlink(elsewhere, join(checkout, "orchestration", "agents"));
  execFileSync("git", ["init", "-q", checkout]);
  process.env.PI_WEB_ROSTER_ROOT = join(checkout, "orchestration");
  assert.throws(() => getRepositoryRosterRoot(), /agents must be a regular directory/);
});
