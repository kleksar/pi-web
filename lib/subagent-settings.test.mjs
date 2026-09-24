import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  disabledBuiltInSubagents,
  isBuiltInSubagentsEnabled,
  readSubagentSettings,
  readSubagentSettingsSources,
  getRepositorySubagentSettingsPath,
  writeBuiltInSubagentsEnabled,
  writeDisabledBuiltInSubagent,
  writeSubagentMaxConcurrent,
} = await createJiti(import.meta.url).import("./subagent-settings.ts");

test("subagent settings default the built-in extension to disabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: false, disabledBuiltIns: [] });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.deepEqual([...disabledBuiltInSubagents(settingsPath)], []);
});

test("subagent settings persist both states and preserve unrelated fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: true, disabledBuiltIns: [] });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  const first = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(first, { version: 1, builtInEnabled: true });

  await writeFile(settingsPath, JSON.stringify({ ...first, futureSetting: 3 }));
  writeBuiltInSubagentsEnabled(false, settingsPath);
  const second = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(second, { version: 1, builtInEnabled: false, futureSetting: 3 });
});

test("disabling a built-in is a minimal edit of the stored name list", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  writeBuiltInSubagentsEnabled(true, settingsPath);
  writeDisabledBuiltInSubagent("explore", true, settingsPath);
  assert.deepEqual([...disabledBuiltInSubagents(settingsPath)], ["explore"]);
  // The feature switch and any unknown field survive the write.
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1,
    builtInEnabled: true,
    disabledBuiltIns: ["explore"],
  });

  writeDisabledBuiltInSubagent("plan", true, settingsPath);
  writeDisabledBuiltInSubagent("explore", true, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, ["explore", "plan"]);

  // A name is matched case-insensitively, and re-enabling one leaves the other.
  writeDisabledBuiltInSubagent("EXPLORE", false, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, ["plan"]);
  writeDisabledBuiltInSubagent("plan", false, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, []);
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);

  assert.throws(() => writeDisabledBuiltInSubagent("  ", true, settingsPath));
});

test("a name no built-in claims is kept, and a damaged list is ignored", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({
    version: 1,
    disabledBuiltIns: ["from-a-newer-build", 7, " explore ", "Explore", ""],
    futureSetting: 3,
  }));
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, ["from-a-newer-build", "explore"]);

  writeDisabledBuiltInSubagent("explore", false, settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    version: 1,
    disabledBuiltIns: ["from-a-newer-build"],
    futureSetting: 3,
  });

  // A switch that changes nothing does not rewrite the file at all.
  const untouched = JSON.stringify({ disabledBuiltIns: ["from-a-newer-build"] });
  await writeFile(settingsPath, untouched);
  writeDisabledBuiltInSubagent("plan", false, settingsPath);
  writeDisabledBuiltInSubagent("From-A-Newer-Build", true, settingsPath);
  assert.equal(await readFile(settingsPath, "utf8"), untouched);

  await writeFile(settingsPath, JSON.stringify({ version: 1, disabledBuiltIns: "explore" }));
  assert.deepEqual(readSubagentSettings(settingsPath).disabledBuiltIns, []);
});

test("damaged settings fail closed and are not overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, "{");

  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.throws(() => readSubagentSettings(settingsPath));
  assert.throws(() => writeBuiltInSubagentsEnabled(true, settingsPath));
  assert.throws(() => writeDisabledBuiltInSubagent("explore", true, settingsPath));
  // Fails open: an unreadable file must not hide the built-in profiles.
  assert.deepEqual([...disabledBuiltInSubagents(settingsPath)], []);
  assert.equal(await readFile(settingsPath, "utf8"), "{");
});

test("repository settings are Git-visible; existing local overrides remain effective until removed", async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), "pi-web-settings-roster-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-settings-local-"));
  const previousRoster = process.env.PI_WEB_ROSTER_ROOT;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => {
    if (previousRoster === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previousRoster;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await Promise.all([checkout, agentDir].map((path) => rm(path, { recursive: true, force: true })));
  });
  const roster = join(checkout, "orchestration");
  await mkdir(join(roster, "agents"), { recursive: true });
  await writeFile(join(roster, "subagent-settings.json"),
    JSON.stringify({ version: 1, builtInEnabled: true, maxConcurrent: 5, disabledBuiltIns: [] }));
  execFileSync("git", ["init", "-q", checkout]);
  execFileSync("git", ["-C", checkout, "add", "orchestration/subagent-settings.json"]);
  execFileSync("git", ["-C", checkout, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"]);
  process.env.PI_WEB_ROSTER_ROOT = roster;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const repoPath = getRepositorySubagentSettingsPath();
  assert.equal(repoPath, join(roster, "subagent-settings.json"));
  assert.equal(readSubagentSettings().builtInEnabled, true);
  assert.equal(readSubagentSettings().maxConcurrent, 5);
  assert.deepEqual(readSubagentSettingsSources(), {
    builtInEnabled: "roster", maxConcurrent: "roster", disabledBuiltIns: "roster",
  });

  const localPath = join(agentDir, "agents", "settings.json");
  await mkdir(join(agentDir, "agents"), { recursive: true });
  await writeFile(localPath, JSON.stringify({ version: 1, builtInEnabled: false, maxConcurrent: 2 }));
  writeBuiltInSubagentsEnabled(true, repoPath);
  writeSubagentMaxConcurrent(6, repoPath);
  writeDisabledBuiltInSubagent("explore", true, repoPath);
  assert.equal(readSubagentSettings().builtInEnabled, false);
  assert.equal(readSubagentSettings().maxConcurrent, 2);
  assert.deepEqual(readSubagentSettingsSources(), {
    builtInEnabled: "local", maxConcurrent: "local", disabledBuiltIns: "roster",
  });
  assert.deepEqual([...disabledBuiltInSubagents()], ["explore"]);
  assert.match(execFileSync("git", ["-C", checkout, "status", "--short"], { encoding: "utf8" }),
    / M orchestration\/subagent-settings\.json/);

  await rm(localPath);
  assert.equal(readSubagentSettings().builtInEnabled, true);
  assert.equal(readSubagentSettings().maxConcurrent, 6);
});
