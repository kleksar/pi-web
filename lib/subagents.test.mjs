import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-subagents-global-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const {
  deleteSubagentProfile,
  deleteProjectSubagentProfile,
  listSubagentProfileSources,
  listSubagentProfiles,
  readSubagentRun,
  readSubagentSessionResources,
  resolveSubagentProfile,
  saveSubagentProfile,
  saveProjectSubagentProfile,
  SUBAGENT_META_TYPE,
  SUBAGENT_STATUS_TYPE,
  SUBAGENT_RESULT_TYPE,
  withSubagentExtensionTools,
  selectSubagentExtensionTools,
  ORCHESTRATION_MAIN_ROLE,
} = await createJiti(import.meta.url).import("./subagents.ts");
const { isSubagentProfileOverridden } = await createJiti(import.meta.url).import("./subagent-profile-precedence.ts");
const { writeDisabledBuiltInSubagent } = await createJiti(import.meta.url).import("./subagent-settings.ts");

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function profile(overrides = {}) {
  return {
    name: "test-agent",
    displayName: " Test agent ",
    description: " Test description ",
    systemPrompt: " Test prompt. ",
    tools: ["read", "read", "unknown-tool"],
    loadSkills: false,
    loadExtensions: false,
    model: " provider/model ",
    thinking: "high",
    maxTurns: 4.9,
    inheritContext: false,
    runInBackground: false,
    enabled: true,
    ...overrides,
  };
}

test("built-in profile IDs use lowercase kebab-case and read-only profiles cannot execute shell commands", () => {
  const profiles = listSubagentProfiles(testAgentDir);
  for (const builtin of profiles.filter((item) => item.scope === "builtin")) {
    assert.match(builtin.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
  for (const name of ["explore", "plan"]) {
    const builtin = profiles.find((item) => item.name === name);
    assert.deepEqual(builtin.tools, ["read", "grep", "find", "ls"]);
    assert.equal(builtin.tools.includes("bash"), false);
  }
});

test("orchestration roles are opt-in, globally available across project cwds, and keep the strong owner", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-roster-"));
  try {
    assert.equal(resolveSubagentProfile(cwd, "orchestration-task-owner"), undefined);
    const roster = listSubagentProfiles(cwd, { orchestrationEnabled: true })
      .filter((item) => item.name.startsWith("orchestration-"));
    assert.equal(roster.length, 10);
    const owner = resolveSubagentProfile(cwd, "orchestration-task-owner", { orchestrationEnabled: true });
    assert.equal(owner.model, "openai-codex/gpt-6-astra");
    assert.equal(owner.thinking, "high");
    assert.equal(owner.fastMode, false);
    assert.equal(owner.allowedSubagents.length, 9);
    assert.equal(owner.allowedSubagents.includes("orchestration-task-owner"), false);
    assert.deepEqual(owner.tools, ["read", "grep", "find", "ls"]);
    const writer = resolveSubagentProfile(cwd, "orchestration-package-writer", { orchestrationEnabled: true });
    assert.deepEqual(writer.tools, ["read", "grep", "find", "ls"]);
    assert.equal(writer.systemPrompt.includes("apply_exact_patch"), true);
    const reviewer = resolveSubagentProfile(cwd, "orchestration-change-reviewer", { orchestrationEnabled: true });
    assert.equal(reviewer.model, "openai-codex/gpt-6-astra");
    assert.deepEqual(reviewer.tools, ["read", "grep", "find", "ls"]);
    assert.equal(ORCHESTRATION_MAIN_ROLE.model, "openai-codex/gpt-6-luna");
    assert.equal(ORCHESTRATION_MAIN_ROLE.fastMode, true);
    for (const role of roster.filter((item) => item.model?.endsWith("gpt-6-luna"))) {
      assert.equal(role.fastMode, true);
      assert.deepEqual(role.allowedSubagents, undefined);
    }

    // Project files do not get to impersonate the host-owned opted-in roster.
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(join(cwd, ".pi", "agents", "orchestration-task-owner.md"),
      "---\nmodel: openai-codex/gpt-6-luna\norchestration_children: [general-purpose]\n---\nImpersonated owner.\n");
    assert.equal(resolveSubagentProfile(cwd, "orchestration-task-owner", { orchestrationEnabled: true }).model,
      "openai-codex/gpt-6-astra");
    assert.equal(resolveSubagentProfile(cwd, "orchestration-task-owner", { orchestrationEnabled: true }).scope,
      "builtin");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("override detection follows scope precedence case-insensitively", () => {
  const builtin = { name: "Reviewer", scope: "builtin" };
  const global = { name: "reviewer", scope: "global" };
  const workspace = { name: "REVIEWER", scope: "workspace" };
  const project = { name: "Reviewer", scope: "project" };
  const unrelated = { name: "other", scope: "builtin" };
  const profiles = [builtin, global, workspace, project, unrelated];

  assert.equal(isSubagentProfileOverridden(builtin, profiles), true);
  assert.equal(isSubagentProfileOverridden(global, profiles), true);
  assert.equal(isSubagentProfileOverridden(workspace, profiles), true);
  assert.equal(isSubagentProfileOverridden(project, profiles), false);
  assert.equal(isSubagentProfileOverridden(unrelated, profiles), false);
});

test("project profiles override built-ins and round-trip their runtime settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    saveProjectSubagentProfile(cwd, {
      name: "Explore",
      displayName: "Repository scout",
      description: "Inspect this repository",
      systemPrompt: "Read carefully and report findings.",
      tools: ["read", "grep"],
      loadSkills: true,
      loadExtensions: true,
      model: "anthropic/test-model",
      thinking: "high",
      maxTurns: 8,
      inheritContext: true,
      runInBackground: true,
      enabled: true,
    });

    const profile = listSubagentProfiles(cwd).find((item) => item.name === "Explore");
    assert.equal(profile.scope, "project");
    assert.equal(profile.displayName, "Repository scout");
    assert.deepEqual(profile.tools, ["read", "grep"]);
    assert.equal(profile.loadSkills, true);
    assert.equal(profile.loadExtensions, true);
    assert.equal(profile.thinking, "high");
    assert.equal(profile.maxTurns, 8);
    assert.equal(profile.inheritContext, true);
    assert.equal(profile.runInBackground, true);

    const source = await readFile(join(cwd, ".pi", "agents", "Explore.md"), "utf8");
    assert.match(source, /max_turns: 8/);
    assert.match(source, /load_skills: true/);
    assert.match(source, /load_extensions: true/);
    assert.match(source, /Read carefully and report findings\./);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("tintinweb extension selectors stay scoped to the selected extension tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "legacy.md"),
      "---\ndescription: Legacy\ntools: read, ext:mcp/search, write\ndisallowed_tools: write\n---\nInspect only.\n",
    );
    const profile = listSubagentProfiles(cwd).find((item) => item.name === "legacy");
    assert.deepEqual(profile.tools, ["read"]);
    assert.deepEqual(profile.extensionTools, ["ext:mcp/search"]);
    assert.equal(profile.loadSkills, false);
    assert.equal(profile.loadExtensions, true);
    const extensions = [
      { path: "/tmp/mcp/index.ts", sourceInfo: { source: "mcp" }, tools: new Map([["search", {}], ["admin", {}]]) },
      { path: "/tmp/other/index.ts", sourceInfo: { source: "other" }, tools: new Map([["search", {}]]) },
    ];
    assert.deepEqual(selectSubagentExtensionTools(extensions, profile.extensionTools), ["search"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reads tintinweb profile aliases and frontmatter identity", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-tintin-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(join(cwd, ".pi", "agents", "review.md"), `---
name: security-review
color: cyan
skills: true
extensions: false
prompt_mode: replace
isolation: worktree
persist_session: false
disallowed_tools: bash
---
Review securely.
`);
    const profile = resolveSubagentProfile(cwd, "security-review");
    assert.equal(profile.name, "security-review");
    assert.equal(profile.loadSkills, true);
    assert.equal(profile.loadExtensions, false);
    assert.equal(profile.promptMode, "replace");
    assert.equal(profile.color, "cyan");
    assert.equal(profile.isolation, "worktree");
    assert.equal(profile.persistSession, false);
    assert.equal(profile.tools.includes("bash"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("persisted subagent metadata reconstructs the final run", () => {
  const entries = [
    {
      type: "custom",
      customType: SUBAGENT_META_TYPE,
      id: "meta",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      data: {
        version: 1,
        parentSessionId: "parent",
        parentSessionPath: "/tmp/parent.jsonl",
        parentToolCallId: "tool-call",
        profile: "Explore",
        description: "Find the parser",
        task: "Locate parser code",
        runInBackground: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      type: "custom",
      customType: SUBAGENT_RESULT_TYPE,
      id: "result",
      parentId: "meta",
      timestamp: "2026-01-01T00:01:00.000Z",
      data: {
        version: 1,
        status: "completed",
        completedAt: "2026-01-01T00:01:00.000Z",
        result: "Located it.",
      },
    },
  ];

  assert.deepEqual(readSubagentRun(entries, "child", "/tmp/child.jsonl"), {
    sessionId: "child",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent",
    parentToolCallId: "tool-call",
    profile: "Explore",
    description: "Find the parser",
    task: "Locate parser code",
    runInBackground: true,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: "Located it.",
  });
  assert.equal(readSubagentRun(entries, "child", "/tmp/child.jsonl", "/tmp/unrelated-parent.jsonl"), null);
  assert.equal(readSubagentRun(entries, "child", "/tmp/child.jsonl", ""), null);
  const optedIn = [{ ...entries[0], data: {
    ...entries[0].data, orchestrationEnabled: true, subagentSessionId: "child", rootTaskId: "task-1",
  } }, entries[1]];
  assert.equal(readSubagentRun(optedIn, "fork-copy", "/tmp/fork.jsonl"), null);
  assert.equal(readSubagentRun(optedIn, "child", "/tmp/child.jsonl").rootTaskId, "task-1");
  const forkEntries = [...entries, {
    type: "custom", customType: "pi-web:fork-cost-baseline",
    data: { version: 2, sessionId: "fork-copy" },
  }];
  assert.equal(readSubagentRun(forkEntries, "fork-copy", "/tmp/fork.jsonl", "/tmp/parent.jsonl"), null);
});

test("persisted subagent resources restore the exact isolated prompt and tools", () => {
  const entries = [{
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    id: "meta",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      profile: "reviewer",
      resourceSnapshot: {
        version: 1,
        appendSystemPrompt: ["Review carefully.", "Inherited parent context."],
        tools: ["read", "grep", "web_search", "read"],
        loadSkills: true,
        loadExtensions: true,
      },
    },
  }];

  assert.deepEqual(readSubagentSessionResources(entries), {
    appendSystemPrompt: ["Review carefully.", "Inherited parent context."],
    tools: ["read", "grep", "web_search"],
    loadSkills: true,
    loadExtensions: true,
  });
});

test("legacy subagent resource snapshots keep skills and extensions disabled", () => {
  const entries = [{
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      resourceSnapshot: {
        version: 1,
        appendSystemPrompt: ["Stay focused."],
        tools: ["read"],
      },
    },
  }];

  assert.deepEqual(readSubagentSessionResources(entries), {
    appendSystemPrompt: ["Stay focused."],
    tools: ["read"],
    loadSkills: false,
    loadExtensions: false,
  });
});

test("persisted delegation is explicit and legacy or malformed snapshots cannot gain control tools", () => {
  const record = (snapshot, metadata = {}) => [{
    type: "custom", customType: SUBAGENT_META_TYPE,
    data: { version: 1, parentSessionId: "parent", parentSessionPath: "/tmp/parent", resourceSnapshot: snapshot, ...metadata },
  }];
  const base = { version: 1, appendSystemPrompt: [], tools: ["read"], loadSkills: false, loadExtensions: false };
  assert.equal(readSubagentSessionResources(record(base)).allowedSubagents, undefined);
  assert.equal(readSubagentSessionResources(record({ ...base, tools: ["Agent"], loadExtensions: true })), null);
  const ownerSnapshot = {
    ...base, tools: ["read", "Agent", "get_subagent_results"],
    allowedSubagents: ["orchestration-code-reader"], fastMode: false,
  };
  assert.equal(readSubagentSessionResources(record(ownerSnapshot)), null);
  const owner = readSubagentSessionResources(record(ownerSnapshot,
    { profile: "orchestration-task-owner", orchestrationEnabled: true, subagentSessionId: "owner" }));
  assert.deepEqual(owner.allowedSubagents, ["orchestration-code-reader"]);
  assert.deepEqual(owner.tools, ["read", "Agent", "get_subagent_results"]);
  assert.throws(() => readSubagentSessionResources(record(ownerSnapshot,
    { profile: "orchestration-task-owner", orchestrationEnabled: true })), /Invalid persisted subagent session identity/);
  assert.throws(() => readSubagentSessionResources(record({
    ...base, allowedSubagents: ["../escape"], tools: ["Agent"],
  })), /Invalid persisted subagent resource policy/);
  assert.throws(() => readSubagentSessionResources(record({ ...base, fastMode: "true" })),
    /Invalid persisted subagent resource policy/);
});

test("bounded writer scope and pinned snapshot survive reopen, while arbitrary paths fail closed", () => {
  const record = (snapshot) => [{
    type: "custom", customType: SUBAGENT_META_TYPE,
    data: {
      version: 1, parentSessionId: "parent", parentSessionPath: "/tmp/parent",
      profile: "orchestration-package-writer", orchestrationEnabled: true, subagentSessionId: "writer",
      resourceSnapshot: snapshot,
    },
  }];
  const snapshot = {
    version: 1, appendSystemPrompt: [], tools: ["read", "apply_exact_patch", "read_evidence"],
    loadSkills: false, loadExtensions: false,
    writerAllowedPaths: ["lib/file.ts"], writerProjectFingerprint: "fingerprint-1",
    writerExpectedSnapshotId: "snapshot-1", fastMode: true,
  };
  assert.deepEqual(readSubagentSessionResources(record(snapshot)), {
    appendSystemPrompt: [], tools: ["read", "apply_exact_patch", "read_evidence"],
    loadSkills: false, loadExtensions: false,
    fastMode: true, writerAllowedPaths: ["lib/file.ts"],
    writerProjectFingerprint: "fingerprint-1", writerExpectedSnapshotId: "snapshot-1",
  });
  for (const unsafe of ["../secret", "/abs/path", "lib/../escape", "C:\\secret", "lib/*.ts"]) {
    assert.throws(() => readSubagentSessionResources(record({ ...snapshot, writerAllowedPaths: [unsafe] })),
      /Invalid persisted subagent resource policy/);
  }
  assert.throws(() => readSubagentSessionResources(record({ ...snapshot, writerAllowedPaths: undefined })),
    /Invalid persisted subagent resource policy/);
  assert.equal(readSubagentSessionResources(record({ ...snapshot, tools: ["run_check"] })), null);
});

test("reopened orchestration sessions retain only the host tools allowed to their exact role", () => {
  const read = (profile, tools) => readSubagentSessionResources([{
    type: "custom", customType: SUBAGENT_META_TYPE,
    data: {
      version: 1, parentSessionId: "parent", parentSessionPath: "/tmp/parent",
      profile, orchestrationEnabled: true, subagentSessionId: "role-session",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools, loadSkills: false, loadExtensions: false },
    },
  }]);
  assert.deepEqual(read("orchestration-code-reader", ["read", "capture_evidence", "project_context"]).tools,
    ["read", "capture_evidence", "project_context"]);
  assert.equal(read("orchestration-code-reader", ["submit_review"]), null);
  assert.deepEqual(read("orchestration-task-owner", ["run_check", "assess_acceptance"]).tools,
    ["run_check", "assess_acceptance"]);
  assert.equal(read("orchestration-change-reviewer", ["run_check"]), null);
  assert.deepEqual(read("orchestration-change-reviewer", ["read_change_manifest", "submit_review"]).tools,
    ["read_change_manifest", "submit_review"]);
  assert.equal(read("orchestration-package-writer", ["submit_review"]), null);
});

test("Pi Web delegation and Fast are opt-in without adopting foreign allowed_subagents", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-roster-policy-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const path = join(cwd, ".pi", "agents", "thirdparty.md");
    await writeFile(path, "---\nname: thirdparty\ntools: read\nallowed_subagents: [general-purpose]\n---\nInspect.\n");
    const thirdParty = resolveSubagentProfile(cwd, "thirdparty");
    assert.equal(thirdParty.fastMode, false);
    assert.equal(thirdParty.allowedSubagents, undefined);
    const saved = saveProjectSubagentProfile(cwd, {
      ...thirdParty, fastMode: true, allowedSubagents: ["code-reader", "CODE-READER"],
    });
    assert.deepEqual(saved.allowedSubagents, ["CODE-READER"]);
    assert.equal(saved.fastMode, true);
    const loaded = resolveSubagentProfile(cwd, "thirdparty");
    assert.deepEqual(loaded.allowedSubagents, ["CODE-READER"]);
    assert.equal(loaded.fastMode, true);
    const text = await readFile(path, "utf8");
    assert.match(text, /allowed_subagents:[\s\S]*general-purpose/);
    assert.match(text, /orchestration_children:[\s\S]*CODE-READER/);
    assert.match(text, /pi_web_fast_mode: true/);
    assert.throws(() => saveProjectSubagentProfile(cwd,
      { ...thirdParty, allowedSubagents: ["../escape"] }), /valid agent names/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("extension tools are merged while subagent control tools stay excluded", () => {
  assert.deepEqual(
    withSubagentExtensionTools(
      ["read"],
      ["web_search", "Agent", "get_subagent_result", "get_subagent_results", "steer_subagent", "web_search"],
    ),
    ["read", "web_search"],
  );
});

test("an empty tool selection round-trips without restoring default tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const saved = saveProjectSubagentProfile(cwd, profile({ tools: [] }));
    const loaded = listSubagentProfiles(cwd).find((item) => item.name === saved.name);
    const source = await readFile(join(cwd, ".pi", "agents", `${saved.name}.md`), "utf8");

    assert.deepEqual(saved.tools, []);
    assert.deepEqual(loaded.tools, []);
    assert.match(source, /tools: none/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("saved profiles normalize runtime values and reject invalid settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const saved = saveProjectSubagentProfile(cwd, profile());
    assert.equal(saved.displayName, "Test agent");
    assert.equal(saved.description, "Test description");
    assert.equal(saved.systemPrompt, "Test prompt.");
    assert.deepEqual(saved.tools, ["read"]);
    assert.equal(saved.model, "provider/model");
    assert.equal(saved.maxTurns, 4);
    assert.equal(saved.loadSkills, false);
    assert.equal(saved.loadExtensions, false);

    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ name: "../escape" })),
      /Agent name may contain only/,
    );
    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ thinking: "extreme" })),
      /Invalid thinking level/,
    );
    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ maxTurns: Number.POSITIVE_INFINITY })),
      /Max turns must be a non-negative number/,
    );
    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ maxTurns: -1 })),
      /Max turns must be a non-negative number/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project profiles override workspace profiles and deletion restores the workspace version", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".agents", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents", "agents", "test-agent.md"),
      "---\ndescription: Workspace version\ntools: read\n---\nWorkspace prompt.\n",
    );
    saveProjectSubagentProfile(cwd, profile({ description: "Project version" }));
    assert.equal(resolveSubagentProfile(cwd, "TEST-AGENT").description, "Project version");

    deleteProjectSubagentProfile(cwd, "test-agent");
    const restored = resolveSubagentProfile(cwd, "test-agent");
    assert.equal(restored.scope, "workspace");
    assert.equal(restored.description, "Workspace version");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("global and project sources with the same name stay visible while project wins at runtime", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    saveSubagentProfile(cwd, "global", profile({ description: "Global version" }));
    saveSubagentProfile(cwd, "project", profile({ description: "Project version" }));

    const sources = listSubagentProfileSources(cwd)
      .filter((item) => item.name === "test-agent")
      .sort((a, b) => a.scope.localeCompare(b.scope));
    assert.deepEqual(sources.map((item) => item.scope), ["global", "project"]);
    assert.deepEqual(sources.map((item) => item.description), ["Global version", "Project version"]);

    const effective = resolveSubagentProfile(cwd, "test-agent");
    assert.equal(effective.scope, "project");
    assert.equal(effective.description, "Project version");
  } finally {
    deleteSubagentProfile(cwd, "global", "test-agent");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("global profiles round-trip and deleting an override restores the built-in", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const saved = saveSubagentProfile(cwd, "global", profile({
      name: "Explore",
      displayName: "Global explorer",
      description: "Global override",
      tools: ["read", "grep"],
    }));
    assert.equal(saved.scope, "global");
    assert.equal(saved.filePath, join(testAgentDir, "agents", "Explore.md"));
    assert.equal(resolveSubagentProfile(cwd, "Explore").scope, "global");
    assert.equal(resolveSubagentProfile(cwd, "Explore").description, "Global override");

    deleteSubagentProfile(cwd, "global", "Explore");
    const restored = resolveSubagentProfile(cwd, "Explore");
    assert.equal(restored.scope, "builtin");
    assert.equal(restored.displayName, "Explore");
  } finally {
    deleteSubagentProfile(cwd, "global", "Explore");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a built-in is switched off through settings.json, not a copied-out file", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    writeDisabledBuiltInSubagent("Explore", true);

    const builtin = listSubagentProfileSources(cwd).find((item) => item.scope === "builtin" && item.name === "explore");
    assert.equal(builtin.enabled, false);
    assert.equal(builtin.filePath, undefined);
    assert.equal(existsSync(join(testAgentDir, "agents", "explore.md")), false);
    assert.equal(resolveSubagentProfile(cwd, "explore"), undefined);
    // Only the named built-in is affected.
    assert.equal(resolveSubagentProfile(cwd, "plan").scope, "builtin");

    // A same-name file replaces the built-in outright, so its own `enabled` decides.
    saveSubagentProfile(cwd, "global", profile({ name: "explore", description: "Global override" }));
    const overriding = resolveSubagentProfile(cwd, "explore");
    assert.equal(overriding.scope, "global");
    assert.equal(overriding.description, "Global override");
    deleteSubagentProfile(cwd, "global", "explore");

    writeDisabledBuiltInSubagent("explore", false);
    assert.equal(resolveSubagentProfile(cwd, "explore").scope, "builtin");
  } finally {
    writeDisabledBuiltInSubagent("explore", false);
    deleteSubagentProfile(cwd, "global", "explore");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("disabled profiles cannot be resolved for execution", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    saveSubagentProfile(cwd, "global", profile({ description: "Global version" }));
    saveProjectSubagentProfile(cwd, profile({ enabled: false }));
    const sources = listSubagentProfileSources(cwd).filter((item) => item.name === "test-agent");
    const globalProfile = sources.find((item) => item.scope === "global");
    const projectProfile = sources.find((item) => item.scope === "project");

    assert.equal(isSubagentProfileOverridden(globalProfile, sources), true);
    assert.equal(isSubagentProfileOverridden(projectProfile, sources), false);
    assert.equal(resolveSubagentProfile(cwd, "test-agent"), undefined);
    assert.equal(listSubagentProfiles(cwd).find((item) => item.name === "test-agent").enabled, false);
  } finally {
    deleteSubagentProfile(cwd, "global", "test-agent");
    await rm(cwd, { recursive: true, force: true });
  }
});

test("persisted runs distinguish interrupted, failed, aborted, and latest results", () => {
  const meta = {
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    id: "meta",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "tool-call",
      profile: "Explore",
      description: "Inspect",
      task: "Inspect files",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  assert.equal(readSubagentRun([meta], "child", "/tmp/child.jsonl").status, "interrupted");

  const failed = {
    ...meta,
    id: "failed",
    customType: SUBAGENT_RESULT_TYPE,
    data: { version: 1, status: "failed", completedAt: "2026-01-01T00:01:00.000Z", error: "boom" },
  };
  const aborted = {
    ...failed,
    id: "aborted",
    data: { version: 1, status: "aborted", completedAt: "2026-01-01T00:02:00.000Z" },
  };
  assert.equal(readSubagentRun([meta, failed], "child", "/tmp/child.jsonl").status, "failed");
  assert.equal(readSubagentRun([meta, failed], "child", "/tmp/child.jsonl").error, "boom");
  assert.equal(readSubagentRun([meta, failed, aborted], "child", "/tmp/child.jsonl").status, "aborted");
  const resumed = { ...failed, id: "resumed", customType: SUBAGENT_STATUS_TYPE, data: { version: 1, status: "queued" } };
  assert.equal(readSubagentRun([meta, failed, resumed], "child", "/tmp/child.jsonl").status, "queued");
  assert.equal(readSubagentRun([{ ...meta, data: { version: 2 } }], "child", "/tmp/child.jsonl"), null);
});

test("project profile directories cannot escape cwd through symbolic links", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "pi-web-subagent-boundary-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, "project");
  const outside = join(base, "outside");
  await mkdir(join(cwd, ".agents"), { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secret.md"), "---\ndescription: Secret\n---\nprivate\n");

  try {
    await symlink(outside, join(cwd, ".agents", "agents"), process.platform === "win32" ? "junction" : "dir");
    await symlink(outside, join(cwd, ".pi", "agents"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.equal(listSubagentProfileSources(cwd).some((item) => item.name === "secret"), false);
  assert.equal(listSubagentProfiles(cwd).some((item) => item.name === "secret"), false);
  assert.throws(
    () => saveProjectSubagentProfile(cwd, profile({ name: "escaped" })),
    /outside the project root/,
  );
  assert.throws(
    () => deleteProjectSubagentProfile(cwd, "secret"),
    /outside the project root/,
  );
  assert.match(await readFile(join(outside, "secret.md"), "utf8"), /private/);
});

test("a save keeps frontmatter keys this app does not manage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const file = join(cwd, ".pi", "agents", "orchestrator.md");
    await writeFile(
      file,
      [
        "---",
        "name: orchestrator",
        "description: Hands out work",
        "display_name: orchestrator",
        "tools: read, bash, edit, write, grep, find, ls, ext:pi-advisor-flow/ask_advisor",
        "skills: false",
        "extensions: pi-advisor-flow",
        "exclude_extensions: pi-advisor-flow",
        "allowed_subagents: thinker, executor",
        "disallowed_tools: write",
        "enabled: true",
        "inherit_context: false",
        "run_in_background: false",
        "---",
        "Dispatch the work.",
      ].join("\n"),
    );

    saveProjectSubagentProfile(cwd, profile({ name: "orchestrator", tools: ["read", "bash"] }));
    const source = await readFile(file, "utf8");

    assert.match(source, /^name: orchestrator$/m);
    assert.match(source, /allowed_subagents: thinker, executor/);
    assert.match(source, /exclude_extensions: pi-advisor-flow/);
    assert.match(source, /disallowed_tools: write/);
    assert.match(source, /skills: false/);
    assert.match(source, /extensions: pi-advisor-flow/);
    assert.match(source, /tools: read, bash, ext:pi-advisor-flow\/ask_advisor/);
    assert.match(source, /Test prompt\./);

    const loaded = listSubagentProfiles(cwd).find((item) => item.name === "orchestrator");
    assert.deepEqual(loaded.tools, ["read", "bash"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a save refuses to overwrite malformed existing frontmatter", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const file = join(cwd, ".pi", "agents", "malformed.md");
    const source = "---\nallowed_subagents: [executor\n---\nKeep this file intact.\n";
    await writeFile(file, source);

    assert.throws(
      () => saveProjectSubagentProfile(cwd, profile({ name: "malformed" })),
      /existing frontmatter is invalid/,
    );
    assert.equal(await readFile(file, "utf8"), source);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the pi-subagents flag aliases are seeded, kept in step, and never overwrite a whitelist", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    const file = join(cwd, ".pi", "agents", "fresh.md");
    saveProjectSubagentProfile(cwd, profile({ name: "fresh", loadSkills: true, loadExtensions: true }));
    const seeded = await readFile(file, "utf8");
    assert.match(seeded, /load_skills: true/);
    assert.match(seeded, /skills: true/);
    assert.match(seeded, /load_extensions: true/);
    assert.match(seeded, /extensions: true/);

    saveProjectSubagentProfile(cwd, profile({ name: "fresh", loadSkills: false, loadExtensions: false }));
    const flipped = await readFile(file, "utf8");
    assert.match(flipped, /skills: false/);
    assert.match(flipped, /extensions: false/);

    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const scoped = join(cwd, ".pi", "agents", "scoped.md");
    await writeFile(scoped, "---\ndescription: Scoped\nextensions: pi-advisor-flow\n---\nOnly the advisor.\n");
    saveProjectSubagentProfile(cwd, profile({ name: "scoped", loadExtensions: true }));
    assert.match(await readFile(scoped, "utf8"), /extensions: pi-advisor-flow/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("profile flags fall back to the pi-subagents spellings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-web-subagents-"));
  try {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "legacy-flags.md"),
      "---\ndescription: Legacy flags\nskills: false\nextensions: pi-advisor-flow\n---\nScoped.\n",
    );

    const loaded = listSubagentProfiles(cwd).find((item) => item.name === "legacy-flags");
    assert.equal(loaded.loadSkills, false);
    assert.equal(loaded.loadExtensions, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
