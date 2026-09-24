import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_MAIN_DISPATCHER_CONFIG,
  MainDispatcherConfigConflictError,
  mainDispatcherPrompt,
  isMainDispatcherDefaultEnabled,
  readMainDispatcherConfig,
  saveMainDispatcherConfig,
  validateMainDispatcherConfig,
} = await jiti.import("./main-dispatcher-config.ts");

test("a saved Git Main and enabled sub-agents default new chats to dispatcher", (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "pi-web-dispatcher-default-"));
  const roster = join(checkout, "orchestration");
  const agentDir = join(checkout, "local-agent");
  const previousRoster = process.env.PI_WEB_ROSTER_ROOT;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previousRoster === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previousRoster;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(checkout, { recursive: true, force: true });
  });
  mkdirSync(join(checkout, ".git"));
  mkdirSync(join(roster, "agents"), { recursive: true });
  process.env.PI_WEB_ROSTER_ROOT = roster;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  assert.equal(isMainDispatcherDefaultEnabled(), false);

  writeFileSync(join(roster, "subagent-settings.json"), JSON.stringify({ version: 1, builtInEnabled: true }));
  assert.equal(isMainDispatcherDefaultEnabled(), false);

  writeFileSync(join(roster, "main-dispatcher.json"), JSON.stringify({ version: 1, config: DEFAULT_MAIN_DISPATCHER_CONFIG }));
  assert.equal(isMainDispatcherDefaultEnabled(), true);

  writeFileSync(join(roster, "main-dispatcher.json"), "{");
  assert.throws(() => isMainDispatcherDefaultEnabled(), /JSON/);
  writeFileSync(join(roster, "main-dispatcher.json"), JSON.stringify({ version: 1, config: DEFAULT_MAIN_DISPATCHER_CONFIG }));

  mkdirSync(join(agentDir, "agents"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "settings.json"), JSON.stringify({ version: 1, builtInEnabled: false }));
  assert.equal(isMainDispatcherDefaultEnabled(), false);
});

test("Main dispatcher settings are a versioned Git-visible file with revision-safe saves", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-main-config-"));
  const path = join(dir, "main-dispatcher.json");
  try {
    const initial = readMainDispatcherConfig(path);
    assert.equal(initial.revision, "absent");
    assert.deepEqual(initial.config, DEFAULT_MAIN_DISPATCHER_CONFIG);

    const changed = { ...initial.config, model: "openai-codex/gpt-6-sol", additionalInstructions: "Keep the request identity." };
    const saved = saveMainDispatcherConfig(changed, initial.revision, path);
    assert.deepEqual(saved.config, changed);
    assert.equal(saved.path, path);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 1);
    assert.notEqual(saved.revision, "absent");
    assert.throws(() => saveMainDispatcherConfig(initial.config, initial.revision, path), MainDispatcherConfigConflictError);
    assert.deepEqual(readMainDispatcherConfig(path).config, changed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Main instructions append to the fixed dispatcher policy; malformed model and symlinked config fail closed", () => {
  const changed = { ...DEFAULT_MAIN_DISPATCHER_CONFIG, additionalInstructions: "Use concise status updates." };
  const prompt = mainDispatcherPrompt(changed);
  assert.match(prompt, /Delegate each new engineering request to orchestration-task-owner \(Astra High\)/);
  assert.match(prompt, /architecture and feature discussions, PR or issue research/);
  assert.match(prompt, /Use concise status updates/);
  assert.throws(() => validateMainDispatcherConfig({ ...changed, model: "gpt-6-luna" }), /provider\/model-id/);

  const dir = mkdtempSync(join(tmpdir(), "pi-web-main-symlink-"));
  const target = join(dir, "target.json");
  const link = join(dir, "main-dispatcher.json");
  try {
    writeFileSync(target, JSON.stringify({ version: 1, config: changed }));
    symlinkSync(target, link);
    assert.throws(() => readMainDispatcherConfig(link), /regular file/);
    assert.throws(() => saveMainDispatcherConfig(changed, "absent", link), /regular file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
