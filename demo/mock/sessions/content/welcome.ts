import { PROJECT_ROOT } from "../../paths";
import { SESSION_IDS } from "../ids";
import type { SessionScript } from "../types";

export const welcomeSession: SessionScript = {
  id: SESSION_IDS.welcome,
  cwd: PROJECT_ROOT,
  startedMinutesAgo: 12,
  name: "👋 Welcome to Pi Web — a quick tour",
  steps: [
    { kind: "model", provider: "openai-codex", modelId: "gpt-5.5" },
    { kind: "thinking", level: "medium" },
    {
      kind: "user",
      gapMinutes: 0.2,
      text: "Hi! I just opened Pi Web for the first time. Can you give me a quick tour of this screen?",
    },
    {
      kind: "assistant",
      rounds: [
        {
          thinking: "The user is new to Pi Web. Walk through the four areas of the screen from left to right, and point at the README that is already open on the right so they have something concrete to look at.",
          seconds: 9,
          text: `Welcome! Pi Web is a browser UI for the **pi coding agent**. It reads the same \`~/.pi/agent\` sessions and settings as the pi CLI, so everything you do here also shows up in the terminal — and the other way round.

The screen has four areas:

| Area | What it's for |
| --- | --- |
| **Left sidebar** | Project picker and Git worktree switcher at the top, this **session list** in the middle, the **file explorer** at the bottom, and the **Models · Skills · Settings** buttons at the very bottom. |
| **Chat (center)** | The conversation. The composer below it picks the **model**, the **reasoning level** and the **tool preset**, and takes \`@file\` mentions, \`/\` commands, \`!\` shell commands and images. |
| **Top bar** | **Full history**, **Generate title**, **Branches**, **System** (the exact system prompt) and **Tools** (the tool definitions the model sees), plus tokens, cost and context usage for this session. |
| **Right panel** | Files and terminals in tabs. It is showing \`README.md\` right now — click any file in the explorer to open another one. |

\`\`\`mermaid
flowchart LR
  B["Browser<br/>(Pi Web UI)"] -- "HTTP + SSE" --> S["Pi Web server<br/>(Next.js)"]
  S -- "in-process" --> A["pi agent session"]
  A --> M["Model providers<br/>Codex · DeepSeek · Claude"]
  A --> F["Your project files<br/>and shell"]
  S -. "same files as the CLI" .- D[("~/.pi/agent")]
\`\`\`

Each session in the sidebar is a small hands-on tutorial. Open any of them — nothing you click here can break anything.`,
        },
      ],
    },
    {
      kind: "user",
      gapMinutes: 1.5,
      text: "Nice. What should I try first?",
    },
    {
      kind: "assistant",
      rounds: [
        {
          thinking: "Give a short, ordered checklist that touches each major feature and maps to the other tutorial sessions.",
          seconds: 6,
          text: `Here's a five-minute path through the demo:

1. **Browse the sessions** in the sidebar. They're sorted by activity and grouped by project — switch to the second project with the picker at the top of the sidebar.
2. **Open files.** Click \`package.json\` or \`app/page.tsx\` in the explorer. Markdown opens as a rendered preview; code opens with syntax highlighting. The **changed files** button (the small commit icon next to *Explorer*) lists what Git sees as modified.
3. **Type in the composer.** Try \`@READ\` to mention a file, \`/\` for slash commands, or \`!git log\` to run a shell command. Send any message and I'll answer with a streamed demo reply.
4. **Look behind the curtain.** Click **System** or **Tools** in the top bar to see exactly what the model receives.
5. **Check the settings.** **Models** shows a signed-in ChatGPT (Codex) account, a DeepSeek API key and a custom provider; **Settings** has themes and chat preferences.

> This page is a static demo — the replies are canned. To use Pi Web with your own agent, run:
>
> \`\`\`bash
> npx @agegr/pi-web@latest
> \`\`\``,
        },
      ],
    },
  ],
};
