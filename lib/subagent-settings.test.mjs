import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  disabledBuiltInSubagents,
  isBuiltInSubagentsEnabled,
  readSubagentSettings,
  writeBuiltInSubagentsEnabled,
  writeDisabledBuiltInSubagent,
  getRepositorySubagentSettingsPath,
  readSubagentSettingsSources,
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

test("repository settings survive deleting local settings and local experiments override only their own fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-repo-settings-"));
  const roster = join(root, "orchestration");
  const agentDir = join(root, "agent-home");
  await mkdir(join(roster, "agents"), { recursive: true });
  await mkdir(join(roster, "skills"));
  await mkdir(agentDir);
  const previousRoster = process.env.PI_WEB_ROSTER_ROOT;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_WEB_ROSTER_ROOT = roster;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousRoster === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previousRoster;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  const repoPath = getRepositorySubagentSettingsPath();
  const localPath = join(agentDir, "agents", "settings.json");
  await writeFile(repoPath, JSON.stringify({ version: 1, builtInEnabled: true, maxConcurrent: 12,
    disabledBuiltIns: ["plan"], futureSetting: "preserved" }));
  assert.equal(isBuiltInSubagentsEnabled(), true);
  assert.equal(readSubagentSettings().maxConcurrent, 12);
  assert.deepEqual(readSubagentSettings().disabledBuiltIns, ["plan"]);
  assert.deepEqual(readSubagentSettingsSources(), {
    builtInEnabled: "roster", maxConcurrent: "roster", disabledBuiltIns: "roster",
  });

  writeSubagentMaxConcurrent(4);
  assert.equal(isBuiltInSubagentsEnabled(), true, "a local concurrency experiment must not disable delegation");
  assert.equal(readSubagentSettings().maxConcurrent, 4);
  assert.equal(readSubagentSettingsSources().maxConcurrent, "local");
  writeDisabledBuiltInSubagent("explore", true, repoPath);
  assert.deepEqual(readSubagentSettings().disabledBuiltIns, ["plan", "explore"]);
  writeBuiltInSubagentsEnabled(false, repoPath);
  assert.equal(isBuiltInSubagentsEnabled(), false);
  assert.equal(JSON.parse(await readFile(repoPath, "utf8")).futureSetting, "preserved");

  await rm(localPath);
  assert.equal(readSubagentSettings().maxConcurrent, 12);
  assert.equal(isBuiltInSubagentsEnabled(), false, "removing a local experiment restores the tracked default");
  writeBuiltInSubagentsEnabled(true, repoPath);
  assert.equal(isBuiltInSubagentsEnabled(), true);
  assert.equal(await readFile(localPath, "utf8").then(() => true).catch(() => false), false);

  await writeFile(repoPath, JSON.stringify({ version: 1, builtInEnabled: "yes" }));
  assert.equal(isBuiltInSubagentsEnabled(), false, "malformed tracked policy fails closed");
  assert.throws(() => readSubagentSettings(), /builtInEnabled/);
  await rm(repoPath);
  const outside = join(root, "outside.json");
  await writeFile(outside, JSON.stringify({ builtInEnabled: true }));
  await symlink(outside, repoPath);
  assert.equal(isBuiltInSubagentsEnabled(), false);
  assert.throws(() => readSubagentSettings(), /regular file/);
});
