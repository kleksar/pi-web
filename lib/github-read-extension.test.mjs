import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { createGitHubReadExtension, githubRepositoryFromRemote, readGitHubOrigin } from "./github-read-extension.ts";

test("GitHub reader accepts only an origin on github.com", () => {
  assert.equal(githubRepositoryFromRemote("https://github.com/example/repo.git\n"), "example/repo");
  assert.equal(githubRepositoryFromRemote("git@github.com:example/repo.git"), "example/repo");
  assert.equal(githubRepositoryFromRemote("ssh://git@github.com/example/repo"), "example/repo");
  for (const remote of ["https://github.com.evil.test/example/repo", "https://gitlab.com/example/repo",
    "https://github.com/example/repo/other", "git@github.com:example/../repo",
    "https://github.com/example/repo?token=secret"]) {
    assert.equal(githubRepositoryFromRemote(remote), null, remote);
  }
});

test("read operations use GET paths under the origin and separate issues from PRs", async () => {
  const paths = [];
  const dependencies = { getOrigin: async () => "git@github.com:example/repo.git",
    get: async (path) => {
      paths.push(path);
      return [{ number: 1, title: "Issue", state: "open", html_url: "https://github.com/example/repo/issues/1" },
        { number: 2, title: "PR", state: "open", pull_request: {}, html_url: "https://github.com/example/repo/pull/2" }];
    } };
  const issues = await readGitHubOrigin("/any/project", { action: "list_issues" }, dependencies);
  assert.equal(issues.repository, "example/repo");
  assert.deepEqual(issues.items.map((item) => item.number), [1]);
  assert.equal(issues.hasMore, false);
  assert.match(issues.fetchedAt, /^\d{4}-/);
  const prs = await readGitHubOrigin("/any/project", { action: "list_pull_requests", page: 3, state: "closed" }, dependencies);
  assert.equal(prs.items.length, 2);
  assert.deepEqual(paths, ["/repos/example/repo/issues?state=open&per_page=20&page=1",
    "/repos/example/repo/pulls?state=closed&per_page=20&page=3"]);
});

test("a page containing only PR entries does not imply that no issues remain", async () => {
  const issues = await readGitHubOrigin("/any/project", { action: "list_issues" }, {
    getOrigin: async () => "https://github.com/example/repo.git",
    get: async () => Array.from({ length: 20 }, (_, index) => ({ number: index + 1, pull_request: {} })),
  });
  assert.deepEqual(issues.items, []);
  assert.equal(issues.hasMore, true);
});

test("invalid inputs and non-GitHub origins never issue an HTTP request", async () => {
  let requests = 0;
  const dependencies = { getOrigin: async () => "https://github.com/example/repo.git",
    get: async () => { requests++; return {}; } };
  for (const input of [{ action: "delete_issue", number: 1 }, { action: "get_issue", number: 0 },
    { action: "get_pull_request", number: 1.5 }, { action: "list_issues", page: 101 },
    { action: "list_pull_requests", state: "merged" }]) {
    await assert.rejects(readGitHubOrigin("/any/project", input, dependencies));
  }
  await assert.rejects(readGitHubOrigin("/any/project", { action: "list_issues" }, {
    ...dependencies, getOrigin: async () => "git@gitlab.com:example/repo.git" }));
  assert.equal(requests, 0);
});

test("individual PRs include bounded details and the inline tool exposes only github_read", async () => {
  const result = await readGitHubOrigin("/any/project", { action: "get_pull_request", number: 42 }, {
    getOrigin: async () => "https://github.com/example/repo.git",
    get: async (path) => {
      assert.equal(path, "/repos/example/repo/pulls/42");
      return { number: 42, title: "Change", body: "x".repeat(20_000), head: { ref: "feature" },
        base: { ref: "main" }, html_url: "https://github.com/example/repo/pull/42" };
    },
  });
  assert.equal(result.item.body.length, 16_000);
  assert.equal(result.item.bodyTruncated, true);
  assert.equal(result.item.head, "feature");
  const tools = [];
  createGitHubReadExtension("/any/project", async (_cwd, params) => ({ action: params.action }))
    .factory({ registerTool: (tool) => tools.push(tool) });
  assert.deepEqual(tools.map((tool) => tool.name), ["github_read"]);
  const response = await tools[0].execute("call", { action: "list_issues" });
  assert.deepEqual(JSON.parse(response.content[0].text), { action: "list_issues" });
});

test("a leaf with external extensions disabled still loads only the inline GitHub reader", async () => {
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: join(process.cwd(), ".test-agent"),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [createGitHubReadExtension(process.cwd())] });
  await loader.reload();
  const extensions = loader.getExtensions();
  assert.deepEqual(extensions.errors, []);
  assert.deepEqual(extensions.extensions.flatMap((extension) => [...extension.tools.keys()]), ["github_read"]);
});
