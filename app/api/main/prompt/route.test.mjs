import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fixture = await mkdtemp(join(tmpdir(), "pi-web-main-prompt-"));
const agentDir = join(fixture, "agent");
await mkdir(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { GET, PUT } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
const { trustProject } = await jiti.import("../../../../lib/project-trust.ts");
const { projectTrustReloadOptions } = await jiti.import("../../../../lib/project-trust.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(fixture, { recursive: true, force: true });
});

async function cwd(t) {
  const location = await mkdtemp(join(fixture, "project-"));
  allowFileRoot(location);
  t.after(() => rm(location, { recursive: true, force: true }));
  return location;
}

async function readState(location) {
  const response = await GET(new Request(`http://localhost/api/main/prompt?cwd=${encodeURIComponent(location)}`));
  return { response, state: await response.json() };
}

async function save(location, scope, content, revision) {
  return PUT(new Request("http://localhost/api/main/prompt", {
    method: "PUT",
    headers: { Host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: location, scope, content, revision }),
  }));
}

test("global and trusted project prompts follow SDK discovery and preserve both files", async (t) => {
  const location = await cwd(t);
  let { response, state } = await readState(location);
  assert.equal(response.status, 200);
  assert.equal(state.effectiveScope, null);
  assert.equal(state.global.revision, "absent");
  assert.equal(state.project.revision, "absent");

  response = await save(location, "global", "Main coordinator\n", state.global.revision);
  assert.equal(response.status, 200);
  state = await response.json();
  assert.equal(state.effectiveScope, "global");
  assert.equal(state.global.content, "Main coordinator\n");
  const loader = new DefaultResourceLoader({
    cwd: location, agentDir,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload(projectTrustReloadOptions(location, agentDir));
  assert.deepEqual(loader.getAppendSystemPrompt(), [state.global.content]);

  response = await save(location, "project", "Project coordinator\n", state.project.revision);
  assert.equal(response.status, 200);
  state = await response.json();
  assert.equal(state.effectiveScope, "global", "new project resources require explicit trust");
  assert.equal(state.projectTrusted, false);
  assert.equal(state.global.content, "Main coordinator\n");
  await loader.reload(projectTrustReloadOptions(location, agentDir));
  assert.equal(loader.getAppendSystemPromptSources()[0].path, state.global.path);
  assert.equal(await readFile(join(location, ".pi", "APPEND_SYSTEM.md"), "utf8"), "Project coordinator\n");

  trustProject(location, agentDir);
  ({ state } = await readState(location));
  assert.equal(state.effectiveScope, "project");
  assert.equal(state.project.effective, true);
  assert.equal(state.global.effective, false);
  await loader.reload(projectTrustReloadOptions(location, agentDir));
  assert.deepEqual(loader.getAppendSystemPrompt(), [state.project.content]);
  assert.equal(loader.getAppendSystemPromptSources()[0].path, state.project.path);

  response = await save(location, "project", "", state.project.revision);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).effectiveScope, "project", "empty project file still shadows global");
});

test("stale revisions cannot overwrite disk changes or race each other", async (t) => {
  const location = await cwd(t);
  const { state } = await readState(location);
  const first = await save(location, "global", "first", state.global.revision);
  assert.equal(first.status, 200);
  const stale = await save(location, "global", "stale", state.global.revision);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "conflict");
  assert.equal(await readFile(join(agentDir, "APPEND_SYSTEM.md"), "utf8"), "first");

  const current = (await readState(location)).state;
  const results = await Promise.all([
    save(location, "global", "second", current.global.revision),
    save(location, "global", "third", current.global.revision),
  ]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
  assert.ok(["second", "third"].includes(await readFile(join(agentDir, "APPEND_SYSTEM.md"), "utf8")));
});

test("project prompt cannot read or write through a symlink outside cwd", async (t) => {
  const location = await cwd(t);
  const external = await mkdtemp(join(fixture, "external-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(join(external, "APPEND_SYSTEM.md"), "outside");
  await symlink(external, join(location, ".pi"), "dir");

  let response = await GET(new Request(`http://localhost/api/main/prompt?cwd=${encodeURIComponent(location)}`));
  assert.equal(response.status, 403);
  response = await save(location, "project", "attack", "absent");
  assert.equal(response.status, 403);
  assert.equal(await readFile(join(external, "APPEND_SYSTEM.md"), "utf8"), "outside");
});

test("linked APPEND_SYSTEM.md cannot be silently replaced, and cwd is checked", async (t) => {
  const location = await cwd(t);
  const target = join(fixture, "linked-prompt.md");
  await writeFile(target, "original");
  await mkdir(join(location, ".pi"));
  await symlink(target, join(location, ".pi", "APPEND_SYSTEM.md"));
  let response = await save(location, "project", "edited", "absent");
  assert.equal(response.status, 403);
  assert.equal(await readFile(target, "utf8"), "original");

  const denied = await mkdtemp(join(tmpdir(), "pi-web-prompt-denied-"));
  t.after(() => rm(denied, { recursive: true, force: true }));
  response = await GET(new Request(`http://localhost/api/main/prompt?cwd=${encodeURIComponent(denied)}`));
  assert.equal(response.status, 403);
});

test("prompt writes enforce same origin and JSON", async (t) => {
  const location = await cwd(t);
  const crossOrigin = await PUT(new Request("http://localhost/api/main/prompt", {
    method: "PUT",
    headers: {
      Host: "localhost",
      Origin: "https://attacker.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ cwd: location, scope: "project", content: "malicious", revision: "absent" }),
  }));
  assert.equal(crossOrigin.status, 403);
  const formRequest = await PUT(new Request("http://localhost/api/main/prompt", {
    method: "PUT",
    headers: { Host: "localhost", "Content-Type": "text/plain" },
    body: JSON.stringify({ cwd: location, scope: "project", content: "malicious", revision: "absent" }),
  }));
  assert.equal(formRequest.status, 415);
});

test("repository Main prompt is editable through UI with revision checks and yields to local and trusted project files", async (t) => {
  const location = await cwd(t);
  const roster = join(fixture, "roster-main-prompt");
  await mkdir(join(roster, "agents"), { recursive: true });
  await mkdir(join(roster, "skills"));
  const repositoryPrompt = join(roster, "APPEND_SYSTEM.md");
  await writeFile(repositoryPrompt, "Versioned coordinator");
  const previousRoster = process.env.PI_WEB_ROSTER_ROOT;
  process.env.PI_WEB_ROSTER_ROOT = roster;
  const globalPrompt = join(agentDir, "APPEND_SYSTEM.md");
  let previousGlobal = null;
  try { previousGlobal = await readFile(globalPrompt); } catch { /* The global experiment can be absent. */ }
  await rm(globalPrompt, { force: true });
  t.after(async () => {
    if (previousRoster === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = previousRoster;
    if (previousGlobal !== null) await writeFile(globalPrompt, previousGlobal);
    else await rm(globalPrompt, { force: true });
    await rm(roster, { recursive: true, force: true });
  });

  let { state } = await readState(location);
  assert.equal(state.effectiveScope, "roster");
  assert.equal(state.roster.path, repositoryPrompt);
  assert.equal(state.roster.content, "Versioned coordinator");
  const firstRevision = state.roster.revision;
  let response = await save(location, "roster", "Reviewed coordinator", firstRevision);
  assert.equal(response.status, 200);
  state = await response.json();
  assert.equal(state.effectiveScope, "roster");
  assert.equal(await readFile(repositoryPrompt, "utf8"), "Reviewed coordinator");
  response = await save(location, "roster", "Stale", firstRevision);
  assert.equal(response.status, 409);
  assert.equal(await readFile(repositoryPrompt, "utf8"), "Reviewed coordinator");
  const simultaneous = await Promise.all([
    save(location, "roster", "Concurrent A", state.roster.revision),
    save(location, "roster", "Concurrent B", state.roster.revision),
  ]);
  assert.deepEqual(simultaneous.map((item) => item.status).sort(), [200, 409]);
  state = (await readState(location)).state;

  const { repositoryMainPromptFallback } = await jiti.import("../../../../lib/main-prompt.ts");
  const loader = new DefaultResourceLoader({
    cwd: location, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
    appendSystemPromptOverride: (base) => base.length ? base : repositoryMainPromptFallback(location, agentDir),
  });
  await loader.reload(projectTrustReloadOptions(location, agentDir));
  assert.deepEqual(loader.getAppendSystemPrompt(), [state.roster.content]);

  response = await save(location, "global", "Local experiment", state.global.revision);
  state = await response.json();
  assert.equal(state.effectiveScope, "global");
  await loader.reload(projectTrustReloadOptions(location, agentDir));
  assert.deepEqual(loader.getAppendSystemPrompt(), ["Local experiment"]);

  response = await save(location, "project", "", state.project.revision);
  state = await response.json();
  assert.equal(state.effectiveScope, "global", "untrusted project prompt remains inactive");
  trustProject(location, agentDir);
  ({ state } = await readState(location));
  assert.equal(state.effectiveScope, "project");
  await loader.reload(projectTrustReloadOptions(location, agentDir));
  assert.deepEqual(loader.getAppendSystemPrompt(), [""], "an empty trusted project prompt shadows both fallbacks");

  const outside = join(fixture, "repo-prompt-outside.md");
  await writeFile(outside, "untouched");
  await rm(repositoryPrompt);
  await symlink(outside, repositoryPrompt);
  response = await save(location, "roster", "attack", "absent");
  assert.equal(response.status, 403);
  assert.equal(await readFile(outside, "utf8"), "untouched");
});
