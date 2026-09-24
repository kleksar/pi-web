import { PROJECT_ROOT } from "../../paths";
import { SESSION_IDS } from "../ids";
import type { SessionScript, Step } from "../types";

const question: Step = {
  kind: "user",
  gapMinutes: 0.1,
  text: "Suggest a name for a CLI flag that stops pi-web from opening the browser on start.",
};

const firstAnswer: Step = {
  kind: "assistant",
  rounds: [
    {
      thinking: "Common conventions: --no-open (Vite, Next), --no-browser (Jupyter), --headless. Negated long flags read best.",
      seconds: 6,
      text: "I'd go with **`--no-open`**. It matches Vite and Next.js, reads naturally (`pi-web --no-open`), and leaves room for a matching environment variable such as `PI_WEB_NO_OPEN=1`. Alternatives: `--no-browser` (Jupyter's name) or `--headless`, which suggests more than it does.",
    },
  ],
};

/** Shared by the branching session and the session forked from it. */
export const branchingPrefix: Step[] = [
  { kind: "model", provider: "openai-codex", modelId: "gpt-5.6-terra" },
  { kind: "thinking", level: "low" },
  question,
  firstAnswer,
];

export const branchingSession: SessionScript = {
  id: SESSION_IDS.branching,
  cwd: PROJECT_ROOT,
  startedMinutesAgo: 26 * 60,
  name: "Branching: edit from here vs. new session",
  steps: [
    ...branchingPrefix,
    { kind: "mark", name: "answer" },
    {
      kind: "user",
      gapMinutes: 1,
      text: "Something shorter?",
    },
    {
      kind: "assistant",
      rounds: [
        {
          seconds: 3,
          text: "Shortest reasonable option: **`-n`**. But single letters are easy to collide with later flags, so I'd keep `--no-open` as the long form and add `-n` only as an alias if you really want it.",
        },
      ],
    },
    { kind: "rewind", to: "answer", gapMinutes: 4 },
    {
      kind: "user",
      text: "Actually — keep it consistent with the options pi-web already has, and explain how this branching works.",
    },
    {
      kind: "assistant",
      rounds: [
        {
          thinking: "Check the existing option parser to match its style, then explain the two branching modes.",
          seconds: 4,
          tools: [{ name: "read", args: { path: "bin/pi-web-options.js" }, result: { readFile: "bin/pi-web-options.js", limit: 50 } }],
        },
        {
          seconds: 16,
          text: `\`bin/pi-web-options.js\` already uses \`--no-open\` together with \`PI_WEB_NO_OPEN=1\`, so the consistent answer is to keep exactly that.

**About the branching you just did.** You edited an earlier message instead of continuing the thread, so this session now has **two branches**:

\`\`\`text
Suggest a name for a CLI flag…
└─ I'd go with --no-open…
   ├─ Something shorter?                       ← branch 1
   └─ Actually — keep it consistent…           ← branch 2 (you are here)
\`\`\`

Pi Web offers two ways to branch — hover any of your messages to see them:

| | **Edit from here** | **New session** |
| --- | --- | --- |
| Where it goes | A new branch **inside this session file** | A **new session file**, copied up to that point |
| Good for | Trying another prompt without losing the old answer | Taking the conversation in a separate direction |
| How to switch | **Branches** in the top bar | Open it from the sidebar — it's listed like any other session |

Try it now: open **Branches** in the top bar and click the *Something shorter?* branch, then come back. A session forked with **New session** from this one is in the sidebar as well.`,
        },
      ],
    },
  ],
};

export const branchingForkSession: SessionScript = {
  id: SESSION_IDS.branchingFork,
  cwd: PROJECT_ROOT,
  startedMinutesAgo: 26 * 60 - 20,
  name: "Fork: add a --port flag",
  parentSessionId: SESSION_IDS.branching,
  relation: { kind: "fork", originSessionId: SESSION_IDS.branching },
  steps: [
    ...branchingPrefix,
    {
      kind: "user",
      gapMinutes: 20,
      text: "Forked this into a new session. Which other startup flags would people expect next to --no-open?",
    },
    {
      kind: "assistant",
      rounds: [
        {
          seconds: 8,
          text: `This session was created with **New session** on the *Something shorter?* message in *Branching: edit from here vs. new session*: everything before that message was copied, and from here on the two conversations are independent files.

For a local server like pi-web, people usually expect:

- \`--port <n>\` / \`-p <n>\` — plus \`PORT\` from the environment
- \`--hostname <host>\` / \`-H <host>\` — default \`127.0.0.1\` so it isn't exposed by accident
- \`--no-open\` — what we just named
- \`--help\` / \`-h\` — print the options and exit

Command-line flags should override environment variables, and unknown flags should fail loudly instead of being ignored.`,
        },
      ],
    },
  ],
};
