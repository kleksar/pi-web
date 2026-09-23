import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false, interopDefault: true });
const {
  getRepositoryRosterRoot,
  getRepositorySkillPaths,
  isRepositoryRosterSkillPath,
} = await jiti.import("./repository-roster.ts");

async function rosterFixture(t) {
  const previous = process.env.PI_WEB_ROSTER_ROOT;
  const root = await mkdtemp(join(tmpdir(), "pi-web-shared-roster-"));
  const roster = join(root, "orchestration");
  const skill = join(roster, "skills", "pi-web-roster-probe", "SKILL.md");
  const cwd = join(root, "other-project");
  await mkdir(join(roster, "agents"), { recursive: true });
  await mkdir(join(roster, "skills", "pi-web-roster-probe"), { recursive: true });
  await mkdir(cwd);
  await writeFile(skill, "---\nname: pi-web-roster-probe\ndescription: Probe shared skill discovery.\n---\nA roster skill.\n");
  process.env.PI_WEB_ROSTER_ROOT = roster;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  return { root, roster, skill, cwd };
}

test("an absent roster does not change default resource discovery", () => {
  const previous = process.env.PI_WEB_ROSTER_ROOT;
  try {
    delete process.env.PI_WEB_ROSTER_ROOT;
    assert.equal(getRepositoryRosterRoot(), undefined);
    assert.deepEqual(getRepositorySkillPaths(), []);
    assert.equal(isRepositoryRosterSkillPath("/tmp/SKILL.md"), false);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previous;
  }
});

test("a configured roster resolves to its physical root and keeps its skills read only", async (t) => {
  const { root, roster, skill } = await rosterFixture(t);
  assert.equal(getRepositoryRosterRoot(), roster);
  assert.deepEqual(getRepositorySkillPaths(), [join(roster, "skills")]);
  assert.equal(isRepositoryRosterSkillPath(skill), true);
  assert.equal(isRepositoryRosterSkillPath(join(root, "other-project", "SKILL.md")), false);

  const alias = join(root, "skill-alias.md");
  await symlink(skill, alias);
  assert.equal(isRepositoryRosterSkillPath(alias), true);
});

test("a configured roster rejects relative paths and symlinks escaping its root", async (t) => {
  const { root, roster } = await rosterFixture(t);
  process.env.PI_WEB_ROSTER_ROOT = relative(root, roster);
  assert.throws(() => getRepositoryRosterRoot(), /absolute orchestration directory/);
  process.env.PI_WEB_ROSTER_ROOT = roster;

  const external = join(root, "external-skill");
  await mkdir(external);
  await writeFile(join(external, "SKILL.md"), "---\nname: forbidden\ndescription: External skill.\n---\nOutside.\n");
  await symlink(external, join(roster, "skills", "outside"));
  assert.throws(() => getRepositorySkillPaths(), /skill symlink escapes/);
  assert.equal(isRepositoryRosterSkillPath(join(roster, "skills", "outside", "SKILL.md")), true);

  await rm(join(roster, "agents"), { recursive: true });
  await symlink(external, join(roster, "agents"));
  assert.throws(() => getRepositoryRosterRoot(), /agents directory cannot be a symlink/);
});

test("skill list and assignment catalog discover the shared roster across project directories", async (t) => {
  const { root, skill, cwd } = await rosterFixture(t);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent-home");
  await mkdir(process.env.PI_CODING_AGENT_DIR);
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const { loadSkillsWithInstallInfo } = await jiti.import("./skills-service.ts");
  const { loadAgentResourceCatalog } = await jiti.import("./agent-resource-service.ts");
  const listed = await loadSkillsWithInstallInfo(cwd);
  const catalog = await loadAgentResourceCatalog(cwd);
  const listedSkill = listed.skills.find((candidate) => candidate.name === "pi-web-roster-probe");
  assert.equal(listedSkill?.filePath, skill);
  assert.equal(listedSkill?.readOnly, true);
  assert.equal(listedSkill?.install, undefined);
  assert.equal(catalog.skills.find((candidate) => candidate.name === "pi-web-roster-probe")?.filePath, skill);
});

test("Skills API cannot rewrite a versioned SKILL.md through an alias", async (t) => {
  const { root, skill } = await rosterFixture(t);
  const alias = join(root, "skill-alias.md");
  await symlink(skill, alias);
  const original = await readFile(skill, "utf8");
  const { PATCH } = await jiti.import("../app/api/skills/route.ts");
  const result = await PATCH(new Request("http://localhost/api/skills", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Host: "localhost" },
    body: JSON.stringify({ filePath: alias, disableModelInvocation: true }),
  }));
  assert.equal(result.status, 403);
  assert.match((await result.json()).error, /edited in Git/);
  assert.equal(await readFile(skill, "utf8"), original);
});
