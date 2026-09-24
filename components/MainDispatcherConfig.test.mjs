import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { SETTINGS_SECTION_VALUES, getLastSettingsSection, setLastSettingsSection } = await jiti.import("../lib/settings-navigation.ts");
const panel = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const editor = await readFile(new URL("./MainDispatcherConfig.tsx", import.meta.url), "utf8");
const labels = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");

test("restores Main as a Settings tab before Sub-agents, including without a selected project", () => {
  const mainIndex = SETTINGS_SECTION_VALUES.indexOf("main");
  assert.equal(mainIndex + 1, SETTINGS_SECTION_VALUES.indexOf("agents"));
  assert.match(panel, /\{ id: "main", label: t\("common\.main"\), requiresProject: false \}/);
  assert.match(panel, /sectionHost\("main", <MainDispatcherConfig embedded/);
  const state = new Map();
  const storage = { getItem: (key) => state.get(key) ?? null, setItem: (key, value) => state.set(key, value) };
  setLastSettingsSection("main", storage);
  assert.equal(getLastSettingsSection(null, storage), "main");
});

test("edits the persisted dispatcher with a revision and keeps the fixed guard read-only", () => {
  assert.match(editor, /fetch\("\/api\/main\/config", \{ cache: "no-store", signal \}\)/);
  assert.match(editor, /body: JSON\.stringify\(\{ config: draft, expectedRevision: revision \}\)/);
  assert.match(editor, /if \(response\.status === 409\) \{[\s\S]*?setConflict\(true\)/);
  assert.match(editor, /dirty && !window\.confirm\(t\("main\.unsavedChanges"\)\)/);
  assert.match(editor, /!path \|\| !dirty \|\| saving \|\| conflict/);
  assert.match(editor, /onChange=\{\(event\) => update\("additionalInstructions", event\.target\.value\)\}/);
  assert.match(editor, /\{basePrompt\}<\/pre>/);
  assert.doesNotMatch(editor, /onChange=\{[^}]*basePrompt/);
  assert.match(editor, /disabled=\{!path \|\| loading \|\| saving \|\| conflict\}/);
});

test("distinguishes the new-chat dispatcher default from existing sessions", () => {
  assert.match(labels, /"chat\.mainDispatcher": "Task dispatcher"/);
  assert.match(labels, /"chat\.mainDispatcherHint": "New Task dispatcher sessions use the model, thinking level and Fast mode from Settings → Main\./);
  assert.match(labels, /"main\.description": "With a Git-owned Main configuration and enabled sub-agents, new chats start as Task dispatchers\. Existing sessions keep their mode\./);
  assert.match(labels, /"chat\.standardSession": "Standard session · direct tools"/);
});
