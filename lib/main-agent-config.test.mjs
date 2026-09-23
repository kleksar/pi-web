import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  getMainAgentConfigRevision,
  readMainAgentConfig,
  saveMainAgentConfig,
  validateMainAgentConfig,
} = await createJiti(import.meta.url).import("./main-agent-config.ts");

test("Main config distinguishes legacy unrestricted from explicitly empty assignments", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-main-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "main.json");
  assert.deepEqual(readMainAgentConfig(path), {});
  assert.equal(getMainAgentConfigRevision(path), "absent");

  const expected = {
    selectedSkills: [],
    selectedExtensionTools: [],
    orchestration: { allowedChildren: [] },
  };
  const first = await saveMainAgentConfig(expected, "absent", path);
  assert.deepEqual(first.config, expected);
  assert.deepEqual(readMainAgentConfig(path), expected);
  assert.notEqual(first.revision, "absent");
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);

  const second = await saveMainAgentConfig({ orchestration: null }, first.revision, path);
  assert.deepEqual(second.config, { orchestration: null });
});

test("Main config refuses invalid dependency links and a damaged existing file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-main-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "main.json");
  assert.throws(() => validateMainAgentConfig({
    orchestration: { allowedChildren: ["a", "b"], dependencies: { a: ["b"], b: ["a"] } },
  }), /cycle/);
  assert.throws(() => validateMainAgentConfig({
    orchestration: { allowedChildren: ["a", "b"], dependencies: { a: ["unknown"] } },
  }), /allowed children/);
  await writeFile(path, "{");
  await assert.rejects(saveMainAgentConfig({ selectedSkills: [] }, getMainAgentConfigRevision(path), path));
  assert.equal(await readFile(path, "utf8"), "{");
});

test("two stale Main editors cannot both save even when started concurrently", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-main-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "main.json");
  const revision = getMainAgentConfigRevision(path);
  const results = await Promise.allSettled([
    saveMainAgentConfig({ orchestration: { allowedChildren: ["analyst"] } }, revision, path),
    saveMainAgentConfig({ orchestration: { allowedChildren: ["reader"] } }, revision, path),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.name === "MainAgentConfigConflictError").length, 1);
  const winner = results.find((result) => result.status === "fulfilled").value;
  assert.deepEqual(readMainAgentConfig(path), winner.config);
  assert.equal(getMainAgentConfigRevision(path), winner.revision);
});
