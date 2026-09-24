import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
const { listSubagentProfiles } = await jiti.import("./subagents.ts");
const { readEffectiveMainAgentConfig } = await jiti.import("./main-agent-config.ts");
const { validateSelectedAgentResources } = await jiti.import("./agent-resource-selection.ts");
const { readMainPrompt } = await jiti.import("./main-prompt.ts");
const { readSubagentSettings } = await jiti.import("./subagent-settings.ts");

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
  const rosterProfiles = profiles.filter((agent) => agent.scope === "roster");
  assert.equal(rosterProfiles.length, 17);
  for (const agent of rosterProfiles) {
    assert.equal(agent.enabled, true, `${agent.name}: ${agent.configurationError ?? "disabled"}`);
    assert.match(agent.model ?? "", /^openai-codex\/gpt-6-(luna|sol|astra)$/, `${agent.name}: pinned GPT-6 model`);
    const model = OPENAI_CODEX_MODELS[agent.model.slice("openai-codex/".length)];
    assert.ok(model, `${agent.name}: model is present in the installed Pi SDK`);
    assert.ok(model.thinkingLevelMap[agent.thinking], `${agent.name}: effort is supported by ${agent.model}`);
    const isLuna = agent.model === "openai-codex/gpt-6-luna";
    assert.equal(agent.fastMode, isLuna, `${agent.name}: Fast mode is on by default only for Luna`);
    if (isLuna) {
      assert.equal(model.provider, "openai-codex", `${agent.name}: Fast mode uses the Codex provider`);
      assert.equal(model.api, "openai-codex-responses", `${agent.name}: Fast mode uses a supported API`);
    }
    for (const skill of agent.selectedSkills ?? []) {
      await access(skill);
      assert.equal(skill.startsWith(join(roster, "skills") + "/"), true, agent.name);
    }
    for (const child of agent.orchestration?.allowedChildren ?? []) {
      assert.equal(byName.get(child)?.scope, "roster", `${agent.name} delegates to a missing catalog profile ${child}`);
    }
  }
  const coordinator = byName.get("task-coordinator");
  assert.equal(coordinator?.scope, "roster");
  assert.equal(coordinator?.enabled, true);
  assert.deepEqual(coordinator?.tools, []);
  assert.deepEqual(coordinator?.orchestration?.allowedChildren, [
    "project-policy-reader", "project-requirements-reader", "project-docs-reader", "project-code-reader", "github-reader",
    "technical-analyst", "architecture-reviewer", "bounded-writer", "change-verifier",
  ]);
  assert.deepEqual(coordinator?.orchestration?.contextProviders?.["technical-analyst"], [
    "project-code-reader", "project-docs-reader", "project-requirements-reader",
  ]);
  assert.deepEqual(coordinator?.orchestration?.dependencies?.["change-verifier"], ["bounded-writer"]);
  assert.equal(coordinator?.selectedSkills?.[0], join(roster, "skills", "coordinate-task", "SKILL.md"));
  assert.deepEqual(byName.get("technical-analyst")?.tools, []);
  assert.deepEqual(byName.get("technical-analyst")?.selectedSkills, []);
  assert.deepEqual(byName.get("project-code-reader")?.tools, ["read", "grep", "find", "ls"]);
  assert.deepEqual(byName.get("github-reader")?.tools, ["github_read"]);
  assert.equal(byName.get("github-reader")?.loadExtensions, false);

  const main = readEffectiveMainAgentConfig(root).config;
  assert.deepEqual(main.orchestration?.allowedChildren, [
    "evidence-coordinator", "small-task-coordinator", "task-coordinator", "complex-task-coordinator",
  ]);
  const complex = byName.get("complex-task-coordinator");
  assert.deepEqual(complex?.orchestration?.allowedChildren, [
    "evidence-coordinator", "technical-analyst", "architecture-reviewer",
    "implementation-coordinator", "verification-coordinator",
  ]);
  assert.deepEqual(complex?.orchestration?.dependencies?.["verification-coordinator"], ["implementation-coordinator"]);
  // Main (0) -> complex (1) -> evidence (2) -> reader (3) reaches the runtime's depth limit.
  assert.deepEqual(byName.get("evidence-coordinator")?.orchestration?.allowedChildren, [
    "project-policy-reader", "project-requirements-reader", "project-docs-reader", "project-code-reader", "github-reader",
  ]);
  assert.equal(byName.get("project-docs-reader")?.orchestration, undefined);
  assert.deepEqual(main.selectedSkills, [join(roster, "skills", "coordinate-task", "SKILL.md")]);
  assert.deepEqual(main.allowedBuiltInTools, []);
  assert.deepEqual(main.selectedExtensionTools, []);
  assert.deepEqual(main.orchestration.allowedChildren, [
    "evidence-coordinator", "small-task-coordinator", "task-coordinator", "complex-task-coordinator",
  ]);
  await validateSelectedAgentResources(root, main);
  const prompt = readMainPrompt(root);
  assert.equal(prompt.effectiveScope, "roster");
  assert.match(prompt.roster.content, /регистратор/);
  assert.equal(readSubagentSettings().builtInEnabled, true);
  assert.equal(readSubagentSettings().maxConcurrent, 10);
});
