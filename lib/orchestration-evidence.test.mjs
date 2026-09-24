import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { OrchestrationEvidenceStore } = await createJiti(import.meta.url).import("./orchestration-evidence.ts");

test("captured original bytes survive a source edit and store reopen, scoped to task, snapshot and worktree", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-web-evidence-"));
  const other = await mkdtemp(join(tmpdir(), "pi-web-evidence-other-"));
  try {
    await writeFile(join(base, "source.ts"), "const name = 'é';\r\nconst result = 42;\r\n");
    const storeRoot = join(base, "evidence-store");
    const store = new OrchestrationEvidenceStore(storeRoot);
    const ref = store.captureFile({ taskId: "task-1", worktreeRoot: base, snapshotId: "before-edit", path: "source.ts" });
    const input = { id: ref.id, taskId: "task-1", worktreeRoot: base, snapshotId: "before-edit" };
    assert.equal(store.readExcerpt({ ...input, startLine: 1, endLine: 1 }).text, "const name = 'é';\r\n");
    assert.equal(store.isSourceCurrent(input), true);

    await writeFile(join(base, "source.ts"), "const name = 'changed';\n");
    assert.equal(store.isSourceCurrent(input), false);
    const reopened = new OrchestrationEvidenceStore(storeRoot);
    assert.equal(reopened.readExcerpt({ ...input, startLine: 2, endLine: 2 }).text, "const result = 42;\r\n");
    assert.throws(() => reopened.readExcerpt({ ...input, taskId: "task-2" }), /outside this task/);
    assert.throws(() => reopened.readExcerpt({ ...input, snapshotId: "after-edit" }), /outside this task/);
    assert.throws(() => reopened.readExcerpt({ ...input, worktreeRoot: other }), /outside this task/);

    const newer = reopened.captureFile({ taskId: "task-1", worktreeRoot: base, snapshotId: "after-edit", path: "source.ts" });
    assert.notEqual(newer.sha256, ref.sha256);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("bounded direct range and single-file search expose incomplete results instead of hiding them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-evidence-limits-"));
  try {
    await writeFile(join(root, "source.txt"), "needle one\nneedle two\nneedle three\n");
    const store = new OrchestrationEvidenceStore(join(root, "store"));
    const scope = { taskId: "task", worktreeRoot: root, snapshotId: "revision", path: "source.txt" };
    const excerpt = store.readFileRange({ ...scope, startLine: 1, endLine: 3, maxBytes: 12 });
    assert.equal(excerpt.text, "needle one\n");
    assert.equal(excerpt.truncated, true);
    assert.equal(excerpt.nextLine, 2);
    assert.equal(excerpt.totalLines, 3);
    const matches = store.searchFile({ ...scope, query: "needle", maxMatches: 2 });
    assert.deepEqual(matches.matches, [{ line: 1 }, { line: 2 }]);
    assert.equal(matches.truncated, true);
    assert.equal(store.readExcerpt({
      id: matches.ref.id, taskId: "task", worktreeRoot: root, snapshotId: "revision", startLine: 3, endLine: 3,
    }).text, "needle three\n");
    assert.throws(() => store.readExcerpt({
      id: matches.ref.id, taskId: "task", worktreeRoot: root, startLine: 4, endLine: 4,
    }), /positive inclusive line range/);
    assert.throws(() => store.captureFile({ ...scope, maxSourceBytes: 10 }), /byte limit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evidence rejects escaping symlinks, binary sources and unknown references", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-evidence-root-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-web-evidence-outside-"));
  try {
    const store = new OrchestrationEvidenceStore(join(root, "store"));
    await writeFile(join(outside, "secret.txt"), "outside\n");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    const scope = { taskId: "task", worktreeRoot: root, snapshotId: "r1" };
    assert.throws(() => store.captureFile({ ...scope, path: "link.txt" }), /resolves outside the worktree/);
    assert.throws(() => store.captureFile({ ...scope, path: "../secret.txt" }), /outside the worktree/);
    await writeFile(join(root, "binary.txt"), Buffer.from([0xc3, 0x28]));
    assert.throws(() => store.captureFile({ ...scope, path: "binary.txt" }), /not valid UTF-8/);
    assert.throws(() => store.readExcerpt({ ...scope, id: "../../outside" }), /Invalid evidence reference/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
