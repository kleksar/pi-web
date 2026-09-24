import { PROJECT_ROOT } from "../../paths";
import { SESSION_IDS } from "../ids";
import type { SessionScript } from "../types";

export const filesSession: SessionScript = {
  id: SESSION_IDS.files,
  cwd: PROJECT_ROOT,
  startedMinutesAgo: 95,
  name: "Files, @mentions and diffs",
  steps: [
    { kind: "model", provider: "claude-gateway", modelId: "claude-sonnet-5" },
    { kind: "thinking", level: "high" },
    {
      kind: "user",
      gapMinutes: 0.1,
      text: "@README.md What does this project do? Keep it short.",
    },
    {
      kind: "assistant",
      rounds: [
        {
          thinking: "The user mentioned README.md with an @-mention, so read it first and summarize the main points in a few bullets.",
          seconds: 4,
          tools: [{ name: "read", args: { path: "README.md" }, result: { readFile: "README.md" } }],
        },
        {
          seconds: 11,
          text: `**Pi Web** is a local browser UI for the [pi coding agent](https://github.com/earendil-works/pi). In short:

- **Same data as the CLI** — it reads and writes \`~/.pi/agent\`, so sessions, models and credentials are shared with \`pi\` in your terminal.
- **Session workspace** — browse, resume, rename, export and delete conversations grouped by project, with cost and context usage.
- **Branching** — *New session* forks into a new file; *Edit from here* branches inside the same session.
- **Project tools** — file explorer, uploads, Git diffs, previews (Markdown, images, PDF, DOCX…) and Git worktrees.
- **Web configuration** — provider login, API keys, models, skills and plugins without leaving the browser.

Start it with \`npx @agegr/pi-web@latest\`; it listens on \`127.0.0.1:30141\` by default.`,
        },
      ],
    },
    {
      kind: "user",
      gapMinutes: 2,
      text: "Add a tip under **Quick Start** that points people to `pi-web --help`.",
    },
    {
      kind: "assistant",
      rounds: [
        {
          thinking: "A one-line blockquote right under the Quick Start heading keeps the steps below it intact. Use a single targeted edit.",
          seconds: 5,
          tools: [{ name: "edit", args: {}, result: { editKey: "readme-help-tip" } }],
        },
        {
          seconds: 4,
          text: `Done — added a tip under **Quick Start** in \`README.md\`.

You can check it three ways:

- Expand the **edit** card above to see the diff of this change.
- Click the **changed files** button next to *Explorer* in the sidebar: \`README.md\` is listed as modified, and clicking it opens a side-by-side **Diff**.
- The \`README.md\` tab on the right already shows the new line — open files refresh automatically when the agent changes them.`,
        },
      ],
    },
    {
      kind: "user",
      gapMinutes: 3,
      text: "How do I open files and point you at specific lines?",
    },
    {
      kind: "assistant",
      rounds: [
        {
          seconds: 14,
          text: `A few ways, from quickest to most precise:

**Open and browse**
- Click a file in the **Explorer** (bottom-left) to open it in a tab on the right. Folders expand in place; the 🔍 button searches every file in the project.
- Markdown opens as a rendered **Preview**; switch to **Source** in the viewer toolbar. Images, audio, video, PDF and DOCX get native previews.
- The ⤢ button in the tab bar expands the file panel to full width; drag its left edge to resize.

**Point me at files**
- Type \`@\` in the composer and start typing a path — for example \`@lib/tool\` — then pick a match. Folders work too.
- Hover a file in the explorer and click **mention** to insert it, or drag files into the composer.

**Point me at lines**
- Open a file in **Source** mode, select the lines you care about, and click the **@** button in the viewer toolbar. It inserts a reference like \`@components/ChatInput.tsx:224-232\`, and I'll read exactly that range.

**Upload**
- Drop files on the explorer (or use the upload button) to copy them into the project, then mention them like any other file.`,
        },
      ],
    },
  ],
};
