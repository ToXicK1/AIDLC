// Application state. One store; the server is the source of truth and this
// mirrors it: snapshots and events arrive over the project stream, and after
// any reconnect the latest persisted state is fetched again rather than
// trusting what was on screen.

import { create } from "zustand";
import type {
  ChatEvent,
  ChatStatus,
  CommandSpec,
  Conversation,
  FsChange,
  GitStatus,
  LogLine,
  ProjectRecord,
  RunEvent,
  Snapshot,
  StudioAuditEntry,
  SystemInfo,
  TestRun,
  TreeEntry,
} from "../../shared/types.ts";
import { ApiError, P, Sys, bootstrapAuth, signIn } from "./api.ts";

export type View = "overview" | "requirements" | "architecture" | "implementation" | "testing" | "operations" | "artifacts" | "approvals" | `stage:${string}`;
export type BottomTab = "terminal" | "logs" | "agents" | "problems" | "tests" | "git";

export interface EditorTab {
  path: string;
  content: string;
  saved: string;
  mtime: number;
  mode: "edit" | "diff";
  original?: string;
  readOnly: boolean;
  binary: boolean;
  truncated: boolean;
  staleOnDisk: boolean;
  sensitive: boolean;
  line?: number;
}

export interface TermLine {
  id: number;
  kind: "cmd" | "out" | "err" | "info";
  text: string;
  ts: string;
}

export interface Toast {
  id: number;
  kind: "info" | "error" | "ok";
  text: string;
}

type ProjectRow = ProjectRecord & { exists?: boolean };
type Connection = "idle" | "connecting" | "live" | "reconnecting";

interface State {
  auth: "checking" | "needs_token" | "ok" | "offline";
  system: SystemInfo | null;
  projects: ProjectRow[];
  project: ProjectRow | null;
  snapshot: Snapshot | null;
  snapshotLoading: boolean;
  connection: Connection;
  view: View;
  dialog: null | "open" | "new" | "settings" | "setup";

  tree: Record<string, TreeEntry[]>;
  expanded: Record<string, boolean>;
  changes: Record<string, FsChange>;
  git: GitStatus | null;

  tabs: EditorTab[];
  activeTab: string | null;

  conversations: Conversation[];
  conversationId: string | null;
  chatEvents: ChatEvent[];
  streamText: string;
  chatStatus: ChatStatus;
  chatError: string | null;
  aidlcMode: boolean;

  logs: LogLine[];
  term: TermLine[];
  runs: Record<string, { commandId: string; running: boolean }>;
  commands: CommandSpec[];
  tests: { runs: TestRun[]; coverage: any; commands: Array<{ id: string; label: string; display: string }> };
  studioAudit: StudioAuditEntry[];

  bottomOpen: boolean;
  bottomTab: BottomTab;
  toasts: Toast[];

  boot(): Promise<void>;
  submitToken(token: string): Promise<void>;
  loadProjects(): Promise<void>;
  openProject(path: string, create?: boolean, name?: string): Promise<void>;
  selectProject(id: string): Promise<void>;
  closeProject(): void;
  refreshSnapshot(): Promise<void>;
  setView(view: View): void;
  setDialog(dialog: State["dialog"]): void;
  toast(kind: Toast["kind"], text: string): void;
  dismissToast(id: number): void;

  loadDir(dir: string): Promise<void>;
  toggleDir(dir: string): void;
  refreshGit(): Promise<void>;

  openFile(path: string, options?: { diff?: boolean; line?: number; reveal?: boolean }): Promise<void>;
  closeTab(path: string): void;
  setActiveTab(path: string): void;
  editTab(path: string, content: string): void;
  saveTab(path: string): Promise<void>;
  reloadTab(path: string): Promise<void>;
  setTabMode(path: string, mode: "edit" | "diff"): Promise<void>;

  loadConversations(): Promise<void>;
  selectConversation(id: string | null): Promise<void>;
  newConversation(): Promise<void>;
  sendChat(text: string): Promise<void>;
  stopChat(): Promise<void>;
  answerQuestion(id: string, answers: Record<string, string | string[]> | null, stage?: string): Promise<void>;
  decidePermission(id: string, decision: "allow" | "deny", message?: string): Promise<void>;
  decideGate(stage: string, decision: "approve" | "reject", comment: string): Promise<void>;
  setAidlcMode(on: boolean): void;

  loadCommands(): Promise<void>;
  runCommand(id: string): Promise<void>;
  killRun(runId: string): Promise<void>;
  clearTerm(): void;
  clearLogs(): Promise<void>;
  loadTests(): Promise<void>;
  loadAudit(): Promise<void>;
  setBottom(open: boolean, tab?: BottomTab): void;
  setupProject(harness: string, runtime?: string): Promise<boolean>;
  updateProject(patch: unknown): Promise<void>;
}

let stream: EventSource | null = null;
let termSeq = 0;
let toastSeq = 0;
const dirTimers = new Map<string, ReturnType<typeof setTimeout>>();
let gitTimer: ReturnType<typeof setTimeout> | null = null;
let workspaceTimer: ReturnType<typeof setTimeout> | null = null;

const parentDir = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useStudio = create<State>((set, get) => {
  const pid = (): string => {
    const project = get().project;
    if (!project) throw new Error("No project is open.");
    return project.id;
  };

  const persistWorkspace = (): void => {
    if (workspaceTimer) clearTimeout(workspaceTimer);
    workspaceTimer = setTimeout(() => {
      const s = get();
      if (!s.project) return;
      const perProject = {
        view: s.view,
        tabs: s.tabs.map((t) => ({ path: t.path, mode: t.mode })),
        activeTab: s.activeTab,
        conversationId: s.conversationId,
        expanded: Object.keys(s.expanded).filter((k) => s.expanded[k]).slice(0, 200),
        bottomOpen: s.bottomOpen,
        bottomTab: s.bottomTab,
      };
      void Sys.workspace()
        .then((current) => Sys.saveWorkspace({ ...(current.workspace ?? {}), [s.project!.id]: perProject }))
        .catch(() => undefined);
    }, 800);
  };

  const pushTerm = (kind: TermLine["kind"], text: string, ts = new Date().toISOString()): void => {
    const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
    set((s) => ({ term: [...s.term, ...lines.map((line) => ({ id: ++termSeq, kind, text: line, ts }))].slice(-4000) }));
  };

  const applyChat = (event: ChatEvent): void => {
    const s = get();
    if (event.type === "status") {
      if (!s.conversationId || event.conversationId === s.conversationId) {
        set({ chatStatus: event.status, chatError: event.status === "failed" ? (event.detail ?? "The harness session failed.") : null, ...(event.status === "idle" || event.status === "stopped" || event.status === "failed" ? { streamText: "" } : {}) });
      }
      return;
    }
    if (s.conversationId === null) {
      // The first message of a new conversation: adopt it.
      set({ conversationId: event.conversationId });
      void get().loadConversations();
    } else if (event.conversationId !== s.conversationId) {
      return;
    }
    if (event.type === "assistant_delta") {
      set((st) => ({ streamText: st.streamText + event.text }));
      return;
    }
    set((st) => ({
      chatEvents: st.chatEvents.some((e) => e.seq === event.seq) ? st.chatEvents : [...st.chatEvents, event],
      ...(event.type === "assistant" && !event.parent ? { streamText: "" } : {}),
    }));
    if (event.type === "question" || event.type === "permission") set({ bottomOpen: get().bottomOpen });
  };

  const onFs = (changes: FsChange[]): void => {
    const s = get();
    const next = { ...s.changes };
    const dirs = new Set<string>();
    for (const change of changes) {
      if (change.kind === "add" || change.kind === "change" || change.kind === "unlink") {
        if (!change.path.startsWith("aidlc/.aidlc-") && !change.path.includes("/.aidlc-engine/")) next[change.path] = change;
      }
      if (change.kind !== "change") dirs.add(parentDir(change.path));
      const tab = s.tabs.find((t) => t.path === change.path);
      if (tab && change.kind === "change") {
        if (tab.content === tab.saved) void get().reloadTab(tab.path);
        else set((st) => ({ tabs: st.tabs.map((t) => (t.path === tab.path ? { ...t, staleOnDisk: true } : t)) }));
      }
    }
    set({ changes: next });
    for (const dir of dirs) {
      if (!(dir in s.tree)) continue;
      const pending = dirTimers.get(dir);
      if (pending) clearTimeout(pending);
      dirTimers.set(
        dir,
        setTimeout(() => {
          dirTimers.delete(dir);
          void get().loadDir(dir);
        }, 250),
      );
    }
    if (gitTimer) clearTimeout(gitTimer);
    gitTimer = setTimeout(() => void get().refreshGit(), 1200);
  };

  const connect = (id: string): void => {
    stream?.close();
    set({ connection: "connecting" });
    const source = new EventSource(P(id).eventsUrl);
    stream = source;
    const on = <T,>(type: string, handler: (data: T) => void): void => {
      source.addEventListener(type, (raw) => {
        if (stream !== source) return;
        try {
          handler(JSON.parse((raw as MessageEvent).data) as T);
        } catch {
          // ignore a malformed frame
        }
      });
    };
    source.onopen = () => {
      if (stream !== source) return;
      const wasReconnect = get().connection === "reconnecting";
      set({ connection: "live" });
      if (wasReconnect) {
        // Recover from persisted state instead of showing stale progress as live.
        void get().refreshSnapshot();
        void get().selectConversation(get().conversationId);
        void get().loadTests();
        void get().refreshGit();
      }
    };
    source.onerror = () => {
      if (stream !== source) return;
      set({ connection: "reconnecting" });
    };
    on<{ chat: { status: ChatStatus; conversationId: string | null } }>("hello", (data) => {
      set({ chatStatus: data.chat.status });
    });
    on<Snapshot>("snapshot", (snapshot) => set({ snapshot }));
    on<ChatEvent>("chat", applyChat);
    on<LogLine>("log", (line) => set((s) => ({ logs: [...s.logs, line].slice(-3000) })));
    on<{ changes: FsChange[] }>("fs", (data) => onFs(data.changes));
    on<RunEvent>("run", (event) => {
      if (event.kind === "start") {
        pushTerm("cmd", `$ ${event.display ?? event.commandId}`, event.ts);
        set((s) => ({ runs: { ...s.runs, [event.runId]: { commandId: event.commandId, running: true } } }));
      } else if (event.kind === "stdout") pushTerm("out", event.text ?? "", event.ts);
      else if (event.kind === "stderr") pushTerm("err", event.text ?? "", event.ts);
      else if (event.kind === "error") pushTerm("err", `[error] ${event.text ?? ""}`, event.ts);
      else if (event.kind === "exit") {
        pushTerm("info", `[exit ${event.code ?? "killed"}]`, event.ts);
        set((s) => ({ runs: { ...s.runs, [event.runId]: { commandId: event.commandId, running: false } } }));
      }
    });
    on("tests", () => void get().loadTests());
    on("agents", () => void get().refreshSnapshot());
  };

  return {
    auth: "checking",
    system: null,
    projects: [],
    project: null,
    snapshot: null,
    snapshotLoading: false,
    connection: "idle",
    view: "overview",
    dialog: null,
    tree: {},
    expanded: {},
    changes: {},
    git: null,
    tabs: [],
    activeTab: null,
    conversations: [],
    conversationId: null,
    chatEvents: [],
    streamText: "",
    chatStatus: "idle",
    chatError: null,
    aidlcMode: true,
    logs: [],
    term: [],
    runs: {},
    commands: [],
    tests: { runs: [], coverage: null, commands: [] },
    studioAudit: [],
    bottomOpen: true,
    bottomTab: "logs",
    toasts: [],

    async boot() {
      try {
        const ok = await bootstrapAuth();
        if (!ok) {
          set({ auth: "needs_token" });
          return;
        }
      } catch {
        set({ auth: "offline" });
        return;
      }
      set({ auth: "ok" });
      void Sys.system().then((system) => set({ system })).catch(() => undefined);
      await get().loadProjects();
      const last = await Sys.projects().catch(() => null);
      const lastId = last?.lastProjectId as string | null | undefined;
      const row = lastId ? get().projects.find((p) => p.id === lastId && p.exists !== false) : undefined;
      if (row) await get().selectProject(row.id);
    },

    async submitToken(token) {
      await signIn(token.trim());
      await get().boot();
    },

    async loadProjects() {
      const data = await Sys.projects();
      set({ projects: data.projects });
    },

    async openProject(path, create = false, name) {
      const data = await Sys.open(path, create, name);
      await get().loadProjects();
      await get().selectProject(data.project.id);
    },

    async selectProject(id) {
      const row = get().projects.find((p) => p.id === id);
      if (!row) return;
      // Re-open on the server so it becomes the last project and its runtime exists.
      try {
        await Sys.open(row.path);
      } catch (error) {
        get().toast("error", message(error));
        return;
      }
      stream?.close();
      set({
        project: row,
        snapshot: null,
        tree: {},
        expanded: {},
        changes: {},
        git: null,
        tabs: [],
        activeTab: null,
        conversations: [],
        conversationId: null,
        chatEvents: [],
        streamText: "",
        chatStatus: "idle",
        chatError: null,
        logs: [],
        term: [],
        runs: {},
        commands: [],
        tests: { runs: [], coverage: null, commands: [] },
        view: "overview",
        dialog: null,
      });
      connect(id);
      const api = P(id);
      const saved = await Sys.workspace()
        .then((w) => (w.workspace?.[id] ?? null) as any)
        .catch(() => null);
      await Promise.all([
        get().refreshSnapshot(),
        get().loadDir(""),
        get().refreshGit(),
        get().loadCommands(),
        get().loadTests(),
        api.logs().then((d) => set({ logs: d.lines })).catch(() => undefined),
        api.changes().then((d) => set({ changes: Object.fromEntries((d.changes as FsChange[]).map((c) => [c.path, c])) })).catch(() => undefined),
        get().loadConversations(),
      ]);
      if (saved) {
        if (typeof saved.view === "string") set({ view: saved.view });
        if (typeof saved.bottomOpen === "boolean") set({ bottomOpen: saved.bottomOpen });
        if (typeof saved.bottomTab === "string") set({ bottomTab: saved.bottomTab });
        for (const dir of (saved.expanded ?? []) as string[]) {
          set((s) => ({ expanded: { ...s.expanded, [dir]: true } }));
          void get().loadDir(dir);
        }
        for (const tab of (saved.tabs ?? []) as Array<{ path: string; mode: "edit" | "diff" }>) {
          await get().openFile(tab.path, { diff: tab.mode === "diff" }).catch(() => undefined);
        }
        if (saved.activeTab && get().tabs.some((t) => t.path === saved.activeTab)) set({ activeTab: saved.activeTab });
      }
      const conversations = get().conversations;
      const wanted = saved?.conversationId && conversations.some((c) => c.id === saved.conversationId) ? saved.conversationId : (conversations[0]?.id ?? null);
      await get().selectConversation(wanted);
      const snapshot = get().snapshot;
      if (snapshot && !snapshot.install.installed) set({ dialog: "setup" });
    },

    closeProject() {
      stream?.close();
      stream = null;
      set({ project: null, snapshot: null, connection: "idle" });
    },

    async refreshSnapshot() {
      const project = get().project;
      if (!project) return;
      set({ snapshotLoading: true });
      try {
        const snapshot = await P(project.id).snapshot();
        if (get().project?.id === project.id) set({ snapshot });
      } catch (error) {
        get().toast("error", message(error));
      } finally {
        set({ snapshotLoading: false });
      }
    },

    setView(view) {
      set({ view });
      persistWorkspace();
    },

    setDialog(dialog) {
      set({ dialog });
    },

    toast(kind, text) {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-4) }));
      setTimeout(() => get().dismissToast(id), kind === "error" ? 9000 : 4500);
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    async loadDir(dir) {
      try {
        const data = await P(pid()).tree(dir);
        set((s) => ({ tree: { ...s.tree, [dir]: data.entries } }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          set((s) => {
            const tree = { ...s.tree };
            delete tree[dir];
            return { tree };
          });
        }
      }
    },

    toggleDir(dir) {
      const open = !get().expanded[dir];
      set((s) => ({ expanded: { ...s.expanded, [dir]: open } }));
      if (open && !(dir in get().tree)) void get().loadDir(dir);
      persistWorkspace();
    },

    async refreshGit() {
      const project = get().project;
      if (!project) return;
      try {
        const git = await P(project.id).gitStatus();
        if (get().project?.id === project.id) set({ git });
      } catch {
        // git view is optional
      }
    },

    async openFile(path, options = {}) {
      const api = P(pid());
      const existing = get().tabs.find((t) => t.path === path);
      if (existing && !options.reveal) {
        set({ activeTab: path, view: "implementation" });
        if (options.line) set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, line: options.line } : t)) }));
        if (options.diff && existing.mode !== "diff") await get().setTabMode(path, "diff");
        persistWorkspace();
        return;
      }
      let file: any;
      try {
        file = await api.file(path, options.reveal === true);
      } catch (error) {
        if (error instanceof ApiError && error.code === "sensitive") {
          if (window.confirm(`${path} may contain secrets (keys, passwords).\n\nShow its contents in Studio?`)) {
            await get().openFile(path, { ...options, reveal: true });
          }
          return;
        }
        get().toast("error", `${path}: ${message(error)}`);
        return;
      }
      let original: string | undefined;
      if (options.diff) original = (await api.gitOriginal(path).catch(() => ({ content: "" }))).content;
      const tab: EditorTab = {
        path: file.path,
        content: file.content,
        saved: file.content,
        mtime: file.mtime,
        mode: options.diff ? "diff" : "edit",
        original,
        readOnly: file.binary || file.truncated,
        binary: file.binary,
        truncated: file.truncated,
        staleOnDisk: false,
        sensitive: file.sensitive,
        line: options.line,
      };
      set((s) => ({ tabs: [...s.tabs.filter((t) => t.path !== tab.path), tab], activeTab: tab.path, view: "implementation" }));
      persistWorkspace();
    },

    closeTab(path) {
      const tab = get().tabs.find((t) => t.path === path);
      if (tab && tab.content !== tab.saved && !window.confirm(`Discard unsaved changes to ${path}?`)) return;
      set((s) => {
        const tabs = s.tabs.filter((t) => t.path !== path);
        return { tabs, activeTab: s.activeTab === path ? (tabs[tabs.length - 1]?.path ?? null) : s.activeTab };
      });
      persistWorkspace();
    },

    setActiveTab(path) {
      set({ activeTab: path });
      persistWorkspace();
    },

    editTab(path, content) {
      set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, content } : t)) }));
    },

    async saveTab(path) {
      const tab = get().tabs.find((t) => t.path === path);
      if (!tab || tab.readOnly) return;
      const body = { path, content: tab.content, expectedMtime: tab.mtime, confirmSensitive: tab.sensitive };
      try {
        const saved = await P(pid()).save(body);
        set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, saved: tab.content, mtime: saved.mtime, staleOnDisk: false } : t)) }));
        get().toast("ok", `Saved ${path}`);
      } catch (error) {
        if (error instanceof ApiError && error.code === "conflict") {
          if (window.confirm(`${path} changed on disk since you opened it.\n\nOverwrite it with your version?`)) {
            const saved = await P(pid()).save({ ...body, expectedMtime: undefined });
            set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, saved: tab.content, mtime: saved.mtime, staleOnDisk: false } : t)) }));
          }
          return;
        }
        get().toast("error", `Could not save ${path}: ${message(error)}`);
      }
    },

    async reloadTab(path) {
      const tab = get().tabs.find((t) => t.path === path);
      if (!tab) return;
      try {
        const file = await P(pid()).file(path, tab.sensitive);
        set((s) => ({
          tabs: s.tabs.map((t) => (t.path === path ? { ...t, content: file.content, saved: file.content, mtime: file.mtime, staleOnDisk: false, binary: file.binary, truncated: file.truncated } : t)),
        }));
      } catch {
        // The file was removed; keep what the editor has.
      }
    },

    async setTabMode(path, mode) {
      let original: string | undefined;
      if (mode === "diff") original = (await P(pid()).gitOriginal(path).catch(() => ({ content: "" }))).content;
      set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, mode, original: mode === "diff" ? original : t.original } : t)) }));
      persistWorkspace();
    },

    async loadConversations() {
      const project = get().project;
      if (!project) return;
      try {
        const data = await P(project.id).conversations();
        set({ conversations: data.conversations, chatStatus: data.chat.status });
      } catch {
        // shown when the person next sends
      }
    },

    async selectConversation(id) {
      if (!id) {
        set({ conversationId: null, chatEvents: [], streamText: "" });
        return;
      }
      try {
        const data = await P(pid()).events(id);
        const active = data.chat.conversationId === id;
        set({ conversationId: id, chatEvents: data.events, streamText: "", chatStatus: active ? data.chat.status : "idle", chatError: null });
        // /aidlc was already invoked in this conversation: later messages are plain replies.
        set({ aidlcMode: !(data.events as ChatEvent[]).some((e) => e.type === "user" && e.text.startsWith("/aidlc")) });
        persistWorkspace();
      } catch (error) {
        get().toast("error", message(error));
      }
    },

    async newConversation() {
      try {
        const data = await P(pid()).newConversation();
        await get().loadConversations();
        set({ conversationId: data.conversation.id, chatEvents: [], streamText: "", chatStatus: "idle", chatError: null, aidlcMode: true });
        persistWorkspace();
      } catch (error) {
        get().toast("error", message(error));
      }
    },

    async sendChat(text) {
      set({ chatError: null });
      try {
        const data = await P(pid()).send(get().conversationId, text);
        if (get().conversationId !== data.conversation.id) set({ conversationId: data.conversation.id });
        if (text.startsWith("/aidlc")) set({ aidlcMode: false });
        void get().loadConversations();
        persistWorkspace();
      } catch (error) {
        set({ chatError: message(error) });
        throw error;
      }
    },

    async stopChat() {
      await P(pid()).stop().catch((error) => get().toast("error", message(error)));
    },

    async answerQuestion(id, answers, stage) {
      try {
        await P(pid()).answer(id, answers, stage);
      } catch (error) {
        get().toast("error", message(error));
      }
    },

    async decidePermission(id, decision, text) {
      try {
        await P(pid()).permission(id, decision, text);
      } catch (error) {
        get().toast("error", message(error));
      }
    },

    async decideGate(stage, decision, comment) {
      try {
        await P(pid()).approve(stage, decision, comment);
        get().toast("ok", decision === "approve" ? "Approval sent to the workflow." : "Change request sent to the workflow.");
        void get().loadAudit();
      } catch (error) {
        get().toast("error", message(error));
      }
    },

    setAidlcMode(on) {
      set({ aidlcMode: on });
    },

    async loadCommands() {
      try {
        const data = await P(pid()).commands();
        set({ commands: data.commands });
      } catch {
        // none
      }
    },

    async runCommand(id) {
      set({ bottomOpen: true, bottomTab: "terminal" });
      try {
        await P(pid()).run(id);
      } catch (error) {
        pushTerm("err", message(error));
      }
    },

    async killRun(runId) {
      await P(pid()).kill(runId).catch(() => undefined);
    },

    clearTerm() {
      set({ term: [] });
    },

    async clearLogs() {
      await P(pid()).clearLogs().catch(() => undefined);
      set({ logs: [] });
    },

    async loadTests() {
      const project = get().project;
      if (!project) return;
      try {
        const data = await P(project.id).tests();
        if (get().project?.id === project.id) set({ tests: data });
      } catch {
        // none
      }
    },

    async loadAudit() {
      try {
        const data = await P(pid()).audit();
        set({ studioAudit: data.entries });
      } catch {
        // none
      }
    },

    setBottom(open, tab) {
      set({ bottomOpen: open, ...(tab ? { bottomTab: tab } : {}) });
      persistWorkspace();
    },

    async setupProject(harness, runtime = "auto") {
      try {
        const data = await P(pid()).init(harness, runtime);
        set({ snapshot: data.snapshot });
        get().toast("ok", data.result.message);
        await Promise.all([get().loadDir(""), get().loadCommands(), get().loadProjects()]);
        const row = get().projects.find((p) => p.id === get().project?.id);
        if (row) set({ project: row });
        return true;
      } catch (error) {
        get().toast("error", message(error));
        void get().refreshSnapshot();
        return false;
      }
    },

    async updateProject(patch) {
      try {
        const data = await P(pid()).patch(patch);
        set({ project: { ...get().project!, ...data.project } });
        await get().loadProjects();
      } catch (error) {
        get().toast("error", message(error));
      }
    },
  };
});

/** Open questions and permission requests in the current conversation. */
export function pendingRequests(events: ChatEvent[]): { questions: Extract<ChatEvent, { type: "question" }>[]; permissions: Extract<ChatEvent, { type: "permission" }>[] } {
  const answered = new Set<string>();
  const decided = new Set<string>();
  for (const e of events) {
    if (e.type === "question_answered") answered.add(e.id);
    if (e.type === "permission_decided") decided.add(e.id);
  }
  return {
    questions: events.filter((e): e is Extract<ChatEvent, { type: "question" }> => e.type === "question" && !answered.has(e.id)),
    permissions: events.filter((e): e is Extract<ChatEvent, { type: "permission" }> => e.type === "permission" && !decided.has(e.id)),
  };
}
