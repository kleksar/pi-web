import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isPathWithinRoots } from "./path-security";
import { samePath, toNativePath, toSlashPath } from "./paths";

const INSTRUCTIONS_FILE = "AGENTS.md";
const MAX_INSTRUCTION_BYTES = 512 * 1024;

export interface ProjectInstruction {
  /** Path relative to worktreeRoot. */
  path: string;
  /** Original UTF-8 contents; never a reader's summary. */
  content: string;
  sha256: string;
}

export interface ProjectContext {
  /** The actual worktree used by the child, resolved through symlinks. */
  worktreeRoot: string;
  targetPaths: string[];
  /** Explicitly configured sources only: no inferred tracker or Knowledge directory. */
  sourceBindings: Record<string, string>;
  instructions: ProjectInstruction[];
  /** Includes absent AGENTS.md locations so creating one changes the fingerprint. */
  inspectedPaths: string[];
  fingerprint: string;
}

export interface ResolveProjectContextRequest {
  worktreeRoot: string;
  /** Files or directories within the selected worktree. Empty means root only. */
  targetPaths?: readonly string[];
  sourceBindings?: Readonly<Record<string, string>>;
}

/** An explicit worktree boundary even if the active session cwd is a subdirectory. */
export function resolveWorktreeRoot(cwd: string): string {
  const actualCwd = realpathSync(cwd);
  if (!statSync(actualCwd).isDirectory()) throw new Error("Project cwd must be a directory");
  try {
    const output = execFileSync("git", ["-C", actualCwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output ? realpathSync(toNativePath(output)) : actualCwd;
  } catch {
    return actualCwd;
  }
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function existingAncestor(candidate: string): string {
  let current = candidate;
  while (!existsSync(current)) {
    try {
      lstatSync(current);
      throw new Error(`Project target has a broken symlink: ${candidate}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (current === parent) throw new Error(`No existing ancestor for target: ${candidate}`);
    current = parent;
  }
  return realpathSync(current);
}

function targetDirectory(worktreeRoot: string, requested: string): { target: string; directory: string } {
  if (!requested.trim()) throw new Error("Project target path must not be empty");
  const target = path.resolve(worktreeRoot, requested);
  if (!isPathWithinRoots(target, new Set([worktreeRoot]))) {
    throw new Error(`Project target is outside its worktree: ${requested}`);
  }
  // For a path that does not exist yet, check its nearest existing ancestor:
  // a symlinked parent must never make a seemingly local target point outside.
  if (!isPathWithinRoots(existingAncestor(target), new Set([worktreeRoot]))) {
    throw new Error(`Project target resolves outside its worktree: ${requested}`);
  }
  const isDirectory = requested.endsWith("/") || requested.endsWith(path.sep)
    || (existsSync(target) && statSync(target).isDirectory());
  const relativeTarget = toSlashPath(path.relative(worktreeRoot, target)) || ".";
  return {
    target: isDirectory && relativeTarget !== "." ? `${relativeTarget}/` : relativeTarget,
    directory: isDirectory ? target : path.dirname(target),
  };
}

/** Resolve the root and every applicable nested AGENTS.md for the given paths. */
export function resolveProjectContext(request: ResolveProjectContextRequest): ProjectContext {
  const worktreeRoot = realpathSync(request.worktreeRoot);
  if (!statSync(worktreeRoot).isDirectory()) throw new Error("Project worktree must be a directory");

  const resolvedTargets = (request.targetPaths ?? []).map((target) => targetDirectory(worktreeRoot, target));
  const targetPaths = [...new Set(resolvedTargets.map(({ target }) => target))].sort();
  const candidates = new Set([path.join(worktreeRoot, INSTRUCTIONS_FILE)]);

  for (const { directory } of resolvedTargets) {
    let current = directory;
    while (isPathWithinRoots(current, new Set([worktreeRoot]))) {
      candidates.add(path.join(current, INSTRUCTIONS_FILE));
      if (samePath(current, worktreeRoot)) break;
      current = path.dirname(current);
    }
  }

  const inspectedPaths = [...candidates]
    .map((candidate) => toSlashPath(path.relative(worktreeRoot, candidate)))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const instructions: ProjectInstruction[] = [];
  const documentHashes: Array<[string, string | null]> = [];
  const utf8 = new TextDecoder("utf-8", { fatal: true });

  for (const relativePath of inspectedPaths) {
    const absolute = path.join(worktreeRoot, relativePath);
    if (!existsSync(absolute)) {
      try {
        lstatSync(absolute);
        throw new Error(`Project instruction has a broken symlink: ${relativePath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      documentHashes.push([relativePath, null]);
      continue;
    }
    const real = realpathSync(absolute);
    if (!isPathWithinRoots(real, new Set([worktreeRoot]))) {
      throw new Error(`Project instruction resolves outside its worktree: ${relativePath}`);
    }
    const stat = statSync(real);
    if (!stat.isFile()) throw new Error(`Project instruction is not a file: ${relativePath}`);
    if (stat.size > MAX_INSTRUCTION_BYTES) throw new Error(`Project instruction is too large: ${relativePath}`);
    const bytes = readFileSync(real);
    if (bytes.byteLength > MAX_INSTRUCTION_BYTES) throw new Error(`Project instruction is too large: ${relativePath}`);
    let content: string;
    try {
      content = utf8.decode(bytes);
    } catch {
      throw new Error(`Project instruction is not UTF-8: ${relativePath}`);
    }
    const sha256 = hash(bytes);
    instructions.push({ path: relativePath, content, sha256 });
    documentHashes.push([relativePath, sha256]);
  }

  const sourceBindings = Object.fromEntries(Object.entries(request.sourceBindings ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const fingerprint = hash(JSON.stringify({ worktreeRoot, targetPaths, sourceBindings, documentHashes }));
  return { worktreeRoot, targetPaths, sourceBindings, instructions, inspectedPaths, fingerprint };
}

export function getProjectContextForPaths(worktreeRoot: string, targetPaths: readonly string[]): ProjectContext {
  return resolveProjectContext({ worktreeRoot, targetPaths });
}

/** Literal contents remain available to reinsert after context compaction. */
export function formatProjectInstructions(context: ProjectContext): string {
  return context.instructions.map(({ path: filePath, content, sha256 }) =>
    `<project-instructions path=${JSON.stringify(filePath)} sha256=${JSON.stringify(sha256)}>\n${content}\n</project-instructions>`
  ).join("\n\n");
}

/** Checks only known target paths and instructions, not an atomic whole-repo snapshot. */
export function hasProjectContextChanged(context: ProjectContext): boolean {
  try {
    return resolveProjectContext({
      worktreeRoot: context.worktreeRoot,
      targetPaths: context.targetPaths,
      sourceBindings: context.sourceBindings,
    }).fingerprint !== context.fingerprint;
  } catch {
    return true;
  }
}
