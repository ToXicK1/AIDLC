// Project dialogs: folder picker (open / new), first-run setup, settings.

import { AlertTriangle, ArrowUp, CheckCircle2, Folder, HardDrive, Home, Stethoscope } from "lucide-react";
import { useEffect, useState } from "react";
import { P, Sys } from "../api.ts";
import { useStudio } from "../store.ts";
import { Badge, Modal, Spinner, cx } from "./ui.tsx";

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  dirs: Array<{ name: string; path: string }>;
}

function FolderPicker({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const browse = (path: string): void => {
    setLoading(true);
    Sys.browse(path)
      .then((data: Listing) => {
        setListing(data);
        setError(null);
        onChange(data.path);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    Sys.browse("")
      .then((root: Listing) => browse(root.home))
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div>
      <div className="flex items-center gap-1">
        <input
          className="input font-mono text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && browse(value)}
          placeholder="C:\path\to\project"
          aria-label="Folder path"
          spellCheck={false}
        />
        <button type="button" className="btn" onClick={() => browse(value)}>Go</button>
      </div>
      <div className="mt-2 flex items-center gap-1">
        <button type="button" className="btn btn-ghost" disabled={!listing || listing.parent === null} onClick={() => listing && browse(listing.parent ?? "")} title="Up one folder">
          <ArrowUp size={12} /> Up
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => listing && browse(listing.home)} title="Home folder">
          <Home size={12} /> Home
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => browse("")} title="Drives">
          <HardDrive size={12} /> Drives
        </button>
        {loading ? <Spinner /> : null}
      </div>
      {error ? <div className="mt-1 text-xs text-bad">{error}</div> : null}
      <div className="mt-1 h-56 overflow-y-auto rounded-md border border-line bg-bg">
        {listing?.dirs.length === 0 ? <div className="px-3 py-2 text-xs text-ink-faint">No sub-folders here.</div> : null}
        {listing?.dirs.map((dir) => (
          <button key={dir.path} type="button" className="flex w-full items-center gap-2 px-3 py-1 text-left text-sm text-ink-muted hover:bg-bg-hover hover:text-ink" onDoubleClick={() => browse(dir.path)} onClick={() => onChange(dir.path)}>
            <Folder size={13} className="shrink-0 text-ink-faint" />
            <span className={cx("truncate", value === dir.path && "text-accent-strong")}>{dir.name}</span>
          </button>
        ))}
      </div>
      <div className="mt-1 text-2xs text-ink-ghost">Click to select, double-click to open a folder. Studio only reads and writes inside the folder you choose.</div>
    </div>
  );
}

export function OpenProjectDialog({ mode }: { mode: "open" | "new" }) {
  const setDialog = useStudio((s) => s.setDialog);
  const openProject = useStudio((s) => s.openProject);
  const hasProject = useStudio((s) => s.project !== null);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sep = path.includes("\\") || /^[A-Za-z]:/.test(path) ? "\\" : "/";
  const target = mode === "new" && name.trim() ? `${path.replace(/[\\/]+$/, "")}${sep}${name.trim()}` : path;
  const validName = mode === "open" || /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}$/.test(name.trim());
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await openProject(target, mode === "new", mode === "new" ? name.trim() : undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={mode === "new" ? "New Project" : "Open Existing Project"}
      onClose={hasProject ? () => setDialog(null) : () => setDialog(null)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => setDialog(null)}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || !path || !validName} onClick={() => void submit()}>
            {busy ? <Spinner /> : null} {mode === "new" ? "Create project" : "Open project"}
          </button>
        </>
      }
    >
      {mode === "new" ? (
        <div className="mb-3">
          <label className="label mb-1 block" htmlFor="new-project-name">Project name (new folder)</label>
          <input id="new-project-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="inventory-api" autoFocus />
          {name && !validName ? <div className="mt-1 text-xs text-bad">Use letters, digits, spaces, dots, dashes or underscores.</div> : null}
        </div>
      ) : null}
      <div className="label mb-1">{mode === "new" ? "Create it inside" : "Project folder"}</div>
      <FolderPicker value={path} onChange={setPath} />
      {mode === "new" && path && name.trim() ? <div className="mt-2 break-all font-mono text-xs text-ink-muted">Will create: {target}</div> : null}
      {error ? <div className="mt-2 rounded border border-bad/40 bg-bad/5 px-2 py-1 text-sm text-bad">{error}</div> : null}
    </Modal>
  );
}

function HarnessChoice({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const harnesses = useStudio((s) => s.system?.harnesses) ?? [];
  return (
    <div className="grid grid-cols-1 gap-1.5" role="radiogroup" aria-label="Harness">
      {harnesses.map((h) => (
        <button key={h.id} type="button" role="radio" aria-checked={value === h.id} onClick={() => onChange(h.id)} className={cx("flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left", value === h.id ? "border-accent bg-accent/10" : "border-line hover:bg-bg-hover")}>
          <span className={cx("mt-1 h-3 w-3 shrink-0 rounded-full border", value === h.id ? "border-accent bg-accent" : "border-ink-ghost")} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-sm font-medium">
              {h.name}
              {h.capabilities.chat ? <Badge tone="ok">in-app chat</Badge> : <Badge>setup + live monitoring</Badge>}
            </span>
            {h.note ? <span className="block text-xs text-ink-faint">{h.note}</span> : <span className="block text-xs text-ink-faint">Chat, streaming, questions and approval gates run inside Studio. Invoke with {h.invoke}.</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

export function SetupDialog() {
  const project = useStudio((s) => s.project);
  const system = useStudio((s) => s.system);
  const snapshot = useStudio((s) => s.snapshot);
  const setDialog = useStudio((s) => s.setDialog);
  const setupProject = useStudio((s) => s.setupProject);
  const [harness, setHarness] = useState(project?.harness ?? "claude");
  const [busy, setBusy] = useState(false);
  const [runtime, setRuntime] = useState("auto");
  const installed = snapshot?.install.installed === true;
  const tools = system?.tools ?? {};
  const run = async (): Promise<void> => {
    setBusy(true);
    const ok = await setupProject(harness, runtime);
    setBusy(false);
    if (ok) setDialog(null);
  };
  return (
    <Modal
      title={installed ? "Set up AI-DLC again" : "Set up AI-DLC in this project"}
      onClose={() => setDialog(null)}
      width="max-w-2xl"
      footer={
        <>
          <button type="button" className="btn" onClick={() => setDialog(null)}>{installed ? "Close" : "Not now"}</button>
          <button type="button" className="btn btn-primary" disabled={busy || (!tools.bun?.ok && !tools.aidlc?.ok)} onClick={() => void run()}>
            {busy ? <Spinner /> : null} {installed ? "Add or refresh missing files" : "Initialize AI-DLC"}
          </button>
        </>
      }
    >
      <p className="text-sm text-ink-muted">
        This adds the AI-DLC engine, stages, agents, hooks and the <span className="font-mono text-xs">aidlc/</span> workspace to
        <span className="break-all font-mono text-xs"> {project?.path}</span>. Files you already have are never overwritten.
      </p>
      <div className="label mb-1 mt-3">This machine</div>
      <div className="space-y-1 rounded-md border border-line p-2 text-sm">
        {(["bun", "claude", "git", "aidlc"] as const).map((name) => {
          const tool = tools[name];
          const optional = name === "aidlc";
          return (
            <div key={name} className="flex items-start gap-2">
              {tool?.ok ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-ok" /> : <AlertTriangle size={13} className={cx("mt-0.5 shrink-0", optional ? "text-ink-faint" : "text-warn")} />}
              <span className="w-16 shrink-0 font-mono text-xs">{name}</span>
              <span className="min-w-0 flex-1 break-words text-xs text-ink-faint">
                {!tool ? "checking…" : tool.ok ? tool.version : name === "aidlc" ? `native command not usable (${tool.error}). Studio falls back to the Bun runtime from this repository.` : name === "bun" ? `${tool.error}. Needed only for the Bun runtime — https://bun.sh` : name === "claude" ? `${tool.error}. Needed for in-app chat with Claude Code.` : tool.error}
              </span>
            </div>
          );
        })}
      </div>
      <div className="label mb-1 mt-3">Harness</div>
      <HarnessChoice value={harness} onChange={setHarness} />
      <label className="label mb-1 mt-3 block" htmlFor="setup-runtime">Engine runtime</label>
      <select id="setup-runtime" className="input" value={runtime} onChange={(e) => setRuntime(e.target.value)}>
        <option value="auto">Automatic — native aidlc when it runs, otherwise the Bun runtime</option>
        <option value="native" disabled={!tools.aidlc?.ok}>Native: aidlc config --harness {harness}</option>
        <option value="bun" disabled={!tools.bun?.ok}>Bun runtime copied from this repository (hooks run through bun)</option>
      </select>
      {!system?.engineRepo ? <div className="mt-2 text-xs text-warn">No AI-DLC repository checkout was found to copy the runtime from. Set AIDLC_STUDIO_ENGINE_REPO and restart Studio.</div> : null}
    </Modal>
  );
}

export function SettingsDialog() {
  const project = useStudio((s) => s.project);
  const snapshot = useStudio((s) => s.snapshot);
  const system = useStudio((s) => s.system);
  const setDialog = useStudio((s) => s.setDialog);
  const updateProject = useStudio((s) => s.updateProject);
  const closeProject = useStudio((s) => s.closeProject);
  const loadProjects = useStudio((s) => s.loadProjects);
  const toast = useStudio((s) => s.toast);
  const [name, setName] = useState(project?.name ?? "");
  const [harness, setHarness] = useState(project?.harness ?? "claude");
  const [mode, setMode] = useState(project?.settings.permissionMode ?? "default");
  const [model, setModel] = useState(project?.settings.model ?? "");
  const [doctor, setDoctor] = useState<{ loading: boolean; text: string | null }>({ loading: false, text: null });
  if (!project) return null;
  const save = async (): Promise<void> => {
    await updateProject({ name, harness, settings: { permissionMode: mode, model } });
    toast("ok", "Project settings saved. They apply from the next chat message.");
    setDialog(null);
  };
  const runDoctor = async (): Promise<void> => {
    setDoctor({ loading: true, text: null });
    try {
      const data = await P(project.id).doctor();
      setDoctor({ loading: false, text: data.report ? `${data.report.status}: ${data.report.message}` : (data.raw ?? "No result") });
    } catch (e) {
      setDoctor({ loading: false, text: (e as Error).message });
    }
  };
  const forget = async (): Promise<void> => {
    if (!window.confirm(`Remove "${project.name}" from Studio's project list?\n\nThe project folder and its files are not touched. Studio's saved conversations for it stay on disk.`)) return;
    await P(project.id).forget().catch(() => undefined);
    closeProject();
    await loadProjects();
    setDialog(null);
  };
  return (
    <Modal
      title="Project Settings"
      onClose={() => setDialog(null)}
      width="max-w-2xl"
      footer={
        <>
          <button type="button" className="btn btn-danger mr-auto" onClick={() => void forget()}>Remove from Studio</button>
          <button type="button" className="btn" onClick={() => setDialog(null)}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()}>Save</button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="label mb-1 block" htmlFor="settings-name">Display name</label>
          <input id="settings-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="mt-1 break-all font-mono text-2xs text-ink-faint">{project.path}</div>
        </div>
        <div>
          <div className="label mb-1">Harness</div>
          <HarnessChoice value={harness} onChange={setHarness} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label mb-1 block" htmlFor="settings-mode">Tool permissions (Claude Code)</label>
            <select id="settings-mode" className="input" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="default">Ask me before anything not pre-approved</option>
              <option value="acceptEdits">Allow file edits, ask for the rest</option>
              <option value="plan">Plan only — make no changes</option>
            </select>
            <div className="mt-1 text-2xs text-ink-faint">Studio never offers a mode that skips permission checks.</div>
          </div>
          <div>
            <label className="label mb-1 block" htmlFor="settings-model">Model (optional)</label>
            <input id="settings-model" className="input font-mono text-xs" value={model} onChange={(e) => setModel(e.target.value)} placeholder="harness default" />
            <div className="mt-1 text-2xs text-ink-faint">Leave empty to use the model your harness is configured with.</div>
          </div>
        </div>
        <div className="rounded-md border border-line p-2">
          <div className="flex items-center gap-2">
            <span className="label flex-1">AI-DLC in this project</span>
            <button type="button" className="btn" onClick={() => void runDoctor()} disabled={doctor.loading || !snapshot?.install.engine}>
              {doctor.loading ? <Spinner /> : <Stethoscope size={12} />} Run diagnostics
            </button>
            <button type="button" className="btn" onClick={() => setDialog("setup")}>Set up / refresh…</button>
          </div>
          <div className="mt-1 text-xs text-ink-muted">
            {snapshot?.install.installed ? `Installed for: ${snapshot.install.harnesses.map((h) => `${h.id} (${h.shape} runtime)`).join(", ")}. Engine command: ${snapshot.install.engine?.display ?? "not runnable"}.` : "Not set up yet."}
          </div>
          {doctor.text ? <div className="mt-1 break-words text-xs text-ink-faint">{doctor.text}</div> : null}
        </div>
        <div className="text-2xs text-ink-ghost">Studio data (conversations, audit of actions, recent projects): {system?.dataDir}</div>
      </div>
    </Modal>
  );
}
