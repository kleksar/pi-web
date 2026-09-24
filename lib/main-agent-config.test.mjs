import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  getMainAgentConfigRevision,
  readMainAgentConfig,
  saveMainAgentConfig,
  validateMainAgentConfig,
  mergeMainAgentConfigs,
  changedProjectMainOverrides,
  readEffectiveMainAgentConfig,
  readEffectiveGlobalMainAgentConfig,
  saveProjectMainAgentConfig,
  writeMainAgentConfig,
} = await createJiti(import.meta.url).import("./main-agent-config.ts");

test("versioned roster defaults inherit through global and trusted project; global edits do not freeze roster", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-roster-main-"));
  const oldRoster = process.env.PI_WEB_ROSTER_ROOT;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => {
    if (oldRoster === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = oldRoster;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  const roster = join(root, "orchestration");
  const skill = join(roster, "skills", "coordinate", "SKILL.md");
  const agentDir = join(root, "agent-home");
  const project = join(root, "another-project");
  await mkdir(join(roster, "agents"), { recursive: true });
  await mkdir(join(roster, "skills", "coordinate"), { recursive: true });
  await mkdir(agentDir);
  await mkdir(project);
  await writeFile(skill, "---\nname: coordinate\ndescription: Route tasks\n---\nUse an agent.\n");
  await writeFile(join(roster, "main-agent-config.json"), JSON.stringify({
    version: 1, selectedSkills: ["skills/coordinate/SKILL.md"], orchestration: { allowedChildren: [] },
  }));
  process.env.PI_WEB_ROSTER_ROOT = roster;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  assert.deepEqual(readEffectiveMainAgentConfig(project).config, {
    selectedSkills: [skill], orchestration: { allowedChildren: [] },
  });
  assert.equal(readEffectiveMainAgentConfig(project).trusted, false);
  writeMainAgentConfig({ orchestration: null });
  assert.deepEqual(readEffectiveGlobalMainAgentConfig().config, {
    selectedSkills: [skill], orchestration: null,
  });
  const { trustProjectForMainConfig } = await createJiti(import.meta.url).import("./project-trust.ts");
  trustProjectForMainConfig(project, agentDir);
  const revision = readEffectiveMainAgentConfig(project).revision;
  const saved = await saveProjectMainAgentConfig(project, { selectedSkills: [] }, revision);
  assert.deepEqual(saved.config, { selectedSkills: [], orchestration: null });
  assert.deepEqual(JSON.parse(await readFile(join(project, ".pi", "main-agent-config.json"), "utf8")), {
    version: 1, selectedSkills: [],
  });
  await writeFile(join(roster, "main-agent-config.json"), JSON.stringify({ version: 1,
    selectedSkills: ["skills/coordinate/SKILL.md"], orchestration: { allowedChildren: ["reader"] },
  }));
  assert.notEqual(readEffectiveMainAgentConfig(project).revision, saved.revision);
});

test("project overrides inherit absent fields and explicitly clear inherited assignments", () => {
  const global = { selectedSkills: ["/tmp/global/SKILL.md"], selectedExtensionTools: [],
    orchestration: { allowedChildren: ["reader"] } };
  assert.deepEqual(mergeMainAgentConfigs(global, { selectedSkills: [] }), {
    ...global, selectedSkills: [],
  });
  assert.deepEqual(mergeMainAgentConfigs(global, { orchestration: null }), {
    ...global, orchestration: null,
  });
  const previous = mergeMainAgentConfigs(global, { orchestration: { allowedChildren: [] } });
  assert.deepEqual(changedProjectMainOverrides(previous, { ...previous, selectedSkills: [] },
    { orchestration: { allowedChildren: [] } }, global), {
    selectedSkills: [], orchestration: { allowedChildren: [] },
  });
  assert.deepEqual(changedProjectMainOverrides(previous, { ...previous, orchestration: global.orchestration },
    { orchestration: { allowedChildren: [] } }, global), {});
});

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

test("a large Main config is rejected for both parsing and revision hashing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-large-main-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "main-agent-config.json");
  const file = await open(path, "w");
  try { await file.truncate(64 * 1024 * 1024); } finally { await file.close(); }
  assert.throws(() => readMainAgentConfig(path), /limit/);
  assert.throws(() => getMainAgentConfigRevision(path), /limit/);
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
