import { SCRATCH_ROOT } from "../../paths";
import { SESSION_IDS } from "../ids";
import type { SessionScript } from "../types";

export const scratchSession: SessionScript = {
  id: SESSION_IDS.scratch,
  cwd: SCRATCH_ROOT,
  startedMinutesAgo: 5 * 24 * 60 + 300,
  name: "Quick question: SSE vs WebSocket",
  steps: [
    { kind: "model", provider: "deepseek", modelId: "deepseek-v4-pro" },
    { kind: "thinking", level: "off" },
    { kind: "tools", tools: [] },
    {
      kind: "user",
      gapMinutes: 0.1,
      text: "Quick one: when should a web app use Server-Sent Events instead of WebSockets?",
    },
    {
      kind: "assistant",
      rounds: [
        {
          seconds: 9,
          text: `Use **SSE** when data mostly flows **server → client** and the client talks back with ordinary requests:

- It's plain HTTP: works through proxies, load balancers and HTTP/2 without special configuration.
- \`EventSource\` reconnects automatically and can resume with \`Last-Event-ID\`.
- It's text-only and one-directional — that's the trade-off.

Use **WebSockets** when both sides send frequent messages (collaborative editing, games, terminals), or you need binary frames.

Pi Web is a good example of the SSE pattern: agent events stream to the browser over SSE, and prompts and commands go back as normal \`POST\` requests.

*This project uses the **Chat only** tool preset — no file or shell tools, just conversation. It lives in a dated scratch folder created with **Use default directory** in the project picker.*`,
        },
      ],
    },
  ],
};
