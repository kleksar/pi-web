import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const checkout = mkdtempSync(join(tmpdir(), "pi-web-main-route-"));
const roster = join(checkout, "orchestration");
mkdirSync(join(checkout, ".git"));
mkdirSync(join(roster, "agents"), { recursive: true });
const originalRoster = process.env.PI_WEB_ROSTER_ROOT;
process.env.PI_WEB_ROSTER_ROOT = roster;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, PUT } = await jiti.import("./route.ts");

test("Main editor persists changes inside the Git checkout and rejects stale revisions", async (t) => {
  t.after(() => {
    if (originalRoster === undefined) delete process.env.PI_WEB_ROSTER_ROOT;
    else process.env.PI_WEB_ROSTER_ROOT = originalRoster;
    rmSync(checkout, { recursive: true, force: true });
  });

  const initial = await (await GET()).json();
  assert.equal(initial.path, join(roster, "main-dispatcher.json"));
  const config = { ...initial.config, additionalInstructions: "Report blockers without guessing." };
  const request = (revision) => new Request("http://localhost/api/main/config", {
    method: "PUT",
    headers: { Host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ config, expectedRevision: revision }),
  });
  const savedResponse = await PUT(request(initial.revision));
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(JSON.parse(readFileSync(saved.path, "utf8")).config.additionalInstructions, config.additionalInstructions);
  const stale = await PUT(request(initial.revision));
  assert.equal(stale.status, 409);
  assert.deepEqual((await GET()).status, 200);

  const untrusted = await PUT(new Request("http://localhost/api/main/config", {
    method: "PUT", headers: { Host: "untrusted.example", "Content-Type": "application/json" },
    body: JSON.stringify({ config, expectedRevision: saved.revision }),
  }));
  assert.equal(untrusted.status, 403);
  const wrongType = await PUT(new Request("http://localhost/api/main/config", {
    method: "PUT", headers: { Host: "localhost", "Content-Type": "text/plain" }, body: "{}",
  }));
  assert.equal(wrongType.status, 415);
});
