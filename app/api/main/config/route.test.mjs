import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousAllowedRoots = globalThis.__piAllowedRootsCache;
const testRoot = await mkdtemp(join(tmpdir(), "pi-web-main-route-"));
const agentDir = join(testRoot, "agent-home");
const cwd = join(testRoot, "project");
await mkdir(agentDir);
await mkdir(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
globalThis.__piAllowedRootsCache = {
  roots: new Set([cwd]),
  expiresAt: Date.now() + 60_000,
};

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");
const { saveSubagentProfile } = await jiti.import("../../../../lib/subagents.ts");
const configPath = join(agentDir, "main-agent-config.json");
const url = `http://localhost/api/main/config?cwd=${encodeURIComponent(cwd)}`;

after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  globalThis.__piAllowedRootsCache = previousAllowedRoots;
  await rm(testRoot, { recursive: true, force: true });
});

function put(config, expectedRevision, headers = {}) {
  return new Request("http://localhost/api/main/config", {
    method: "PUT",
    headers: {
      Host: "localhost",
      Origin: "http://localhost",
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ cwd, config, expectedRevision }),
  });
}

test("GET reads the global Main config for an allowed project; PUT requires same-origin JSON", async () => {
  const initial = await GET(new Request(url));
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { config: {}, revision: "absent" });

  const foreignCwd = await GET(new Request(
    `http://localhost/api/main/config?cwd=${encodeURIComponent(testRoot)}`,
  ));
  assert.equal(foreignCwd.status, 403);

  const crossSite = await PUT(put({ orchestration: { allowedChildren: [] } }, "absent", {
    Origin: "https://other.example",
    "Sec-Fetch-Site": "cross-site",
  }));
  assert.equal(crossSite.status, 403);
  const wrongType = await PUT(put({ orchestration: { allowedChildren: [] } }, "absent", {
    "Content-Type": "text/plain",
  }));
  assert.equal(wrongType.status, 415);
  assert.equal((await GET(new Request(url))).status, 200);
});

test("PUT rejects unknown or disabled children and preserves the winner on stale writes", async () => {
  const profile = {
    name: "reader",
    displayName: "Reader",
    description: "Read files",
    systemPrompt: "Read only.",
    tools: ["read"],
    loadSkills: false,
    loadExtensions: false,
    promptMode: "append",
    inheritContext: false,
    runInBackground: false,
    enabled: true,
  };
  saveSubagentProfile(cwd, "project", profile);

  const invalid = await PUT(put({ orchestration: { allowedChildren: ["missing"] } }, "absent"));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /missing or disabled/);

  const expected = { orchestration: { allowedChildren: ["reader"] } };
  const first = await PUT(put(expected, "absent"));
  assert.equal(first.status, 200);
  const saved = await first.json();
  assert.deepEqual(saved.config, expected);
  assert.match(saved.revision, /^[0-9a-f]{64}$/);
  assert.deepEqual(await (await GET(new Request(url))).json(), saved);

  const stale = await PUT(put({ orchestration: { allowedChildren: [] } }, "absent"));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "conflict");
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).orchestration, expected.orchestration);

  saveSubagentProfile(cwd, "project", { ...profile, enabled: false });
  const disabled = await PUT(put(expected, saved.revision));
  assert.equal(disabled.status, 400);
  assert.match((await disabled.json()).error, /missing or disabled/);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).orchestration, expected.orchestration);
});
