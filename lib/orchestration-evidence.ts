import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isPathWithinRoots } from "./path-security";
import { samePath, toSlashPath } from "./paths";

const DEFAULT_SOURCE_LIMIT = 2 * 1024 * 1024;
const DEFAULT_EXCERPT_LIMIT = 32 * 1024;
const MAX_EXCERPT_LIMIT = 256 * 1024;
const MAX_SEARCH_MATCHES = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EvidenceCaptureRequest {
  taskId: string;
  worktreeRoot: string;
  /** Caller-supplied task revision, never a claim of a whole-worktree atomic snapshot. */
  snapshotId: string;
  /** A known file path inside the specified worktree, relative or absolute. */
  path: string;
  maxSourceBytes?: number;
}

export interface EvidenceRef {
  id: string;
  taskId: string;
  worktreeRoot: string;
  snapshotId: string;
  path: string;
  byteLength: number;
  sha256: string;
  capturedAt: string;
}

export interface EvidenceAccessRequest {
  id: string;
  taskId: string;
  worktreeRoot: string;
  snapshotId?: string;
}

export interface EvidenceExcerpt extends EvidenceRef {
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
  truncated: boolean;
  nextLine?: number;
}

export interface EvidenceRangeRequest extends EvidenceCaptureRequest {
  startLine: number;
  endLine: number;
  maxBytes?: number;
}

export interface EvidenceSearchRequest extends EvidenceCaptureRequest {
  /** Literal substring search in one named file; no model-written regex or repository-wide scan. */
  query: string;
  maxMatches?: number;
}

export interface EvidenceSearchResult {
  ref: EvidenceRef;
  matches: Array<{ line: number }>;
  truncated: boolean;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function bounded(value: number | undefined, fallback: number, cap: number, label: string): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > cap) throw new Error(`${label} must be in [1, ${cap}]`);
  return n;
}

function resolveSource(worktreeRoot: string, requestedPath: string): { root: string; absolute: string; relative: string } {
  assertNonEmpty(requestedPath, "Evidence path");
  const root = realpathSync(worktreeRoot);
  if (!statSync(root).isDirectory()) throw new Error("Evidence worktree must be a directory");
  const lexical = path.resolve(root, requestedPath);
  if (!isPathWithinRoots(lexical, new Set([root]))) throw new Error("Evidence path is outside the worktree");
  const absolute = realpathSync(lexical);
  if (!isPathWithinRoots(absolute, new Set([root]))) throw new Error("Evidence path resolves outside the worktree");
  if (!statSync(absolute).isFile()) throw new Error("Evidence source must be a regular file");
  return { root, absolute, relative: toSlashPath(path.relative(root, lexical)) };
}

function linesWithTerminators(source: string): string[] {
  if (!source) return [];
  return source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Durable, task-scoped original bytes. The caller supplies a private host-owned storeRoot. */
export class OrchestrationEvidenceStore {
  private readonly storeRoot: string;

  constructor(storeRoot: string) {
    mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
    this.storeRoot = realpathSync(storeRoot);
    if (!statSync(this.storeRoot).isDirectory()) throw new Error("Evidence store must be a directory");
  }

  captureFile(request: EvidenceCaptureRequest): EvidenceRef {
    assertNonEmpty(request.taskId, "Evidence taskId");
    assertNonEmpty(request.snapshotId, "Evidence snapshotId");
    const source = resolveSource(request.worktreeRoot, request.path);
    const limit = bounded(request.maxSourceBytes, DEFAULT_SOURCE_LIMIT, DEFAULT_SOURCE_LIMIT, "Evidence source limit");
    if (statSync(source.absolute).size > limit) throw new Error("Evidence source exceeds byte limit");
    const bytes = readFileSync(source.absolute);
    if (bytes.byteLength > limit) throw new Error("Evidence source exceeds byte limit");
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Evidence source is not valid UTF-8 text");
    }

    const ref: EvidenceRef = {
      id: randomUUID(), taskId: request.taskId, worktreeRoot: source.root,
      snapshotId: request.snapshotId, path: source.relative,
      byteLength: bytes.byteLength, sha256: hash(bytes), capturedAt: new Date().toISOString(),
    };
    const blob = path.join(this.storeRoot, `${ref.id}.bin`);
    const metadata = path.join(this.storeRoot, `${ref.id}.json`);
    writeFileSync(blob, bytes, { flag: "wx", mode: 0o600, flush: true });
    try {
      writeFileSync(metadata, JSON.stringify(ref), { flag: "wx", mode: 0o600, flush: true });
    } catch (error) {
      unlinkSync(blob);
      throw error;
    }
    return ref;
  }

  private load(request: EvidenceAccessRequest): { ref: EvidenceRef; bytes: Buffer; text: string } {
    if (!UUID_RE.test(request.id)) throw new Error("Invalid evidence reference");
    const metadata = readFileSync(path.join(this.storeRoot, `${request.id}.json`), "utf8");
    const ref = JSON.parse(metadata) as EvidenceRef;
    if (ref.id !== request.id || ref.taskId !== request.taskId
      || !samePath(ref.worktreeRoot, realpathSync(request.worktreeRoot))
      || (request.snapshotId !== undefined && ref.snapshotId !== request.snapshotId)) {
      throw new Error("Evidence reference is outside this task, worktree, or snapshot");
    }
    const bytes = readFileSync(path.join(this.storeRoot, `${request.id}.bin`));
    if (bytes.byteLength !== ref.byteLength || hash(bytes) !== ref.sha256) {
      throw new Error("Saved evidence content failed integrity check");
    }
    return { ref, bytes, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  }

  readExcerpt(request: EvidenceAccessRequest & { startLine?: number; endLine?: number; maxBytes?: number }): EvidenceExcerpt {
    const { ref, text } = this.load(request);
    const lines = linesWithTerminators(text);
    const start = request.startLine ?? 1;
    const end = request.endLine ?? lines.length;
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < 0
      || (lines.length > 0 && (end < start || start > lines.length))
      || (lines.length === 0 && (start !== 1 || end !== 0))) {
      throw new Error("Evidence excerpt needs a positive inclusive line range");
    }
    const maxBytes = bounded(request.maxBytes, DEFAULT_EXCERPT_LIMIT, MAX_EXCERPT_LIMIT, "Evidence excerpt limit");
    let textOut = "";
    let lastLine = start - 1;
    let size = 0;
    for (let i = start - 1; i < Math.min(end, lines.length); i++) {
      const nextBytes = Buffer.byteLength(lines[i]);
      if (size + nextBytes > maxBytes) break;
      textOut += lines[i];
      size += nextBytes;
      lastLine = i + 1;
    }
    const truncated = lastLine < Math.min(end, lines.length);
    return {
      ...ref, startLine: start, endLine: lastLine, totalLines: lines.length,
      text: textOut, truncated,
      ...(truncated ? { nextLine: lastLine + 1 } : {}),
    };
  }

  /** Capture once, return an exact saved excerpt; useful after owner compaction. */
  readFileRange(request: EvidenceRangeRequest): EvidenceExcerpt {
    const ref = this.captureFile(request);
    return this.readExcerpt({
      id: ref.id, taskId: ref.taskId, worktreeRoot: ref.worktreeRoot,
      snapshotId: ref.snapshotId, startLine: request.startLine,
      endLine: request.endLine, maxBytes: request.maxBytes,
    });
  }

  searchFile(request: EvidenceSearchRequest): EvidenceSearchResult {
    assertNonEmpty(request.query, "Evidence search query");
    if (request.query.length > 256 || request.query.includes("\n")) {
      throw new Error("Evidence search query must be a single line of at most 256 characters");
    }
    const maxMatches = bounded(request.maxMatches, 20, MAX_SEARCH_MATCHES, "Evidence search matches");
    const ref = this.captureFile(request);
    const { text } = this.load({ id: ref.id, taskId: ref.taskId, worktreeRoot: ref.worktreeRoot });
    const matches: Array<{ line: number }> = [];
    let truncated = false;
    for (const [index, line] of linesWithTerminators(text).entries()) {
      if (!line.includes(request.query)) continue;
      if (matches.length === maxMatches) {
        truncated = true;
        break;
      }
      matches.push({ line: index + 1 });
    }
    return { ref, matches, truncated };
  }

  /** Per-file freshness only: this does not validate a whole-worktree snapshot. */
  isSourceCurrent(request: EvidenceAccessRequest): boolean {
    const { ref } = this.load(request);
    try {
      const source = resolveSource(ref.worktreeRoot, ref.path);
      if (!existsSync(source.absolute)) return false;
      const bytes = readFileSync(source.absolute);
      return bytes.byteLength === ref.byteLength && hash(bytes) === ref.sha256;
    } catch {
      return false;
    }
  }
}
