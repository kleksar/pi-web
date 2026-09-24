import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";
import {
  collectChangesWhileLocked,
  disposeChangeSnapshotArtifacts,
  verifyChangeSnapshot,
  withOrchestrationWorktreeLock,
  type ChangeSnapshot,
} from "./orchestration-changes";
import { hasProjectContextChanged, resolveProjectContext, resolveWorktreeRoot } from "./project-context";

const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 512 * 1024;
const GIT_APPLY_TIMEOUT_MS = 30_000;

export interface BoundedPatchRequest {
  cwd: string;
  patch: string;
  /** Exact file paths relative to the selected Git worktree root. */
  allowedPaths: readonly string[];
  /** Captured before the writer was dispatched; a live mismatch blocks the mutation. */
  expectedSnapshotId?: string;
  /** Fingerprint of root + nested AGENTS.md for these exact allowedPaths. */
  expectedProjectFingerprint?: string;
}

export interface BoundedPatchResult {
  status: "applied";
  affectedPaths: string[];
  beforeSnapshotId: string;
  afterSnapshotId: string;
  projectFingerprint: string;
}

export class BoundedPatchError extends Error {
  constructor(
    public readonly code: "invalid_patch" | "outside_scope" | "stale_snapshot" | "changed_project_rules" | "apply_failed",
    message: string,
    /** `true` means inspect the worktree before retrying; the apply command may have modified it. */
    public readonly mayHaveApplied = false,
  ) {
    super(message);
    this.name = "BoundedPatchError";
  }
}

function parseGitQuoted(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  if (!raw.endsWith('"') || raw.length < 2) throw new BoundedPatchError("invalid_patch", "Unterminated quoted Git path");
  const bytes: number[] = [];
  const inner = raw.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== "\\") {
      const point = inner.codePointAt(i)!;
      bytes.push(...Buffer.from(String.fromCodePoint(point), "utf8"));
      if (point > 0xffff) i++;
      continue;
    }
    const next = inner[++i];
    if (!next) throw new BoundedPatchError("invalid_patch", "Incomplete Git path escape");
    const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, v: 11, "\\": 92, '"': 34 };
    if (next in escapes) {
      bytes.push(escapes[next]);
    } else if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(inner[i + 1] ?? "")) octal += inner[++i];
      bytes.push(parseInt(octal, 8));
    } else {
      throw new BoundedPatchError("invalid_patch", "Unsupported Git path escape");
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(bytes));
  } catch {
    throw new BoundedPatchError("invalid_patch", "Git path is not valid UTF-8");
  }
}

function parseDiffHeader(header: string): [string, string] {
  const body = header.slice("diff --git ".length);
  let oldName: string;
  let newName: string;
  if (body.startsWith('"')) {
    const first = /^"(?:\\.|[^"\\])*"/.exec(body)?.[0];
    if (!first || body[first.length] !== " ") {
      throw new BoundedPatchError("invalid_patch", "Malformed quoted Git diff header");
    }
    oldName = parseGitQuoted(first);
    newName = parseGitQuoted(body.slice(first.length + 1));
  } else {
    const plain = body.indexOf(" b/");
    const quoted = body.indexOf(' "b/');
    const marker = plain < 0 ? quoted : quoted < 0 ? plain : Math.min(plain, quoted);
    if (marker < 0 || body.indexOf(" b/", marker + 1) !== -1 || body.indexOf(' "b/', marker + 1) !== -1) {
      throw new BoundedPatchError("invalid_patch", "Ambiguous Git diff header paths");
    }
    oldName = body.slice(0, marker);
    newName = parseGitQuoted(body.slice(marker + 1));
  }
  if (!oldName.startsWith("a/") || !newName.startsWith("b/")) {
    throw new BoundedPatchError("invalid_patch", "Expected a/ and b/ Git diff paths");
  }
  return [oldName.slice(2), newName.slice(2)];
}

function normalizedGitPath(gitPath: string): string {
  if (!gitPath || gitPath.includes("\0") || gitPath.includes("\\") || gitPath.startsWith("/")
    || /^(?:[a-zA-Z]:|\\\\)/.test(gitPath)
    || gitPath.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new BoundedPatchError("outside_scope", `Unsafe Git patch path: ${JSON.stringify(gitPath)}`);
  }
  return gitPath;
}

function metadataPath(raw: string, prefix?: "a/" | "b/"): string | null {
  if (raw === "/dev/null") return null;
  const decoded = parseGitQuoted(raw);
  if (prefix) {
    if (!decoded.startsWith(prefix)) throw new BoundedPatchError("invalid_patch", "Diff marker has an unexpected path prefix");
    return normalizedGitPath(decoded.slice(2));
  }
  return normalizedGitPath(decoded);
}

function affectedPatchPaths(patch: string): string[] {
  if (!patch.startsWith("diff --git ")) throw new BoundedPatchError("invalid_patch", "Patch must contain Git diff headers");
  const blocks = patch.split(/(?=^diff --git )/m).filter(Boolean);
  const affected = new Set<string>();
  for (const block of blocks) {
    const lines = block.split("\n");
    if (!lines[0].startsWith("diff --git ")) throw new BoundedPatchError("invalid_patch", "Patch contains content outside Git diff blocks");
    const [oldPath, newPath] = parseDiffHeader(lines[0].replace(/\r$/, ""));
    affected.add(normalizedGitPath(oldPath));
    affected.add(normalizedGitPath(newPath));
    for (const lineRaw of lines.slice(1)) {
      const line = lineRaw.replace(/\r$/, "");
      // Once the hunk or binary body starts, following lines are file contents.
      if (line.startsWith("@@ ") || line === "GIT binary patch" || line.startsWith("Binary files ")) break;
      const mode = /^(?:new file mode|deleted file mode|old mode|new mode) ([0-7]+)$/.exec(line)?.[1];
      if (mode && (parseInt(mode, 8) & 0o170000) !== 0o100000) {
        throw new BoundedPatchError("outside_scope", "Patch may not create or edit symlinks or submodules");
      }
      if (line.startsWith("copy from ") || line.startsWith("copy to ")) {
        throw new BoundedPatchError("outside_scope", "Copy patches require a separately scoped change");
      }
      if (line.startsWith("rename from ")) affected.add(metadataPath(line.slice("rename from ".length))!);
      if (line.startsWith("rename to ")) affected.add(metadataPath(line.slice("rename to ".length))!);
      if (line.startsWith("--- ")) {
        const old = metadataPath(line.slice(4), "a/");
        if (old) affected.add(old);
      }
      if (line.startsWith("+++ ")) {
        const next = metadataPath(line.slice(4), "b/");
        if (next) affected.add(next);
      }
    }
  }
  return [...affected].sort();
}

function rejectSymlinkComponents(root: string, filePath: string): void {
  let component = root;
  for (const part of filePath.split("/")) {
    component = path.join(component, part);
    try {
      if (lstatSync(component).isSymbolicLink()) {
        throw new BoundedPatchError("outside_scope", `Patch path traverses a symlink: ${filePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function gitApply(root: string, args: readonly string[], patch: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, "apply", ...args, "-"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout: Buffer[] = [];
    let stderr: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    const timer = setTimeout(() => child.kill(), GIT_APPLY_TIMEOUT_MS);
    child.stdout.on("data", (part: Buffer) => {
      bytes += part.byteLength;
      if (bytes > MAX_GIT_OUTPUT_BYTES) { exceeded = true; child.kill(); } else stdout.push(part);
    });
    child.stderr.on("data", (part: Buffer) => {
      bytes += part.byteLength;
      if (bytes > MAX_GIT_OUTPUT_BYTES) { exceeded = true; child.kill(); } else stderr.push(part);
    });
    child.stdin.on("error", () => { /* malformed patches can close stdin early; close reports the failure */ });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (exceeded || code !== 0) {
        reject(new Error(exceeded ? "Git apply output exceeded limit" : errorText || `git apply exited ${code}`));
      } else resolve(Buffer.concat(stdout));
      stdout = [];
      stderr = [];
    });
    child.stdin.end(patch);
  });
}

function gitProbe(root: string, args: readonly string[], allowNoMatch = false, input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...args], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let total = 0;
    let exceeded = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, GIT_APPLY_TIMEOUT_MS);
    for (const [stream, chunks] of [[child.stdout, output], [child.stderr, errors]] as const) {
      stream.on("data", (part: Buffer) => {
        total += part.byteLength;
        if (total > MAX_GIT_OUTPUT_BYTES) { exceeded = true; child.kill(); } else chunks.push(part);
      });
    }
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (exceeded || timedOut || (code !== 0 && !(allowNoMatch && code === 1))) {
        reject(new Error(exceeded ? "Git path probe output exceeded limit"
          : timedOut ? "Git path probe timed out"
            : Buffer.concat(errors).toString("utf8").trim() || `git ${args[0]} exited ${code}`));
      } else resolve(Buffer.concat(output));
    });
    child.stdin.on("error", () => { /* early Git failure is reported through close */ });
    child.stdin.end(input);
  });
}

/** Git status intentionally omits ignored paths and index flags; never write through that blind spot. */
async function assertPathsVisibleInSnapshot(root: string, allowedPaths: readonly string[]): Promise<void> {
  const ignored = await gitProbe(
    root, ["check-ignore", "--no-index", "--stdin", "-z"], true,
    Buffer.from(`${allowedPaths.join("\0")}\0`, "utf8"),
  );
  const firstIgnored = ignored.toString("utf8").split("\0").find(Boolean);
  if (firstIgnored) {
    throw new BoundedPatchError("outside_scope", `Patch path is ignored by Git: ${firstIgnored}`);
  }
  const tracked = await gitProbe(root, ["ls-files", "-v", "-z", "--", ...allowedPaths]);
  for (const entry of tracked.toString("utf8").split("\0").filter(Boolean)) {
    if (entry.length < 3 || entry[1] !== " ") {
      throw new BoundedPatchError("invalid_patch", "Unexpected git ls-files output for allowed paths");
    }
    if (entry[0] !== "H") {
      throw new BoundedPatchError("outside_scope", `Patch path has hidden or unsupported Git index flags: ${entry.slice(2)}`);
    }
  }
}

function confirmGitDestinationPaths(statistics: Buffer, affected: Set<string>): void {
  const records = statistics.toString("utf8").split("\0").filter(Boolean);
  if (records.length === 0) throw new BoundedPatchError("invalid_patch", "Git did not recognize a changed file");
  for (const record of records) {
    const tabs = [...record.matchAll(/\t/g)];
    if (tabs.length < 2) throw new BoundedPatchError("invalid_patch", "Malformed Git patch statistics");
    const filePath = normalizedGitPath(record.slice(tabs[1].index! + 1));
    if (!affected.has(filePath)) {
      throw new BoundedPatchError("outside_scope", `Git discovered an unvalidated patch path: ${filePath}`);
    }
  }
}

/** Apply a literal, finished patch. Failed preconditions never reset existing dirty work. */
export async function applyBoundedPatch(request: BoundedPatchRequest): Promise<BoundedPatchResult> {
  if (!request.patch.trim() || Buffer.byteLength(request.patch) > MAX_PATCH_BYTES || request.patch.includes("\0")) {
    throw new BoundedPatchError("invalid_patch", "Patch must be nonempty UTF-8 Git diff text within the 2 MiB limit");
  }
  const root = resolveWorktreeRoot(request.cwd);
  const allowed = new Set(request.allowedPaths.map(normalizedGitPath));
  if (allowed.size === 0) throw new BoundedPatchError("outside_scope", "Bounded patch requires explicit allowedPaths");
  const affectedPaths = affectedPatchPaths(request.patch);
  for (const filePath of affectedPaths) {
    if (!allowed.has(filePath)) throw new BoundedPatchError("outside_scope", `Patch changes an unlisted path: ${filePath}`);
    rejectSymlinkComponents(root, filePath);
  }
  return withOrchestrationWorktreeLock(root, async () => {
    let before: ChangeSnapshot | undefined;
    let after: ChangeSnapshot | undefined;
    try {
      ({ snapshot: before } = await collectChangesWhileLocked(root));
      if (request.expectedSnapshotId !== undefined && before.id !== request.expectedSnapshotId) {
        throw new BoundedPatchError("stale_snapshot", "Worktree changed since the patch was assigned");
      }
      const context = resolveProjectContext({ worktreeRoot: root, targetPaths: [...allowed] });
      if (request.expectedProjectFingerprint !== undefined && context.fingerprint !== request.expectedProjectFingerprint) {
        throw new BoundedPatchError("changed_project_rules", "Applicable project instructions changed since dispatch");
      }
      await verifyChangeSnapshot(before);
      await assertPathsVisibleInSnapshot(root, [...allowed]);
      for (const filePath of affectedPaths) rejectSymlinkComponents(root, filePath);
      try {
        confirmGitDestinationPaths(await gitApply(root, ["--numstat", "-z"], request.patch), new Set(affectedPaths));
        await gitApply(root, ["--check", "--binary"], request.patch);
        await verifyChangeSnapshot(before);
        await assertPathsVisibleInSnapshot(root, [...allowed]);
        if (hasProjectContextChanged(context)) {
          throw new BoundedPatchError("changed_project_rules", "Applicable project instructions changed while checking the patch");
        }
      } catch (error) {
        if (error instanceof BoundedPatchError) throw error;
        throw new BoundedPatchError("invalid_patch", `Git rejected patch before applying: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await gitApply(root, ["--binary"], request.patch);
      } catch (error) {
        throw new BoundedPatchError("apply_failed", `Git apply failed; inspect the worktree before retrying: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      try {
        ({ snapshot: after } = await collectChangesWhileLocked(root));
      } catch (error) {
        throw new BoundedPatchError("apply_failed", `Patch applied but the resulting snapshot could not be collected: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      if (after.id === before.id) {
        throw new BoundedPatchError("apply_failed", "Patch applied but no change is visible in the Git-backed snapshot; inspect the worktree", true);
      }
      return { status: "applied", affectedPaths, beforeSnapshotId: before.id, afterSnapshotId: after.id, projectFingerprint: context.fingerprint };
    } finally {
      await Promise.allSettled([
        ...(before ? [disposeChangeSnapshotArtifacts(before)] : []),
        ...(after ? [disposeChangeSnapshotArtifacts(after)] : []),
      ]);
    }
  });
}
