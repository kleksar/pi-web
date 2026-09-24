import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { POST } = await createJiti(import.meta.url, {
  alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false,
}).import("./route.ts");

test("the default workspace is a real directory and cannot be redirected by a symlink", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "pi-web-default-cwd-"));
  const previousHome = process.env.HOME;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(base, { recursive: true, force: true });
  });
  const home = join(base, "home");
  const external = join(base, "external");
  await mkdir(home);
  await mkdir(external);
  process.env.HOME = home;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const expected = join(home, `pi-cwd-${date}`);
  await symlink(external, expected, "dir");

  const denied = await POST();
  assert.equal(denied.status, 500);
  assert.match((await denied.json()).error, /real directory/);
  assert.equal((await lstat(expected)).isSymbolicLink(), true);
  await rm(expected);

  const created = await POST();
  assert.equal(created.status, 200);
  assert.equal((await created.json()).cwd, expected);
  assert.equal((await lstat(expected)).isDirectory(), true);
});
