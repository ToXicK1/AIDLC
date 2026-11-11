// Studio's own persistent data: recent projects, conversations, workspace
// state and the audit trail of actions taken through Studio. Kept outside any
// project so nothing here is ever committed with the person's code.

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatEvent, Conversation, ProjectRecord, ProjectSettings, StudioAuditEntry } from "../../shared/types.ts";

export function defaultDataDir(): string {
  if (process.env.AIDLC_STUDIO_HOME) return path.resolve(process.env.AIDLC_STUDIO_HOME);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "aidlc-studio");
  return path.join(os.homedir(), ".aidlc-studio");
}

interface StateFile {
  version: 1;
  projects: ProjectRecord[];
  lastProjectId: string | null;
  workspace: Record<string, unknown>;
}

const DEFAULT_SETTINGS: ProjectSettings = { permissionMode: "default", model: "" };

export function projectIdFor(projectPath: string): string {
  const key = process.platform === "win32" ? projectPath.toLowerCase() : projectPath;
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, file);
}

export class Store {
  readonly dir: string;
  private state: StateFile;

  constructor(dir: string = defaultDataDir()) {
    this.dir = dir;
    mkdirSync(path.join(dir, "projects"), { recursive: true });
    this.state = this.load();
  }

  private get stateFile(): string {
    return path.join(this.dir, "state.json");
  }

  private load(): StateFile {
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as StateFile;
      if (parsed && Array.isArray(parsed.projects)) {
        return { version: 1, projects: parsed.projects, lastProjectId: parsed.lastProjectId ?? null, workspace: parsed.workspace ?? {} };
      }
    } catch {
      // First run, or an unreadable file: start clean rather than fail to boot.
    }
    return { version: 1, projects: [], lastProjectId: null, workspace: {} };
  }

  private save(): void {
    writeAtomic(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  // ----- projects -----

  projects(): ProjectRecord[] {
    return [...this.state.projects].sort((a, b) => b.lastOpened.localeCompare(a.lastOpened));
  }

  project(id: string): ProjectRecord | undefined {
    return this.state.projects.find((p) => p.id === id);
  }

  lastProjectId(): string | null {
    return this.state.lastProjectId;
  }

  upsertProject(projectPath: string, name?: string): ProjectRecord {
    const id = projectIdFor(projectPath);
    let record = this.project(id);
    if (!record) {
      record = {
        id,
        path: projectPath,
        name: name?.trim() || path.basename(projectPath),
        lastOpened: new Date().toISOString(),
        harness: "claude",
        settings: { ...DEFAULT_SETTINGS },
      };
      this.state.projects.push(record);
    } else {
      record.lastOpened = new Date().toISOString();
      if (name?.trim()) record.name = name.trim();
    }
    this.state.lastProjectId = id;
    this.save();
    return record;
  }

  updateProject(id: string, patch: Partial<Pick<ProjectRecord, "name" | "harness">> & { settings?: Partial<ProjectSettings> }): ProjectRecord | undefined {
    const record = this.project(id);
    if (!record) return undefined;
    if (patch.name?.trim()) record.name = patch.name.trim();
    if (patch.harness) record.harness = patch.harness;
    if (patch.settings) record.settings = { ...record.settings, ...patch.settings };
    this.save();
    return record;
  }

  /** Forget a project in Studio. Never touches the project's files. */
  removeProject(id: string): boolean {
    const before = this.state.projects.length;
    this.state.projects = this.state.projects.filter((p) => p.id !== id);
    if (this.state.lastProjectId === id) this.state.lastProjectId = null;
    this.save();
    return this.state.projects.length !== before;
  }

  // ----- workspace state -----

  workspace(): Record<string, unknown> {
    return this.state.workspace;
  }

  setWorkspace(value: Record<string, unknown>): void {
    this.state.workspace = value;
    this.save();
  }

  // ----- conversations -----

  private convDir(projectId: string): string {
    const dir = path.join(this.dir, "projects", projectId, "conversations");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private convIndexFile(projectId: string): string {
    return path.join(this.convDir(projectId), "index.json");
  }

  conversations(projectId: string): Conversation[] {
    try {
      const list = JSON.parse(readFileSync(this.convIndexFile(projectId), "utf8")) as Conversation[];
      return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  conversation(projectId: string, id: string): Conversation | undefined {
    return this.conversations(projectId).find((c) => c.id === id);
  }

  createConversation(projectId: string, harness: string, title = "New conversation"): Conversation {
    const now = new Date().toISOString();
    const conv: Conversation = { id: randomUUID(), title, createdAt: now, updatedAt: now, harness };
    writeAtomic(this.convIndexFile(projectId), JSON.stringify([conv, ...this.conversations(projectId)], null, 2));
    return conv;
  }

  updateConversation(projectId: string, id: string, patch: Partial<Conversation>): Conversation | undefined {
    const list = this.conversations(projectId);
    const conv = list.find((c) => c.id === id);
    if (!conv) return undefined;
    Object.assign(conv, patch, { id: conv.id, updatedAt: new Date().toISOString() });
    writeAtomic(this.convIndexFile(projectId), JSON.stringify(list, null, 2));
    return conv;
  }

  private convLog(projectId: string, id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid conversation id.");
    return path.join(this.convDir(projectId), `${id}.jsonl`);
  }

  appendChatEvent(projectId: string, event: ChatEvent): void {
    appendFileSync(this.convLog(projectId, event.conversationId), `${JSON.stringify(event)}\n`, "utf8");
  }

  chatEvents(projectId: string, id: string): ChatEvent[] {
    const file = this.convLog(projectId, id);
    if (!existsSync(file)) return [];
    const events: ChatEvent[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as ChatEvent);
      } catch {
        // A line cut off by a crash is dropped; the rest of the log stands.
      }
    }
    return events;
  }

  // ----- audit trail of Studio actions -----

  audit(action: string, detail: Record<string, unknown>, projectId?: string): void {
    const entry: StudioAuditEntry = { ts: new Date().toISOString(), projectId, action, detail };
    appendFileSync(path.join(this.dir, "audit.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  }

  auditEntries(projectId?: string, limit = 500): StudioAuditEntry[] {
    const file = path.join(this.dir, "audit.jsonl");
    if (!existsSync(file)) return [];
    const entries: StudioAuditEntry[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as StudioAuditEntry;
        if (!projectId || entry.projectId === projectId) entries.push(entry);
      } catch {
        // skip a damaged line
      }
    }
    return entries.slice(-limit).reverse();
  }

  listProjectDataDirs(): string[] {
    return readdirSync(path.join(this.dir, "projects"));
  }
}
