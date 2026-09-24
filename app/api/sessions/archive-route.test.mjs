import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { POST: archive, DELETE: restore } = await jiti.import("./[id]/archive/route.ts");
const { GET: list } = await jiti.import("./route.ts");
const { invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");

test("archive list is separate from normal list, and restoring a parent restores descendants", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-archive-route-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const projectDir = join(dir, "sessions", "project");
  await mkdir(projectDir, { recursive: true });
  const rootId = "archive-route-root";
  const childId = "archive-route-child";
  const rootPath = join(projectDir, `2026-01-01T00-00-00_${rootId}.jsonl`);
  const childPath = join(projectDir, `2026-01-01T00-00-01_${childId}.jsonl`);
  await writeFile(rootPath, JSON.stringify({ type: "session", id: rootId, cwd: dir, timestamp: new Date().toISOString() }) + "\n");
  await writeFile(childPath, JSON.stringify({ type: "session", id: childId, cwd: dir, timestamp: new Date().toISOString(), parentSession: rootPath }) + "\n");
  invalidateSessionListCache();
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    invalidateSessionListCache();
    invalidateSessionPathCache(rootId);
    invalidateSessionPathCache(childId);
    await rm(dir, { recursive: true, force: true });
  });
  const context = (id) => ({ params: Promise.resolve({ id }) });
  const request = (id, method) => new Request(`http://localhost/api/sessions/${id}/archive`, { method });
  const ids = async (view) => {
    const response = await list(new Request(`http://localhost/api/sessions?force=1${view ? "&archive=1" : ""}`));
    assert.equal(response.status, 200);
    return (await response.json()).sessions.map((session) => session.id);
  };
  assert.ok((await ids(false)).includes(rootId));
  assert.equal((await archive(request(childId, "POST"), context(childId))).status, 200);
  assert.equal((await archive(request(rootId, "POST"), context(rootId))).status, 200);
  assert.deepEqual(new Set(await ids(true)), new Set([rootId, childId]));
  assert.deepEqual(await ids(false), []);
  assert.equal((await restore(request(rootId, "DELETE"), context(rootId))).status, 200);
  assert.deepEqual(new Set(await ids(false)), new Set([rootId, childId]));
  assert.deepEqual(await ids(true), []);
  assert.ok((await readFile(childPath, "utf8")).includes(childId));
});
