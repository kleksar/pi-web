import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AgentsConfig.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const modelSelectorSource = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");
const mapSource = await readFile(new URL("./OrchestrationMap.tsx", import.meta.url), "utf8");

test("opens the complete overview from Sub-agents, focuses profiles, and handles a separate Main request", () => {
  assert.match(source, /const lastMainMapRequest = useRef\(0\)/);
  assert.match(source, /if \(openMainMapRequest === lastMainMapRequest\.current\) return;/);
  const topMapButton = source.slice(source.indexOf('{t("agents.profiles")}'), source.indexOf('{view === "map" && <span'));
  assert.match(topMapButton, /setMapFocusNode\(null\)/);
  assert.match(topMapButton, /selectMapOwner\(null\)/);
  assert.match(topMapButton, /setMapOwner\(null\)/);
  assert.match(topMapButton, /t\("agents\.openMap"\)/);
  assert.match(source, /if \(openMainMapRequest === lastMainMapRequest\.current\) return;[\s\S]*?setMapOwner\(MAIN_NODE_ID\)/);
  assert.match(source, /const openSelectedOnMap = \(\) => \{[\s\S]*?setMapFocusNode\(selected\.name\)/);
  assert.match(mapSource, /const \[query, setQuery\] = useState\(""\)/);
  assert.doesNotMatch(mapSource, /setQuery\(focusNodeId\)/);
});

test("keeps same-name profiles selectable by scope and shows the shared roster when configured", () => {
  assert.match(source, /return `\$\{profile\.scope\}:\$\{profile\.name\}`/);
  assert.match(source, /\["project", \.\.\.\(rosterAvailable \? \["roster" as const\] : \[\]\), "global", "workspace", "builtin"\] as const/);
  assert.match(source, /profile\.scope === scope/);
});

test("filters large profile catalogs without hiding the selected edit or exposing scratch project profiles", () => {
  assert.match(source, /const visibleProfiles = useMemo\(\(\) => \{[\s\S]*?profileQuery\.trim\(\)\.toLowerCase\(\)/);
  assert.match(source, /visibleProfiles\.filter\(\(profile\) => profile\.scope === scope\)/);
  assert.match(source, /const next = \(data\.profiles \?\? \[\]\)\.filter\(\(profile\) => projectSelected/);
  assert.match(source, /profile\.scope !== "project" && profile\.scope !== "workspace"/);
  assert.match(source, /excludeProjectResources=\{!projectSelected\}/);
});

test("rejects invalid concurrency without writing it, and restores the persisted value if saving fails", () => {
  assert.match(source, /!raw\.trim\(\) \|\| !Number\.isInteger\(value\) \|\| value < 1 \|\| value > 32/);
  assert.match(source, /setMaxConcurrentInput\(String\(maxConcurrent\)\);\s*setSettingsError\(t\("agents\.concurrentRange"\)\)/);
  assert.match(source, /catch \(cause\) \{\s*setMaxConcurrentInput\(String\(maxConcurrent\)\);\s*setSettingsError/);
  assert.match(source, /setSettingsSaving\(true\);[\s\S]*?fetch\("\/api\/subagents\/settings"/);
});

test("uses the shared enabled status treatment", () => {
  assert.match(source, /<ConfigStatusDot active=\{profile\.enabled\}/);
  assert.match(source, /className=\{`is-grow\$\{profile\.enabled \? "" : " is-muted"\}`\}/);
  assert.match(cssSource, /\.config-sidebar-text\.is-muted \{[\s\S]*?color: var\(--text-dim\)/);
});

const sidebarRow = source.slice(source.indexOf('<ConfigSidebarItem\n                          key={profileKey(profile)}'), source.indexOf('</ConfigSidebarItem>', source.indexOf('<ConfigSidebarItem\n                          key={profileKey(profile)}')));

test("resolves roster models by exact provider and id with name/id/raw fallbacks", () => {
  assert.match(source, /const provider = value\.slice\(0, separator\)/);
  assert.match(source, /const id = value\.slice\(separator \+ 1\)/);
  assert.match(source, /models\.find\(\(model\) => model\.provider === provider && model\.id === id\)/);
  assert.match(source, /return match \? match\.name \|\| match\.id : value/);
  assert.match(sidebarRow, /title=\{profile\.model \|\| undefined\}/);
  assert.match(sidebarRow, /rosterModelName\(profile\.model, modelOptions, t\("agents\.inherited"\)\)/);
  assert.doesNotMatch(sidebarRow, /\{t\("agents\.model"\)\}:/);
});

test("shows one truncated model and raw effort line beneath the sidebar name", () => {
  assert.match(sidebarRow, /\{profile\.displayName\}<\/ConfigSidebarText>\s*<span className=\{`agents-profile-metadata[^>]*>\s*\{rosterModelName\(profile\.model, modelOptions, t\("agents\.inherited"\)\)\} \{profile\.thinking \|\| t\("agents\.inherited"\)\}\s*<\/span>/);
  assert.doesNotMatch(sidebarRow, /\{t\("agents\.thinking"\)\}/);
  assert.match(cssSource, /\.agents-profile-summary \{[\s\S]*?min-width: 0;/);
  assert.match(cssSource, /\.agents-profile-metadata \{[\s\S]*?display: block;[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/);
});

test("labels each unset sidebar field Inherited without resolving session values", () => {
  assert.match(source, /if \(!value\) return inherited/);
  assert.match(sidebarRow, /profile\.thinking \|\| t\("agents\.inherited"\)/);
  assert.doesNotMatch(sidebarRow, /t\("agents\.inherit"\)|Parent default/);
  assert.equal((sidebarRow.match(/className=\{`agents-profile-metadata\$\{profile\.enabled \? "" : " is-muted"\}`\}/g) ?? []).length, 1);
  assert.match(cssSource, /\.agents-profile-metadata\.is-muted \{[\s\S]*?opacity: 0\.7;/);
});

test("offers a persisted built-in sub-agent switch with explicit session reload", () => {
  assert.match(source, /fetch\("\/api\/subagents\/settings"/);
  assert.match(source, /JSON\.stringify\(\{ enabled, scope: settingsEditScope \}\)/);
  assert.match(source, /<ConfigSwitch[\s\S]*?checked=\{builtInEnabled\}[\s\S]*?t\("agents\.builtInTitle"\)/);
  assert.match(source, /sendAgentCommand\(sessionId, \{ type: "reload" \}\)/);
  assert.match(source, /reloadNeeded && sessionId/);
  assert.match(source, /className="agents-concurrency-control"[\s\S]*?t\("agents\.maxConcurrent"\)/);
  assert.equal((source.match(/className="agents-feature-setting"/g) ?? []).length, 1);
  assert.match(cssSource, /\.agents-feature-setting \{[\s\S]*?border-bottom: 1px solid var\(--border\)/);
  assert.match(cssSource, /\.agents-concurrency-control \{[\s\S]*?white-space: nowrap;/);
});

test("marks profiles shadowed by a higher-precedence source", () => {
  assert.match(source, /isSubagentProfileOverridden\(profile, profiles\)/);
  assert.match(source, /overridden && <span className="agents-overridden-label">\{t\("agents\.overridden"\)\}<\/span>/);
  assert.match(cssSource, /\.agents-overridden-label \{[\s\S]*?white-space: nowrap;/);
});

test("treats roster, global and project profiles as directly editable", () => {
  assert.match(source, /scope === "global" \|\| scope === "project" \|\| scope === "roster"/);
  assert.match(source, /setMode\(isWritableScope\(profile\.scope\) \? "edit" : "view"\)/);
  assert.match(source, /selected && isWritableScope\(selected\.scope\) && mode === "edit"/);
});

test("offers a roster creation scope only when a shared catalog is configured", () => {
  assert.match(source, /\{creating && \(/);
  assert.match(source, /\[\.\.\.\(rosterAvailable \? \["roster" as const\] : \[\]\), \.\.\.\(projectSelected \? \["project" as const\] : \[\]\), "global"\] as const/);
  assert.doesNotMatch(source, /beginOverride|mode === "override"|agents\.readOnly|agents\.override/);
});

test("uses the shared sidebar action for new profiles", () => {
  assert.match(source, /<ConfigListAction[\s\S]*?active=\{creating\}[\s\S]*?onClick=\{beginCreate\}/);
  assert.match(source, /t\("agents\.new"\)[\s\S]*?<\/ConfigListAction>/);
});

test("sends the selected scope for saves and the source scope for deletes", () => {
  assert.match(source, /JSON\.stringify\(\{ cwd, scope: targetScope, profile: draft \}\)/);
  assert.match(source, /JSON\.stringify\(\{ cwd, scope: selected\.scope, name: selected\.name \}\)/);
});

test("shows a Skills-style path row with the same switch in editable and readonly modes", () => {
  assert.match(source, /function displayProfilePath\(profile: SubagentProfile, cwd: string\)/);
  assert.match(source, /profile\.scope === "project" \|\| profile\.scope === "workspace"/);
  assert.match(source, /`~\/\.pi\/agent\/agents\/\$\{draft\.name \|\| "\.\.\."\}\.md`/);
  assert.match(source, /<ConfigSwitch checked=\{draft\.enabled\} disabled=\{switchDisabled\}/);
  assert.doesNotMatch(source, /agents-readonly-status/);
  assert.doesNotMatch(source, /<Toggle label=\{t\("agents\.enabled"\)\}/);
});

test("keeps the enabled switch live for built-ins whose fields stay read-only", () => {
  assert.match(source, /function isTogglableScope\(scope: SubagentScope\): boolean \{\s*return isWritableScope\(scope\) \|\| scope === "builtin";/);
  assert.match(source, /const switchDisabled = creating\s*\? disabled\s*: !selected \|\| Boolean\(selected\.configurationError\) \|\| !isTogglableScope\(selected\.scope\)[\s\S]*?\|\| saving \|\| toggling;/);
  assert.match(source, /if \(!selected \|\| selected\.configurationError \|\| !isTogglableScope\(selected\.scope\)\) return;/);
  // Everything else on a built-in stays read-only: only the switch has somewhere to write.
  assert.match(source, /setMode\(isWritableScope\(profile\.scope\) \? "edit" : "view"\)/);
});

test("shows invalid profile policy with repair instructions", () => {
  assert.match(source, /selected\?\.configurationError && !creating && \([\s\S]*?<div role="alert"[\s\S]*?selected\.configurationError[\s\S]*?agents\.configurationErrorHelp/);
});

test("persists existing profile toggles immediately without submitting unsaved fields", () => {
  assert.match(source, /const toggleEnabled = async \(enabled: boolean\)/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /JSON\.stringify\(\{ cwd, scope: selected\.scope, name: selected\.name, enabled \}\)/);
  assert.match(source, /setDraft\(\(current\) => \(\{ \.\.\.current, enabled: saved\.enabled \}\)\)/);
  assert.doesNotMatch(source, /method: "PATCH"[\s\S]*?profile: draft/);
});

test("reuses the ChatInput model selector with scoped models", () => {
  assert.match(source, /fetch\(`\/api\/models\?cwd=\$\{encodeURIComponent\(cwd\)\}`/);
  assert.match(source, /import \{ ModelSelector \} from "\.\/ModelSelector"/);
  assert.match(chatInputSource, /import \{ ModelSelector, type ModelSelectorOption \} from "\.\/ModelSelector"/);
  assert.match(source, /<ModelSelector[\s\S]*?options=\{modelSelectorOptions\}[\s\S]*?variant="field"/);
  assert.match(chatInputSource, /<ModelSelector[\s\S]*?options=\{modelOptions\}/);
  assert.match(modelSelectorSource, /filterModelOptions\(sortedOptions, filter\)/);
  assert.match(modelSelectorSource, /modelsByProvider\.map/);
  assert.match(modelSelectorSource, /event\.key !== "Escape" \|\| !open[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(source, /agents\.modelUnavailable/);
  assert.doesNotMatch(source, /placeholder="provider\/modelId"/);
});

test("renders the stable agent id as text outside create mode", () => {
  assert.match(source, /creating \? \(\s*<input aria-label=\{t\("agents\.name"\)\}/);
  assert.match(source, /<code style=\{\{ minHeight: 34,[\s\S]*?\{draft\.name\}[\s\S]*?<\/code>/);
  assert.doesNotMatch(source, /disabled=\{disabled \|\| !creating\}/);
});

test("uses the same form controls for editable and readonly profiles", () => {
  assert.match(source, /<input aria-label=\{t\("agents\.displayName"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<input aria-label=\{t\("agents\.description"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<textarea className="agents-system-prompt"[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<Toggle key=\{tool\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<select aria-label=\{t\("agents\.thinking"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<input aria-label=\{t\("agents\.maxTurns"\)[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<Toggle label=\{t\("agents\.inheritContext"\)\} disabled=\{disabled\}/);
  assert.match(source, /<Toggle label=\{t\("agents\.background"\)\} disabled=\{disabled\}/);
  assert.match(source, /<Toggle label=\{t\("agents\.loadSkills"\)\} disabled=\{disabled\}/);
  assert.match(source, /<Toggle label=\{t\("agents\.loadExtensions"\)\} disabled=\{disabled\}/);
  assert.doesNotMatch(source, /ReadonlyValue|readonlyPromptStyle|agents-readonly/);
});

test("shows disabled controls with a gray background", () => {
  const disabledStyle = source.match(/const disabledInputStyle: CSSProperties = \{([\s\S]*?)\n\};/)?.[1] ?? "";
  assert.match(source, /<textarea[^>]*aria-label=\{t\("agents\.prompt"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /height: 195,[\s\S]*?minHeight: 195,[\s\S]*?maxHeight: "60vh"[\s\S]*?resize: disabled \? "none" : "vertical"/);
  assert.doesNotMatch(source, /agents-system-prompt[^\n]*fontFamily/);
  assert.match(disabledStyle, /background: "var\(--bg-panel\)"/);
  assert.match(disabledStyle, /color: "var\(--text-dim\)"/);
  assert.match(modelSelectorSource, /background: locked \? "var\(--bg-panel\)" : "var\(--bg\)"/);
});

test("keeps a larger resize corner when system instructions need a scrollbar", () => {
  assert.match(source, /<textarea className="agents-system-prompt" aria-label=\{t\("agents\.prompt"\)\}/);
  assert.match(cssSource, /.agents-system-prompt \{[\s\S]*?scrollbar-width: auto;/);
  assert.match(cssSource, /\.agents-system-prompt::-webkit-scrollbar \{[\s\S]*?width: 14px;[\s\S]*?height: 14px;/);
  assert.match(cssSource, /\.agents-system-prompt::-webkit-scrollbar-thumb \{[\s\S]*?border: 5px solid transparent;/);
});

test("duplicates any selected profile through the existing create flow", () => {
  assert.match(source, /function duplicateProfileName\(name: string, profiles: readonly SubagentProfile\[\]\)/);
  assert.match(source, /while \(existing\.has\(candidate\.toLowerCase\(\)\)\) candidate = `\$\{base\}-\$\{suffix\+\+\}`/);
  assert.match(source, /const beginDuplicate = \(\) =>/);
  assert.match(source, /\.\.\.editableProfile\(selected\),[\s\S]*?name,[\s\S]*?displayName: t\("agents\.copyName"/);
  assert.match(source, /setMode\("create"\)/);
  assert.match(source, /setTargetScope\(isWritableScope\(selected\.scope\) && \(selected\.scope !== "project" \|\| projectSelected\)/);
  assert.match(source, /\? selected\.scope : rosterAvailable \? "roster" : projectSelected \? "project" : "global"\)/);
  assert.match(source, /onClick=\{beginDuplicate\}[^>]*>[\s\S]*?t\("agents\.duplicate"\)/);
});

test("places duplicate and delete immediately before the enabled switch", () => {
  assert.match(source, /onClick=\{beginDuplicate\}[\s\S]*?onClick=\{\(\) => void remove\(\)\}[\s\S]*?<ConfigSwitch checked=\{draft\.enabled\}/);
});

test("confirms deletion and limits it to writable profiles", () => {
  assert.match(source, /window\.confirm\(t\("agents\.deleteConfirm", \{ name: selected\.displayName \}\)\)/);
  assert.match(source, /selected && isWritableScope\(selected\.scope\) && mode === "edit"/);
  assert.match(source, /method: "DELETE"/);
});
