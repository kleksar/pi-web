import { PROJECT_ROOT } from "../../paths";
import { FORMAT_DURATION_TEST_OUTPUT } from "../../data/project-files";
import { SESSION_IDS } from "../ids";
import type { SessionScript } from "../types";

const RG_OUTPUT = `components/AppShell.tsx:2102:                    const formatDuration = (ms: number) => {
components/AppShell.tsx:2118:                       ...(totalActiveMs > 0 ? [{ label: translate("session.totalActive"), value: formatDuration(totalActiveMs), copyField: null }] : []),
components/FileViewer.tsx:595:function formatDuration(seconds: number): string {
components/FileViewer.tsx:705:        {duration != null && <span>{formatDuration(duration)}</span>}
components/FileViewer.tsx:858:        {duration != null && <span>{formatDuration(duration)}</span>}
components/FileViewer.state.test.mjs:21:  ["ImageViewer", "formatDuration"],`;

export const featureSession: SessionScript = {
  id: SESSION_IDS.feature,
  cwd: PROJECT_ROOT,
  startedMinutesAgo: 2 * 24 * 60 + 70,
  name: "Refactor: extract formatDuration with tests",
  steps: [
    { kind: "model", provider: "claude-gateway", modelId: "claude-opus-5" },
    { kind: "thinking", level: "high" },
    {
      kind: "user",
      gapMinutes: 0.1,
      text: "The session stats popover in AppShell.tsx has its own inline `formatDuration`. Move it into `lib/` with unit tests.",
    },
    {
      kind: "assistant",
      rounds: [
        {
          thinking: "First find every formatDuration so I don't merge two helpers that mean different things.",
          seconds: 4,
          tools: [{ name: "bash", args: { command: "rg -n \"formatDuration\" components lib" }, result: RG_OUTPUT, seconds: 1 }],
        },
        {
          thinking: "FileViewer's formatDuration formats media time as m:ss from seconds — a different helper. Only the AppShell one takes milliseconds. Read it to preserve its exact behaviour (floor, \"0s\" for non-positive).",
          seconds: 5,
          tools: [{
            name: "read",
            args: { path: "components/AppShell.tsx" },
            result: { readFile: "components/AppShell.tsx", anchor: "const formatDuration = (ms: number)", limit: 12 },
          }],
        },
        {
          text: "`FileViewer.tsx` has an unrelated `formatDuration(seconds)` for audio/video time, so I'll leave it alone and only extract the millisecond version from `AppShell.tsx`.",
          seconds: 14,
          tools: [
            { name: "write", args: {}, result: { writePath: "lib/format-duration.ts" } },
            { name: "write", args: {}, result: { writePath: "lib/format-duration.test.mjs" } },
          ],
        },
        {
          seconds: 7,
          tools: [{ name: "edit", args: {}, result: { editKey: "appshell-format-duration" } }],
        },
        {
          seconds: 3,
          tools: [{ name: "bash", args: { command: "node --test lib/format-duration.test.mjs" }, result: FORMAT_DURATION_TEST_OUTPUT, seconds: 2 }],
        },
        {
          seconds: 9,
          text: `Done — the helper now lives in \`lib/format-duration.ts\` and all 3 tests pass.

| File | Change |
| --- | --- |
| \`lib/format-duration.ts\` | New: \`formatDuration(ms)\` → \`"42s"\`, \`"5m 3s"\`, \`"1h 5m"\` |
| \`lib/format-duration.test.mjs\` | New: normal values, partial seconds, and \`0\` / negative / \`NaN\` / \`Infinity\` |
| \`components/AppShell.tsx\` | Imports the helper and drops the inline copy |

Behaviour is unchanged (floor to whole seconds, \`"0s"\` for anything ≤ 0), except that \`NaN\` and \`Infinity\` now also render as \`"0s"\` instead of garbage like \`"NaNs"\`.

The written files are listed under this reply — click one to open it. The explorer's **changed files** view shows all three with diffs.`,
        },
      ],
    },
  ],
};
