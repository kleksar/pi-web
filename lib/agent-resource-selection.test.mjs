import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
  validatePinnedSkills,
} = await createJiti(import.meta.url).import("./agent-resource-selection.ts");

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
  await writeFile(path, "export const version = 2");
  assert.throws(() => assertSelectedExtensionToolsUnchanged(pinned), /Selected extension changed since session start/);
});
