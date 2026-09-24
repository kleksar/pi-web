import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { changeBranchArchive, isSessionArchived } = await jiti.import("./session-archive.ts");

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-archive-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__piSessions = new Map();
  const sessions = [];
  const add = async (id, parent) => {
    const path = join(dir, `${id}.jsonl`);
    await writeFile(path, JSON.stringify({ type: "session", id, cwd: dir, timestamp: new Date().toISOString(), ...(parent ? { parentSession: parent.path } : {}) }) + "\n");
    const row = { id, path, cwd: dir, transient: false, parentSessionId: parent?.id };
    sessions.push(row);
    return row;
  };
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, sessions, add };
}

test("archive and restore traverse header ancestry, including separately archived descendants", async (t) => {
  const { sessions, add } = await fixture(t);
  const root = await add("archive-root");
  const child = await add("archive-child", root);
  const grandchild = await add("archive-grandchild", child);
  const other = await add("archive-other");
  // This is presentation metadata only, and must not change membership.
  other.parentSessionId = root.id;
  changeBranchArchive(child.id, sessions, true);
  assert.equal(isSessionArchived(child), true);
  assert.deepEqual(new Set(changeBranchArchive(root.id, sessions, true)), new Set([root.id, child.id, grandchild.id]));
  assert.equal(isSessionArchived(other), false);
  assert.deepEqual(new Set(changeBranchArchive(root.id, sessions, false)), new Set([root.id, child.id, grandchild.id]));
  assert.equal(isSessionArchived(child), false);
  assert.equal(isSessionArchived(grandchild), false);
  assert.ok((await readFile(child.path, "utf8")).includes(child.id), "transcripts are untouched");
});

test("running descendants and unreliable state fail closed without modifying markers", async (t) => {
  const { sessions, add, dir } = await fixture(t);
  const root = await add("safety-root");
  const child = await add("safety-child", root);
  globalThis.__piSessions.set(child.id, { isRunning: () => true, isAlive: () => false });
  assert.throws(() => changeBranchArchive(root.id, sessions, true), /running/);
  globalThis.__piSessions.clear();
  await writeFile(child.path, "broken header\n");
  assert.throws(() => changeBranchArchive(root.id, sessions, true), /changed/);
  assert.equal(isSessionArchived(root), false);
  assert.equal(isSessionArchived(child), false);
  assert.equal(dir.length > 0, true);
});

test("live state is checked again immediately before writes", async (t) => {
  const { sessions, add } = await fixture(t);
  const root = await add("recheck-root");
  let checks = 0;
  globalThis.__piSessions.set(root.id, {
    isAlive: () => false,
    isRunning: () => ++checks >= 3,
  });
  assert.throws(() => changeBranchArchive(root.id, sessions, true), /running/);
  assert.equal(isSessionArchived(root), false);
  assert.ok(checks >= 3);
});
