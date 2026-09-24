import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { allowFileRoot, getAllowedFileRoots, isExistingFilePathAllowed } = await createJiti(import.meta.url).import("./file-access.ts");

test("a default workspace symlink cannot become an allowed root through discovery or a cached root", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "pi-web-root-symlink-"));
  const previousHome = process.env.HOME;
  const previousCache = globalThis.__piAllowedRootsCache;
  const previousAdditional = globalThis.__piAdditionalAllowedRoots;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    globalThis.__piAllowedRootsCache = previousCache;
    globalThis.__piAdditionalAllowedRoots = previousAdditional;
    await rm(base, { recursive: true, force: true });
  });
  const home = join(base, "home");
  const outside = join(base, "outside");
  await mkdir(home);
  await mkdir(outside);
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "do not expose");
  const candidate = join(home, "pi-cwd-20260924");
  await symlink(outside, candidate, "dir");
  process.env.HOME = home;
  globalThis.__piAllowedRootsCache = undefined;
  globalThis.__piAdditionalAllowedRoots = new Set();
  let roots = await getAllowedFileRoots();
  assert.equal(roots.has(candidate), false);
  assert.equal(isExistingFilePathAllowed(secret, roots), false);

  await rm(candidate);
  await mkdir(candidate);
  allowFileRoot(candidate);
  roots = await getAllowedFileRoots();
  assert.equal(roots.has(candidate), true);
  assert.equal((await lstat(candidate)).isDirectory(), true);
  await rm(candidate, { recursive: true });
  await symlink(outside, candidate, "dir");
  assert.equal(isExistingFilePathAllowed(secret, roots), false, "cached permission cannot follow a replacement symlink");
});
