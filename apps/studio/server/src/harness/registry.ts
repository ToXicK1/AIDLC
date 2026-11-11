// The harnesses AI-DLC ships for (README "Pick your harness"). Studio can set
// any of them up in a project and always shows the engine's state, whichever
// harness drives it. In-app chat needs an adapter; only harnesses with one
// claim the chat capability.

import type { HarnessInfo } from "../../../shared/types.ts";

const EXTERNAL = (open: string): string =>
  `Studio has no in-app chat adapter for this harness yet. Run it in its own tool (${open}); Studio still shows the lifecycle, artifacts, audit trail and file changes live.`;

export const HARNESSES: HarnessInfo[] = [
  {
    id: "claude",
    name: "Claude Code",
    dir: ".claude",
    distDir: "claude",
    invoke: "/aidlc",
    capabilities: { configure: true, chat: true, streaming: true, approvals: true },
  },
  {
    id: "codex",
    name: "Codex CLI",
    dir: ".codex",
    distDir: "codex",
    invoke: "$aidlc",
    capabilities: { configure: true, chat: false, streaming: false, approvals: false },
    note: EXTERNAL("`codex`, then `$aidlc`"),
  },
  {
    id: "cursor",
    name: "Cursor",
    dir: ".cursor",
    distDir: "cursor",
    invoke: "/aidlc",
    capabilities: { configure: true, chat: false, streaming: false, approvals: false },
    note: EXTERNAL("Cursor or `agent`, then `/aidlc`"),
  },
  {
    id: "kiro",
    name: "Kiro (IDE and CLI v3)",
    dir: ".kiro",
    distDir: "kiro-ide",
    invoke: "/aidlc",
    capabilities: { configure: true, chat: false, streaming: false, approvals: false },
    note: EXTERNAL("Kiro IDE, or `kiro-cli --v3`, then `/aidlc`"),
  },
  {
    id: "kiro-v2",
    name: "Kiro CLI (V2)",
    dir: ".kiro",
    distDir: "kiro",
    invoke: "/aidlc",
    capabilities: { configure: true, chat: false, streaming: false, approvals: false },
    note: EXTERNAL("`kiro-cli --v2`, then `/aidlc`"),
  },
  {
    id: "opencode",
    name: "opencode",
    dir: ".aidlc",
    distDir: "opencode",
    invoke: "/aidlc",
    capabilities: { configure: true, chat: false, streaming: false, approvals: false },
    note: EXTERNAL("`opencode`, then `/aidlc`"),
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    dir: ".aidlc",
    distDir: "copilot",
    invoke: "/aidlc",
    capabilities: { configure: true, chat: false, streaming: false, approvals: false },
    note: EXTERNAL("Copilot CLI or VS Code, then `/aidlc`"),
  },
];

export function harnessById(id: string): HarnessInfo | undefined {
  return HARNESSES.find((h) => h.id === id);
}
