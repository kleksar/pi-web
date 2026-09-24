import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, lstatSync, readlinkSync, statSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseGitPorcelainV1 } from "./git-status";

const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_CHANGE_BLOB_BYTES = 4 * 1024 * 1024;

export interface ChangedFile {
  /** Git paths are relative to repositoryRoot and use forward slashes. */
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  /** Includes index mode, object ID and stage; detects changes with identical worktree bytes. */
  indexEntries: string[];
  kind: "file" | "symlink" | "directory" | "special" | "missing";
  bytes: number | null;
  sha256: string | null;
  /** Null means there are no readable regular-file bytes to classify. */
  binary: boolean | null;
  /** Literal bytes at capture time, kept outside the worktree; never infer completeness from a hash alone. */
  contentArtifactPath?: string;
  contentAvailability: "available" | "too_large" | "unsupported" | "not_applicable";
}

export interface ChangeSnapshot {
  id: string;
  repositoryRoot: string;
  cwd: string;
  head: string | null;
  branch: string | null;
  /** SHA-256 of every tracked index path, mode, stage and Git object ID. */
  indexId: string;
  dirty: ChangedFile[];
  /** The caller should dispose these private blobs after the task/review finishes. */
  blobDirectory: string | null;
  /** Binary-safe Git patches against the captured HEAD; untracked paths appear in dirty. */
  stagedPatch: string;
  unstagedPatch: string;
}

export interface ChangeCaptureOptions {
  /** Private task artifact directory; when omitted, transient snapshots use os.tmpdir(). */
  blobRoot?: string;
}

export interface TaskFileChange {
  path: string;
  previousPath?: string;
  before: ChangedFile | null;
  after: ChangedFile | null;
  /** Null means no dirty record: the path may be clean in HEAD or absent entirely. */
  change: "added" | "renamed" | "modified" | "restored" | "removed";
}

export interface ChangeManifest {
  beforeSnapshotId: string | null;
  candidateSnapshotId: string;
  repositoryRoot: string;
  head: string | null;
  /** Pre-existing dirty files remain visible separately from task changes. */
  preexisting: ChangedFile[];
  changed: TaskFileChange[];
  /** Current dirty state includes staged, unstaged, untracked, deletions and renames. */
  candidateDirty: ChangedFile[];
  baselineStagedPatch: string;
  baselineUnstagedPatch: string;
  candidateStagedPatch: string;
  candidateUnstagedPatch: string;
}

export class StaleChangeSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleChangeSnapshotError";
  }
}

async function git(cwd: string, args: readonly string[], allowFailure = false): Promise<Buffer | null> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let total = 0;
    let failed = false;
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_GIT_OUTPUT_BYTES) {
        failed = true;
        child.kill();
      } else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_GIT_OUTPUT_BYTES) {
        failed = true;
        child.kill();
      } else errors.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (failed) reject(new Error(`Git output exceeds ${MAX_GIT_OUTPUT_BYTES} bytes; snapshot is incomplete`));
      else if (code === 0) resolvePromise(Buffer.concat(output));
      else if (allowFailure) resolvePromise(null);
      else reject(new Error(`git ${args[0]} failed: ${Buffer.concat(errors).toString("utf8").trim()}`));
    });
  });
}

function nulPaths(output: Buffer): string[] {
  return output.toString("utf8").split("\0").filter(Boolean);
}

function within(root: string, filePath: string): boolean {
  const rel = relative(root, filePath);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function parseIndex(output: Buffer): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  for (const item of nulPaths(output)) {
    const tab = item.indexOf("\t");
    if (tab < 0) throw new Error("Malformed git ls-files --stage output");
    const path = item.slice(tab + 1);
    const rows = entries.get(path) ?? [];
    rows.push(item.slice(0, tab));
    entries.set(path, rows);
  }
  return entries;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileIdentity(file: ChangedFile): Omit<ChangedFile, "contentArtifactPath"> {
  return {
    path: file.path,
    ...(file.originalPath ? { originalPath: file.originalPath } : {}),
    indexStatus: file.indexStatus,
    worktreeStatus: file.worktreeStatus,
    indexEntries: file.indexEntries,
    kind: file.kind,
    bytes: file.bytes,
    sha256: file.sha256,
    binary: file.binary,
    contentAvailability: file.contentAvailability,
  };
}

type WorkingPath = Pick<ChangedFile, "kind" | "bytes" | "sha256" | "binary"> & {
  contentArtifactPath?: string;
  contentAvailability?: ChangedFile["contentAvailability"];
};

async function saveBlob(directory: string | undefined, contents: Buffer): Promise<Pick<WorkingPath, "contentArtifactPath" | "contentAvailability">> {
  if (!directory) return {};
  const contentArtifactPath = join(directory, randomUUID());
  await writeFile(contentArtifactPath, contents, { flag: "wx", mode: 0o600 });
  return { contentArtifactPath, contentAvailability: "available" };
}

async function hashWorkingPath(root: string, gitPath: string, blobDirectory?: string): Promise<WorkingPath> {
  const filePath = resolve(root, gitPath);
  if (!within(root, filePath)) throw new Error(`Git path outside repository: ${gitPath}`);
  let initial;
  try {
    initial = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing", bytes: null, sha256: null, binary: null, contentAvailability: "not_applicable" };
    }
    throw error;
  }
  if (initial.isSymbolicLink()) {
    const link = readlinkSync(filePath, { encoding: "buffer" });
    return {
      kind: "symlink", bytes: link.byteLength, sha256: sha256(link), binary: false,
      ...await saveBlob(blobDirectory, link),
    };
  }
  if (initial.isDirectory()) {
    // Submodules need their own Git snapshot; the parent's status records that they are dirty.
    const submoduleHead = await git(filePath, ["rev-parse", "--verify", "HEAD"], true);
    return { kind: "directory", bytes: null, sha256: submoduleHead ? sha256(submoduleHead) : null, binary: null, contentAvailability: "unsupported" };
  }
  if (!initial.isFile()) return { kind: "special", bytes: null, sha256: null, binary: null, contentAvailability: "unsupported" };

  const digest = createHash("sha256");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let binary = false;
  let bytes = 0;
  const storedChunks: Buffer[] = [];
  let storeBytes = Boolean(blobDirectory) && initial.size <= MAX_CHANGE_BLOB_BYTES;
  for await (const data of createReadStream(filePath)) {
    const chunk = data as Buffer;
    bytes += chunk.byteLength;
    digest.update(chunk);
    if (storeBytes && bytes <= MAX_CHANGE_BLOB_BYTES) storedChunks.push(chunk);
    else { storeBytes = false; storedChunks.length = 0; }
    if (chunk.includes(0)) binary = true;
    if (!binary) {
      try { decoder.decode(chunk, { stream: true }); } catch { binary = true; }
    }
  }
  if (!binary) {
    try { decoder.decode(); } catch { binary = true; }
  }
  const current = lstatSync(filePath);
  if (!current.isFile() || current.size !== initial.size || current.mtimeMs !== initial.mtimeMs || current.ctimeMs !== initial.ctimeMs || bytes !== initial.size) {
    throw new StaleChangeSnapshotError(`File changed while capturing snapshot: ${gitPath}`);
  }
  return {
    kind: "file", bytes, sha256: digest.digest("hex"), binary,
    ...(storeBytes ? await saveBlob(blobDirectory, Buffer.concat(storedChunks))
      : { contentAvailability: "too_large" as const }),
  };
}

type WorktreeLock = { tail: Promise<void> };
declare global {
  var __piOrchestrationWorktreeLocks: Map<string, WorktreeLock> | undefined;
  var __piOrchestrationChangeBlobs: Set<string> | undefined;
}

export async function disposeChangeSnapshotArtifacts(snapshot: ChangeSnapshot): Promise<void> {
  const directory = snapshot.blobDirectory;
  if (!directory || !globalThis.__piOrchestrationChangeBlobs?.delete(directory)) return;
  await rm(directory, { recursive: true, force: true });
}

/** Read the immutable original/candidate bytes by verified host reference. */
export async function readChangeBlob(file: ChangedFile): Promise<Buffer> {
  const blob = file.contentArtifactPath;
  if (file.contentAvailability !== "available" || !blob || !globalThis.__piOrchestrationChangeBlobs?.has(dirname(blob))) {
    throw new Error(`Original bytes are not available for ${file.path}: ${file.contentAvailability}`);
  }
  const info = statSync(blob);
  if (!info.isFile() || info.size > MAX_CHANGE_BLOB_BYTES) throw new StaleChangeSnapshotError(`Invalid change blob: ${file.path}`);
  const contents = await readFile(blob);
  if (contents.length !== file.bytes || sha256(contents) !== file.sha256) {
    throw new StaleChangeSnapshotError(`Change blob no longer matches captured bytes: ${file.path}`);
  }
  return contents;
}

/** In-process lock. External editors/processes still require optimistic revalidation. */
export async function withOrchestrationWorktreeLock<T>(repositoryRoot: string, action: () => Promise<T>): Promise<T> {
  const locks = globalThis.__piOrchestrationWorktreeLocks ??= new Map();
  const lock = locks.get(repositoryRoot) ?? { tail: Promise.resolve() };
  locks.set(repositoryRoot, lock);
  const previous = lock.tail;
  let unlock!: () => void;
  const current = new Promise<void>((resolvePromise) => { unlock = resolvePromise; });
  lock.tail = current;
  await previous;
  try { return await action(); }
  finally {
    unlock();
    if (lock.tail === current) locks.delete(repositoryRoot);
  }
}

async function capture(root: string, cwd: string, options: ChangeCaptureOptions = {}): Promise<ChangeSnapshot> {
  const [headResult, branchResult, indexOutput, statusOutput] = await Promise.all([
    git(root, ["rev-parse", "--verify", "HEAD"], true),
    git(root, ["symbolic-ref", "--quiet", "HEAD"], true),
    git(root, ["ls-files", "--stage", "-z"]),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  const head = headResult?.toString("utf8").trim() || null;
  const branch = branchResult?.toString("utf8").trim() || null;
  const index = parseIndex(indexOutput!);
  const statuses = parseGitPorcelainV1(statusOutput!.toString("utf8"));
  const blobRoot = options.blobRoot ? await realpath(options.blobRoot) : tmpdir();
  if (!statSync(blobRoot).isDirectory()) throw new Error(`Change blob root is not a directory: ${blobRoot}`);
  const blobDirectory = statuses.length > 0 ? await mkdtemp(join(blobRoot, "pi-web-change-blobs-")) : null;
  if (blobDirectory) (globalThis.__piOrchestrationChangeBlobs ??= new Set()).add(blobDirectory);
  try {
    const dirty: ChangedFile[] = [];
    for (const entry of statuses) {
      const hashed = await hashWorkingPath(root, entry.path, blobDirectory ?? undefined);
      dirty.push({
        path: entry.path,
        ...(entry.originalPath ? { originalPath: entry.originalPath } : {}),
        indexStatus: entry.indexStatus,
        worktreeStatus: entry.worktreeStatus,
        indexEntries: index.get(entry.path) ?? [],
        ...hashed,
        contentAvailability: hashed.contentAvailability ?? "unsupported",
      });
    }
    dirty.sort((a, b) => a.path.localeCompare(b.path));
    const [endHead, endBranch, endIndex, endStatus] = await Promise.all([
      git(root, ["rev-parse", "--verify", "HEAD"], true),
      git(root, ["symbolic-ref", "--quiet", "HEAD"], true),
      git(root, ["ls-files", "--stage", "-z"]),
      git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    if (!(headResult ?? Buffer.alloc(0)).equals(endHead ?? Buffer.alloc(0))
      || !(branchResult ?? Buffer.alloc(0)).equals(endBranch ?? Buffer.alloc(0))
      || !indexOutput!.equals(endIndex!) || !statusOutput!.equals(endStatus!)) {
      throw new StaleChangeSnapshotError("Git HEAD, index or status changed while capturing snapshot");
    }
    const [staged, unstaged] = await Promise.all([
      git(root, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", ...(head ? [head] : [])]),
      git(root, ["diff", "--binary", "--full-index", "--no-ext-diff"]),
    ]);
    const [finalIndex, finalStatus] = await Promise.all([
      git(root, ["ls-files", "--stage", "-z"]),
      git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    ]);
    if (!indexOutput!.equals(finalIndex!) || !statusOutput!.equals(finalStatus!)) {
      throw new StaleChangeSnapshotError("Git index or status changed while collecting patches");
    }
    for (const file of dirty) {
      const afterPatch = await hashWorkingPath(root, file.path);
      if (afterPatch.kind !== file.kind || afterPatch.sha256 !== file.sha256 || afterPatch.bytes !== file.bytes) {
        throw new StaleChangeSnapshotError(`File changed while collecting patches: ${file.path}`);
      }
    }
    const indexId = sha256(indexOutput!);
    const id = sha256(JSON.stringify({ root, head, branch, indexId, dirty: dirty.map(fileIdentity) }));
    return { id, repositoryRoot: root, cwd, head, branch, indexId, dirty, blobDirectory, stagedPatch: staged!.toString("utf8"), unstagedPatch: unstaged!.toString("utf8") };
  } catch (error) {
    if (blobDirectory) {
      globalThis.__piOrchestrationChangeBlobs?.delete(blobDirectory);
      await rm(blobDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

function taskDelta(baseline: ChangeSnapshot, candidate: ChangeSnapshot): TaskFileChange[] {
  const before = new Map(baseline.dirty.map((file) => [file.path, file]));
  const after = new Map(candidate.dirty.map((file) => [file.path, file]));
  const changes: TaskFileChange[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const current = after.get(path) ?? null;
    const previousPath = current?.originalPath;
    const prior = before.get(path) ?? (previousPath ? before.get(previousPath) : undefined) ?? null;
    if (current && prior && JSON.stringify(fileIdentity(current)) === JSON.stringify(fileIdentity(prior))) continue;
    if (!current && candidate.dirty.some((file) => file.originalPath === path)) continue;
    const change: TaskFileChange["change"] = previousPath && previousPath !== path
      ? "renamed"
      : !current
        ? prior?.indexStatus === "?" ? "removed" : "restored"
        : current.indexStatus === "?" ? "added" : "modified";
    changes.push({
      path,
      ...(previousPath ? { previousPath } : {}),
      before: prior,
      after: current,
      change,
    });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

async function collectChangesWithResolvedRoot(
  root: string, actualCwd: string, baselineSnapshot?: ChangeSnapshot, options?: ChangeCaptureOptions,
): Promise<{ snapshot: ChangeSnapshot; manifest: ChangeManifest }> {
  const snapshot = await capture(root, actualCwd, options);
  if (baselineSnapshot && (baselineSnapshot.repositoryRoot !== root || baselineSnapshot.head !== snapshot.head || baselineSnapshot.branch !== snapshot.branch)) {
    await disposeChangeSnapshotArtifacts(snapshot);
    throw new StaleChangeSnapshotError("Baseline belongs to another worktree, HEAD or branch");
  }
  const manifest: ChangeManifest = {
    beforeSnapshotId: baselineSnapshot?.id ?? null,
    candidateSnapshotId: snapshot.id,
    repositoryRoot: root,
    head: snapshot.head,
    preexisting: baselineSnapshot?.dirty ?? [],
    changed: baselineSnapshot ? taskDelta(baselineSnapshot, snapshot) : [],
    candidateDirty: snapshot.dirty,
    baselineStagedPatch: baselineSnapshot?.stagedPatch ?? "",
    baselineUnstagedPatch: baselineSnapshot?.unstagedPatch ?? "",
    candidateStagedPatch: snapshot.stagedPatch,
    candidateUnstagedPatch: snapshot.unstagedPatch,
  };
  return { snapshot, manifest };
}

async function resolveCwdAndRoot(cwd: string): Promise<{ root: string; actualCwd: string }> {
  const actualCwd = await realpath(cwd);
  if (!statSync(actualCwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
  const rootOutput = await git(actualCwd, ["rev-parse", "--show-toplevel"]);
  const root = await realpath(rootOutput!.toString("utf8").trim());
  return { root, actualCwd };
}

/** Use only inside withOrchestrationWorktreeLock(root, …) to avoid nested-lock deadlock. */
export async function collectChangesWhileLocked(
  cwd: string, baselineSnapshot?: ChangeSnapshot, options?: ChangeCaptureOptions,
): Promise<{ snapshot: ChangeSnapshot; manifest: ChangeManifest }> {
  const { root, actualCwd } = await resolveCwdAndRoot(cwd);
  return collectChangesWithResolvedRoot(root, actualCwd, baselineSnapshot, options);
}

/** Capture changed-file evidence without rereading the bytes of every clean tracked file. */
export async function collectChanges(
  cwd: string, baselineSnapshot?: ChangeSnapshot, options?: ChangeCaptureOptions,
): Promise<{ snapshot: ChangeSnapshot; manifest: ChangeManifest }> {
  const { root, actualCwd } = await resolveCwdAndRoot(cwd);
  return withOrchestrationWorktreeLock(root, () => collectChangesWithResolvedRoot(root, actualCwd, baselineSnapshot, options));
}

/** Recheck selected dirty files and the index before a writer/reviewer uses a snapshot. */
export async function verifyChangeSnapshot(snapshot: ChangeSnapshot, paths: readonly string[] = snapshot.dirty.map((file) => file.path)): Promise<void> {
  const index = await git(snapshot.repositoryRoot, ["ls-files", "--stage", "-z"]);
  if (sha256(index!) !== snapshot.indexId) throw new StaleChangeSnapshotError("Git index changed after snapshot");
  const head = await git(snapshot.repositoryRoot, ["rev-parse", "--verify", "HEAD"], true);
  if ((head?.toString("utf8").trim() || null) !== snapshot.head) throw new StaleChangeSnapshotError("Git HEAD changed after snapshot");
  const existing = new Map(snapshot.dirty.map((file) => [file.path, file]));
  for (const path of paths) {
    const file = existing.get(path);
    if (!file) throw new StaleChangeSnapshotError(`Path is not recorded in snapshot: ${path}`);
    const current = await hashWorkingPath(snapshot.repositoryRoot, path);
    if (current.kind !== file.kind || current.sha256 !== file.sha256 || current.bytes !== file.bytes) {
      throw new StaleChangeSnapshotError(`File changed after snapshot: ${path}`);
    }
  }
  const status = await git(snapshot.repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const expectedStatus = snapshot.dirty.map(({ path, originalPath, indexStatus, worktreeStatus }) => ({
    path, indexStatus, worktreeStatus, ...(originalPath ? { originalPath } : {}),
  }));
  const liveStatus = parseGitPorcelainV1(status!.toString("utf8")).sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(liveStatus) !== JSON.stringify(expectedStatus)) {
    throw new StaleChangeSnapshotError("Git status changed after snapshot");
  }
}
