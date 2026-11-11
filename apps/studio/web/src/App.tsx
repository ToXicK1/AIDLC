// The IDE shell: project/lifecycle sidebar, workspace + execution panel, chat.

import { AlertTriangle, Boxes, ChevronUp, ClipboardList, Code2, FlaskConical, FolderPlus, FolderSearch, GitBranch, LayoutDashboard, Network, PanelLeft, PanelRight, Rocket, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { Component, type ReactNode, lazy, Suspense, useEffect, useRef, useState } from "react";
import { type ImperativePanelHandle, Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { BottomPanel, useProblems } from "./components/BottomPanel.tsx";
import { AIChatPanel } from "./components/Chat.tsx";
import { OpenProjectDialog, SettingsDialog, SetupDialog } from "./components/Dialogs.tsx";
import { ProjectSidebar } from "./components/Sidebar.tsx";
import { Badge, Empty, Spinner, Toasts, cx, timeAgo, titleCase } from "./components/ui.tsx";
import { ApprovalsView, ArchitectureView, ArtifactsView, OperationsView, Overview, RequirementsView, StageView, TestingView } from "./components/views/Views.tsx";
import { type View, useStudio } from "./store.ts";

const ImplementationView = lazy(() => import("./components/views/Implementation.tsx").then((m) => ({ default: m.ImplementationView })));

const VIEWS: Array<{ id: View; label: string; icon: typeof Code2 }> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "requirements", label: "Requirements", icon: ClipboardList },
  { id: "architecture", label: "Architecture", icon: Network },
  { id: "implementation", label: "Implementation", icon: Code2 },
  { id: "testing", label: "Testing", icon: FlaskConical },
  { id: "operations", label: "Deploy & Ops", icon: Rocket },
  { id: "artifacts", label: "Artifacts", icon: Boxes },
  { id: "approvals", label: "Approvals", icon: ShieldCheck },
];

/** Keeps one failing view from blanking the whole IDE. */
class ErrorBoundary extends Component<{ children: ReactNode; label: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }
  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = /dynamically imported module|Loading chunk|module script/i.test(error.message);
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <AlertTriangle size={22} className="text-warn" />
        <div className="text-sm font-medium">{stale ? "Studio was updated while this page was open" : `${this.props.label} could not be shown`}</div>
        <div className="max-w-md break-words text-xs text-ink-faint">{stale ? "Reload the page to load the new version. Your project, workflow and conversations are saved." : error.message}</div>
        <div className="mt-1 flex gap-2">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload Studio</button>
          {!stale ? <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Try again</button> : null}
        </div>
      </div>
    );
  }
}

function TokenScreen({ offline }: { offline: boolean }) {
  const submitToken = useStudio((s) => s.submitToken);
  const boot = useStudio((s) => s.boot);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="card w-full max-w-md p-5">
        <h1 className="text-[15px] font-semibold">AI-DLC Studio</h1>
        {offline ? (
          <>
            <p className="mt-2 text-sm text-ink-muted">Studio's local server is not answering. Start it again, then retry.</p>
            <pre className="mt-2 rounded border border-line bg-bg p-2 font-mono text-xs text-ink-muted">npm start</pre>
            <button type="button" className="btn btn-primary mt-3" onClick={() => void boot()}>Retry</button>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-ink-muted">This Studio is protected by a one-launch access token. Open the link printed in the terminal where Studio was started, or paste the token here.</p>
            <input className="input mt-3 font-mono text-xs" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Access token" aria-label="Access token" autoFocus />
            {error ? <div className="mt-1 text-xs text-bad">{error}</div> : null}
            <button type="button" className="btn btn-primary mt-3" disabled={!token.trim()} onClick={() => void submitToken(token).catch((e: Error) => setError(e.message))}>Unlock</button>
          </>
        )}
      </div>
    </div>
  );
}

function Welcome() {
  const projects = useStudio((s) => s.projects);
  const selectProject = useStudio((s) => s.selectProject);
  const setDialog = useStudio((s) => s.setDialog);
  const system = useStudio((s) => s.system);
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col justify-center gap-5 overflow-y-auto p-8">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">AI-DLC Studio</h1>
        <p className="mt-1 text-sm text-ink-muted">Open a project to run the AI-Driven Development Life Cycle on it: describe the work in chat, watch the stages and agents, review artifacts, and decide every approval gate.</p>
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn btn-primary px-3 py-1.5" onClick={() => setDialog("open")}><FolderSearch size={14} /> Open Existing Project</button>
        <button type="button" className="btn px-3 py-1.5" onClick={() => setDialog("new")}><FolderPlus size={14} /> New Project</button>
      </div>
      {projects.length > 0 ? (
        <div>
          <div className="label mb-1.5">Recent projects</div>
          <div className="card divide-y divide-line">
            {projects.slice(0, 8).map((p) => (
              <button key={p.id} type="button" disabled={p.exists === false} onClick={() => void selectProject(p.id)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-bg-hover disabled:opacity-40">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-accent/15 text-[11px] font-bold text-accent-strong">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{p.name}</span>
                  <span className="block truncate font-mono text-2xs text-ink-faint">{p.exists === false ? "folder missing — " : ""}{p.path}</span>
                </span>
                <span className="shrink-0 text-2xs text-ink-ghost">{timeAgo(p.lastOpened)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div>
        <div className="label mb-1.5">This machine</div>
        <div className="card grid grid-cols-1 gap-x-6 gap-y-1 p-3 text-sm md:grid-cols-2">
          {system ? (
            Object.entries(system.tools).map(([name, tool]) => (
              <div key={name} className="flex items-center gap-2">
                <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", tool.ok ? "bg-ok" : name === "aidlc" ? "bg-ink-ghost" : "bg-warn")} />
                <span className="w-14 shrink-0 font-mono text-xs">{name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-ink-faint" title={tool.error ?? tool.path}>{tool.ok ? tool.version : name === "aidlc" ? "native command unavailable — using the Bun runtime" : tool.error}</span>
              </div>
            ))
          ) : (
            <Spinner />
          )}
        </div>
      </div>
    </div>
  );
}

function WorkspaceBody() {
  const view = useStudio((s) => s.view);
  if (view.startsWith("stage:")) return <StageView slug={view.slice(6)} />;
  switch (view) {
    case "requirements":
      return <RequirementsView />;
    case "architecture":
      return <ArchitectureView />;
    case "implementation":
      return (
        <Suspense fallback={<div className="p-6"><Spinner /></div>}>
          <ImplementationView />
        </Suspense>
      );
    case "testing":
      return <TestingView />;
    case "operations":
      return <OperationsView />;
    case "artifacts":
      return <ArtifactsView />;
    case "approvals":
      return <ApprovalsView />;
    default:
      return <Overview />;
  }
}

export function MainWorkspace() {
  const view = useStudio((s) => s.view);
  const setView = useStudio((s) => s.setView);
  const gates = useStudio((s) => s.snapshot?.gates.length ?? 0);
  const dirtyTabs = useStudio((s) => s.tabs.filter((t) => t.content !== t.saved).length);
  const failing = useStudio((s) => s.tests.runs[0]?.status === "failed" || s.tests.runs[0]?.status === "error");
  const stageSlug = view.startsWith("stage:") ? view.slice(6) : null;
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <nav className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-line bg-bg-raised px-1" role="tablist" aria-label="Workspaces">
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)} className={cx("flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-sm transition-colors", view === id ? "border-accent text-ink" : "border-transparent text-ink-faint hover:text-ink")}>
            <Icon size={13} />
            {label}
            {id === "approvals" && gates > 0 ? <Badge tone="wait">{gates}</Badge> : null}
            {id === "implementation" && dirtyTabs > 0 ? <span className="h-1.5 w-1.5 rounded-full bg-accent" title={`${dirtyTabs} unsaved`} /> : null}
            {id === "testing" && failing ? <span className="h-1.5 w-1.5 rounded-full bg-bad" title="Latest test run failed" /> : null}
          </button>
        ))}
        {stageSlug ? (
          <span className="flex shrink-0 items-center gap-1.5 border-b-2 border-accent px-2.5 text-sm text-ink" role="tab" aria-selected>
            Stage: {titleCase(stageSlug)}
          </span>
        ) : null}
      </nav>
      <div className="min-h-0 flex-1">
        <ErrorBoundary key={view} label="This workspace">
          <WorkspaceBody />
        </ErrorBoundary>
      </div>
    </div>
  );
}

function ApprovalNotice() {
  const gates = useStudio((s) => s.snapshot?.gates);
  const view = useStudio((s) => s.view);
  const setView = useStudio((s) => s.setView);
  if (!gates || gates.length === 0 || view === "approvals") return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-wait/40 bg-wait/10 px-3 py-1 text-sm" role="alert">
      <ShieldCheck size={14} className="shrink-0 text-wait" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">Approval required:</span> {gates.map((g) => g.stageName).join(", ")}. The workflow will not continue until you decide.
      </span>
      <button type="button" className="btn btn-primary h-6" onClick={() => setView("approvals")}>Review</button>
    </div>
  );
}

function StatusBar() {
  const connection = useStudio((s) => s.connection);
  const project = useStudio((s) => s.project);
  const snapshot = useStudio((s) => s.snapshot);
  const chatStatus = useStudio((s) => s.chatStatus);
  const git = useStudio((s) => s.git);
  const setBottom = useStudio((s) => s.setBottom);
  const bottomOpen = useStudio((s) => s.bottomOpen);
  const problems = useProblems();
  const state = snapshot?.state;
  const gates = snapshot?.gates.length ?? 0;
  const workflow = !project ? "No project" : !snapshot ? "Reading…" : !snapshot.install.installed ? "AI-DLC not set up" : !state ? "No workflow" : gates > 0 ? "Waiting for approval" : state.status === "Completed" ? "Completed" : chatStatus === "running" || chatStatus === "starting" ? "Running" : chatStatus === "waiting_input" ? "Waiting for you" : chatStatus === "failed" ? "Failed" : state.status === "Running" ? "Interrupted — resume in chat" : state.status;
  const tone = workflow === "Running" ? "text-info" : workflow.startsWith("Waiting") ? "text-wait" : workflow === "Failed" ? "text-bad" : workflow === "Completed" ? "text-ok" : workflow.startsWith("Interrupted") ? "text-warn" : "text-ink-faint";
  const errors = problems.filter((p) => p.severity === "error").length;
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-bg-raised px-2 text-2xs text-ink-faint">
      <span className={cx("flex items-center gap-1", connection === "live" ? "text-ok" : connection === "idle" ? "text-ink-ghost" : "text-warn")} title="Connection to the Studio server">
        {connection === "live" ? <Wifi size={11} /> : <WifiOff size={11} />}
        {connection === "live" ? "Live" : connection === "connecting" ? "Connecting…" : connection === "reconnecting" ? "Reconnecting… (showing last known state)" : "Offline"}
      </span>
      <span className={cx("font-medium", tone)}>{workflow}</span>
      {state ? <span className="truncate">{titleCase(state.lifecyclePhase.toLowerCase())} › {state.currentStage || "—"} · {state.completed}/{state.total} stages · scope {state.scope}</span> : null}
      <span className="flex-1" />
      {git?.isRepo ? <span className="flex items-center gap-1"><GitBranch size={11} />{git.branch} · {git.files.length} changed</span> : null}
      <button type="button" className={cx("flex items-center gap-1 hover:text-ink", errors > 0 && "text-bad")} onClick={() => setBottom(true, "problems")}>
        <AlertTriangle size={11} /> {problems.length} problem{problems.length === 1 ? "" : "s"}
      </button>
      {snapshot?.install.engine ? <span title="Engine command Studio runs">{snapshot.install.engine.kind === "bun" ? "engine: bun runtime" : "engine: native aidlc"}</span> : null}
      {!bottomOpen ? (
        <button type="button" className="flex items-center gap-1 hover:text-ink" onClick={() => setBottom(true)}>
          <ChevronUp size={11} /> Panel
        </button>
      ) : null}
    </footer>
  );
}

function Shell() {
  const project = useStudio((s) => s.project);
  const bottomOpen = useStudio((s) => s.bottomOpen);
  const setBottom = useStudio((s) => s.setBottom);
  const dialog = useStudio((s) => s.dialog);
  const leftRef = useRef<ImperativePanelHandle>(null);
  const rightRef = useRef<ImperativePanelHandle>(null);
  const bottomRef = useRef<ImperativePanelHandle>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  useEffect(() => {
    const panel = bottomRef.current;
    if (!panel) return;
    if (bottomOpen && panel.isCollapsed()) panel.expand();
    if (!bottomOpen && !panel.isCollapsed()) panel.collapse();
  }, [bottomOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "b") {
        e.preventDefault();
        leftRef.current?.isCollapsed() ? leftRef.current?.expand() : leftRef.current?.collapse();
      } else if (e.key === "j") {
        e.preventDefault();
        setBottom(!useStudio.getState().bottomOpen);
      } else if (e.key === "s") {
        // Never let the browser's "save page" dialog appear over the IDE.
        const s = useStudio.getState();
        e.preventDefault();
        if (s.view === "implementation" && s.activeTab) void s.saveTab(s.activeTab);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setBottom]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent): void => {
      if (useStudio.getState().tabs.some((t) => t.content !== t.saved)) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-bg-raised px-2">
        <button type="button" className={cx("icon-btn", leftOpen && "text-ink")} onClick={() => (leftRef.current?.isCollapsed() ? leftRef.current?.expand() : leftRef.current?.collapse())} title="Toggle sidebar (Ctrl+B)" aria-label="Toggle sidebar">
          <PanelLeft size={15} />
        </button>
        <span className="text-[13px] font-semibold tracking-tight">AI-DLC Studio</span>
        {project ? <span className="truncate text-xs text-ink-faint">— {project.name}</span> : null}
        <span className="flex-1" />
        <button type="button" className={cx("icon-btn", rightOpen && "text-ink")} onClick={() => (rightRef.current?.isCollapsed() ? rightRef.current?.expand() : rightRef.current?.collapse())} title="Toggle chat" aria-label="Toggle chat">
          <PanelRight size={15} />
        </button>
      </header>
      <ApprovalNotice />
      <PanelGroup direction="horizontal" autoSaveId="studio-columns" className="min-h-0 flex-1">
        <Panel ref={leftRef} id="left" order={1} defaultSize={16} minSize={11} maxSize={32} collapsible collapsedSize={0} onCollapse={() => setLeftOpen(false)} onExpand={() => setLeftOpen(true)}>
          <ErrorBoundary label="The sidebar">
            <ProjectSidebar />
          </ErrorBoundary>
        </Panel>
        <PanelResizeHandle className="resize-handle w-px" />
        <Panel id="center" order={2} defaultSize={54} minSize={28}>
          {project ? (
            <PanelGroup direction="vertical" autoSaveId="studio-rows">
              <Panel id="workspace" order={1} defaultSize={68} minSize={25}>
                <MainWorkspace />
              </Panel>
              <PanelResizeHandle className="resize-handle h-px" />
              <Panel ref={bottomRef} id="bottom" order={2} defaultSize={32} minSize={12} collapsible collapsedSize={0} onCollapse={() => setBottom(false)} onExpand={() => setBottom(true)}>
                <ErrorBoundary label="The execution panel">
                  <BottomPanel />
                </ErrorBoundary>
              </Panel>
            </PanelGroup>
          ) : (
            <Welcome />
          )}
        </Panel>
        <PanelResizeHandle className="resize-handle w-px" />
        <Panel ref={rightRef} id="right" order={3} defaultSize={30} minSize={20} maxSize={48} collapsible collapsedSize={0} onCollapse={() => setRightOpen(false)} onExpand={() => setRightOpen(true)}>
          <ErrorBoundary label="The chat">
            <AIChatPanel />
          </ErrorBoundary>
        </Panel>
      </PanelGroup>
      <StatusBar />
      {dialog === "open" || dialog === "new" ? <OpenProjectDialog key={dialog} mode={dialog} /> : null}
      {dialog === "setup" ? <SetupDialog /> : null}
      {dialog === "settings" ? <SettingsDialog /> : null}
      <Toasts />
    </div>
  );
}

export function App() {
  const auth = useStudio((s) => s.auth);
  const boot = useStudio((s) => s.boot);
  useEffect(() => void boot(), [boot]);
  if (auth === "checking") return <Empty title="Starting AI-DLC Studio…" icon={<Spinner className="h-5 w-5" />} />;
  if (auth === "needs_token" || auth === "offline") return <TokenScreen offline={auth === "offline"} />;
  return <Shell />;
}
