import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, appendFileSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { SessionFileCostCache, computeSessionFamilyCost } = await jiti.import("./session-family-cost.ts");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const { GET: getFamilyCost } = await jiti.import("../app/api/sessions/[id]/family-cost/route.ts");

function session(id, relation) {
  return {
    path: `/tmp/${id}.jsonl`, id, cwd: "/tmp", firstMessage: id,
    created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1, ...(relation ? { relation } : {}),
  };
}

function child(id, parentSessionId) {
  return session(id, { kind: "subagent", parentSessionId, profile: "reader", description: id, status: "completed" });
}

function usage(total) {
  return {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
    cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total },
  };
}

function message(id, total) {
  return {
    type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant", content: [{ type: "text", text: id }], provider: "test", model: "test",
      usage: usage(total), timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
    },
  };
}

const jsonLine = (item) => `${JSON.stringify(item)}\n`;

test("totals Main and nested subagents once, but excludes forks and other roots", async () => {
  const main = session("main");
  const analyst = child("analyst", "main");
  const reader = child("reader", "analyst");
  const fork = session("fork", { kind: "fork", originSessionId: "main" });
  const independent = session("independent");
  const prices = new Map([["main", 0.1], ["analyst", 0.2], ["reader", 0.3], ["fork", 1], ["independent", 10]]);
  const calls = [];
  const sessions = [main, analyst, reader, fork, independent, analyst];
  const read = (item) => { calls.push(item.id); return prices.get(item.id); };

  const total = await computeSessionFamilyCost("reader", sessions, read);
  assert.deepEqual(total, { rootSessionId: "main", cost: 0.6000000000000001, sessionCount: 3, complete: true });
  assert.deepEqual(calls, ["main", "analyst", "reader"]);
  assert.deepEqual(await computeSessionFamilyCost("fork", sessions, read), {
    rootSessionId: "fork", cost: 1, sessionCount: 1, complete: true,
  });
});

test("marks missing and non-finite child costs as partial; rejects orphan and unknown sessions", async () => {
  const main = session("main");
  const reader = child("reader", "main");
  const orphan = child("orphan", "missing");
  const sessions = [main, reader, orphan];
  assert.deepEqual(await computeSessionFamilyCost("main", sessions, (item) => item.id === "main" ? 0.4 : null), {
    rootSessionId: "main", cost: 0.4, sessionCount: 2, complete: false,
  });
  assert.deepEqual(await computeSessionFamilyCost("main", sessions, (item) => item.id === "main" ? 0.4 : Number.NaN), {
    rootSessionId: "main", cost: 0.4, sessionCount: 2, complete: false,
  });
  assert.equal(await computeSessionFamilyCost("orphan", sessions, () => 1), null);
  assert.equal(await computeSessionFamilyCost("unknown", sessions, () => 1), null);
});

test("reuses unchanged file cost and refreshes after append, including compaction and standalone usage", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-family-cost-cache-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "session.jsonl");
  writeFileSync(path, jsonLine(message("a", 0.2)));
  let reads = 0;
  const cache = new SessionFileCostCache((filePath) => {
    reads++;
    return readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  });

  assert.equal(cache.get(path), 0.2);
  assert.equal(cache.get(path), 0.2);
  assert.equal(reads, 1);
  appendFileSync(path, jsonLine({ type: "compaction", id: "c", usage: usage(0.3) }));
  appendFileSync(path, jsonLine({ type: "usage", id: "warm", usage: usage(0.4) }));
  assert.ok(Math.abs(cache.get(path) - 0.9) < 1e-9);
  assert.equal(cache.get(path) > 0.89, true);
  assert.equal(reads, 2);
  unlinkSync(path);
  assert.equal(cache.get(path), null);
  writeFileSync(path, jsonLine(message("b", 0.1)));
  assert.equal(cache.get(path), 0.1);
  assert.equal(reads, 3);
});

test("family cost route includes persisted nested sessions and reports partial results when a child disappears", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-family-cost-route-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  const sessionsDir = join(directory, "sessions", "project");
  mkdirSync(sessionsDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = directory;
  invalidateSessionListCache();
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    globalThis.__piSessions = previousRegistry;
    invalidateSessionListCache();
    rmSync(directory, { recursive: true, force: true });
  });

  const stamp = "2026-01-01T00:00:00.000Z";
  const writeSession = (id, total, parentId, withMarker = true) => {
    const path = join(sessionsDir, `${id}.jsonl`);
    const parentSession = parentId ? join(sessionsDir, `${parentId}.jsonl`) : undefined;
    const entries = [
      { type: "session", version: 3, id, cwd: directory, timestamp: stamp, ...(parentSession ? { parentSession } : {}) },
      ...(parentId && withMarker ? [{
        type: "custom", id: `${id}-meta`, parentId: null, timestamp: stamp,
        customType: "pi-web:subagent",
        data: { version: 1, parentSessionId: parentId, parentSessionPath: parentSession, profile: "reader", description: id },
      }] : []),
      message(`${id}-answer`, total),
    ];
    writeFileSync(path, entries.map(jsonLine).join(""));
    return path;
  };
  writeSession("main", 0.1);
  writeSession("coordinator", 0.2, "main");
  const leafPath = writeSession("reader", 0.3, "coordinator");
  writeSession("fork", 1, "main", false);

  const fetchCost = async (id) => {
    const url = `http://localhost/api/sessions/${id}/family-cost`;
    return getFamilyCost(new Request(url), { params: Promise.resolve({ id }) });
  };
  const response = await fetchCost("reader");
  assert.equal(response.status, 200);
  const total = await response.json();
  assert.equal(total.rootSessionId, "main");
  assert.equal(total.sessionCount, 3);
  assert.equal(total.complete, true);
  assert.ok(Math.abs(total.cost - 0.6) < 1e-9);
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  // A running subagent may have billed usage that has not been flushed to disk.
  const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
  globalThis.__piSessions = new Map([["reader", {
    sessionId: "reader", sessionFile: leafPath, cwd: directory,
    isAlive: () => true, isRunning: () => true,
    inner: {
      sessionManager: SessionManager.open(leafPath),
      getSessionStats: () => ({ cost: 0.7 }),
    },
  }]]);
  const running = await (await fetchCost("main")).json();
  assert.equal(running.complete, true);
  assert.equal(running.sessionCount, 3);
  assert.ok(Math.abs(running.cost - 1.0) < 1e-9, "use live subagent spend, not its stale file");
  globalThis.__piSessions = previousRegistry;

  unlinkSync(leafPath);
  const partial = await (await fetchCost("main")).json();
  assert.deepEqual(partial, { rootSessionId: "main", cost: 0.30000000000000004, sessionCount: 3, complete: false });
  assert.equal((await fetchCost("missing")).status, 404);
});

test("family cost route handles 160 nested agents and reuses unchanged JSONL costs", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-family-cost-scale-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const sessionsDir = join(directory, "sessions", "project");
  mkdirSync(sessionsDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = directory;
  invalidateSessionListCache();
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    invalidateSessionListCache();
    rmSync(directory, { recursive: true, force: true });
  });
  const stamp = "2026-01-01T00:00:00.000Z";
  const sessionPath = (id) => join(sessionsDir, `${id}.jsonl`);
  const write = (id, parentSessionId) => {
    const parentSession = parentSessionId ? sessionPath(parentSessionId) : undefined;
    const entries = [
      { type: "session", version: 3, id, cwd: directory, timestamp: stamp, ...(parentSession ? { parentSession } : {}) },
      ...(parentSessionId ? [{
        type: "custom", customType: "pi-web:subagent", id: `${id}-meta`,
        parentId: null, timestamp: stamp,
        data: { version: 1, parentSessionId, parentSessionPath: parentSession, profile: "worker", description: id },
      }] : []),
      message(`${id}-answer`, 0.01),
    ];
    writeFileSync(sessionPath(id), entries.map(jsonLine).join(""));
  };
  write("main");
  for (let index = 0; index < 160; index++) {
    const parentIndex = Math.floor((index - 1) / 3);
    write(`agent-${index}`, parentIndex < 0 ? "main" : `agent-${parentIndex}`);
  }
  const call = async () => getFamilyCost(
    new Request("http://localhost/api/sessions/agent-159/family-cost"),
    { params: Promise.resolve({ id: "agent-159" }) },
  );
  const coldStart = performance.now();
  const coldResponse = await call();
  const coldMs = performance.now() - coldStart;
  assert.equal(coldResponse.status, 200);
  const cold = await coldResponse.json();
  assert.equal(cold.sessionCount, 161);
  assert.equal(cold.complete, true);
  assert.ok(Math.abs(cold.cost - 1.61) < 1e-9);

  const warmStart = performance.now();
  const warmResponse = await call();
  const warmMs = performance.now() - warmStart;
  assert.equal(warmResponse.status, 200);
  assert.deepEqual(await warmResponse.json(), cold);
  t.diagnostic(`161-session family-cost cold ${coldMs.toFixed(1)}ms, warm ${warmMs.toFixed(1)}ms (local fixture)`);
});
