import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "fs";
import { relative, resolve } from "path";
import { isPathWithinRoots } from "./path-security";
import { toSlashPath } from "./paths";

export const MAX_SUBAGENT_INPUT_FILES = 8;
export const MAX_SUBAGENT_INPUT_BYTES = 512 * 1024;

export interface SubagentInputFile {
  path: string;
  content: string;
}

/** Read at most one byte past the remaining allowance, even if a file grows after stat. */
function readBoundedInput(filePath: string, expected: Stats, remainingBytes: number): Buffer {
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
    throw new Error("Secure Agent input_files reading is not available on this platform");
  }
  const file = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // The path can change between realpath/stat and open. Verify the opened
    // inode rather than trusting a pathname that an agent can modify.
    const opened = fstatSync(file);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error("Agent input file changed during loading");
    }
    if (opened.size > remainingBytes) {
      throw new Error(`Agent input_files exceeds the ${MAX_SUBAGENT_INPUT_BYTES}-byte total limit`);
    }
    const buffer = Buffer.allocUnsafe(remainingBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(file, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(file);
  }
}

export function loadSubagentInputFiles(cwd: string, requestedPaths: readonly string[]): SubagentInputFile[] {
  if (requestedPaths.length > MAX_SUBAGENT_INPUT_FILES) {
    throw new Error(`Agent input_files accepts at most ${MAX_SUBAGENT_INPUT_FILES} files`);
  }

  const realCwd = realpathSync(cwd);
  const allowedRoots = new Set([realCwd]);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const seen = new Set<string>();
  const files: SubagentInputFile[] = [];
  let totalBytes = 0;

  for (const requestedPath of requestedPaths) {
    if (!requestedPath.trim()) throw new Error("Agent input_files paths must not be empty");

    let filePath: string;
    try {
      filePath = realpathSync(resolve(cwd, requestedPath));
    } catch {
      throw new Error(`Agent input file does not exist: ${requestedPath}`);
    }
    if (!isPathWithinRoots(filePath, allowedRoots)) {
      throw new Error(`Agent input file is outside the session cwd: ${requestedPath}`);
    }
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      throw new Error(`Agent input path is not a file: ${requestedPath}`);
    }
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    const remainingBytes = MAX_SUBAGENT_INPUT_BYTES - totalBytes;
    if (stat.size > remainingBytes) {
      throw new Error(`Agent input_files exceeds the ${MAX_SUBAGENT_INPUT_BYTES}-byte total limit`);
    }
    const buffer = readBoundedInput(filePath, stat, remainingBytes);
    totalBytes += buffer.byteLength;
    if (buffer.byteLength > remainingBytes) {
      throw new Error(`Agent input_files exceeds the ${MAX_SUBAGENT_INPUT_BYTES}-byte total limit`);
    }

    let content: string;
    try {
      content = decoder.decode(buffer);
    } catch {
      throw new Error(`Agent input file is not valid UTF-8 text: ${requestedPath}`);
    }
    files.push({
      path: toSlashPath(relative(realCwd, filePath)),
      content,
    });
  }

  return files;
}

export function appendSubagentInputFiles(task: string, files: readonly SubagentInputFile[]): string {
  if (files.length === 0) return task;
  const documents = files.map((file) =>
    `<document path=${JSON.stringify(file.path)}>\n${file.content}\n</document>`
  ).join("\n\n");
  return `${task}\n\n<documents>\n${documents}\n</documents>`;
}
