import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const REPO_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ACTIONS = new Set(["list_issues", "list_pull_requests", "get_issue", "get_pull_request"]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const BODY_LIMIT = 16_000;

export interface GitHubReadRequest {
  action: string;
  number?: number;
  page?: number;
  state?: string;
}

/** Git's configured origin is the only repository this tool may query. */
export function githubRepositoryFromRemote(remote: string): string | null {
  const trimmed = remote.trim();
  let path: string;
  if (/^git@github\.com:/i.test(trimmed)) path = trimmed.slice("git@github.com:".length);
  else {
    try {
      const url = new URL(trimmed);
      if (url.hostname.toLowerCase() !== "github.com" || url.port || url.search || url.hash
        || (url.protocol !== "https:" && url.protocol !== "ssh:")) return null;
      path = url.pathname.slice(1);
    } catch { return null; }
  }
  const parts = path.replace(/\.git$/, "").split("/");
  return parts.length === 2 && parts.every((part) => REPO_PART.test(part) && part !== "." && part !== "..")
    ? `${parts[0]}/${parts[1]}` : null;
}

function requestPath(repository: string, input: GitHubReadRequest): string {
  if (!ACTIONS.has(input.action)) throw new Error("Unsupported GitHub read action");
  const base = `/repos/${repository}`;
  if (input.action === "get_issue" || input.action === "get_pull_request") {
    if (!Number.isSafeInteger(input.number) || input.number! < 1) throw new Error("A positive issue or PR number is required");
    return `${base}/${input.action === "get_issue" ? "issues" : "pulls"}/${input.number}`;
  }
  const page = input.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new Error("Page must be between 1 and 100");
  const state = input.state ?? "open";
  if (!["open", "closed", "all"].includes(state)) throw new Error("Invalid GitHub state");
  const kind = input.action === "list_issues" ? "issues" : "pulls";
  return `${base}/${kind}?state=${state}&per_page=20&page=${page}`;
}

async function boundedResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub returned an empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("GitHub response exceeded the read limit; request one item instead");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function requestGitHub(path: string): Promise<unknown> {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    // gh can use the operator's existing login without exposing its token to the agent.
    try {
      const { stdout } = await execFileAsync("gh", ["api", "-X", "GET", "--hostname", "github.com", path],
        { timeout: 15_000, maxBuffer: MAX_RESPONSE_BYTES });
      return JSON.parse(stdout) as unknown;
    } catch { /* A public repository can still be read without gh authentication. */ }
  }
  const response = await fetch(`https://api.github.com${path}`, {
    method: "GET",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-web-github-reader",
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401 || response.status === 404) {
      throw new Error(`GitHub returned ${response.status}; for a private repository, authenticate gh or set GH_TOKEN for Pi Web`);
    }
    if (response.status === 403 || response.status === 429) throw new Error(`GitHub returned ${response.status}; check authentication or rate limits`);
    throw new Error(`GitHub returned ${response.status}`);
  }
  return boundedResponse(response);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function summary(value: unknown, includeBody: boolean) {
  const item = record(value);
  const user = record(item.user);
  const head = record(item.head);
  const base = record(item.base);
  return {
    number: item.number, title: item.title, state: item.state, draft: item.draft,
    url: item.html_url, author: user.login, updatedAt: item.updated_at,
    ...(item.pull_request || item.head ? { type: "pull_request" } : { type: "issue" }),
    ...(head.ref ? { head: head.ref, base: base.ref } : {}),
    ...(includeBody ? { body: typeof item.body === "string" ? item.body.slice(0, BODY_LIMIT) : "",
      bodyTruncated: typeof item.body === "string" && item.body.length > BODY_LIMIT } : {}),
  };
}

/** No arbitrary URLs, HTTP methods, repositories or Git commands reach the model. */
export async function readGitHubOrigin(cwd: string, input: GitHubReadRequest,
  dependencies: { getOrigin?: () => Promise<string>; get?: (path: string) => Promise<unknown> } = {}) {
  const getOrigin = dependencies.getOrigin ?? (async () => (await execFileAsync("git", ["remote", "get-url", "origin"],
    { cwd, timeout: 3000, maxBuffer: 4096 })).stdout);
  let remote: string;
  try { remote = await getOrigin(); } catch { throw new Error("No GitHub origin remote is available for this project"); }
  const repository = githubRepositoryFromRemote(remote);
  if (!repository) throw new Error("This project's origin is not a GitHub repository");
  const path = requestPath(repository, input);
  const data = await (dependencies.get ?? requestGitHub)(path);
  if (Array.isArray(data)) {
    return { repository, fetchedAt: new Date().toISOString(), action: input.action,
      page: input.page ?? 1, hasMore: data.length === 20,
      items: data.filter((item) => input.action !== "list_issues" || !record(item).pull_request)
        .map((item) => summary(item, false)) };
  }
  if (!data || typeof data !== "object" || !record(data).number) throw new Error("Unexpected GitHub response");
  return { repository, fetchedAt: new Date().toISOString(), action: input.action, item: summary(data, true) };
}

/** Available only to leaf profiles explicitly selecting `github_read`. */
export function createGitHubReadExtension(cwd: string,
  read: typeof readGitHubOrigin = readGitHubOrigin): InlineExtension {
  return { name: "pi-web-github-read", hidden: true, factory: (pi) => {
    pi.registerTool(defineTool({
      name: "github_read", label: "GitHub read",
      description: "Read live issues and pull requests from this project's GitHub origin. Read-only; use list_issues, list_pull_requests, get_issue or get_pull_request. Results include the source URL and retrieval time.",
      parameters: Type.Object({
        action: Type.String({ description: "list_issues | list_pull_requests | get_issue | get_pull_request" }),
        number: Type.Optional(Type.Number({ description: "Positive issue or PR number for a get action" })),
        page: Type.Optional(Type.Number({ description: "Page number (1–100); list actions return up to 20 results" })),
        state: Type.Optional(Type.String({ description: "open (default), closed, or all for list actions" })),
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await read(cwd, params);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
        } catch (error) {
          return { content: [{ type: "text", text: error instanceof Error ? error.message : "GitHub read failed" }], details: undefined, isError: true };
        }
      },
    }));
  } };
}
