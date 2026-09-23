import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
const { listSubagentProfiles } = await jiti.import("./subagents.ts");
const { readEffectiveMainAgentConfig } = await jiti.import("./main-agent-config.ts");
const { validateSelectedAgentResources } = await jiti.import("./agent-resource-selection.ts");

test("shipped roster works in a different project and keeps specialists isolated", async (t) => {
  const previousRoster = process.env.PI_WEB_ROSTER_ROOT;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const root = await mkdtemp(join(tmpdir(), "pi-web-roster-sample-"));
  const roster = join(repo, "orchestration");
  process.env.PI_WEB_ROSTER_ROOT = roster;
  process.env.PI_CODING_AGENT_DIR = join(root, "personal-pi-dir");
  t.after(async () => {
    if (previousRoster === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previousRoster;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });

  const profiles = listSubagentProfiles(root);
  const byName = new Map(profiles.map((agent) => [agent.name, agent]));
  const coordinator = byName.get("task-coordinator");
  assert.equal(coordinator?.scope, "roster");
  assert.equal(coordinator?.enabled, true);
  assert.deepEqual(coordinator?.tools, []);
  assert.deepEqual(coordinator?.orchestration?.allowedChildren, [
    "project-code-reader", "technical-analyst", "bounded-writer", "change-verifier",
  ]);
  assert.deepEqual(coordinator?.orchestration?.contextProviders?.["technical-analyst"], ["project-code-reader"]);
  assert.equal(coordinator?.selectedSkills?.[0], join(roster, "skills", "coordinate-task", "SKILL.md"));
  assert.deepEqual(byName.get("technical-analyst")?.tools, []);
  assert.deepEqual(byName.get("technical-analyst")?.selectedSkills, []);
  assert.deepEqual(byName.get("project-code-reader")?.tools, ["read", "grep", "find", "ls"]);

  const main = readEffectiveMainAgentConfig(root).config;
  assert.deepEqual(main.orchestration?.allowedChildren, ["task-coordinator"]);
  assert.deepEqual(main.selectedSkills, [join(roster, "skills", "coordinate-task", "SKILL.md")]);
  await validateSelectedAgentResources(root, main);
});
