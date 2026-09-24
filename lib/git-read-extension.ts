import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
const MAX_BYTES = 512 * 1024;

/** Only the session's selected directory is readable; never return process stderr or log patches. */
export async function readLocalGit(cwd: string, input: { action: string; stage?: string }) {
  if (input.action !== "status" && input.action !== "diff") throw new Error("Unsupported git read action");
  if (input.stage !== undefined && !["staged", "unstaged"].includes(input.stage)) throw new Error("Invalid stage");
  if (input.action === "diff" && !input.stage) throw new Error("Diff requires staged or unstaged stage");
  let directory: string;
  try { directory = await realpath(cwd); } catch { throw new Error("Selected working directory is unavailable"); }
  const run = async (args: string[]) => {
    try {
      return (await exec("git", ["--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-C", directory, ...args], {
        cwd: directory, timeout: 5000, maxBuffer: MAX_BYTES, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" },
      })).stdout;
    } catch { throw new Error("Git read failed or exceeded its time/output limit"); }
  };
  // Reject bare repositories and paths outside the selected worktree; `-- .` confines
  // output to the selected directory even when it is a subdirectory of the worktree.
  // Strip only Git's line terminator; trim() would corrupt a worktree path ending in spaces.
  const root = (await run(["rev-parse", "--show-toplevel"])).replace(/\n$/, "");
  const realRoot = await realpath(root).catch(() => { throw new Error("Git worktree is unavailable"); });
  if (directory !== realRoot && !directory.startsWith(realRoot + "/")) throw new Error("Selected directory is outside the worktree");
  if (input.action === "diff") {
    const patch = await run(["-c", "diff.renames=false", "-c", "diff.external=", "diff", "--no-ext-diff", "--no-textconv", "--no-color",
      ...(input.stage === "staged" ? ["--cached"] : ["--diff-filter=CDMRTUXB"]), "--", "."]);
    return { action: "diff", stage: input.stage, cwd: directory, patch };
  }
  // Porcelain v1 -z preserves filenames safely; untracked files are listed, never opened.
  const output = await run(["-c", "status.renames=false", "-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "--untracked-files=normal", "--", "."]);
  const entries = output.split("\0");
  const files: { path: string; index: string; worktree: string; staged: boolean; unstaged: boolean; originalPath?: string; untracked: boolean }[] = [];
  const prefix = relative(realRoot, directory).split(sep).join("/");
  const scoped = (path: string) => {
    if (prefix && !path.startsWith(prefix + "/")) throw new Error("Git reported a path outside the selected directory");
    return prefix ? path.slice(prefix.length + 1) : path;
  };
  for (let i = 0; i < entries.length - 1; i++) {
    const entry = entries[i];
    if (entry.length < 4 || entry[2] !== " ") throw new Error("Unexpected git status output");
    const index = entry[0], worktree = entry[1];
    const untracked = index === "?" && worktree === "?";
    const file = { path: scoped(entry.slice(3)), index, worktree, untracked,
      staged: !untracked && index !== " ", unstaged: !untracked && worktree !== " " } as typeof files[number];
    if (index === "R" || index === "C" || worktree === "R" || worktree === "C") file.originalPath = scoped(entries[++i]);
    files.push(file);
  }
  return { action: "status", cwd: directory, files };
}

export function createGitReadExtension(cwd: string, read: typeof readLocalGit = readLocalGit): InlineExtension {
  return { name: "pi-web-git-read", hidden: true, factory: (pi) => {
    pi.registerTool(defineTool({
      name: "git_read", label: "Local Git read",
      description: "Read local status metadata or staged/unstaged tracked-file patches only inside this session's selected cwd/worktree. Untracked file content is never read.",
      parameters: Type.Object({
        action: Type.String({ description: "status | diff" }),
        stage: Type.Optional(Type.String({ description: "staged | unstaged (required for diff)" })),
      }),
      async execute(_id, params) {
        try {
          return { content: [{ type: "text", text: JSON.stringify(await read(cwd, params)) }], details: undefined };
        } catch (error) {
          return { content: [{ type: "text", text: error instanceof Error ? error.message : "Git read failed" }], details: undefined, isError: true };
        }
      },
    }));
  } };
}
