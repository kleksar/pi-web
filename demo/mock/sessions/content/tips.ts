import { PROJECT_ROOT } from "../../paths";
import { SESSION_IDS } from "../ids";
import type { SessionScript } from "../types";

const GIT_LOG_OUTPUT = `79c2a44 chore(deps): trim the production install and bump next, semver, undici (#948)
040fadd Release v0.9.2
234e19e perf(session): #928 + #912 rebased onto main, with fixes (#940)
1bd40e4 feat(minimap): show a per-turn tool-call count in the hover preview (#939)
058341d feat(models): add a manual "Refresh catalog" button to the Models panel (#914) (#938)`;

const GIT_STATUS_OUTPUT = `On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
	modified:   README.md
	modified:   components/AppShell.tsx

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	lib/format-duration.test.mjs
	lib/format-duration.ts

no changes added to commit (use "git add" and/or "git commit -a")`;

export const tipsSession: SessionScript = {
  id: SESSION_IDS.tips,
  cwd: PROJECT_ROOT,
  startedMinutesAgo: 5 * 24 * 60 + 30,
  name: "Composer tips: /commands, !shell, shortcuts",
  steps: [
    { kind: "model", provider: "deepseek", modelId: "deepseek-flash" },
    { kind: "thinking", level: "low" },
    {
      kind: "user",
      gapMinutes: 0.1,
      text: "What landed in the last few commits?",
    },
    {
      kind: "assistant",
      rounds: [
        {
          seconds: 3,
          tools: [{ name: "bash", args: { command: "git log --oneline -5" }, result: GIT_LOG_OUTPUT }],
        },
        {
          seconds: 7,
          text: "The latest release is **v0.9.2**. Since then: a leaner production install with dependency bumps (#948). Before the release: faster session loading (#940), per-turn tool-call counts in the minimap preview (#939), and a **Refresh catalog** button in the Models panel (#938).",
        },
      ],
    },
    {
      kind: "compaction",
      tokensBefore: 186_420,
      summary: `## Goal
Get familiar with the pi-web repository and its recent history.

## Progress
- Reviewed the last five commits: v0.9.2 release, faster session loading (#940), minimap tool-call counts (#939), "Refresh catalog" in the Models panel (#938), leaner production install (#948).
- Walked through \`components/\`, \`lib/\` and \`app/api/\` to map UI components to their API routes.

## Next steps
- Learn the composer shortcuts and commands.`,
    },
    { kind: "bash", command: "git status", output: GIT_STATUS_OUTPUT, gapMinutes: 40 },
    {
      kind: "user",
      gapMinutes: 1,
      text: "I just ran `!git status` from the composer — neat. What other composer tricks should I know?",
    },
    {
      kind: "assistant",
      rounds: [
        {
          seconds: 12,
          text: `Here's the cheat sheet:

| Type | What happens |
| --- | --- |
| \`/\` | Command menu: \`/compact\`, \`/auto-compact\`, \`/name\`, \`/session\`, \`/copy\`, \`/clone\`, \`/reload\`, plus \`/skill:…\` and your prompt templates |
| \`@\` | Mention a file or folder; \`@path:12-20\` points at a line range |
| \`!cmd\` | Run a shell command in the project; the output joins the conversation (like the \`git status\` above) |
| \`!!cmd\` | Same, but the output stays **out** of the model's context |
| Paste or drop an image | Attach it to the message |

**Keys:** Enter sends, Shift+Enter adds a line, Esc stops a running agent, Ctrl+Alt+N starts a new session in the current project.

**While the agent is running** you can keep typing: **Steer** interrupts and injects your message now, **Follow-up** (Alt+Enter) queues it for after the current run.

**Also worth knowing**
- The tool preset button switches between *Chat only*, read-only tools, the default four (\`read\`, \`bash\`, \`edit\`, \`write\`) and the full set.
- The divider above marks a **compaction**: older turns were summarized to free up context. \`/compact\` does it on demand; expand the divider to read the summary.
- **Settings → General → Chat** can show *Ask here* / *Ask in new chat* actions when you select text in a reply.
- **Settings → General** has themes (Light, Dark, Mist, Rose, Pine or System), chat width and font size.
- The search button above the session list searches **all** conversations; the strip on the right of the chat is a minimap for long sessions.
- On a phone, add Pi Web to the home screen and turn on push notifications to hear when a long run finishes.`,
        },
      ],
    },
  ],
};
