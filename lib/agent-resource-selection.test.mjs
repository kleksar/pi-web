import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  assertSelectedSkillsUnchanged,
  assertSelectedExtensionToolsUnchanged,
  filterPinnedSkills,
  pinSelectedSkills,
  pinSelectedExtensionTools,
  pinnedSkillsPrompt,
  portableSelectedSkillReferences,
  resolveSelectedSkillReferences,
  validateSelectedAgentResources,
  validatePinnedSkills,
} = await createJiti(import.meta.url).import("./agent-resource-selection.ts");
const { buildAgentResourceCatalog } = await createJiti(import.meta.url).import("./agent-resource-catalog.ts");

test("selected skill uses its discovered link, pins its target and content, and never lists other skills", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-skill-pins-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = join(dir, "first.md");
  const changed = join(dir, "second.md");
  const link = join(dir, "SKILL.md");
  const other = join(dir, "other.md");
  await writeFile(original, "Original coordinator guidance");
  await writeFile(changed, "Retargeted coordinator guidance");
  await writeFile(other, "Worker-only guidance");
  await symlink(original, link);
  const skills = [
    { name: "coordinate", description: "Coordination", filePath: link, disableModelInvocation: false },
    { name: "write-code", description: "Coding", filePath: other, disableModelInvocation: false },
  ];
  const pinned = pinSelectedSkills(skills, [link]);
  assert.equal(pinned[0].realPath, original);
  assert.deepEqual(filterPinnedSkills(skills, pinned).map((skill) => skill.name), ["coordinate"]);
  assert.match(pinnedSkillsPrompt(pinned), /Original coordinator guidance/);
  assert.doesNotMatch(pinnedSkillsPrompt(pinned), /Worker-only guidance/);
  assert.deepEqual(validatePinnedSkills(JSON.parse(JSON.stringify(pinned))), pinned);
  await rm(link);
  await symlink(changed, link);
  assert.throws(() => assertSelectedSkillsUnchanged(pinned), /Selected skill changed since session start/);
  assert.throws(() => filterPinnedSkills(skills, pinned), /Selected skill changed since session start/);
});

test("portable references survive a different checkout and pin the SDK's discovered link", async (t) => {
  const first = await mkdtemp(join(tmpdir(), "pi-web-skills-repo-"));
  const second = await mkdtemp(join(tmpdir(), "pi-web-skills-clone-"));
  t.after(() => Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]));
  for (const root of [first, second]) {
    const source = join(root, "orchestration", "skills", "coordinate", "SKILL.md");
    const linked = join(root, ".pi", "skills", "coordinate", "SKILL.md");
    await mkdir(join(root, "orchestration", "skills", "coordinate"), { recursive: true });
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(source, "Coordinate this checkout");
    await symlink(join(root, "orchestration", "skills"), join(root, ".pi", "skills"));
    const [absolute] = resolveSelectedSkillReferences(root, ["orchestration/skills/coordinate/SKILL.md"]);
    assert.equal(absolute, source);
    assert.deepEqual(portableSelectedSkillReferences(root, [linked], "orchestration/skills"),
      ["orchestration/skills/coordinate/SKILL.md"]);
    const discovered = [{ name: "coordinate", description: "Work", filePath: linked, disableModelInvocation: false }];
    const [pinned] = pinSelectedSkills(discovered, [absolute]);
    assert.equal(pinned.filePath, linked, "snapshots must pin the path used by the SDK");
    assert.equal(pinned.realPath, source);
  }
  assert.throws(() => resolveSelectedSkillReferences(first, ["orchestration/skills/../../outside/SKILL.md"]),
    /Invalid portable skill reference/);
  assert.throws(() => resolveSelectedSkillReferences(first, ["orchestration/skills/missing/SKILL.md"]),
    /Portable skill is missing/);
  assert.deepEqual(resolveSelectedSkillReferences(first, [join(first, "legacy", "SKILL.md")]),
    [join(first, "legacy", "SKILL.md")], "legacy absolute paths retain their format");
});

test("a portable skill cannot follow a symbolic link outside the source root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skill-root-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-web-skill-external-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await mkdir(join(root, "skills", "escaped"), { recursive: true });
  await writeFile(join(outside, "SKILL.md"), "External instructions");
  await symlink(join(outside, "SKILL.md"), join(root, "skills", "escaped", "SKILL.md"));
  assert.throws(() => resolveSelectedSkillReferences(root, ["skills/escaped/SKILL.md"]), /escapes the repository root/);
  assert.deepEqual(portableSelectedSkillReferences(root, [join(root, "skills", "escaped", "SKILL.md")]),
    [join(root, "skills", "escaped", "SKILL.md")]);
});

test("resource validation sees a repository skill even when the active project is elsewhere", async (t) => {
  const roster = await mkdtemp(join(tmpdir(), "pi-web-roster-catalog-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-another-project-"));
  const previous = process.env.PI_WEB_ROSTER_ROOT;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previous;
    await rm(roster, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  });
  await mkdir(join(roster, "agents"), { recursive: true });
  await mkdir(join(roster, "skills", "pi-web-test-coordinator"), { recursive: true });
  const skill = join(roster, "skills", "pi-web-test-coordinator", "SKILL.md");
  await writeFile(skill,
    "---\nname: pi-web-test-coordinator\ndescription: Coordinate an explicitly assigned test task.\n---\nCoordinate.\n");
  process.env.PI_WEB_ROSTER_ROOT = roster;
  await validateSelectedAgentResources(cwd, { selectedSkills: [skill] });
});

test("extension selection names the source and tool, rejects collisions and changed code", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-ext-pins-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "extension.ts");
  await writeFile(path, "export const version = 1");
  const selected = [{ extensionPath: path, toolName: "sentry_query" }];
  const extensions = [{ path, tools: new Map([["sentry_query", {}], ["unrelated", {}]]) }];
  const pinned = pinSelectedExtensionTools(extensions, selected);
  assert.equal(pinned[0].toolName, "sentry_query");
  assert.equal(pinned.length, 1);
  assert.throws(() => pinSelectedExtensionTools(
    [...extensions, { path: join(dir, "collision.ts"), tools: new Map([["sentry_query", {}]]) }], selected,
  ), /ambiguous/);
  assert.throws(() => pinSelectedExtensionTools(
    [{ path, tools: new Map([["read", {}]]) }], [{ extensionPath: path, toolName: "read" }],
  ), /Built-in or Pi Web delegation tool cannot be selected/);
  assert.throws(() => pinSelectedExtensionTools(
    [{ path, tools: new Map([["powershell", {}]]) }], [{ extensionPath: path, toolName: "powershell" }],
  ), /Built-in or Pi Web delegation tool cannot be selected/);
  assert.throws(() => pinSelectedExtensionTools(
    [...extensions, { path: join(dir, "shadow.ts"), tools: new Map([["bash", {}]]) }], selected,
  ), /overrides reserved built-in tool bash/,
  "an unselected extension cannot shadow an active built-in while tool assignments are explicit");
  assert.deepEqual(pinSelectedExtensionTools([
    ...extensions,
    { path: "<inline:pi-web-project-command-environment>", tools: new Map([["bash", {}]]) },
    { path: "<inline:pi-web-subagents>", tools: new Map([["Agent", {}], ["get_subagent_result", {}], ["steer_subagent", {}]]) },
  ], selected), pinned, "Pi Web's own host tools may remain loaded");
  await writeFile(path, "export const version = 2");
  assert.throws(() => assertSelectedExtensionToolsUnchanged(pinned), /Selected extension changed since session start/);
});

test("resource catalog does not offer built-in tool names as extension assignments", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-ext-catalog-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "extension.ts");
  await writeFile(path, "export const version = 1");
  const definition = { label: "Tool", description: "Test tool" };
  const catalog = buildAgentResourceCatalog([], [{
    path, sourceInfo: { source: "user" },
    tools: new Map(["bash", "powershell", "Agent", "sentry_query"].map((name) => [name, { definition }])),
  }]);
  assert.deepEqual(catalog.extensionTools.map((tool) => tool.toolName), ["sentry_query"]);
});
