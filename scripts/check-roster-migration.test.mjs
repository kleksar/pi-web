import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fingerprintRetiredResource, inspectLocalResources } from "./check-roster-migration.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-roster-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const roster = join(root, "orchestration");
  mkdirSync(join(home, ".agents", "skills"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent", "agents"), { recursive: true });
  mkdirSync(join(roster, "skills"), { recursive: true });
  mkdirSync(join(roster, "agents"), { recursive: true });
  const tracked = new Set();
  const add = (relative, contents) => {
    const file = join(roster, relative);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, contents);
    tracked.add(`orchestration/${relative}`);
  };
  return { root, home, roster, tracked, add };
}

test("compares agent settings against their separate Git destination and complete linked skill assets", (t) => {
  const { root, home, roster, tracked, add } = fixture(t);
  const external = join(root, "externally-managed-skill");
  mkdirSync(external);
  writeFileSync(join(external, "SKILL.md"), "Documented skill\n");
  writeFileSync(join(external, "examples.txt"), "Example\n");
  symlinkSync(external, join(home, ".agents", "skills", "docs"));
  add("skills/docs/SKILL.md", "Documented skill\n");
  add("skills/docs/examples.txt", "Example\n");
  writeFileSync(join(home, ".pi", "agent", "agents", "reader.md"), "Read.\n");
  add("agents/reader.md", "Read.\n");
  writeFileSync(join(home, ".pi", "agent", "agents", "settings.json"), '{"builtInEnabled":true}\n');
  add("subagent-settings.json", '{"builtInEnabled":true}\n');
  writeFileSync(join(home, ".pi", "agent", "APPEND_SYSTEM.md"), "Register.\n");
  add("APPEND_SYSTEM.md", "Register.\n");
  const inventory = inspectLocalResources(home, roster, tracked);
  assert.deepEqual(inventory.blockers, []);
  assert.equal(inventory.checked, 5);
  assert.match(inventory.observations.join("\n"), /symbolic link/);
  assert.doesNotMatch(inventory.observations.join("\n"), /externally-managed-skill/);
});

test("changed local prompt needs acknowledgment of both exact content hashes", (t) => {
  const { home, roster, tracked, add } = fixture(t);
  const oldPrompt = join(home, ".pi", "agent", "APPEND_SYSTEM.md");
  const newPrompt = join(roster, "APPEND_SYSTEM.md");
  writeFileSync(oldPrompt, "регистратор\n");
  add("APPEND_SYSTEM.md", "Coordinate tasks.\n");
  const before = inspectLocalResources(home, roster, tracked);
  assert.match(before.blockers.join("\n"), /--reviewed/);
  const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const reviewed = new Map([[".pi/agent/APPEND_SYSTEM.md", `${hash(oldPrompt)}:${hash(newPrompt)}`]]);
  const after = inspectLocalResources(home, roster, tracked, reviewed);
  assert.deepEqual(after.blockers, []);
  assert.match(after.observations.join("\n"), /reviewed replacement/);
  writeFileSync(newPrompt, "Changed after acknowledgment.\n");
  assert.match(inspectLocalResources(home, roster, tracked, reviewed).blockers.join("\n"), /--reviewed/);
});

test("unmatched assets, Git metadata and unrelated global resources block deletion", (t) => {
  const { home, roster, tracked, add } = fixture(t);
  const skill = join(home, ".agents", "skills", "docs");
  mkdirSync(join(skill, ".git"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "Tracked.\n");
  writeFileSync(join(skill, "example.txt"), "Missing.\n");
  add("skills/docs/SKILL.md", "Tracked.\n");
  mkdirSync(join(home, ".pi", "agent", "skills", "global"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "main-agent-config.json"), '{"selectedSkills":[]}');
  const inventory = inspectLocalResources(home, roster, tracked);
  const errors = inventory.blockers.join("\n");
  assert.match(errors, /Git metadata/);
  assert.match(errors, /example\.txt: missing in Git catalog/);
  assert.match(errors, /additional global resources/);
  assert.match(errors, /Main overrides/);
});

test("an intentionally retired skill tree and old profile require matching content fingerprints", (t) => {
  const { home, roster, tracked } = fixture(t);
  const skill = join(home, ".agents", "skills", "old-experiment");
  mkdirSync(join(skill, "examples"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "Deprecated skill\n");
  writeFileSync(join(skill, "examples", "prompt.txt"), "example\n");
  const profile = join(home, ".pi", "agent", "agents", "unused.md");
  writeFileSync(profile, "Deprecated profile\n");
  const before = inspectLocalResources(home, roster, tracked);
  assert.match(before.blockers.join("\n"), /--retired \.agents\/skills\/old-experiment=[a-f0-9]{64}/);
  assert.match(before.blockers.join("\n"), /--retired \.pi\/agent\/agents\/unused\.md=[a-f0-9]{64}/);
  const retired = new Map([
    [".agents/skills/old-experiment", fingerprintRetiredResource(skill)],
    [".pi/agent/agents/unused.md", fingerprintRetiredResource(profile)],
  ]);
  const approved = inspectLocalResources(home, roster, tracked, new Map(), retired);
  assert.deepEqual(approved.blockers, []);
  assert.equal(approved.observations.filter((item) => item.includes("explicitly reviewed retirement")).length, 2);
  writeFileSync(join(skill, "examples", "prompt.txt"), "new example\n");
  assert.match(inspectLocalResources(home, roster, tracked, new Map(), retired).blockers.join("\n"),
    /changed since --retired acknowledgment/);
});

test("retirement cannot waive Main prompt or agent settings; stale acknowledgments fail", (t) => {
  const { home, roster, tracked, add } = fixture(t);
  const prompt = join(home, ".pi", "agent", "APPEND_SYSTEM.md");
  writeFileSync(prompt, "Old Main prompt\n");
  add("APPEND_SYSTEM.md", "New Main prompt\n");
  const settings = join(home, ".pi", "agent", "agents", "settings.json");
  writeFileSync(settings, '{"builtInEnabled":false}');
  add("subagent-settings.json", '{"builtInEnabled":true}');
  const retired = new Map([
    [".pi/agent/APPEND_SYSTEM.md", fingerprintRetiredResource(prompt)],
    [".pi/agent/agents/settings.json", fingerprintRetiredResource(settings)],
    [".pi/agent/agents/missing.md", "0".repeat(64)],
  ]);
  const inventory = inspectLocalResources(home, roster, tracked, new Map(), retired);
  const errors = inventory.blockers.join("\n");
  assert.match(errors, /Main prompt and sub-agent settings cannot be retired/);
  assert.match(errors, /unused or stale --retired acknowledgment/);
});
