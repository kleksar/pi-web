import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

test("new-session startup sends only explicit browser overrides", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureNewSession"),
    source.indexOf("const loadSlashCommands"),
  );

  assert.match(ensureSource, /const selectedModel = newSessionDispatcher \? null : newSessionModelOverrideRef\.current;/);
  assert.doesNotMatch(ensureSource, /newSessionModel \?\? newSessionDefaultModel/);
  assert.match(ensureSource, /const selectedThinkingLevel = newSessionDispatcher \? null : thinkingLevelOverrideRef\.current;/);
  assert.doesNotMatch(ensureSource, /thinkingLevel !== "auto"/);
  assert.match(ensureSource, /if \(newSessionDispatcher === null\) throw new Error\(/);
  assert.match(ensureSource, /mainDispatcher: newSessionDispatcher,/);
  assert.match(ensureSource, /const toolNames = newSessionDispatcher \? undefined : getToolNamesForPreset\(toolPreset\);/);
});

test("fresh composer waits for a live default and keeps an explicit mode choice", () => {
  assert.match(source, /useState<boolean \| null>\(null\)/);
  assert.match(source, /if \(!dispatcherOverrideRef\.current\) setNewSessionDispatcher\(d\.defaultMainDispatcher === true\)/);
  assert.match(source, /dispatcherOverrideRef\.current = true;\s*setNewSessionDispatcher\(enabled\)/);
  assert.match(source, /sessionModePending: isNew && newSessionDispatcher === null/);
});

test("new-session startup adopts server state only while explicit overrides are unchanged", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureNewSession"),
    source.indexOf("const loadSlashCommands"),
  );

  assert.match(
    ensureSource,
    /result\.model && newSessionModelOverrideRef\.current === selectedModel/,
  );
  assert.match(ensureSource, /setPendingModel\(result\.model\)/);
  assert.match(ensureSource, /setNewSessionDefaultModel\(result\.model\)/);
  assert.match(
    ensureSource,
    /thinkingLevelOverrideRef\.current === selectedThinkingLevel/,
  );
  assert.match(ensureSource, /setLiveThinkingLevel\(asConcreteThinkingLevel\(result\.thinkingLevel\)\)/);
  assert.match(ensureSource, /setNewSessionDefaultThinkingLevel\(asConcreteThinkingLevel\(result\.thinkingLevel\)\)/);
});

test("model-list refresh does not overwrite a live session or explicit thinking override", () => {
  const loadModelsSource = source.slice(
    source.indexOf("const loadModels = useCallback"),
    source.indexOf("const handleBuiltinSlashCommand"),
  );

  assert.match(loadModelsSource, /if \(isNew && !sessionIdRef\.current\)/);
  assert.match(
    loadModelsSource,
    /thinkingLevelOverrideRef\.current === null/,
  );
  assert.match(loadModelsSource, /setNewSessionDefaultThinkingLevel\(/);
  assert.doesNotMatch(loadModelsSource, /setThinkingLevel\(/);
});
