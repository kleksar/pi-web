import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function request(body, contentType = "application/json") {
  return new Request("http://localhost/api/subagents/settings", {
    method: "PUT",
    headers: { "Content-Type": contentType, Host: "localhost" },
    body: JSON.stringify(body),
  });
}

test("settings route defaults off and persists both switch states", async () => {
  let response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false, maxConcurrent: 10,
    sources: { builtInEnabled: "default", disabledBuiltIns: "default", maxConcurrent: "default" },
    defaultEditScope: "local" });

  response = await PUT(request({ enabled: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true, maxConcurrent: 10,
    sources: { builtInEnabled: "local", disabledBuiltIns: "default", maxConcurrent: "default" },
    defaultEditScope: "local", savedScope: "local" });
  assert.deepEqual(
    JSON.parse(await readFile(join(testAgentDir, "agents", "settings.json"), "utf8")),
    { version: 1, builtInEnabled: true },
  );

  response = await PUT(request({ enabled: false }));
  assert.deepEqual(await response.json(), { enabled: false, maxConcurrent: 10,
    sources: { builtInEnabled: "local", disabledBuiltIns: "default", maxConcurrent: "default" },
    defaultEditScope: "local", savedScope: "local" });
});

test("settings route validates mutations", async () => {
  let response = await PUT(request({ enabled: "yes" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "enabled must be a boolean" });

  response = await PUT(request({ enabled: true }, "text/plain"));
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "Content-Type must be application/json" });
});

test("settings route validates and persists concurrency", async () => {
  let response = await PUT(request({ maxConcurrent: 2 }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false, maxConcurrent: 2,
    sources: { builtInEnabled: "local", disabledBuiltIns: "default", maxConcurrent: "local" },
    defaultEditScope: "local", savedScope: "local" });
  response = await PUT(request({ maxConcurrent: 0 }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /between 1 and 32/);
});

test("repository settings stay effective without local file; UI saves repo by default and reports local experiments", async (t) => {
  const roster = join(testAgentDir, "orchestration");
  await mkdir(join(roster, "agents"), { recursive: true });
  await mkdir(join(roster, "skills"));
  const repoPath = join(roster, "subagent-settings.json");
  await writeFile(repoPath, JSON.stringify({ version: 1, builtInEnabled: true, maxConcurrent: 8 }));
  const previousRoster = process.env.PI_WEB_ROSTER_ROOT;
  process.env.PI_WEB_ROSTER_ROOT = roster;
  const localPath = join(testAgentDir, "agents", "settings.json");
  await rm(localPath, { force: true });
  t.after(() => {
    if (previousRoster === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previousRoster;
  });

  let response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true, maxConcurrent: 8,
    sources: { builtInEnabled: "roster", disabledBuiltIns: "default", maxConcurrent: "roster" },
    defaultEditScope: "roster" });
  response = await PUT(request({ maxConcurrent: 6 }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).savedScope, "roster");
  assert.equal(JSON.parse(await readFile(repoPath, "utf8")).maxConcurrent, 6);
  assert.equal(await readFile(localPath, "utf8").then(() => true).catch(() => false), false);

  response = await PUT(request({ scope: "local", enabled: false }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false, maxConcurrent: 6,
    sources: { builtInEnabled: "local", disabledBuiltIns: "default", maxConcurrent: "roster" },
    defaultEditScope: "roster", savedScope: "local" });
  await rm(localPath);
  assert.equal((await (await GET()).json()).enabled, true);
});
