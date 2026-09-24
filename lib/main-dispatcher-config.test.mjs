import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_MAIN_DISPATCHER_CONFIG,
  MainDispatcherConfigConflictError,
  mainDispatcherPrompt,
  readMainDispatcherConfig,
  saveMainDispatcherConfig,
  validateMainDispatcherConfig,
} = await jiti.import("./main-dispatcher-config.ts");

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
  assert.match(prompt, /For an unknown engineering task, delegate/);
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
