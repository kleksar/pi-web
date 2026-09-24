import { PROJECT_ROOT } from "../../paths";
import { SESSION_IDS } from "../ids";
import type { SessionScript } from "../types";

export const modelsSession: SessionScript = {
  id: SESSION_IDS.models,
  cwd: PROJECT_ROOT,
  startedMinutesAgo: 190,
  name: "Models, providers and reasoning levels",
  steps: [
    { kind: "model", provider: "deepseek", modelId: "deepseek-v4-pro" },
    { kind: "thinking", level: "high" },
    {
      kind: "user",
      gapMinutes: 0.1,
      text: "Which models can I use in this Pi Web?",
    },
    {
      kind: "assistant",
      rounds: [
        {
          thinking: "Three providers are configured: an OAuth login (ChatGPT/Codex), an API key (DeepSeek) and a custom models.json provider (Claude Gateway). Explain each and where it lives, then how to pick and filter models.",
          seconds: 12,
          text: `This demo has three providers set up, one of each kind Pi Web supports. Open **Models** at the bottom of the sidebar to see them:

| Provider | How it's connected | Models |
| --- | --- | --- |
| **ChatGPT Plus/Pro (Codex)** | Signed in with **OAuth** — no key to copy | GPT-5.5, GPT-5.6 Sol · Terra · Luna, GPT-6 Astra, GPT-5.3 Codex Spark |
| **DeepSeek** | **API key**, stored in \`~/.pi/agent/auth.json\` | DeepSeek V4 Pro *(answering you now)*, DeepSeek V4.1 Flash |
| **Claude Gateway** | **Custom provider** in \`~/.pi/agent/models.json\`, an Anthropic-compatible endpoint | Claude Opus 5, Claude Sonnet 5, Claude Haiku 4.5 |

A few things worth knowing:

- **Switch models** from the model button in the composer. The choice belongs to this session, and the model name under each reply shows who wrote it.
- **Keep the picker short** with the switches under **Available models**. They edit \`enabledModels\` in \`settings.json\` — the same list \`pi --models\` and \`/scoped-models\` use in the terminal.
- **Usage**: Codex and DeepSeek show quota or balance right in the panel — 5-hour and weekly limits for Codex, account balance for DeepSeek.
- **New releases**: **Refresh catalog** fetches a provider's latest model list, so a model released after your pi version still shows up.`,
        },
      ],
    },
    { kind: "model", provider: "openai-codex", modelId: "gpt-5.6-sol" },
    { kind: "thinking", level: "xhigh" },
    {
      kind: "user",
      gapMinutes: 2.5,
      text: "I switched to GPT-5.6 Sol with extra-high reasoning. What do the reasoning levels actually change?",
    },
    {
      kind: "assistant",
      rounds: [
        {
          thinking: `The user just switched model mid-session, which is a good moment to show that the switch is recorded in the session and that the next reply comes from the new model.

Reasoning levels map to the provider's own effort / budget parameter. Pi exposes up to seven levels: off, minimal, low, medium, high, xhigh, max. Each model only supports a subset — the selector hides the rest. DeepSeek V4 Pro, for example, only has off/high/max; GPT-5.5 stops at xhigh; GPT-5.6 models go up to max.

Trade-off: higher levels mean more hidden reasoning tokens → better on hard multi-step problems, slower and more expensive. Point at the top bar for the cost and the thinking block itself for what the model was "thinking".`,
          seconds: 21,
          text: `The reasoning level is how much the model is allowed to "think" before it answers. Pi maps it to each provider's own setting (reasoning effort, thinking budget, …):

| Level | Good for |
| --- | --- |
| **Off** | Quick answers, renames, formatting — no hidden reasoning at all |
| **Minimal / Low** | Small, well-specified edits |
| **Medium** | Everyday coding — the default in this demo |
| **High / Extra-high** | Multi-file changes, debugging, planning |
| **Max** | The hardest problems, when you don't mind waiting |

- **Only supported levels are offered.** DeepSeek V4 Pro has *off / high / max*; GPT-5.5 stops at *extra-high*; the GPT-5.6 models go up to *max*.
- **You can see the thinking.** The collapsed *Thinking* line above this reply expands to show my reasoning. **Settings → Thinking display** decides whether those blocks start expanded.
- **It costs tokens.** Reasoning tokens are billed as output. The top bar shows this session's tokens, cost and context usage — click it for a breakdown.
- **Defaults and pins.** New sessions start with the default from \`settings.json\`. A pattern like \`openai-codex/gpt-5.5:high\` in \`enabledModels\` pins a model to one level.

Notice the model switch is recorded in the session too — scroll up and you'll see the earlier reply came from DeepSeek V4 Pro.`,
        },
      ],
    },
    {
      kind: "user",
      gapMinutes: 3,
      text: "How do I add my own OpenAI- or Anthropic-compatible provider, like that Claude Gateway?",
    },
    {
      kind: "assistant",
      rounds: [
        {
          thinking: "Walk through the Add provider flow in the Models panel and show the resulting models.json entry.",
          seconds: 9,
          text: `In **Models**, click **Add provider** and fill in the form:

1. **Name, base URL and API type** — \`openai-completions\`, \`openai-responses\`, \`anthropic-messages\` and more.
2. **API key** — paste it, or give an environment variable name or a \`!command\` (for example \`!op read op://dev/gateway/key\`) so the key never sits in the file.
3. **Import models…** reads the endpoint's model list so you can tick the ones you want.
4. **Fill model details** looks the model up on models.dev and fills in the context window, max output tokens, capabilities and prices.
5. **Test** sends a tiny request and shows the latency and the reply.

Saving writes \`~/.pi/agent/models.json\`, which pi in the terminal reads as well. The Claude Gateway in this demo looks like this:

\`\`\`json
{
  "providers": {
    "claude-gateway": {
      "name": "Claude Gateway",
      "baseUrl": "https://llm-gateway.example.com",
      "api": "anthropic-messages",
      "apiKey": "CLAUDE_GATEWAY_KEY",
      "models": [
        {
          "id": "claude-sonnet-5",
          "name": "Claude Sonnet 5",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 1000000,
          "maxTokens": 128000,
          "cost": { "input": 2, "output": 10, "cacheRead": 0.2, "cacheWrite": 2.5 }
        }
      ]
    }
  }
}
\`\`\`

Try **Test** on one of its models in the panel — in this demo the gateway answers with a canned "hello".`,
        },
      ],
    },
  ],
};
