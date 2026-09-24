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

test("a Pi Web install without orchestration retains default resource discovery", async (t) => {
  const install = await mkdtemp(join(tmpdir(), "pi-web-no-roster-"));
  const oldPackageRoot = process.env.PI_WEB_PACKAGE_ROOT;
  const previous = process.env.PI_WEB_ROSTER_ROOT;
  process.env.PI_WEB_PACKAGE_ROOT = install;
  delete process.env.PI_WEB_ROSTER_ROOT;
  t.after(async () => {
    if (oldPackageRoot === undefined) delete process.env.PI_WEB_PACKAGE_ROOT;
    else process.env.PI_WEB_PACKAGE_ROOT = oldPackageRoot;
    if (previous === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previous;
    await rm(install, { recursive: true, force: true });
  });
  await writeFile(join(install, "package.json"), '{"name":"@agegr/pi-web"}');
  assert.equal(getRepositoryRosterRoot(), undefined);
  assert.deepEqual(getRepositorySkillPaths(), []);
  assert.equal(isRepositoryRosterSkillPath("/tmp/SKILL.md"), false);
});

test("bundled orchestration loads from Pi Web's package root, never the task cwd", async (t) => {
  const install = await mkdtemp(join(tmpdir(), "pi-web-install-roster-"));
  const task = await mkdtemp(join(tmpdir(), "pi-web-untrusted-task-"));
  const oldPackageRoot = process.env.PI_WEB_PACKAGE_ROOT;
  const previous = process.env.PI_WEB_ROSTER_ROOT;
  const oldCwd = process.cwd();
  t.after(async () => {
    process.chdir(oldCwd);
    if (oldPackageRoot === undefined) delete process.env.PI_WEB_PACKAGE_ROOT;
    else process.env.PI_WEB_PACKAGE_ROOT = oldPackageRoot;
    if (previous === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previous;
    await rm(install, { recursive: true, force: true });
    await rm(task, { recursive: true, force: true });
  });
  await writeFile(join(install, "package.json"), '{"name":"@agegr/pi-web"}');
  await mkdir(join(install, "orchestration", "agents"), { recursive: true });
  await mkdir(join(install, "orchestration", "skills"), { recursive: true });
  await mkdir(join(task, "orchestration", "agents"), { recursive: true });
  await mkdir(join(task, "orchestration", "skills"), { recursive: true });
  await writeFile(join(task, "package.json"), '{"name":"@agegr/pi-web"}');
  delete process.env.PI_WEB_ROSTER_ROOT;
  process.chdir(task);
  delete process.env.PI_WEB_PACKAGE_ROOT;
  assert.equal(getRepositoryRosterRoot(), undefined, "task cwd cannot enable auto-discovery without bootstrap");
  process.env.PI_WEB_PACKAGE_ROOT = install;
  assert.equal(getRepositoryRosterRoot(), join(install, "orchestration"));
  assert.deepEqual(getRepositorySkillPaths(), [join(install, "orchestration", "skills")]);

  process.env.PI_WEB_ROSTER_ROOT = join(task, "orchestration");
  assert.equal(getRepositoryRosterRoot(), join(task, "orchestration"), "explicit operator path takes precedence");
  process.env.PI_WEB_ROSTER_ROOT = "";
  assert.throws(() => getRepositoryRosterRoot(), /absolute orchestration directory/);
});

test("bundled orchestration rejects a symlink to external resources", async (t) => {
  const install = await mkdtemp(join(tmpdir(), "pi-web-linked-roster-"));
  const external = await mkdtemp(join(tmpdir(), "pi-web-external-roster-"));
  const oldPackageRoot = process.env.PI_WEB_PACKAGE_ROOT;
  const previous = process.env.PI_WEB_ROSTER_ROOT;
  t.after(async () => {
    if (oldPackageRoot === undefined) delete process.env.PI_WEB_PACKAGE_ROOT;
    else process.env.PI_WEB_PACKAGE_ROOT = oldPackageRoot;
    if (previous === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previous;
    await rm(install, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  });
  await writeFile(join(install, "package.json"), '{"name":"@agegr/pi-web"}');
  await mkdir(join(external, "agents"));
  await mkdir(join(external, "skills"));
  await symlink(external, join(install, "orchestration"));
  process.env.PI_WEB_PACKAGE_ROOT = install;
  delete process.env.PI_WEB_ROSTER_ROOT;
  assert.throws(() => getRepositoryRosterRoot(), /must be a directory, not a symlink/);
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
