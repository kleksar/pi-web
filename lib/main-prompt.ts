import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { isPathWithinRoots } from "./path-security";
import { getProjectTrustStatus } from "./project-trust";

export type MainPromptScope = "global" | "project";

export interface MainPromptFile {
  path: string;
  exists: boolean;
  content: string;
  revision: string;
  effective: boolean;
}

export interface MainPromptState {
  effectiveScope: MainPromptScope | null;
  projectTrusted: boolean;
  global: MainPromptFile;
  project: MainPromptFile;
}

const FILENAME = "APPEND_SYSTEM.md";
const ABSENT_REVISION = "absent";
const MAX_CONTENT_LENGTH = 512 * 1024;

export class MainPromptAccessError extends Error {}
export class MainPromptConflictError extends Error {}
export class MainPromptValidationError extends Error {}

function promptPath(cwd: string, scope: MainPromptScope, agentDir: string): string {
  return scope === "global"
    ? join(resolve(agentDir), FILENAME)
    : join(resolve(cwd), ".pi", FILENAME);
}

/**
 * Only edit the two fixed SDK discovery paths. Resolve the parent, rather than
 * following a symlink in APPEND_SYSTEM.md, so saves never rewrite a linked repo.
 * Project .pi directories may be linked within the project, but never outside it.
 */
function checkedParent(cwd: string, scope: MainPromptScope, agentDir: string, create: boolean): string | null {
  const root = scope === "global" ? resolve(agentDir) : realpathSync(cwd);
  const dir = scope === "global" ? resolve(agentDir) : join(resolve(cwd), ".pi");
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });

  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!statSync(realDir).isDirectory()) throw new MainPromptAccessError("Prompt directory is not a directory");
  if (scope === "project" && !isPathWithinRoots(realDir, new Set([root]))) {
    throw new MainPromptAccessError("Project prompt directory points outside the project");
  }
  return realDir;
}

function readPromptFile(cwd: string, scope: MainPromptScope, agentDir: string): MainPromptFile {
  const path = promptPath(cwd, scope, agentDir);
  const parent = checkedParent(cwd, scope, agentDir, false);
  if (!parent) return { path, exists: false, content: "", revision: ABSENT_REVISION, effective: false };

  const canonicalFile = join(parent, FILENAME);
  try {
    const stat = lstatSync(canonicalFile);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new MainPromptAccessError("APPEND_SYSTEM.md must be a regular file, not a symlink");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, exists: false, content: "", revision: ABSENT_REVISION, effective: false };
    }
    throw error;
  }

  const bytes = readFileSync(canonicalFile);
  if (bytes.length > MAX_CONTENT_LENGTH) throw new MainPromptValidationError("APPEND_SYSTEM.md is too large to edit in the UI");
  return {
    path,
    exists: true,
    content: bytes.toString("utf8"),
    revision: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    effective: false,
  };
}

/** Mirrors Pi's ordinary discovery: trusted project file wins; otherwise global. */
export function readMainPrompt(cwd: string, agentDir = getAgentDir()): MainPromptState {
  const global = readPromptFile(cwd, "global", agentDir);
  const project = readPromptFile(cwd, "project", agentDir);
  const projectTrusted = getProjectTrustStatus(cwd, agentDir).trusted;
  const effectiveScope: MainPromptScope | null =
    project.exists && projectTrusted ? "project" : global.exists ? "global" : null;
  global.effective = effectiveScope === "global";
  project.effective = effectiveScope === "project";
  return { effectiveScope, projectTrusted, global, project };
}

/** Compare and replace under one lock; a stale editor cannot overwrite a newer edit. */
export async function saveMainPrompt(
  cwd: string,
  scope: MainPromptScope,
  content: string,
  expectedRevision: string,
  agentDir = getAgentDir(),
): Promise<MainPromptState> {
  if (scope !== "global" && scope !== "project") throw new MainPromptValidationError("Invalid prompt scope");
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_CONTENT_LENGTH) {
    throw new MainPromptValidationError("Prompt must be text shorter than 512 KiB");
  }
  if (typeof expectedRevision !== "string" || !/^(absent|sha256:[0-9a-f]{64})$/.test(expectedRevision)) {
    throw new MainPromptValidationError("Valid expected revision required");
  }

  // Resolve the existing file before creating a directory. A missing .pi
  // directory is part of the 'absent' revision and is created only for a save.
  const before = readPromptFile(cwd, scope, agentDir);
  if (before.revision !== expectedRevision) throw new MainPromptConflictError("Prompt changed on disk");
  const parent = checkedParent(cwd, scope, agentDir, true);
  if (!parent) throw new MainPromptAccessError("Prompt directory unavailable");
  const destination = join(parent, FILENAME);
  const release = await lockfile.lock(parent, { retries: { retries: 8, factor: 1, minTimeout: 20, maxTimeout: 100 } });
  try {
    const current = readPromptFile(cwd, scope, agentDir);
    if (current.revision !== expectedRevision) throw new MainPromptConflictError("Prompt changed on disk");
    // An empty prompt is still a file: it shadows a global prompt when the
    // project is trusted, just as Pi's resource loader does.
    writePrivateFileAtomicSync(destination, content);
  } finally {
    await release();
  }
  return readMainPrompt(cwd, agentDir);
}
