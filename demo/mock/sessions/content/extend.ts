import { PROJECT_ROOT } from "../../paths";
import { SESSION_IDS } from "../ids";
import type { SessionScript } from "../types";

const STARTED = 3 * 24 * 60 + 40;

const GREP_OUTPUT = `components/SessionSidebar.tsx:169:const RUNNING_SESSIONS_POLL_MS = 2500;
components/SessionSidebar.tsx:596:      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
components/SessionSidebar.tsx:605:        const res = await fetch("/api/agent/running", {
app/api/agent/running/route.ts:10:// GET /api/agent/running - Lightweight snapshot for visible-tab polling.`;

const REPORT = `**Running-session polling lives in \`components/SessionSidebar.tsx\`.**

- \`RUNNING_SESSIONS_POLL_MS = 2500\` (line 169) sets the interval.
- The effect around line 590 defines \`poll()\`, which fetches \`GET /api/agent/running\` with \`cache: "no-store"\` and an \`AbortController\`, then schedules the next tick with \`setTimeout\`.
- Polling only runs while \`document.visibilityState === "visible"\`; a \`visibilitychange\` listener pauses it in background tabs and polls again immediately when the tab comes back.
- If the response's \`sessionListVersion\` differs from the last one seen, it reloads the full session list.
- Server side: \`app/api/agent/running/route.ts\` returns \`{ sessionListVersion, runningSessionIds, completionNotificationSuppressedSessionIds }\`.`;

const TASK = "Find where the Pi Web sidebar polls for running sessions: the interval, the endpoint it calls, and how it behaves in background tabs. Report file paths and line numbers. Do not modify files.";

export const extendSession: SessionScript = {
  id: SESSION_IDS.extend,
  cwd: PROJECT_ROOT,
  startedMinutesAgo: STARTED,
  name: "Skills, plugins and subagents",
  steps: [
    { kind: "model", provider: "openai-codex", modelId: "gpt-5.5" },
    { kind: "thinking", level: "medium" },
    {
      kind: "user",
      gapMinutes: 0.1,
      text: "What are skills and plugins, and how do I manage them in Pi Web?",
    },
    {
      kind: "assistant",
      rounds: [
        {
          thinking: "Explain skills, pi packages (plugins), project trust and subagents briefly, pointing at the relevant panels.",
          seconds: 13,
          text: `Both extend what the agent can do — they differ in how much they bring along.

**Skills** are folders with a \`SKILL.md\`: a name, a one-line description and instructions. Only the description goes into the system prompt; I read the full file when a task matches. This demo has two:

- \`frontend-design\` — the model may use it on its own.
- \`release-notes\` — **model invocation is off**, so it only runs when you type \`/skill:release-notes\`.

The **Skills** button at the bottom of the sidebar lists every loaded skill with that switch, and can search [skills.sh](https://skills.sh) and install new skills globally or into this project.

**Plugins** are pi packages from npm or git. One package can bundle **extensions** (new tools, commands, UI widgets), **skills**, **prompt templates** and **themes**. Open **Settings → Plugins** to install, update, disable or remove them, globally or per project.

**Project trust.** Skills, extensions and packages that come *with a repository* only load after you trust that project — Pi Web shows a warning in the top bar until you do.

**Subagents** are the third building block: I can hand a focused task to a separate agent. Want to see one in action?`,
        },
      ],
    },
    {
      kind: "user",
      gapMinutes: 1.5,
      text: "Yes — use a subagent to find where the sidebar polls for running sessions.",
    },
    {
      kind: "assistant",
      rounds: [
        {
          thinking: "A read-only search task: delegate to the built-in explore profile in the foreground, since I need the answer right away.",
          seconds: 5,
          tools: [{
            name: "Agent",
            args: { subagent_type: "explore", description: "Find running-session polling", prompt: TASK },
            result: `Subagent ${SESSION_IDS.extendSubagent} completed.\n\n${REPORT}`,
            details: {
              kind: "pi-web-subagent",
              sessionId: SESSION_IDS.extendSubagent,
              profile: "explore",
              description: "Find running-session polling",
              status: "completed",
              runInBackground: false,
              createdAt: "2026-09-20T10:00:00.000Z",
              completedAt: "2026-09-20T10:00:41.000Z",
            },
            seconds: 41,
          }],
        },
        {
          seconds: 10,
          text: `The explore subagent found it: the sidebar polls \`GET /api/agent/running\` every **2.5 s** from \`components/SessionSidebar.tsx\` (line 169 for the interval, ~line 605 for the fetch), pauses while the tab is hidden, and reloads the session list when \`sessionListVersion\` changes.

A few things to notice about how that ran:

- **It's a real session.** Click the arrow on the **Agent** card above, the **Agents** button in the top bar, or the child row under this session in the sidebar to read its full transcript and tool calls.
- **Profiles.** \`explore\` and \`plan\` are read-only; \`general-purpose\` can edit files. **Settings → Sub-agents** turns subagents on or off and lets you write your own profiles with their own prompt, tools and model.
- **Foreground or background.** This one ran in the foreground because I needed the answer. Background runs let me keep working and report back when they're done.`,
        },
      ],
    },
  ],
};

export const extendSubagentSession: SessionScript = {
  id: SESSION_IDS.extendSubagent,
  cwd: PROJECT_ROOT,
  startedMinutesAgo: STARTED - 3,
  relation: {
    kind: "subagent",
    parentSessionId: SESSION_IDS.extend,
    profile: "explore",
    description: "Find running-session polling",
    status: "completed",
  },
  steps: [
    { kind: "model", provider: "openai-codex", modelId: "gpt-5.6-luna" },
    { kind: "thinking", level: "low" },
    { kind: "tools", tools: ["read", "grep", "find", "ls"] },
    { kind: "user", gapMinutes: 0.05, text: TASK },
    {
      kind: "assistant",
      rounds: [
        {
          seconds: 3,
          tools: [{ name: "grep", args: { pattern: "RUNNING_SESSIONS_POLL_MS|/api/agent/running", path: "." }, result: GREP_OUTPUT }],
        },
        {
          seconds: 4,
          tools: [{ name: "read", args: { path: "components/SessionSidebar.tsx" }, result: { readFile: "components/SessionSidebar.tsx", anchor: "const poll = async () =>", anchorLinesBefore: 10, limit: 58 } }],
        },
        { seconds: 18, text: REPORT },
      ],
    },
  ],
};
