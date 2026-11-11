// Everything live about one opened project: the engine adapter, the chat
// session, the command runner, the file watcher and the event stream that
// feeds the UI.

import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { Response } from "express";
import type { AgentActivity, ChatEvent, FsChange, LogLine, ProjectRecord, RunEvent, Snapshot } from "../../shared/types.ts";
import { ChatManager } from "./chat.ts";
import { CommandRunner } from "./commands.ts";
import { Engine } from "./engine/engine.ts";
import { HEAVY_DIRS } from "./files.ts";
import { claudeAdapter } from "./harness/claude.ts";
import type { HarnessAdapter, HarnessEvent } from "./harness/types.ts";
import { redact } from "./security/redact.ts";
import type { Store } from "./store.ts";
import { TestTracker } from "./testing.ts";

const LOG_LIMIT = 3000;

export interface RuntimeOptions {
  adapters?: HarnessAdapter[];
  watch?: boolean;
}

export class ProjectRuntime {
  readonly id: string;
  readonly engine: Engine;
  readonly chat: ChatManager;
  readonly runner: CommandRunner;
  readonly tests: TestTracker;
  private readonly store: Store;
  private readonly clients = new Set<Response>();
  private logs: LogLine[] = [];
  private logSeq = 0;
  private watcher: FSWatcher | null = null;
  private fsBatch: FsChange[] = [];
  private fsTimer: ReturnType<typeof setTimeout> | null = null;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotInFlight: Promise<Snapshot> | null = null;
  private lastSnapshot: Snapshot | null = null;
  private readonly changed = new Map<string, FsChange>();
  private readonly harnessAgents = new Map<string, AgentActivity>();
  private readonly agentToolUses = new Map<string, AgentActivity>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(record: ProjectRecord, store: Store, options: RuntimeOptions = {}) {
    this.id = record.id;
    this.store = store;
    this.engine = new Engine(record.path);
    this.tests = new TestTracker(() => this.emit("tests", { at: Date.now() }));
    this.chat = new ChatManager(
      store,
      {
        project: () => this.record(),
        emit: (event: ChatEvent) => this.emit("chat", event),
        log: (level, source, text) => this.log(level, source, text),
        observe: (event) => this.observeHarness(event),
      },
      options.adapters ?? [claudeAdapter],
    );
    this.runner = new CommandRunner(record.path, this.engine, {
      emit: (event: RunEvent) => {
        this.emit("run", event);
        if (event.kind === "start") this.log("info", "command", `$ ${event.display ?? event.commandId}`);
        if (event.kind === "exit") this.log(event.code === 0 ? "info" : "warn", "command", `${event.commandId} exited with code ${event.code}`);
        if (event.kind === "error") this.log("error", "command", `${event.commandId}: ${event.text ?? ""}`);
      },
      onTestStart: (runId, display) => this.tests.begin(runId, display),
      onTestOutput: (runId, chunk) => this.tests.append(runId, chunk),
      onTestExit: (runId, code) => this.tests.finish(runId, code),
    });
    if (options.watch !== false) this.startWatcher();
    this.heartbeat = setInterval(() => this.emit("ping", { at: Date.now() }), 20000);
    this.heartbeat.unref?.();
  }

  record(): ProjectRecord {
    const record = this.store.project(this.id);
    if (!record) throw new Error("Project is no longer open in Studio.");
    return record;
  }

  get projectDir(): string {
    return this.record().path;
  }

  // ----- event stream -----

  attach(res: Response): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 2000\n\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
    this.send(res, "hello", { projectId: this.id, chat: this.chat.getStatus(), at: Date.now() });
  }

  private send(res: Response, type: string, data: unknown): void {
    try {
      res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      this.clients.delete(res);
    }
  }

  emit(type: string, data: unknown): void {
    for (const client of this.clients) this.send(client, type, data);
  }

  // ----- logs -----

  log(level: LogLine["level"], source: string, text: string): void {
    for (const raw of redact(text).split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const line: LogLine = { seq: ++this.logSeq, ts: new Date().toISOString(), level, source, text: raw.slice(0, 4000) };
      this.logs.push(line);
      this.emit("log", line);
    }
    if (this.logs.length > LOG_LIMIT) this.logs = this.logs.slice(-LOG_LIMIT);
  }

  logLines(): LogLine[] {
    return this.logs;
  }

  clearLogs(): void {
    this.logs = [];
  }

  // ----- file watching -----

  private startWatcher(): void {
    const root = this.projectDir;
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      persistent: true,
      depth: 14,
      ignored: (file: string) => {
        const rel = path.relative(root, file).replace(/\\/g, "/");
        if (rel === "") return false;
        const parts = rel.split("/");
        if (parts.some((p) => HEAVY_DIRS.has(p) && p !== "bin" && p !== "build" && p !== "out" && p !== "dist")) return true;
        if (parts[0] === "node_modules" || parts.includes(".git")) return true;
        // Engine internals churn constantly and are never the person's work.
        if (rel.includes("/.aidlc-engine/") && !rel.endsWith("engine-touch")) return true;
        return false;
      },
    });
    const onChange = (kind: FsChange["kind"]) => (file: string) => {
      const rel = path.relative(root, file).replace(/\\/g, "/");
      const change: FsChange = { path: rel, kind, at: Date.now() };
      this.fsBatch.push(change);
      if (kind === "add" || kind === "change" || kind === "unlink") {
        if (!rel.startsWith("aidlc/.aidlc-") && !rel.includes("/.aidlc-engine/")) this.changed.set(rel, change);
      }
      if (rel.startsWith("aidlc/") || rel.startsWith(".claude/settings")) this.scheduleSnapshot();
      this.fsTimer ??= setTimeout(() => this.flushFs(), 200);
    };
    this.watcher
      .on("add", onChange("add"))
      .on("change", onChange("change"))
      .on("unlink", onChange("unlink"))
      .on("addDir", onChange("addDir"))
      .on("unlinkDir", onChange("unlinkDir"))
      .on("error", (error) => this.log("warn", "watcher", `File watcher: ${(error as Error).message}`));
  }

  private flushFs(): void {
    this.fsTimer = null;
    const batch = this.fsBatch.splice(0, this.fsBatch.length);
    if (batch.length > 0) this.emit("fs", { changes: batch.slice(-500) });
  }

  /** Files created, changed or removed since Studio opened this project. */
  sessionChanges(): FsChange[] {
    return [...this.changed.values()].sort((a, b) => b.at - a.at).slice(0, 2000);
  }

  // ----- harness observation (agents, tests) -----

  private observeHarness(event: HarnessEvent): void {
    if (event.type === "tool_use") {
      this.tests.observeToolUse(event.id, event.name, event.input);
      if (event.name === "Agent" || event.name === "Task") {
        const input = (event.input ?? {}) as { subagent_type?: string; description?: string };
        const agent = typeof input.subagent_type === "string" ? input.subagent_type : "subagent";
        const row: AgentActivity = {
          id: `tool-${event.id}`,
          agent,
          displayName: this.agentDisplay(agent),
          role: /review/i.test(agent) ? "reviewer" : "subagent",
          stage: this.lastSnapshot?.state?.currentStage || undefined,
          task: typeof input.description === "string" ? input.description : undefined,
          status: "active",
          startedAt: new Date().toISOString(),
          source: "harness",
        };
        this.agentToolUses.set(event.id, row);
        this.emit("agents", { at: Date.now() });
      }
    } else if (event.type === "tool_result") {
      this.tests.observeToolResult(event.id, event.text, event.isError);
      const row = this.agentToolUses.get(event.id);
      if (row && row.status === "active") {
        row.status = event.isError ? "failed" : "completed";
        row.completedAt = new Date().toISOString();
        if (event.isError) row.error = event.text.slice(0, 500);
        this.emit("agents", { at: Date.now() });
      }
    } else if (event.type === "task") {
      let row = this.harnessAgents.get(event.taskId);
      if (event.phase === "started") {
        const agent = event.subagentType ?? "background task";
        row = {
          id: `task-${event.taskId}`,
          agent,
          displayName: this.agentDisplay(agent),
          role: /review/i.test(agent) ? "reviewer" : "subagent",
          stage: this.lastSnapshot?.state?.currentStage || undefined,
          task: event.description,
          status: "active",
          startedAt: new Date().toISOString(),
          source: "harness",
        };
        // The Agent tool call and its task describe the same helper; keep the task row.
        for (const [toolId, toolRow] of this.agentToolUses) {
          if (toolRow.status === "active" && toolRow.agent === agent && toolRow.task === event.description) this.agentToolUses.delete(toolId);
        }
        this.harnessAgents.set(event.taskId, row);
      } else if (row) {
        const status = event.status ?? "";
        if (["completed", "failed", "killed", "stopped"].includes(status)) {
          row.status = status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped";
          row.completedAt = new Date().toISOString();
          if (event.summary) row.outputs = [event.summary];
        }
      }
      this.emit("agents", { at: Date.now() });
    } else if (event.type === "result") {
      this.scheduleSnapshot(150);
    }
  }

  private agentDisplay(slug: string): string {
    return this.lastSnapshot?.lifecycle?.agents.find((a) => a.slug === slug)?.display_name ?? slug;
  }

  harnessAgentRows(): AgentActivity[] {
    return [...this.harnessAgents.values(), ...this.agentToolUses.values()];
  }

  // ----- snapshot -----

  scheduleSnapshot(delay = 400): void {
    if (this.disposed) return;
    if (this.snapTimer) clearTimeout(this.snapTimer);
    this.snapTimer = setTimeout(() => {
      this.snapTimer = null;
      void this.snapshot(true).catch((error) => this.log("error", "engine", `Snapshot failed: ${(error as Error).message}`));
    }, delay);
  }

  async snapshot(broadcast = false): Promise<Snapshot> {
    if (!this.snapshotInFlight) {
      this.snapshotInFlight = this.engine
        .snapshot(this.id)
        .then((snap) => {
          // The engine's audit trail and the live harness stream both report a
          // dispatched helper. Keep the audit row; add harness rows only for
          // helpers the trail has not recorded.
          const recorded = snap.agents.filter((a) => a.role === "subagent" || a.role === "reviewer");
          const near = (a?: string, b?: string): boolean => !a || !b || Math.abs(Date.parse(a) - Date.parse(b)) < 180000;
          const extra = this.harnessAgentRows().filter((row) => !recorded.some((r) => r.agent === row.agent && near(r.startedAt, row.startedAt)));
          snap.agents = [...snap.agents, ...extra];
          this.noteTransitions(this.lastSnapshot, snap);
          this.lastSnapshot = snap;
          return snap;
        })
        .finally(() => {
          this.snapshotInFlight = null;
        });
    }
    const snap = await this.snapshotInFlight;
    if (broadcast) this.emit("snapshot", snap);
    return snap;
  }

  /** Write engine-recorded transitions to the execution log as they appear. */
  private noteTransitions(before: Snapshot | null, after: Snapshot): void {
    if (!before || before.state?.recordDir !== after.state?.recordDir) return;
    for (const event of after.audit.slice(before.audit.length)) {
      const detail = Object.entries(event.fields)
        .filter(([key]) => ["Stage", "Phase", "Agent", "Agent Type", "File", "Details", "Scope", "Reason"].includes(key))
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      const level = /ERROR|FAILED|BLOCKED/.test(event.event) ? "error" : /REJECTED|SKIPPED|AWAITING/.test(event.event) ? "warn" : "info";
      this.log(level, "engine", `${event.event} ${detail}`.trim());
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.snapTimer) clearTimeout(this.snapTimer);
    if (this.fsTimer) clearTimeout(this.fsTimer);
    await this.watcher?.close();
    this.runner.dispose();
    await this.chat.dispose();
    for (const client of this.clients) client.end();
    this.clients.clear();
  }
}
