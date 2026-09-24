import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  resolveProjectContext,
  formatProjectInstructions,
  hasProjectContextChanged,
  resolveWorktreeRoot,
} = await createJiti(import.meta.url).import("./project-context.ts");

test("project context carries literal root and nested instructions and detects a newly added deeper rule", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-project-context-"));
  try {
    await mkdir(join(root, "src", "api"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Use this project's rules.\n");
    await writeFile(join(root, "src", "AGENTS.md"), "Keep src files typed.\n");
    await writeFile(join(root, "src", "api", "handler.ts"), "export const x = 1;\n");
    await writeFile(join(root, "Knowledge.md"), "Not an implicit instruction.\n");

    const context = resolveProjectContext({
      worktreeRoot: root,
      targetPaths: ["src/api/handler.ts"],
      sourceBindings: { issues: "github" },
    });
    assert.deepEqual(context.instructions.map((item) => item.path), ["AGENTS.md", "src/AGENTS.md"]);
    assert.equal(context.sourceBindings.issues, "github");
    assert.equal(context.inspectedPaths.includes("src/api/AGENTS.md"), true);
    assert.equal(context.inspectedPaths.includes("Knowledge.md"), false);
    assert.match(formatProjectInstructions(context), /Keep src files typed\./);
    assert.equal(hasProjectContextChanged(context), false);

    await writeFile(join(root, "src", "api", "AGENTS.md"), "API changes require an API test.\n");
    assert.equal(hasProjectContextChanged(context), true);
    const updated = resolveProjectContext({ worktreeRoot: root, targetPaths: context.targetPaths, sourceBindings: context.sourceBindings });
    assert.deepEqual(updated.instructions.map((item) => item.path), ["AGENTS.md", "src/AGENTS.md", "src/api/AGENTS.md"]);
    assert.match(formatProjectInstructions(updated), /API changes require an API test\./);
    assert.notEqual(updated.fingerprint, context.fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new directory target preserves its scope; worktrees and paths cannot borrow one another's instructions", async () => {
  const first = await mkdtemp(join(tmpdir(), "pi-web-project-first-"));
  const second = await mkdtemp(join(tmpdir(), "pi-web-project-second-"));
  try {
    await mkdir(join(first, "lib"));
    await writeFile(join(first, "AGENTS.md"), "First worktree.\n");
    await writeFile(join(first, "lib", "AGENTS.md"), "Library rule.\n");
    await writeFile(join(second, "AGENTS.md"), "Second worktree.\n");

    const directory = resolveProjectContext({ worktreeRoot: first, targetPaths: ["lib/new/"] });
    assert.deepEqual(directory.targetPaths, ["lib/new/"]);
    assert.deepEqual(directory.instructions.map((item) => item.path), ["AGENTS.md", "lib/AGENTS.md"]);
    assert.equal(hasProjectContextChanged(directory), false);

    const other = resolveProjectContext({ worktreeRoot: second, targetPaths: ["lib/new/file.ts"] });
    assert.deepEqual(other.instructions.map((item) => item.path), ["AGENTS.md"]);
    assert.match(other.instructions[0].content, /Second worktree/);
    assert.notEqual(other.fingerprint, directory.fingerprint);

    await assert.rejects(
      async () => resolveProjectContext({ worktreeRoot: first, targetPaths: ["../outside.ts"] }),
      /outside its worktree/,
    );
    await symlink(second, join(first, "external"), "dir");
    assert.throws(
      () => resolveProjectContext({ worktreeRoot: first, targetPaths: ["external/file.ts"] }),
      /resolves outside its worktree/,
    );
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("changing an existing instruction invalidates a task while leaving the old literal snapshot intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-project-rule-change-"));
  try {
    await writeFile(join(root, "AGENTS.md"), "v1\n");
    const context = resolveProjectContext({ worktreeRoot: root });
    await writeFile(join(root, "AGENTS.md"), "v2\n");
    assert.equal(hasProjectContextChanged(context), true);
    assert.equal(context.instructions[0].content, "v1\n");
    assert.equal(resolveProjectContext({ worktreeRoot: root }).instructions[0].content, "v2\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an instruction symlink cannot load rules from another worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-project-instruction-root-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-web-project-instruction-other-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(outside, "AGENTS.md"), "Other project secret rule.\n");
    await symlink(join(outside, "AGENTS.md"), join(root, "src", "AGENTS.md"));
    assert.throws(
      () => resolveProjectContext({ worktreeRoot: root, targetPaths: ["src/feature.ts"] }),
      /Project instruction resolves outside its worktree/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("worktree root resolution includes parent instructions for a session in a subdirectory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-project-subdir-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "AGENTS.md"), "Project root instructions.\n");
    assert.equal(resolveWorktreeRoot(join(root, "src")), join(root, "src"), "non-Git project is its cwd");
    execFileSync("git", ["-C", root, "init", "-q"]);
    assert.equal(resolveWorktreeRoot(join(root, "src")), root);
    const context = resolveProjectContext({ worktreeRoot: resolveWorktreeRoot(join(root, "src")), targetPaths: ["src/new.ts"] });
    assert.equal(context.instructions[0].content, "Project root instructions.\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
