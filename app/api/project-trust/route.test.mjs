import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("project Main trust requires a same-origin JSON request and an explicit user action", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-main-trust-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent-home");
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldAllowedRoots = globalThis.__piAllowedRootsCache;
  await mkdir(cwd);
  await mkdir(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__piAllowedRootsCache = { roots: new Set([cwd]), expiresAt: Date.now() + 60_000 };
  t.after(async () => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    globalThis.__piAllowedRootsCache = oldAllowedRoots;
    await rm(root, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
  const { POST } = await jiti.import("./route.ts");
  const { isProjectMainConfigTrusted } = await jiti.import("../../../lib/project-trust.ts");
  const request = (headers) => new Request("http://localhost/api/project-trust", {
    method: "POST", headers, body: JSON.stringify({ cwd, purpose: "main-config" }),
  });
  assert.equal((await POST(request({ "Content-Type": "application/json", Origin: "https://other.example",
    "Sec-Fetch-Site": "cross-site" }))).status, 403);
  assert.equal((await POST(request({ Host: "localhost", Origin: "http://localhost",
    "Sec-Fetch-Site": "same-origin", "Content-Type": "text/plain" }))).status, 415);
  assert.equal(isProjectMainConfigTrusted(cwd, agentDir), false);
  assert.equal((await POST(request({ Host: "localhost", Origin: "http://localhost",
    "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }))).status, 200);
  assert.equal(isProjectMainConfigTrusted(cwd, agentDir), true);
});
