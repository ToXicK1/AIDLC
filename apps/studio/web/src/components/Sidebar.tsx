// Left sidebar: project switcher, AI-DLC lifecycle navigator, project explorer.

import { ChevronDown, ChevronRight, File, Folder, FolderOpen, FolderPlus, FolderSearch, Lock, RefreshCw, Search, Settings, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { StageProgress, StageState, TreeEntry } from "../../../shared/types.ts";
import { P } from "../api.ts";
import { useStudio } from "../store.ts";
import { Badge, Empty, Spinner, StateDot, cx, titleCase } from "./ui.tsx";

function ProjectMenu() {
  const project = useStudio((s) => s.project);
  const projects = useStudio((s) => s.projects);
  const selectProject = useStudio((s) => s.selectProject);
  const setDialog = useStudio((s) => s.setDialog);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const recent = projects.filter((p) => p.id !== project?.id).slice(0, 8);
  return (
    <div ref={ref} className="relative border-b border-line">
      <button type="button" className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-bg-hover" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-accent/15 text-[11px] font-bold text-accent-strong">{(project?.name ?? "?").slice(0, 1).toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{project?.name ?? "No project"}</span>
          <span className="block truncate text-2xs text-ink-faint" title={project?.path}>
            {project?.path ?? "Open a project to begin"}
          </span>
        </span>
        <ChevronDown size={14} className="shrink-0 text-ink-faint" />
      </button>
      {open ? (
        <div role="menu" className="absolute left-2 right-2 top-full z-40 mt-1 rounded-md border border-line-strong bg-bg-panel py-1 shadow-2xl">
          <MenuItem icon={<FolderPlus size={13} />} label="New Project…" onClick={() => (setOpen(false), setDialog("new"))} />
          <MenuItem icon={<FolderSearch size={13} />} label="Open Existing Project…" onClick={() => (setOpen(false), setDialog("open"))} />
          {project ? <MenuItem icon={<Settings size={13} />} label="Project Settings…" onClick={() => (setOpen(false), setDialog("settings"))} /> : null}
          {recent.length > 0 ? <div className="label mt-1 border-t border-line px-3 pb-1 pt-2">Recent projects</div> : null}
          {recent.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              disabled={p.exists === false}
              className="flex w-full flex-col px-3 py-1 text-left hover:bg-bg-hover disabled:opacity-40"
              onClick={() => (setOpen(false), void selectProject(p.id))}
            >
              <span className="truncate text-sm">{p.name}</span>
              <span className="truncate text-2xs text-ink-faint">{p.exists === false ? "folder missing — " : ""}{p.path}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-hover" onClick={onClick}>
      <span className="text-ink-muted">{icon}</span>
      {label}
    </button>
  );
}

function Section({ title, right, children, defaultOpen = true, grow }: { title: string; right?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; grow?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cx("flex min-h-0 flex-col border-b border-line", open && grow && "flex-1")}>
      <div className="flex h-7 shrink-0 items-center gap-1 px-2">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={12} className="text-ink-faint" /> : <ChevronRight size={12} className="text-ink-faint" />}
          <span className="label truncate">{title}</span>
        </button>
        {right}
      </div>
      {open ? <div className="min-h-0 flex-1 overflow-y-auto pb-1">{children}</div> : null}
    </section>
  );
}

// ---------- lifecycle ----------

const PHASE_TONE: Record<string, "ok" | "info" | "muted"> = { Verified: "ok", Active: "info", Pending: "muted", Skipped: "muted" };

export function LifecycleNavigator() {
  const snapshot = useStudio((s) => s.snapshot);
  const view = useStudio((s) => s.view);
  const setView = useStudio((s) => s.setView);
  const [showAll, setShowAll] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const lifecycle = snapshot?.lifecycle;
  const progress = useMemo(() => new Map<string, StageProgress>((snapshot?.state?.stages ?? []).map((s) => [s.slug, s])), [snapshot?.state]);

  if (!snapshot) return <div className="flex items-center gap-2 px-3 py-2 text-xs text-ink-faint"><Spinner /> Reading the engine…</div>;
  if (!lifecycle) {
    return <div className="px-3 py-2 text-xs text-ink-faint">{snapshot.install.installed ? "The engine's stage graph could not be read. See Problems." : "AI-DLC is not set up in this project yet."}</div>;
  }
  const hasWork = snapshot.state !== null;
  return (
    <div>
      {lifecycle.phases.map((phase) => {
        const phaseStatus = snapshot.state?.phases.find((p) => p.name.toLowerCase() === phase.id)?.status;
        const rows = phase.stages.filter((stage) => showAll || !hasWork || (progress.get(stage.slug)?.state ?? "not_in_plan") !== "not_in_plan");
        const planned = phase.stages.filter((s) => (progress.get(s.slug)?.plan ?? "") === "EXECUTE");
        const done = planned.filter((s) => progress.get(s.slug)?.state === "completed").length;
        const isCollapsed = collapsed[phase.id] ?? (hasWork && (phaseStatus === "Skipped" || rows.length === 0));
        return (
          <div key={phase.id}>
            <button type="button" className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-bg-hover" onClick={() => setCollapsed({ ...collapsed, [phase.id]: !isCollapsed })} aria-expanded={!isCollapsed}>
              {isCollapsed ? <ChevronRight size={12} className="text-ink-faint" /> : <ChevronDown size={12} className="text-ink-faint" />}
              <span className={cx("flex-1 truncate text-xs font-semibold", phaseStatus === "Skipped" ? "text-ink-faint" : "text-ink")}>{titleCase(phase.id)}</span>
              {hasWork && planned.length > 0 ? <span className="text-2xs tabular-nums text-ink-faint">{done}/{planned.length}</span> : null}
              {phaseStatus ? <Badge tone={PHASE_TONE[phaseStatus] ?? "muted"}>{phaseStatus}</Badge> : null}
            </button>
            {!isCollapsed
              ? rows.map((stage) => {
                  const p = progress.get(stage.slug);
                  const state: StageState = hasWork ? (p?.state ?? "not_in_plan") : "pending";
                  const selected = view === `stage:${stage.slug}`;
                  const current = snapshot.state?.currentStage === stage.slug && snapshot.state.status !== "Completed";
                  return (
                    <button
                      key={stage.slug}
                      type="button"
                      onClick={() => setView(`stage:${stage.slug}`)}
                      title={`${stage.number} ${stage.name}`}
                      className={cx(
                        "flex w-full items-center gap-2 py-[3px] pl-7 pr-2 text-left text-sm hover:bg-bg-hover",
                        selected && "bg-bg-active",
                        state === "not_in_plan" || state === "skipped" ? "text-ink-ghost" : state === "pending" ? "text-ink-muted" : "text-ink",
                      )}
                    >
                      {hasWork ? <StateDot state={state} /> : <span className="h-2 w-2 shrink-0 rounded-full border border-ink-ghost" />}
                      <span className="w-6 shrink-0 font-mono text-2xs text-ink-ghost">{stage.number}</span>
                      <span className={cx("min-w-0 flex-1 truncate", current && "font-semibold")}>{stage.name}</span>
                      {state === "awaiting_approval" ? <ShieldCheck size={12} className="shrink-0 text-wait" aria-label="Approval required" /> : null}
                      {state === "revising" ? <Badge tone="warn">revising</Badge> : null}
                    </button>
                  );
                })
              : null}
          </div>
        );
      })}
      {hasWork ? (
        <button type="button" className="mt-1 w-full px-3 py-1 text-left text-2xs text-ink-faint hover:text-ink" onClick={() => setShowAll(!showAll)}>
          {showAll ? "Hide stages not in this plan" : "Show stages not in this plan"}
        </button>
      ) : (
        <div className="px-3 py-1.5 text-2xs text-ink-faint">No workflow yet. Describe what to build in the chat to start one.</div>
      )}
    </div>
  );
}

// ---------- explorer ----------

const GIT_MARK: Record<string, { letter: string; className: string; title: string }> = {
  added: { letter: "A", className: "text-ok", title: "Added" },
  untracked: { letter: "U", className: "text-ok", title: "New (untracked)" },
  modified: { letter: "M", className: "text-warn", title: "Modified" },
  deleted: { letter: "D", className: "text-bad", title: "Deleted" },
  renamed: { letter: "R", className: "text-info", title: "Renamed" },
  conflict: { letter: "!", className: "text-bad", title: "Conflict" },
};

function TreeNode({ entry, depth }: { entry: TreeEntry; depth: number }) {
  const expanded = useStudio((s) => s.expanded[entry.path] === true);
  const children = useStudio((s) => s.tree[entry.path]);
  const toggleDir = useStudio((s) => s.toggleDir);
  const openFile = useStudio((s) => s.openFile);
  const active = useStudio((s) => s.activeTab === entry.path && s.view === "implementation");
  const gitLabel = useStudio((s) => s.git?.files.find((f) => f.path === entry.path)?.label);
  const sessionChange = useStudio((s) => s.changes[entry.path]?.kind);
  const dirChanged = useStudio((s) => entry.dir && Object.keys(s.changes).some((p) => p.startsWith(`${entry.path}/`)));
  const mark = gitLabel ? GIT_MARK[gitLabel] : undefined;
  const pad = { paddingLeft: 8 + depth * 12 };
  if (entry.dir) {
    return (
      <div>
        <button type="button" style={pad} className={cx("flex w-full items-center gap-1 py-[2px] pr-2 text-left text-sm hover:bg-bg-hover", entry.heavy ? "text-ink-ghost" : "text-ink-muted")} onClick={() => toggleDir(entry.path)} aria-expanded={expanded}>
          {expanded ? <ChevronDown size={12} className="shrink-0 text-ink-faint" /> : <ChevronRight size={12} className="shrink-0 text-ink-faint" />}
          {expanded ? <FolderOpen size={13} className="shrink-0 text-ink-faint" /> : <Folder size={13} className="shrink-0 text-ink-faint" />}
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          {dirChanged ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Contains files changed this session" /> : null}
        </button>
        {expanded ? children ? children.length > 0 ? children.map((c) => <TreeNode key={c.path} entry={c} depth={depth + 1} />) : <div style={{ paddingLeft: 32 + depth * 12 }} className="py-0.5 text-2xs text-ink-ghost">empty</div> : <div style={{ paddingLeft: 32 + depth * 12 }} className="py-0.5"><Spinner /></div> : null}
      </div>
    );
  }
  return (
    <button
      type="button"
      style={pad}
      className={cx("flex w-full items-center gap-1 py-[2px] pr-2 text-left text-sm hover:bg-bg-hover", active ? "bg-bg-active text-ink" : mark ? mark.className : "text-ink-muted")}
      onClick={() => void openFile(entry.path, { diff: gitLabel === "modified" })}
      title={entry.path}
    >
      <span className="w-3 shrink-0" />
      {entry.sensitive ? <Lock size={12} className="shrink-0 text-warn" /> : <File size={12} className="shrink-0 text-ink-ghost" />}
      <span className={cx("min-w-0 flex-1 truncate", gitLabel === "deleted" && "line-through")}>{entry.name}</span>
      {sessionChange && sessionChange !== "unlink" ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title={sessionChange === "add" ? "Created this session" : "Changed this session"} /> : null}
      {mark ? <span className={cx("w-3 shrink-0 text-center font-mono text-2xs font-bold", mark.className)} title={mark.title}>{mark.letter}</span> : null}
    </button>
  );
}

function FileSearch({ onClose }: { onClose: () => void }) {
  const project = useStudio((s) => s.project);
  const openFile = useStudio((s) => s.openFile);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"name" | "content">("name");
  const [regex, setRegex] = useState(false);
  const [busy, setBusy] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  const [hits, setHits] = useState<{ hits: Array<{ path: string; line: number; text: string }>; truncated: boolean; filesScanned: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!project || text.trim().length < 2) {
      setNames([]);
      setHits(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setBusy(true);
      setError(null);
      const request = mode === "name" ? P(project.id).find(text.trim()).then((d) => setNames(d.files)) : P(project.id).search(text, regex, false).then((d) => setHits(d));
      request.catch((e: Error) => setError(e.message)).finally(() => !controller.signal.aborted && setBusy(false));
    }, 280);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [text, mode, regex, project]);

  return (
    <div className="border-b border-line px-2 pb-2">
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-ghost" />
          <input autoFocus className="input pl-6" placeholder={mode === "name" ? "Find file by name" : "Search in files"} value={text} onChange={(e) => setText(e.target.value)} aria-label="Search" />
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close search">
          <X size={13} />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-1 text-2xs">
        <button type="button" className={cx("chip", mode === "name" && "border-accent text-accent-strong")} onClick={() => setMode("name")}>File names</button>
        <button type="button" className={cx("chip", mode === "content" && "border-accent text-accent-strong")} onClick={() => setMode("content")}>Contents</button>
        {mode === "content" ? <button type="button" className={cx("chip font-mono", regex && "border-accent text-accent-strong")} onClick={() => setRegex(!regex)} title="Regular expression">.*</button> : null}
        {busy ? <Spinner /> : null}
      </div>
      {error ? <div className="mt-1 text-2xs text-bad">{error}</div> : null}
      <div className="mt-1 max-h-64 overflow-y-auto">
        {mode === "name"
          ? names.map((file) => (
              <button key={file} type="button" className="block w-full truncate rounded px-1 py-0.5 text-left text-xs text-ink-muted hover:bg-bg-hover hover:text-ink" onClick={() => void openFile(file)} title={file}>
                {file}
              </button>
            ))
          : hits?.hits.map((hit, i) => (
              <button key={`${hit.path}:${hit.line}:${i}`} type="button" className="block w-full rounded px-1 py-0.5 text-left hover:bg-bg-hover" onClick={() => void openFile(hit.path, { line: hit.line })}>
                <span className="block truncate text-2xs text-ink-faint">{hit.path}:{hit.line}</span>
                <span className="block truncate font-mono text-2xs text-ink-muted">{hit.text.trim()}</span>
              </button>
            ))}
        {mode === "content" && hits ? <div className="px-1 pt-1 text-2xs text-ink-ghost">{hits.hits.length} match{hits.hits.length === 1 ? "" : "es"} in {hits.filesScanned} files{hits.truncated ? " (stopped early)" : ""}</div> : null}
        {mode === "name" && text.trim().length >= 2 && !busy && names.length === 0 ? <div className="px-1 pt-1 text-2xs text-ink-ghost">No files match.</div> : null}
      </div>
    </div>
  );
}

export function ProjectExplorer() {
  const root = useStudio((s) => s.tree[""]);
  if (!root) return <div className="px-3 py-2"><Spinner /></div>;
  if (root.length === 0) return <Empty title="This folder is empty">Files appear here as they are created.</Empty>;
  return (
    <div>
      {root.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={0} />
      ))}
    </div>
  );
}

export function ProjectSidebar() {
  const project = useStudio((s) => s.project);
  const loadDir = useStudio((s) => s.loadDir);
  const refreshGit = useStudio((s) => s.refreshGit);
  const refreshSnapshot = useStudio((s) => s.refreshSnapshot);
  const loading = useStudio((s) => s.snapshotLoading);
  const changedCount = useStudio((s) => Object.keys(s.changes).length);
  const [searching, setSearching] = useState(false);
  return (
    <aside className="flex h-full min-w-0 flex-col bg-bg-raised" aria-label="Project and lifecycle">
      <ProjectMenu />
      {project ? (
        <>
          <Section
            title="AI-DLC Lifecycle"
            right={
              <button type="button" className="icon-btn" onClick={() => void refreshSnapshot()} title="Re-read engine state" aria-label="Refresh lifecycle">
                <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
              </button>
            }
          >
            <LifecycleNavigator />
          </Section>
          <Section
            title="Explorer"
            grow
            right={
              <span className="flex items-center gap-0.5">
                {changedCount > 0 ? <Badge tone="accent" title="Files changed since Studio opened this project">{changedCount}</Badge> : null}
                <button type="button" className="icon-btn" onClick={() => setSearching(!searching)} title="Search files" aria-label="Search files">
                  <Search size={12} />
                </button>
                <button type="button" className="icon-btn" onClick={() => (void loadDir(""), void refreshGit())} title="Refresh explorer" aria-label="Refresh explorer">
                  <RefreshCw size={12} />
                </button>
              </span>
            }
          >
            {searching ? <FileSearch onClose={() => setSearching(false)} /> : null}
            <ProjectExplorer />
          </Section>
        </>
      ) : (
        <Empty title="No project open">Use the menu above to create or open a project.</Empty>
      )}
    </aside>
  );
}
