# AI-DLC Studio

A visual IDE around the AI-DLC engine. You describe the work in a chat panel,
and Studio shows the real lifecycle, agents, artifacts, files, tests and
approval gates as your harness runs the workflow.

Studio does not reimplement AI-DLC. It runs the engine's own commands, reads
the records the engine writes under `aidlc/`, and drives the harness the same
way the repository's own test suite does. Nothing on screen is simulated: when
a source has no data, the view says so.

## Prerequisites

| Tool | Why | Check |
| --- | --- | --- |
| Node.js 22.18 or later | Runs the Studio server (TypeScript, no build step) | `node --version` |
| Bun | Builds the client; runs the engine when the native command cannot | `bun --version` |
| Claude Code, signed in | In-app chat (the only harness with a chat adapter today) | `claude --version` |
| git | Git changes and diff views | `git --version` |
| AI-DLC `aidlc` command | Optional. Preferred project setup route when it runs | `aidlc version` |

Studio lives inside the AI-DLC repository checkout (`apps/studio/`) and uses
that checkout as the source of the Bun runtime.

## Install and start (Windows PowerShell)

```powershell
cd "C:\Users\vyshu\Desktop\AWSIDE\aidlc-workflows\apps\studio"
.\start.ps1
```

`start.ps1` checks the prerequisites, runs `npm install` on first use, builds
the client when it is missing or stale, starts the server on
`http://127.0.0.1:4317` and opens your browser on a link that carries a
one-launch access token.

If PowerShell refuses to run the script, run it for this one process:

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

The same steps by hand:

```powershell
npm install
npm run build
npm start
```

Stop Studio with `Ctrl+C` in its terminal. That ends the harness session and
any command it started.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AIDLC_STUDIO_PORT` | `4317` | Port on 127.0.0.1 (`.\start.ps1 -Port 4400`) |
| `AIDLC_STUDIO_HOME` | `%LOCALAPPDATA%\aidlc-studio` | Studio's own data: recent projects, conversations, audit of actions |
| `AIDLC_STUDIO_ENGINE_REPO` | the checkout Studio is in | AI-DLC repository to take the Bun runtime from |
| `AIDLC_STUDIO_CLAUDE_PATH` | found on `PATH` | Claude Code executable to drive |

Model-provider setup belongs to the harness. Studio uses whatever Claude Code
is already signed in to.

## Using it

1. **Open a project.** New Project creates a folder; Open Existing Project
   picks one. Studio only reads and writes inside that folder.
2. **Set up AI-DLC.** The first time, Studio offers to initialize the project
   for a harness. It uses `aidlc config --harness <name>` when the native
   command runs, and otherwise copies the Bun runtime from this repository.
   Files you already have are never overwritten.
3. **Start a workflow from the chat.** Type what to build. With the `/aidlc`
   chip on, the message is sent as `/aidlc <your text>`, which is how a
   workflow starts. Later messages are plain replies.
4. **Answer and approve.** Questions and approval gates appear in the chat and
   in the Approvals workspace, with the artifacts to review. Your choice is
   sent to the workflow exactly as shown.
5. **Watch.** The lifecycle tree, workspaces, explorer and bottom panel update
   live from the engine's state, the audit trail and the file system.

Keyboard: `Ctrl+B` toggles the sidebar, `Ctrl+J` the bottom panel, `Ctrl+S`
saves the active editor tab, `Enter` sends a chat message, `Shift+Enter` adds a
line.

## What each part shows, and where the data comes from

| Area | Source |
| --- | --- |
| Lifecycle tree (phases, stages, lead agents) | `engine graph export`, the engine's compiled stage graph. Nothing is hardcoded |
| Stage status, progress, current stage | The active intent's `aidlc-state.md` |
| Recent activity, decision trail | `engine audit history` |
| Requirements, Architecture, Artifacts | Files in the intent record (`aidlc/spaces/<space>/intents/<record>/`) and the space's `codekb/` |
| Approvals | Stages the state file marks awaiting approval or revising, plus the question the harness is asking |
| Agent activity | Audit events (`STAGE_STARTED`, `SUBAGENT_DISPATCHED`, `SUBAGENT_COMPLETED`) and the live harness stream |
| Implementation | The project's files. Monaco editor, diff against the last commit, live reload |
| Testing | Test commands you run from Studio, test commands the agent runs in chat, the Build and Test stage's reports, and `coverage/coverage-summary.json` when present |
| Deploy & Ops | Operation-phase stage status, `aidlc doctor`, tool versions, deployment documents |
| Execution Logs | Engine events, tool calls, hook results, command runs. Secrets are redacted |
| Terminal | A fixed list of commands, not a shell (see Security) |

### Harness support

| Harness | Set up from Studio | Live state, artifacts, audit | In-app chat and approvals |
| --- | --- | --- | --- |
| Claude Code | Yes | Yes | Yes |
| Codex CLI, Cursor, Kiro, Kiro CLI (V2), opencode, GitHub Copilot | Yes | Yes | No. Run the harness in its own tool; Studio follows along |

A new harness gets in-app chat by implementing `HarnessAdapter`
(`server/src/harness/types.ts`) and registering it; the UI needs no change.

## Architecture

```text
apps/studio/
  server/src/
    index.ts            entry: loopback listener, launch token
    app.ts              REST API and one event stream per project
    project.ts          per-project runtime: engine, chat, watcher, logs
    engine/engine.ts    adapter around the engine's commands and records
    engine/stateFile.ts parser for aidlc-state.md
    engine/install.ts   project setup (native config, or Bun runtime copy)
    harness/types.ts    the harness abstraction
    harness/claude.ts   Claude Code adapter (Claude Agent SDK)
    harness/registry.ts the harnesses AI-DLC ships for
    chat.ts             conversations, pending questions and permissions
    commands.ts         allowlisted command runner
    testing.ts          test-output parsing and tracking
    files.ts, git.ts    project files and read-only git views
    security/           path sandbox, secret redaction, access control
    store.ts            Studio's own persistent data
  shared/types.ts       types shared by server and client
  web/src/              React client (store.ts is the single state store)
  scripts/              build and dev launchers
```

**Chat.** The Claude Code adapter starts your installed Claude Code through
the Claude Agent SDK with the project's own settings, so AI-DLC's hooks run
(human-turn recording, audit, guards, the Stop hook that continues the
workflow). The prompt is a message stream held open across turns. When the
harness asks a question or needs a permission, the SDK calls back into Studio
and waits; Studio shows it and returns only what you choose.

**Approvals.** An AI-DLC gate is decided by the person's reply in the harness
session. Studio either answers the question the workflow is asking, or sends
your decision as your reply in that session. The engine records
`GATE_APPROVED` or `GATE_REJECTED`; Studio keeps its own trail of what was
clicked. Studio never writes workflow state.

**Live updates.** A file watcher on the project pushes file changes, and any
change under `aidlc/` triggers a fresh read of the engine's state. After a
reconnect the client fetches the latest persisted state again.

**Recovery.** Workflow state lives in the project, so it survives anything.
Studio also stores each conversation's harness session id; after a restart the
next message resumes that session. If a gate is open and no session holds it,
the Approvals view offers Resume workflow so the gate is asked again.

## Security

- The server listens on `127.0.0.1` only. Every API call needs the per-launch
  token (HttpOnly, SameSite=Strict cookie). Host and Origin headers are
  checked, so another site or a DNS-rebinding name cannot call it.
- File access goes through one sandbox: project-relative paths only, no
  traversal, no drive or UNC paths, no NTFS streams or device names, and no
  link that resolves outside the project.
- Files that may hold secrets (`.env*`, keys, credentials, local settings) are
  not shown, searched or diffed unless you explicitly confirm.
- Processes are started with an executable and an argument array, never a
  shell string. The Terminal runs a server-built allowlist: read-only engine
  commands, read-only git views, and the scripts your project declares.
- Logs, tool inputs and tool results are redacted for tokens, keys, passwords
  and the values of secret-named environment variables before they are shown
  or stored.
- Permission modes that skip checks are not offered. Tools your project's
  settings do not pre-approve ask you first.
- Studio's audit trail (`audit.jsonl` in the data folder) records project
  setup, saves, commands, answers, permission decisions and approvals.

## Tests

```powershell
npm run typecheck          # TypeScript, server and client
npm run test:server        # 49 backend unit and API tests
npm run test:web           # 23 component tests
npm run test:integration   # 10 tests against the real engine (needs Bun)
npm test                   # all three
```

The integration suite sets up a real project with the real runtime, has the
engine create work, and checks state, audit, artifacts, live stream, command
runner, doctor and restart recovery. It does not call a model.

## Known limits

- In-app chat exists for Claude Code only.
- The Terminal is a command allowlist, not an interactive shell. A real PTY
  needs a native add-on, which this machine's application-control policy
  blocked; it is also the safer design.
- Tailwind v3 and Bun's bundler are used instead of Tailwind v4 and Vite,
  because those depend on native add-ons the same policy blocked.
- Test counts come from parsing the runner's own summary line. An unrecognised
  format is reported by exit status and raw log only.
- Coverage is shown only from `coverage/coverage-summary.json`.
- Runtime health and monitoring: the AI-DLC runtime provides none, so Studio
  shows the documents those stages write and nothing else.
- Team Construction (Unit claims, worktrees, swarm) has no dedicated view; it
  is driven through chat.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Browser shows "protected by a one-launch access token" | Open the link printed in Studio's terminal, or paste the token from it |
| "Port 4317 is already in use" | Another Studio is running. Stop it, or `.\start.ps1 -Port 4400` |
| Setup dialog says `bun` is missing | Install Bun, open a new terminal, start Studio again |
| Chat says Claude Code was not found | `npm install -g @anthropic-ai/claude-code`, run `claude` once to sign in |
| A turn fails with a usage-limit message | That is your Claude plan's limit. Wait for the reset, then use Resume workflow |
| Status bar says "Interrupted â€” resume in chat" | The engine shows work in progress but no session is running. Click Resume workflow |
| A gate is open but there are no Approve buttons | No session holds the workflow. Click Resume workflow; the gate is asked again |
| `aidlc` shows as unavailable | The native command did not start (often an application-control policy). Studio uses the Bun runtime instead |
| Lifecycle is empty and Problems lists an engine error | Run `aidlc:doctor` from the Terminal tab and follow its fixes |
| Git Changes says the folder has no repository of its own | The project sits inside another repository, which Studio leaves alone. Run `git init` in the project |
