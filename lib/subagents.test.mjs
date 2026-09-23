import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-subagents-global-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const {
  deleteSubagentProfile,
  deleteProjectSubagentProfile,
  listSubagentProfileSources,
  listSubagentProfiles,
  readSubagentRun,
  readSubagentSessionResources,
  resolveSubagentProfile,
  saveSubagentProfile,
  saveProjectSubagentProfile,
  SUBAGENT_META_TYPE,
  SUBAGENT_STATUS_TYPE,
  SUBAGENT_RESULT_TYPE,
  withSubagentExtensionTools,
  selectSubagentExtensionTools,
} = await createJiti(import.meta.url).import("./subagents.ts");
const { isSubagentProfileOverridden } = await createJiti(import.meta.url).import("./subagent-profile-precedence.ts");
const { writeDisabledBuiltInSubagent } = await createJiti(import.meta.url).import("./subagent-settings.ts");
const { trustProjectForMainConfig } = await createJiti(import.meta.url).import("./project-trust.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function profile(overrides = {}) {
  return {
    name: "test-agent",
    displayName: " Test agent ",
    description: " Test description ",
    systemPrompt: " Test prompt. ",
    tools: ["read", "read", "unknown-tool"],
    loadSkills: false,
    loadExtensions: false,
    model: " provider/model ",
    thinking: "high",
    maxTurns: 4.9,
    inheritContext: false,
    runInBackground: false,
    enabled: true,
    ...overrides,
  };
}

test("built-in profile IDs use lowercase kebab-case and read-only profiles cannot execute shell commands", () => {
  const profiles = listSubagentProfiles(testAgentDir);
  for (const builtin of profiles.filter((item) => item.scope === "builtin")) {
    assert.match(builtin.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(builtin.fastMode, false);
  }
  for (const name of ["explore", "plan"]) {
    const builtin = profiles.find((item) => item.name === name);
    assert.deepEqual(builtin.tools, ["read", "grep", "find", "ls"]);
    assert.equal(builtin.tools.includes("bash"), false);
  }
});

test("override detection follows scope precedence case-insensitively", () => {
  const builtin = { name: "Reviewer", scope: "builtin" };
  const roster = { name: "REVIEWER", scope: "roster" };
  const global = { name: "reviewer", scope: "global" };
  const workspace = { name: "REVIEWER", scope: "workspace" };
  const project = { name: "Reviewer", scope: "project" };
  const unrelated = { name: "other", scope: "builtin" };
  const profiles = [builtin, roster, global, workspace, project, unrelated];

  assert.equal(isSubagentProfileOverridden(builtin, profiles), true);
  assert.equal(isSubagentProfileOverridden(roster, profiles), true);
  assert.equal(isSubagentProfileOverridden(global, profiles), true);
  assert.equal(isSubagentProfileOverridden(workspace, profiles), true);
  assert.equal(isSubagentProfileOverridden(project, profiles), false);
  assert.equal(isSubagentProfileOverridden(unrelated, profiles), false);
});

test("Fast mode defaults off, survives legacy profile saves, and can be switched off explicitly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-fast-profile-"));
  try {
    const oldProfile = profile({ name: "reader" });
    assert.equal(saveProjectSubagentProfile(cwd, oldProfile).fastMode, false);
    assert.equal(resolveSubagentProfile(cwd, "reader").fastMode, false);
    assert.equal(saveProjectSubagentProfile(cwd, { ...oldProfile, fastMode: true }).fastMode, true);
    assert.equal(saveProjectSubagentProfile(cwd, oldProfile).fastMode, true, "an older client must preserve the existing switch");
    assert.match(await readFile(join(cwd, ".pi", "agents", "reader.md"), "utf8"), /pi_web_fast_mode: true/);
    assert.equal(saveProjectSubagentProfile(cwd, { ...oldProfile, fastMode: false }).fastMode, false);
    assert.equal(resolveSubagentProfile(cwd, "reader").fastMode, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project profiles override built-ins and round-trip their runtime settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    saveProjectSubagentProfile(cwd, {
      name: "Explore",
      displayName: "Repository scout",
      description: "Inspect this repository",
      systemPrompt: "Read carefully and report findings.",
      tools: ["read", "grep"],
      loadSkills: true,
      loadExtensions: true,
      fastMode: true,
      model: "anthropic/test-model",
      thinking: "high",
      maxTurns: 8,
      inheritContext: true,
      runInBackground: true,
      enabled: true,
    });

    const profile = listSubagentProfiles(cwd).find((item) => item.name === "Explore");
    assert.equal(profile.scope, "project");
    assert.equal(profile.displayName, "Repository scout");
    assert.deepEqual(profile.tools, ["read", "grep"]);
    assert.equal(profile.loadSkills, true);
    assert.equal(profile.loadExtensions, true);
    assert.equal(profile.fastMode, true);
    assert.equal(profile.thinking, "high");
    assert.equal(profile.maxTurns, 8);
    assert.equal(profile.inheritContext, true);
    assert.equal(profile.runInBackground, true);

    const source = await readFile(join(cwd, ".pi", "agents", "Explore.md"), "utf8");
    assert.match(source, /max_turns: 8/);
    assert.match(source, /load_skills: true/);
    assert.match(source, /load_extensions: true/);
    assert.match(source, /pi_web_fast_mode: true/);
    assert.match(source, /Read carefully and report findings\./);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("linked repository profiles persist portable skills and reject escaping references", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-roster-repo-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-web-roster-external-"));
  try {
    const agents = join(cwd, "orchestration", "agents");
    const skill = join(cwd, "orchestration", "skills", "coordinate", "SKILL.md");
    await mkdir(agents, { recursive: true });
    await mkdir(join(cwd, "orchestration", "skills", "coordinate"), { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(skill, "Coordinate this repository");
    await symlink(agents, join(cwd, ".pi", "agents"));
    await symlink(join(cwd, "orchestration", "skills"), join(cwd, ".pi", "skills"));
    const profileFile = join(agents, "repo-reader.md");
    const projectSkillPath = join(cwd, ".pi", "skills", "coordinate", "SKILL.md");
    await writeFile(profileFile,
      "---\ndescription: Repo reader\npi_web_selected_skills:\n  - skills/coordinate/SKILL.md\n---\nRead.\n");
    assert.deepEqual(resolveSubagentProfile(cwd, "repo-reader").selectedSkills, [skill]);
    const updated = saveSubagentProfile(cwd, "project", profile({ name: "repo-reader", selectedSkills: [projectSkillPath] }));
    assert.deepEqual(updated.selectedSkills, [projectSkillPath]);
    assert.match(await readFile(profileFile, "utf8"), /skills\/coordinate\/SKILL\.md/);
    assert.doesNotMatch(await readFile(profileFile, "utf8"), new RegExp(cwd));
    assert.deepEqual(resolveSubagentProfile(cwd, "repo-reader").selectedSkills, [skill]);

    await writeFile(join(outside, "SKILL.md"), "Unexpected outside instructions");
    await symlink(outside, join(cwd, "orchestration", "skills", "escaped"));
    await writeFile(profileFile,
      "---\ndescription: Escaped\npi_web_selected_skills:\n  - skills/escaped/SKILL.md\n---\nRead.\n");
    const invalid = listSubagentProfiles(cwd).find((item) => item.name === "repo-reader");
    assert.equal(invalid.enabled, false);
    assert.match(invalid.configurationError, /Invalid Pi Web selected resources/);
    assert.throws(() => saveSubagentProfile(cwd, "project", profile({ name: "repo-reader",
      selectedSkills: ["skills/../../escape/SKILL.md"] })), /Invalid selected agent resources/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("repository roster is shared across projects, editable, and overridden by global or project profiles", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-other-project-"));
  const root = await mkdtemp(join(tmpdir(), "pi-web-shared-roster-"));
  const previous = process.env.PI_WEB_ROSTER_ROOT;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previous;
    deleteSubagentProfile(cwd, "global", "roster-specialist");
    await rm(cwd, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const agents = join(root, "agents");
  const skill = join(root, "skills", "coordinate", "SKILL.md");
  await mkdir(agents, { recursive: true });
  await mkdir(join(root, "skills", "coordinate"), { recursive: true });
  await writeFile(skill, "---\nname: coordinate\ndescription: Coordinate\n---\nCoordinate carefully\n");
  process.env.PI_WEB_ROSTER_ROOT = root;
  const stored = saveSubagentProfile(cwd, "roster", profile({
    name: "roster-specialist", selectedSkills: [skill], description: "Tracked specialist",
  }));
  assert.equal(stored.scope, "roster");
  assert.equal(stored.filePath, join(agents, "roster-specialist.md"));
  assert.match(await readFile(stored.filePath, "utf8"), /skills\/coordinate\/SKILL\.md/);
  assert.doesNotMatch(await readFile(stored.filePath, "utf8"), new RegExp(cwd));
  assert.equal(resolveSubagentProfile(cwd, "roster-specialist").scope, "roster");
  assert.deepEqual(resolveSubagentProfile(cwd, "roster-specialist").selectedSkills, [skill]);
  const projectSkill = join(cwd, ".pi", "skills", "local", "SKILL.md");
  const externalSkill = join(cwd, "external", "SKILL.md");
  await mkdir(join(cwd, ".pi", "skills", "local"), { recursive: true });
  await mkdir(join(cwd, "external"), { recursive: true });
  await writeFile(projectSkill, "Project only");
  await writeFile(externalSkill, "Outside roster");
  for (const outside of [projectSkill, externalSkill]) {
    assert.throws(() => saveSubagentProfile(cwd, "roster", profile({ name: "roster-specialist",
      selectedSkills: [outside] })), /may select only skills inside the repository roster/);
    assert.deepEqual(resolveSubagentProfile(cwd, "roster-specialist").selectedSkills, [skill],
      "a failed save cannot replace the tracked profile");
  }
  await symlink(join(cwd, "external"), join(root, "skills", "escaped"));
  assert.throws(() => saveSubagentProfile(cwd, "roster", profile({ name: "roster-specialist",
    selectedSkills: [join(root, "skills", "escaped", "SKILL.md")] })),
  /may select only skills inside the repository roster/);
  assert.throws(() => saveSubagentProfile(cwd, "roster", profile({ name: "roster-specialist",
    selectedExtensionTools: [{ extensionPath: join(cwd, "extension.ts"), toolName: "sentry_read" }] })),
  /cannot store machine-local extension tool paths/);
  assert.throws(() => saveSubagentProfile(cwd, "roster", profile({ name: "unscoped-new-specialist",
    selectedSkills: undefined, loadSkills: true })), /require an explicit selected skills list/);
  assert.throws(() => saveSubagentProfile(cwd, "roster", profile({ name: "roster-specialist",
    selectedSkills: [skill], loadExtensions: true })), /cannot load unscoped extensions/);
  const outsideProfile = join(cwd, "external", "outside.md");
  await writeFile(outsideProfile, "---\nsecret: should-not-read\n---\nOutside\n");
  await symlink(outsideProfile, join(agents, "linked-profile.md"));
  assert.throws(() => saveSubagentProfile(cwd, "roster", profile({ name: "linked-profile" })),
    /must be a regular file/);
  assert.throws(() => deleteSubagentProfile(cwd, "roster", "linked-profile"), /must be a regular file/);
  assert.match(await readFile(outsideProfile, "utf8"), /should-not-read/);
  await writeFile(join(agents, "committed-absolute.md"),
    `---\ndescription: Unportable\npi_web_selected_skills:\n  - ${JSON.stringify(skill)}\n---\nRun.\n`);
  const unportable = listSubagentProfiles(cwd).find((item) => item.name === "committed-absolute");
  assert.equal(unportable.enabled, false, "tracked files with machine-specific paths must fail closed");
  assert.match(unportable.configurationError, /Invalid Pi Web selected resources/);
  await writeFile(join(agents, "committed-all-skills.md"),
    "---\ndescription: Unrestricted skills\nload_skills: true\n---\nRun.\n");
  await writeFile(join(agents, "committed-all-extensions.md"),
    "---\ndescription: Unrestricted extensions\nload_extensions: true\n---\nRun.\n");
  for (const name of ["committed-all-skills", "committed-all-extensions"]) {
    const unscoped = listSubagentProfiles(cwd).find((item) => item.name === name);
    assert.equal(unscoped.enabled, false, "a tracked profile must never enable all resources implicitly");
    assert.match(unscoped.configurationError, /Invalid Pi Web selected resources/);
  }
  saveSubagentProfile(cwd, "global", profile({ name: "roster-specialist", description: "Operator override" }));
  assert.equal(resolveSubagentProfile(cwd, "roster-specialist").scope, "global");
  assert.deepEqual(listSubagentProfileSources(cwd).filter((item) => item.name === "roster-specialist")
    .map((item) => item.scope).sort(), ["global", "roster"]);
  assert.throws(() => saveProjectSubagentProfile(cwd, profile({
    name: "roster-specialist", description: "Project override",
  })), /Trust this project before overriding repository agent/);
  assert.equal(resolveSubagentProfile(cwd, "roster-specialist").scope, "global");
  trustProjectForMainConfig(cwd, testAgentDir);
  saveProjectSubagentProfile(cwd, profile({ name: "roster-specialist", description: "Project override" }));
  assert.equal(resolveSubagentProfile(cwd, "roster-specialist").scope, "project");
  deleteProjectSubagentProfile(cwd, "roster-specialist");
  deleteSubagentProfile(cwd, "global", "roster-specialist");
  assert.equal(resolveSubagentProfile(cwd, "roster-specialist").scope, "roster");
  deleteSubagentProfile(cwd, "roster", "roster-specialist");
  assert.equal(resolveSubagentProfile(cwd, "roster-specialist"), undefined);
});

test("untrusted project and workspace files cannot shadow a roster ID, while trusted projects can", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-roster-trust-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-roster-project-"));
  const previous = process.env.PI_WEB_ROSTER_ROOT;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previous;
    deleteSubagentProfile(cwd, "global", "coordinator");
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });
  await mkdir(join(root, "agents"));
  await mkdir(join(root, "skills"));
  await mkdir(join(cwd, ".agents", "agents"), { recursive: true });
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(join(root, "agents", "coordinator.md"),
    "---\ndescription: Tracked coordinator\ntools: none\n---\nShared instructions.\n");
  await writeFile(join(cwd, ".agents", "agents", "COORDINATOR.md"),
    "---\ndescription: Workspace coordinator\ntools: read\n---\nWorkspace instructions.\n");
  await writeFile(join(cwd, ".pi", "agents", "coordinator.md"),
    "---\ndescription: Project coordinator\ntools: write\n---\nProject instructions.\n");
  process.env.PI_WEB_ROSTER_ROOT = root;

  let sources = listSubagentProfileSources(cwd).filter((item) => item.name.toLowerCase() === "coordinator");
  assert.deepEqual(sources.map((item) => item.scope), ["roster"]);
  assert.equal(isSubagentProfileOverridden(sources[0], sources), false);
  assert.equal(resolveSubagentProfile(cwd, "COORDINATOR").scope, "roster");
  assert.throws(() => saveProjectSubagentProfile(cwd, profile({ name: "coordinator" })),
    /Trust this project before overriding repository agent/);
  saveSubagentProfile(cwd, "global", profile({ name: "coordinator", description: "Local experiment" }));
  assert.equal(resolveSubagentProfile(cwd, "coordinator").scope, "global");
  deleteSubagentProfile(cwd, "global", "coordinator");

  trustProjectForMainConfig(cwd, testAgentDir);
  sources = listSubagentProfileSources(cwd).filter((item) => item.name.toLowerCase() === "coordinator");
  assert.deepEqual(sources.map((item) => item.scope).sort(), ["project", "roster", "workspace"]);
  assert.equal(isSubagentProfileOverridden(sources.find((item) => item.scope === "roster"), sources), true);
  assert.equal(resolveSubagentProfile(cwd, "coordinator").scope, "project");
});

test("Pi Web delegation requires explicit namespaced opt-in and round-trips independently of foreign permissions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-orchestration-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const file = join(cwd, ".pi", "agents", "manager.md");
    await writeFile(file, "---\nallowed_subagents: external-agent\ntools: none\n---\nRoute work.\n");
    assert.equal(resolveSubagentProfile(cwd, "manager").orchestration, undefined);

    const enabled = saveProjectSubagentProfile(cwd, profile({
      name: "manager",
      tools: [],
      orchestration: { allowedChildren: [" Reader ", "Writer"] },
    }));
    assert.deepEqual(enabled.orchestration, { allowedChildren: ["Reader", "Writer"] });
    assert.deepEqual(resolveSubagentProfile(cwd, "manager").orchestration, enabled.orchestration);
    let source = await readFile(file, "utf8");
    assert.match(source, /pi_web_orchestration:\n  kind: orchestrator\n  allowed_children:/);
    assert.match(source, /allowed_subagents: external-agent/);

    const oldClientEdit = saveProjectSubagentProfile(cwd, profile({ name: "manager", tools: [], description: "Edited" }));
    assert.deepEqual(oldClientEdit.orchestration, enabled.orchestration);
    assert.deepEqual(resolveSubagentProfile(cwd, "manager").orchestration, enabled.orchestration);

    const disabled = saveProjectSubagentProfile(cwd, profile({ name: "manager", tools: [], orchestration: null }));
    assert.equal(disabled.orchestration, undefined);
    source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /pi_web_orchestration/);
    assert.match(source, /allowed_subagents: external-agent/);
    assert.equal(resolveSubagentProfile(cwd, "manager").orchestration, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("orchestrator dependencies round-trip with canonical child names and preserve old-client saves", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-dependencies-"));
  try {
    const saved = saveProjectSubagentProfile(cwd, profile({
      name: "manager", tools: [],
      orchestration: {
        allowedChildren: ["Reader", "Analyst", "Writer", "Reviewer"],
        dependencies: { analyst: ["reader"], WRITER: ["Reader", "ANALYST"], reviewer: ["writer"] },
      },
    }));
    const expected = {
      allowedChildren: ["Reader", "Analyst", "Writer", "Reviewer"],
      dependencies: { Analyst: ["Reader"], Writer: ["Reader", "Analyst"], Reviewer: ["Writer"] },
    };
    assert.deepEqual(saved.orchestration, expected);
    assert.deepEqual(resolveSubagentProfile(cwd, "manager").orchestration, expected);
    const source = await readFile(join(cwd, ".pi", "agents", "manager.md"), "utf8");
    assert.match(source, /depends_on:\n    Analyst:\n      - Reader/);
    assert.deepEqual(saveProjectSubagentProfile(cwd, profile({
      name: "manager", tools: [], description: "Edited by an old client",
    })).orchestration, expected);
    const reservedName = saveProjectSubagentProfile(cwd, profile({
      name: "manager", tools: [],
      orchestration: {
        allowedChildren: ["toString", "constructor", "Writer"],
        dependencies: { Writer: ["constructor"] },
      },
    }));
    assert.deepEqual(reservedName.orchestration.dependencies, { Writer: ["constructor"] });
    assert.deepEqual(resolveSubagentProfile(cwd, "manager").orchestration.dependencies, { Writer: ["constructor"] });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("invalid dependency graphs disable profile discovery and reject writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-dependencies-invalid-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const file = join(cwd, ".pi", "agents", "manager.md");
    const invalid = [
      "depends_on: [reader]",
      "depends_on:\n    Reader: writer",
      "depends_on:\n    Unknown: [Reader]",
      "depends_on:\n    Reader: [Reader]",
      "depends_on:\n    Writer: [Reader, reader]",
      "depends_on:\n    Reader: [Writer]\n    reader: []",
      "depends_on:\n    Reader: [Writer]\n    Writer: [Reader]",
    ];
    for (const dependencyYaml of invalid) {
      await writeFile(file, `---\ntools: none\npi_web_orchestration:\n  kind: orchestrator\n  allowed_children: [Reader, Writer]\n  ${dependencyYaml}\n---\nRoute work.\n`);
      assert.equal(resolveSubagentProfile(cwd, "manager"), undefined, dependencyYaml);
      assert.match(listSubagentProfileSources(cwd).find((item) => item.name === "manager").configurationError, /Invalid Pi Web orchestration/);
    }
    for (const dependencies of [
      { Unknown: ["Reader"] },
      { Reader: ["Reader"] },
      { Writer: ["Reader", "reader"] },
      { Reader: ["Writer"], Writer: ["Reader"] },
      { Reader: [], reader: [] },
      { Writer: "Reader" },
      [],
    ]) {
      assert.throws(() => saveProjectSubagentProfile(cwd, profile({
        name: "manager", tools: [], orchestration: { allowedChildren: ["Reader", "Writer"], dependencies },
      })), /Orchestrator dependencies/, JSON.stringify(dependencies));
    }
    const producers = Array.from({ length: 9 }, (_, index) => `producer-${index}`);
    assert.throws(() => saveProjectSubagentProfile(cwd, profile({
      name: "manager", tools: [],
      orchestration: { allowedChildren: ["consumer", ...producers], dependencies: { consumer: producers } },
    })), /at most 8 prerequisites/);
    assert.throws(() => saveProjectSubagentProfile(cwd, profile({ name: "manager", tools: [] })), /Invalid stored Pi Web orchestration/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("invalid Pi Web orchestration is non-delegating and invalid writes are rejected", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-orchestration-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const file = join(cwd, ".pi", "agents", "manager.md");
    for (const value of [
      "kind: specialist\n  allowed_children: [reader]",
      "kind: orchestrator\n  allowed_children: reader",
      "kind: orchestrator\n  allowed_children: [Reader, reader]",
      "kind: orchestrator\n  allowed_children: [MANAGER]",
      "kind: orchestrator\n  allowed_children: [../escape]",
    ]) {
      await writeFile(file, `---\ntools: none\npi_web_orchestration:\n  ${value}\n---\nRoute work.\n`);
      assert.equal(resolveSubagentProfile(cwd, "manager"), undefined);
    }
    for (const children of [["manager"], ["Reader", "reader"], ["../escape"]]) {
      assert.throws(
        () => saveProjectSubagentProfile(cwd, profile({ name: "manager", orchestration: { allowedChildren: children } })),
        /delegate to itself|unique agent profile names/,
      );
    }
    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ name: "manager", orchestration: { allowedChildren: ["reader"] } })),
      /Orchestrators cannot use file tools/,
    );
    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({
        name: "manager", tools: [], loadSkills: true, orchestration: { allowedChildren: ["reader"] },
      })),
      /Orchestrators cannot use file tools/,
    );
    await writeFile(file, "---\ntools: read\npi_web_orchestration:\n  kind: orchestrator\n  allowed_children: [reader]\n---\nRoute work.\n");
    assert.equal(resolveSubagentProfile(cwd, "manager"), undefined);
    const invalidSource = "---\ntools: none\npi_web_orchestration:\n  kind: orchestrator\n  allowed_children: reader\n---\nRoute work.\n";
    await writeFile(file, invalidSource);
    assert.equal(resolveSubagentProfile(cwd, "manager"), undefined);
    assert.match(listSubagentProfileSources(cwd).find((item) => item.name === "manager").configurationError, /Invalid Pi Web orchestration/);
    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ name: "manager", tools: [] })),
      /Invalid stored Pi Web orchestration/,
    );
    assert.equal(await readFile(file, "utf8"), invalidSource);
    saveProjectSubagentProfile(cwd, profile({ name: "manager", tools: [], orchestration: null }));
    assert.equal(resolveSubagentProfile(cwd, "manager").orchestration, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("invalid higher-scope orchestration shadows an otherwise enabled lower-scope profile", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-orchestration-shadow-"));
  try {
    saveSubagentProfile(cwd, "global", profile({ name: "manager", tools: [], orchestration: { allowedChildren: ["reader"] } }));
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const local = join(cwd, ".pi", "agents", "manager.md");
    await writeFile(local, "---\ntools: read\npi_web_orchestration:\n  kind: orchestrator\n  allowed_children: [reader]\n---\nRoute work.\n");
    const effective = listSubagentProfiles(cwd).find((item) => item.name === "manager");
    assert.equal(effective.scope, "project");
    assert.equal(effective.enabled, false);
    assert.deepEqual(effective.tools, []);
    assert.match(effective.configurationError, /Invalid Pi Web orchestration/);
    assert.equal(resolveSubagentProfile(cwd, "manager"), undefined);

    // Unparseable YAML can contain a `name` different from the filename, so
    // discovery must fail closed instead of guessing which name to shadow.
    await writeFile(local, "---\npi_web_orchestration: [reader\n---\nRoute work.\n");
    assert.throws(() => listSubagentProfiles(cwd), /Invalid agent profile frontmatter/);
    assert.throws(() => resolveSubagentProfile(cwd, "manager"), /Invalid agent profile frontmatter/);

    await writeFile(local, "---\n  pi_web_orchestration: [reader\n---\nRoute work.\n");
    assert.throws(() => listSubagentProfiles(cwd), /Invalid agent profile frontmatter/);
    assert.throws(() => resolveSubagentProfile(cwd, "manager"), /Invalid agent profile frontmatter/);
  } finally {
    deleteSubagentProfile(cwd, "global", "manager");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("profile read and directory access errors cannot fall through to a lower-scope profile", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-profile-read-error-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-profile-read-error-global-"));
  try {
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(join(agentDir, "agents", "manager.md"), "---\ndescription: Global manager\ntools: none\n---\nGlobal.\n");
    const projectFile = join(cwd, ".pi", "agents", "manager.md");
    await writeFile(projectFile, "---\ndescription: Project manager\ntools: none\n---\nProject.\n");

    // Inject a deterministic EACCES between readdir and read in an isolated
    // process, so the test neither depends on Unix permissions nor patches fs
    // for unrelated tests running in this process.
    const script = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { createJiti } from "jiti";
      let failure = "file";
      const originalRead = fs.readFileSync;
      const originalStat = fs.statSync;
      const originalRealpath = fs.realpathSync;
      fs.readFileSync = (path, ...args) => {
        if (failure === "file" && String(path) === process.env.TEST_PROJECT_PROFILE) {
          throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
        }
        return originalRead(path, ...args);
      };
      fs.statSync = (path, ...args) => {
        if (failure === "directory" && String(path) === process.env.TEST_PROJECT_DIRECTORY) {
          throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
        }
        return originalStat(path, ...args);
      };
      fs.realpathSync = (path, ...args) => {
        if (failure === "realpath" && String(path) === process.env.TEST_PROJECT_DIRECTORY) {
          throw Object.assign(new Error("simulated EACCES"), { code: "EACCES" });
        }
        return originalRealpath(path, ...args);
      };
      syncBuiltinESMExports();
      const { listSubagentProfiles, saveProjectSubagentProfile } = await createJiti(import.meta.url).import(process.env.TEST_SUBAGENTS_MODULE);
      for (failure of ["file", "directory", "realpath"]) {
        try {
          listSubagentProfiles(process.env.TEST_PROJECT_CWD);
          throw new Error("discovery unexpectedly succeeded: " + failure);
        } catch (error) {
          if (error.code !== "EACCES") throw error;
        }
      }
      failure = "file";
      try {
        saveProjectSubagentProfile(process.env.TEST_PROJECT_CWD, {
          name: "manager", displayName: "Manager", description: "Manager", systemPrompt: "Updated.",
          tools: [], loadSkills: false, loadExtensions: false, inheritContext: false,
          runInBackground: false, promptMode: "append", enabled: true,
        });
        throw new Error("save unexpectedly succeeded despite unreadable existing profile");
      } catch (error) {
        if (error.code !== "EACCES") throw error;
      }
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        TEST_PROJECT_CWD: cwd,
        TEST_PROJECT_DIRECTORY: join(cwd, ".pi", "agents"),
        TEST_PROJECT_PROFILE: projectFile,
        TEST_SUBAGENTS_MODULE: fileURLToPath(new URL("./subagents.ts", import.meta.url)),
      },
      encoding: "utf8",
      timeout: 20_000,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.match(await readFile(projectFile, "utf8"), /Project\./);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("enabling an orchestrator clears hidden extension selectors from a former specialist", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-orchestration-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const file = join(cwd, ".pi", "agents", "manager.md");
    await writeFile(file, "---\ntools: read, ext:mcp/search\nallowed_subagents: foreign\n---\nInspect.\n");

    saveProjectSubagentProfile(cwd, profile({
      name: "manager", tools: [], orchestration: { allowedChildren: ["reader"] },
    }));
    const source = await readFile(file, "utf8");
    assert.match(source, /tools: none/);
    assert.doesNotMatch(source, /ext:mcp\/search/);
    assert.match(source, /allowed_subagents: foreign/);
    const loaded = resolveSubagentProfile(cwd, "manager");
    assert.deepEqual(loaded.tools, []);
    assert.equal(loaded.extensionTools, undefined);
    assert.deepEqual(loaded.orchestration, { allowedChildren: ["reader"] });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tintinweb extension selectors stay scoped to the selected extension tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "legacy.md"),
      "---\ndescription: Legacy\ntools: read, ext:mcp/search, write\ndisallowed_tools: write\n---\nInspect only.\n",
    );
    const profile = listSubagentProfiles(cwd).find((item) => item.name === "legacy");
    assert.deepEqual(profile.tools, ["read"]);
    assert.deepEqual(profile.extensionTools, ["ext:mcp/search"]);
    assert.equal(profile.loadSkills, false);
    assert.equal(profile.loadExtensions, true);
    const extensions = [
      { path: "/tmp/mcp/index.ts", sourceInfo: { source: "mcp" }, tools: new Map([["search", {}], ["admin", {}]]) },
      { path: "/tmp/other/index.ts", sourceInfo: { source: "other" }, tools: new Map([["search", {}]]) },
    ];
    assert.deepEqual(selectSubagentExtensionTools(extensions, profile.extensionTools), ["search"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reads tintinweb profile aliases and frontmatter identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-tintin-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(join(cwd, ".pi", "agents", "review.md"), `---
name: security-review
color: cyan
skills: true
extensions: false
prompt_mode: replace
isolation: worktree
persist_session: false
disallowed_tools: bash
---
Review securely.
`);
    const profile = resolveSubagentProfile(cwd, "security-review");
    assert.equal(profile.name, "security-review");
    assert.equal(profile.loadSkills, true);
    assert.equal(profile.loadExtensions, false);
    assert.equal(profile.promptMode, "replace");
    assert.equal(profile.color, "cyan");
    assert.equal(profile.isolation, "worktree");
    assert.equal(profile.persistSession, false);
    assert.equal(profile.tools.includes("bash"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("persisted subagent metadata reconstructs the final run", () => {
  const entries = [
    {
      type: "custom",
      customType: SUBAGENT_META_TYPE,
      id: "meta",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: {
        version: 1,
        parentSessionId: "parent",
        parentSessionPath: "/tmp/parent.jsonl",
        parentToolCallId: "tool-call",
        profile: "Explore",
        description: "Find the parser",
        task: "Locate parser code",
        runInBackground: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      type: "custom",
      customType: SUBAGENT_RESULT_TYPE,
      id: "result",
      parentId: "meta",
      timestamp: "2026-01-01T00:01:00.000Z",
      data: {
        version: 1,
        status: "completed",
        completedAt: "2026-01-01T00:01:00.000Z",
        result: "Located it.",
      },
    },
  ];

  assert.deepEqual(readSubagentRun(entries, "child", "/tmp/child.jsonl"), {
    sessionId: "child",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent",
    parentToolCallId: "tool-call",
    profile: "Explore",
    description: "Find the parser",
    task: "Locate parser code",
    runInBackground: true,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: "Located it.",
  });
});

test("persisted subagent resources restore the exact isolated prompt and tools", () => {
  const entries = [{
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    id: "meta",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      profile: "reviewer",
      resourceSnapshot: {
        version: 1,
        appendSystemPrompt: ["Review carefully.", "Inherited parent context."],
        tools: ["read", "grep", "web_search", "read"],
        loadSkills: true,
        loadExtensions: true,
      },
    },
  }];

  assert.deepEqual(readSubagentSessionResources(entries), {
    appendSystemPrompt: ["Review carefully.", "Inherited parent context."],
    tools: ["read", "grep", "web_search"],
    loadSkills: true,
    loadExtensions: true,
    fastMode: false,
  });
});

test("legacy subagent resource snapshots keep skills and extensions disabled", () => {
  const entries = [{
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      resourceSnapshot: {
        version: 1,
        appendSystemPrompt: ["Stay focused."],
        tools: ["read"],
      },
    },
  }];

  assert.deepEqual(readSubagentSessionResources(entries), {
    appendSystemPrompt: ["Stay focused."],
    tools: ["read"],
    loadSkills: false,
    loadExtensions: false,
    fastMode: false,
  });
});

test("v2 snapshots restore the exact orchestrator controls and leave specialists non-delegating", () => {
  const childProfiles = {
    reader: { scope: "project", filePath: "/tmp/reader.md", sha256: "a".repeat(64) },
    writer: { scope: "builtin", sha256: "b".repeat(64) },
  };
  const snapshot = {
    version: 2,
    appendSystemPrompt: ["Route work."],
    tools: ["Agent", "get_subagent_result", "steer_subagent"],
    loadSkills: false,
    loadExtensions: false,
    orchestration: {
      allowedChildren: ["Reader", "Writer"], dependencies: { writer: ["reader"] },
      rootSessionId: "root", depth: 1, childProfiles,
    },
  };
  const entry = (resourceSnapshot) => [{
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    data: { version: 1, parentSessionId: "root", parentSessionPath: "/tmp/root.jsonl", profile: "manager", resourceSnapshot },
  }];
  assert.deepEqual(readSubagentSessionResources(entry(snapshot)), {
    appendSystemPrompt: ["Route work."],
    tools: ["Agent", "get_subagent_result", "steer_subagent"],
    loadSkills: false,
    loadExtensions: false,
    fastMode: false,
    orchestration: {
      allowedChildren: ["Reader", "Writer"], dependencies: { Writer: ["Reader"] },
      rootSessionId: "root", depth: 1, childProfiles,
    },
  });
  const legacy = { ...snapshot, orchestration: { ...snapshot.orchestration } };
  delete legacy.orchestration.dependencies;
  assert.equal(readSubagentSessionResources(entry(legacy)).orchestration.dependencies, undefined);
  assert.deepEqual(readSubagentSessionResources(entry({
    version: 2, appendSystemPrompt: [], tools: ["read"], loadSkills: false, loadExtensions: false,
  })), {
    appendSystemPrompt: [], tools: ["read"], loadSkills: false, loadExtensions: false, fastMode: false,
  });
});

test("resource restoration distinguishes no marker from corrupt metadata and rejects privilege escalation", () => {
  const entry = (resourceSnapshot, metadata = {}) => [{
    type: "custom", customType: SUBAGENT_META_TYPE,
    data: {
      version: 1,
      parentSessionId: "root",
      parentSessionPath: "/tmp/root.jsonl",
      profile: "manager",
      resourceSnapshot,
      ...metadata,
    },
  }];
  const base = { version: 2, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false };
  const controls = ["Agent", "get_subagent_result", "steer_subagent"];
  const orchestration = {
    allowedChildren: ["reader"], rootSessionId: "root", depth: 1,
    childProfiles: { reader: { scope: "project", filePath: "/tmp/reader.md", sha256: "a".repeat(64) } },
  };
  assert.equal(readSubagentSessionResources([]), null);
  assert.throws(() => readSubagentSessionResources(entry(base, { version: 3 })), /Invalid subagent metadata/);
  assert.throws(() => readSubagentSessionResources(entry(undefined)), /Invalid.*snapshot/);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, version: 4 })), /Invalid or unsupported/);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, fastMode: "true" })), /Invalid.*snapshot/);
  assert.equal(readSubagentSessionResources(entry({ ...base, fastMode: true })).fastMode, true);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, version: 1, tools: controls })), /Invalid.*tools/);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, version: 1, orchestration })), /Invalid.*orchestration/);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, tools: controls })), /Invalid.*tools/);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, tools: ["Agent"], orchestration })), /Invalid.*tools/);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, tools: [...controls, "Agent"], orchestration })), /Invalid.*tools/);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, tools: [...controls, "read"], orchestration })), /Invalid.*tools/);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, tools: controls, loadSkills: true, orchestration })), /Invalid.*tools/);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, tools: controls, orchestration: { ...orchestration, depth: -1 } })), /Invalid.*orchestration/);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, tools: controls, orchestration: { ...orchestration, allowedChildren: ["MANAGER"] } })), /Invalid.*orchestration/);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, tools: controls, orchestration: { ...orchestration, childProfiles: {} } })), /Invalid.*orchestration/);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, tools: controls, orchestration: { ...orchestration, childProfiles: { reader: { scope: "project", filePath: "/tmp/reader.md", sha256: "bad" } } } })), /Invalid.*orchestration/);
  assert.throws(() => readSubagentSessionResources(entry({ ...base, tools: controls, orchestration: { ...orchestration, childProfiles: { reader: { scope: "builtin", filePath: "/tmp/reader.md", sha256: "a".repeat(64) } } } })), /Invalid.*orchestration/);
  for (const dependencies of [
    { reader: ["reader"] }, { reader: ["unknown"] }, { reader: "reader" }, { reader: [], READER: [] }, [],
  ]) {
    assert.throws(() => readSubagentSessionResources(entry({
      ...base, tools: controls, orchestration: { ...orchestration, dependencies },
    })), /Invalid.*orchestration/, JSON.stringify(dependencies));
  }
});

test("extension tools are merged while subagent control tools stay excluded", () => {
  assert.deepEqual(
    withSubagentExtensionTools(
      ["read"],
      ["web_search", "Agent", "get_subagent_result", "steer_subagent", "web_search"],
    ),
    ["read", "web_search"],
  );
});

test("an empty tool selection round-trips without restoring default tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const saved = saveProjectSubagentProfile(cwd, profile({ tools: [] }));
    const loaded = listSubagentProfiles(cwd).find((item) => item.name === saved.name);
    const source = await readFile(join(cwd, ".pi", "agents", `${saved.name}.md`), "utf8");

    assert.deepEqual(saved.tools, []);
    assert.deepEqual(loaded.tools, []);
    assert.match(source, /tools: none/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("saved profiles normalize runtime values and reject invalid settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const saved = saveProjectSubagentProfile(cwd, profile());
    assert.equal(saved.displayName, "Test agent");
    assert.equal(saved.description, "Test description");
    assert.equal(saved.systemPrompt, "Test prompt.");
    assert.deepEqual(saved.tools, ["read"]);
    assert.equal(saved.model, "provider/model");
    assert.equal(saved.maxTurns, 4);
    assert.equal(saved.loadSkills, false);
    assert.equal(saved.loadExtensions, false);
    assert.equal(saved.fastMode, false);

    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ name: "../escape" })),
      /Agent name may contain only/,
    );
    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ thinking: "extreme" })),
      /Invalid thinking level/,
    );
    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ fastMode: "true" })),
      /Fast mode must be a boolean/,
    );
    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ maxTurns: Number.POSITIVE_INFINITY })),
      /Max turns must be a non-negative number/,
    );
    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ maxTurns: -1 })),
      /Max turns must be a non-negative number/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project profiles override workspace profiles and deletion restores the workspace version", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".agents", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "agents", "test-agent.md"),
      "---\ndescription: Workspace version\ntools: read\n---\nWorkspace prompt.\n",
    );
    saveProjectSubagentProfile(cwd, profile({ description: "Project version" }));
    assert.equal(resolveSubagentProfile(cwd, "TEST-AGENT").description, "Project version");

    deleteProjectSubagentProfile(cwd, "test-agent");
    const restored = resolveSubagentProfile(cwd, "test-agent");
    assert.equal(restored.scope, "workspace");
    assert.equal(restored.description, "Workspace version");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("global and project sources with the same name stay visible while project wins at runtime", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    saveSubagentProfile(cwd, "global", profile({ description: "Global version" }));
    saveSubagentProfile(cwd, "project", profile({ description: "Project version" }));

    const sources = listSubagentProfileSources(cwd)
      .filter((item) => item.name === "test-agent")
      .sort((a, b) => a.scope.localeCompare(b.scope));
    assert.deepEqual(sources.map((item) => item.scope), ["global", "project"]);
    assert.deepEqual(sources.map((item) => item.description), ["Global version", "Project version"]);

    const effective = resolveSubagentProfile(cwd, "test-agent");
    assert.equal(effective.scope, "project");
    assert.equal(effective.description, "Project version");
  } finally {
    deleteSubagentProfile(cwd, "global", "test-agent");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("global profiles round-trip and deleting an override restores the built-in", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const saved = saveSubagentProfile(cwd, "global", profile({
      name: "Explore",
      displayName: "Global explorer",
      description: "Global override",
      tools: ["read", "grep"],
    }));
    assert.equal(saved.scope, "global");
    assert.equal(saved.filePath, join(testAgentDir, "agents", "Explore.md"));
    assert.equal(resolveSubagentProfile(cwd, "Explore").scope, "global");
    assert.equal(resolveSubagentProfile(cwd, "Explore").description, "Global override");

    deleteSubagentProfile(cwd, "global", "Explore");
    const restored = resolveSubagentProfile(cwd, "Explore");
    assert.equal(restored.scope, "builtin");
    assert.equal(restored.displayName, "Explore");
  } finally {
    deleteSubagentProfile(cwd, "global", "Explore");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a built-in is switched off through settings.json, not a copied-out file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    writeDisabledBuiltInSubagent("Explore", true);

    const builtin = listSubagentProfileSources(cwd).find((item) => item.scope === "builtin" && item.name === "explore");
    assert.equal(builtin.enabled, false);
    assert.equal(builtin.filePath, undefined);
    assert.equal(existsSync(join(testAgentDir, "agents", "explore.md")), false);
    assert.equal(resolveSubagentProfile(cwd, "explore"), undefined);
    // Only the named built-in is affected.
    assert.equal(resolveSubagentProfile(cwd, "plan").scope, "builtin");

    // A same-name file replaces the built-in outright, so its own `enabled` decides.
    saveSubagentProfile(cwd, "global", profile({ name: "explore", description: "Global override" }));
    const overriding = resolveSubagentProfile(cwd, "explore");
    assert.equal(overriding.scope, "global");
    assert.equal(overriding.description, "Global override");
    deleteSubagentProfile(cwd, "global", "explore");

    writeDisabledBuiltInSubagent("explore", false);
    assert.equal(resolveSubagentProfile(cwd, "explore").scope, "builtin");
  } finally {
    writeDisabledBuiltInSubagent("explore", false);
    deleteSubagentProfile(cwd, "global", "explore");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("disabled profiles cannot be resolved for execution", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    saveSubagentProfile(cwd, "global", profile({ description: "Global version" }));
    saveProjectSubagentProfile(cwd, profile({ enabled: false }));
    const sources = listSubagentProfileSources(cwd).filter((item) => item.name === "test-agent");
    const globalProfile = sources.find((item) => item.scope === "global");
    const projectProfile = sources.find((item) => item.scope === "project");

    assert.equal(isSubagentProfileOverridden(globalProfile, sources), true);
    assert.equal(isSubagentProfileOverridden(projectProfile, sources), false);
    assert.equal(resolveSubagentProfile(cwd, "test-agent"), undefined);
    assert.equal(listSubagentProfiles(cwd).find((item) => item.name === "test-agent").enabled, false);
  } finally {
    deleteSubagentProfile(cwd, "global", "test-agent");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("persisted runs distinguish interrupted, failed, aborted, and latest results", () => {
  const meta = {
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    id: "meta",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "tool-call",
      profile: "Explore",
      description: "Inspect",
      task: "Inspect files",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  assert.equal(readSubagentRun([meta], "child", "/tmp/child.jsonl").status, "interrupted");

  const failed = {
    ...meta,
    id: "failed",
    customType: SUBAGENT_RESULT_TYPE,
    data: { version: 1, status: "failed", completedAt: "2026-01-01T00:01:00.000Z", error: "boom" },
  };
  const aborted = {
    ...failed,
    id: "aborted",
    data: { version: 1, status: "aborted", completedAt: "2026-01-01T00:02:00.000Z" },
  };
  assert.equal(readSubagentRun([meta, failed], "child", "/tmp/child.jsonl").status, "failed");
  assert.equal(readSubagentRun([meta, failed], "child", "/tmp/child.jsonl").error, "boom");
  assert.equal(readSubagentRun([meta, failed, aborted], "child", "/tmp/child.jsonl").status, "aborted");
  const resumed = { ...failed, id: "resumed", customType: SUBAGENT_STATUS_TYPE, data: { version: 1, status: "queued" } };
  assert.equal(readSubagentRun([meta, failed, resumed], "child", "/tmp/child.jsonl").status, "queued");
  const resumeFields = {
    parentToolCallId: "new-tool-call", task: "Review revised files",
    description: "Review", runInBackground: true,
  };
  const running = { ...resumed, id: "running", data: { ...resumed.data, status: "running", ...resumeFields } };
  assert.deepEqual(
    (({ status, parentToolCallId, task, description, runInBackground }) => ({ status, parentToolCallId, task, description, runInBackground }))(
      readSubagentRun([meta, failed, resumed, running], "child", "/tmp/child.jsonl")
    ),
    { status: "running", ...resumeFields },
  );
  const finished = { ...failed, id: "finished", data: {
    version: 1, status: "completed", completedAt: "2026-01-01T00:03:00.000Z", result: "Reviewed",
    ...resumeFields,
  } };
  const reopened = readSubagentRun([meta, failed, running, finished], "child", "/tmp/child.jsonl");
  assert.equal(reopened.parentToolCallId, "new-tool-call");
  assert.equal(reopened.task, "Review revised files");
  assert.equal(reopened.description, "Review");
  assert.equal(reopened.runInBackground, true);
  assert.equal(reopened.result, "Reviewed");
  assert.equal(readSubagentRun([{ ...meta, data: { version: 2 } }], "child", "/tmp/child.jsonl"), null);
});

test("project profile directories cannot escape cwd through symbolic links", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "pi-web-subagent-boundary-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, "project");
  const outside = join(base, "outside");
  await mkdir(join(cwd, ".agents"), { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secret.md"), "---\ndescription: Secret\n---\nprivate\n");

  try {
    await symlink(outside, join(cwd, ".agents", "agents"), process.platform === "win32" ? "junction" : "dir");
    await symlink(outside, join(cwd, ".pi", "agents"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.equal(listSubagentProfileSources(cwd).some((item) => item.name === "secret"), false);
  assert.equal(listSubagentProfiles(cwd).some((item) => item.name === "secret"), false);
  assert.throws(
    () => saveProjectSubagentProfile(cwd, profile({ name: "escaped" })),
    /outside the project root/,
  );
  assert.throws(
    () => deleteProjectSubagentProfile(cwd, "secret"),
    /outside the project root/,
  );
  assert.match(await readFile(join(outside, "secret.md"), "utf8"), /private/);
});

test("a save keeps frontmatter keys this app does not manage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const file = join(cwd, ".pi", "agents", "orchestrator.md");
    await writeFile(
      file,
      [
        "---",
        "name: orchestrator",
        "description: Hands out work",
        "display_name: orchestrator",
        "tools: read, bash, edit, write, grep, find, ls, ext:pi-advisor-flow/ask_advisor",
        "skills: false",
        "extensions: pi-advisor-flow",
        "exclude_extensions: pi-advisor-flow",
        "allowed_subagents: thinker, executor",
        "disallowed_tools: write",
        "enabled: true",
        "inherit_context: false",
        "run_in_background: false",
        "---",
        "Dispatch the work.",
      ].join("\n"),
    );

    saveProjectSubagentProfile(cwd, profile({ name: "orchestrator", tools: ["read", "bash"] }));
    const source = await readFile(file, "utf8");

    assert.match(source, /^name: orchestrator$/m);
    assert.match(source, /allowed_subagents: thinker, executor/);
    assert.match(source, /exclude_extensions: pi-advisor-flow/);
    assert.match(source, /disallowed_tools: write/);
    assert.match(source, /skills: false/);
    assert.match(source, /extensions: pi-advisor-flow/);
    assert.match(source, /tools: read, bash, ext:pi-advisor-flow\/ask_advisor/);
    assert.match(source, /Test prompt\./);

    const loaded = listSubagentProfiles(cwd).find((item) => item.name === "orchestrator");
    assert.deepEqual(loaded.tools, ["read", "bash"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a save refuses to overwrite malformed existing frontmatter", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const file = join(cwd, ".pi", "agents", "malformed.md");
    const source = "---\nallowed_subagents: [executor\n---\nKeep this file intact.\n";
    await writeFile(file, source);

    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ name: "malformed" })),
      /existing frontmatter is invalid/,
    );
    assert.equal(await readFile(file, "utf8"), source);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the pi-subagents flag aliases are seeded, kept in step, and never overwrite a whitelist", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const file = join(cwd, ".pi", "agents", "fresh.md");
    saveProjectSubagentProfile(cwd, profile({ name: "fresh", loadSkills: true, loadExtensions: true }));
    const seeded = await readFile(file, "utf8");
    assert.match(seeded, /load_skills: true/);
    assert.match(seeded, /skills: true/);
    assert.match(seeded, /load_extensions: true/);
    assert.match(seeded, /extensions: true/);

    saveProjectSubagentProfile(cwd, profile({ name: "fresh", loadSkills: false, loadExtensions: false }));
    const flipped = await readFile(file, "utf8");
    assert.match(flipped, /skills: false/);
    assert.match(flipped, /extensions: false/);

    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const scoped = join(cwd, ".pi", "agents", "scoped.md");
    await writeFile(scoped, "---\ndescription: Scoped\nextensions: pi-advisor-flow\n---\nOnly the advisor.\n");
    saveProjectSubagentProfile(cwd, profile({ name: "scoped", loadExtensions: true }));
    assert.match(await readFile(scoped, "utf8"), /extensions: pi-advisor-flow/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("profile flags fall back to the pi-subagents spellings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "legacy-flags.md"),
      "---\ndescription: Legacy flags\nskills: false\nextensions: pi-advisor-flow\n---\nScoped.\n",
    );

    const loaded = listSubagentProfiles(cwd).find((item) => item.name === "legacy-flags");
    assert.equal(loaded.loadSkills, false);
    assert.equal(loaded.loadExtensions, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
