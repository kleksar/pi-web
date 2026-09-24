/**
 * Canned answers for prompts typed into the demo. They pick a topic from the
 * prompt, optionally run one read-only tool so the stream shows a tool call,
 * and always explain that this is a static demo.
 */
import { MODELS_RESPONSE } from "./data/models";
import { buildContext, type MockSession } from "./sessions/store";

export interface ReplyPlan {
  thinking?: string;
  /** Text streamed before the tool call. */
  preface?: string;
  text: string;
  tool?: {
    name: string;
    args: Record<string, unknown>;
    readFile?: string;
    limit?: number;
    result?: string;
  };
}

const INSTALL = "npx @agegr/pi-web@latest";

function modelName(session: MockSession): string {
  const model = session.live?.model;
  if (!model) return "the selected model";
  return MODELS_RESPONSE.modelList.find((item) => item.provider === model.provider && item.id === model.modelId)?.name ?? model.modelId;
}

function footer(): string {
  return `\n\n---\n*This is a static Pi Web demo: replies are canned and no model is called. To try it with your own models, run \`${INSTALL}\`.*`;
}

function mentionedPath(prompt: string): string | null {
  const match = /@("([^"]+)"|[^\s]+)/.exec(prompt);
  if (!match) return null;
  const raw = (match[2] ?? match[1]).replace(/[),.;!?，。！？]+$/, "");
  return raw.replace(/:\d+(-\d+)?$/, "").replace(/\/$/, "") || null;
}

/** Match whole words so "ls" does not match "models". */
function has(prompt: string, words: string[]): boolean {
  const lower = prompt.toLowerCase();
  return words.some((word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(lower));
}

export function composeReply(prompt: string, session: MockSession): ReplyPlan {
  const model = modelName(session);
  const path = mentionedPath(prompt);

  if (path) {
    return {
      thinking: `The user mentioned ${path}; read the beginning of it first.`,
      tool: { name: "read", args: { path, limit: 40 }, readFile: path, limit: 40 },
      text: `I read the first 40 lines of \`${path}\` — expand the **read** card above to see the raw tool output.\n\nIn a real Pi Web session, ${model} would now work through your question: reading more, searching, editing or running commands, each step shown as an expandable tool call like the one above.\n\nTip: select lines in the file viewer's **Source** mode and click **@** in its toolbar to mention a range like \`${path}:12-20\`.${footer()}`,
    };
  }

  if (has(prompt, ["ls", "list", "files", "folder", "folders", "directory", "structure"])) {
    return {
      thinking: "List the project root so the user can see what a tool call looks like.",
      tool: { name: "bash", args: { command: "ls" } },
      text: `That's the project root — expand the **bash** card above for the raw output. The **Explorer** at the bottom-left shows the same files: click one to open it on the right, or mention it with \`@\` in the composer.${footer()}`,
    };
  }

  if (has(prompt, ["model", "models", "provider", "providers", "codex", "claude", "deepseek", "gpt", "reasoning", "thinking"])) {
    return {
      thinking: "Explain model selection and reasoning levels.",
      text: `This reply "comes from" **${model}** (simulated in the demo).\n\n- Switch models with the model button in the composer; the next message uses the new one.\n- The reasoning button next to it sets how much the model thinks before answering, and only offers levels the model supports.\n- **Models** at the bottom of the sidebar has the signed-in ChatGPT (Codex) account, the DeepSeek API key and the custom Claude Gateway — toggle which models appear, check usage, and test connections there.\n\nThe *Models, providers and reasoning levels* session goes into more detail.${footer()}`,
    };
  }

  if (has(prompt, ["branch", "branches", "fork", "edit from", "clone"])) {
    return {
      thinking: "Explain the two ways to branch.",
      text: `Hover one of your messages:\n\n- **Edit from here** creates a new branch in this same session. The old answer stays; switch with **Branches** in the top bar.\n- **New session** copies the conversation into a new session file, and the two go their own ways.\n\n\`/clone\` copies the whole current branch into a new session. See *Branching: edit from here vs. new session* for a worked example.${footer()}`,
    };
  }

  if (has(prompt, ["hi", "hello", "hey"])) {
    return {
      thinking: "Say hello and suggest things to try.",
      text: `Hi! 👋 I'm the demo's ${model}. A few things to try:\n\n- Send \`@README.md summarize this\` to see how tool calls render.\n- Type \`!git status\` to run a (simulated) shell command.\n- Open the other sessions in the sidebar — each one is a short tutorial.${footer()}`,
    };
  }

  return {
    thinking: "This is the demo; explain that and suggest what to explore.",
    text: `Got it! In a real Pi Web session, ${model} would stream its answer here and read files, run commands or edit code as needed — each step shown as an expandable tool call, with tokens and cost updating in the top bar.\n\nIn this demo you can also:\n\n- Mention a file with \`@\` (for example \`@package.json\`) and I'll actually read it.\n- Type \`/\` for slash commands, or \`!ls\` for a simulated shell command.\n- Hover your message and try **Edit from here** or **New session**.${footer()}`,
  };
}

/** Title for "Generate title": the first user message, trimmed to a short line. */
export function autoTitle(session: MockSession): string {
  const context = buildContext(session, session.leafId, { tail: 0 });
  const first = context.messages.find((message) => message.role === "user");
  const content = first && "content" in first ? first.content : "";
  const text = typeof content === "string"
    ? content
    : (content as { type: string; text?: string }[]).find((block) => block.type === "text")?.text ?? "";
  const clean = text.replace(/@\S+\s*/g, "").replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
  const sentence = clean.split(/(?<=[.?!。？！])\s*/)[0] || clean || "Untitled session";
  return sentence.length > 48 ? `${sentence.slice(0, 47).trimEnd()}…` : sentence.replace(/[.。]$/, "");
}
