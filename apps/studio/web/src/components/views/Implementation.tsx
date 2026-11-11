// Implementation workspace: Monaco editor with file tabs, a diff view against
// the last commit, save with unsaved-change markers, and live reload of files
// the agent changes on disk.

import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import { AlertTriangle, Code2, Columns2, Eye, FileDiff, Lock, RefreshCw, Save, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "../../monaco.ts";
import { languageFor } from "../../monaco.ts";
import { type EditorTab, useStudio } from "../../store.ts";
import { Badge, Empty, Markdown, cx, timeAgo } from "../ui.tsx";

const EDITOR_OPTIONS = {
  fontSize: 12.5,
  lineHeight: 19,
  fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
  minimap: { enabled: true, scale: 1, renderCharacters: false },
  scrollBeyondLastLine: false,
  smoothScrolling: true,
  renderWhitespace: "selection" as const,
  automaticLayout: true,
  tabSize: 2,
  padding: { top: 8 },
  bracketPairColorization: { enabled: true },
  stickyScroll: { enabled: true },
};

function TabStrip() {
  const tabs = useStudio((s) => s.tabs);
  const active = useStudio((s) => s.activeTab);
  const setActive = useStudio((s) => s.setActiveTab);
  const close = useStudio((s) => s.closeTab);
  return (
    <div className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-line bg-bg-raised" role="tablist" aria-label="Open files">
      {tabs.map((tab) => {
        const dirty = tab.content !== tab.saved;
        const name = tab.path.split("/").pop();
        return (
          <div key={tab.path} role="tab" aria-selected={active === tab.path} title={tab.path} className={cx("group flex shrink-0 items-center gap-1.5 border-r border-line pl-3 pr-1.5 text-sm", active === tab.path ? "bg-bg text-ink" : "text-ink-muted hover:bg-bg-hover")}>
            <button type="button" className="flex items-center gap-1.5 py-1" onClick={() => setActive(tab.path)}>
              {tab.mode === "diff" ? <FileDiff size={12} className="text-warn" /> : tab.sensitive ? <Lock size={12} className="text-warn" /> : null}
              <span className={cx(dirty && "italic")}>{name}</span>
            </button>
            <button type="button" className="icon-btn h-5 w-5" onClick={() => close(tab.path)} aria-label={`Close ${name}`}>
              {dirty ? <span className="h-2 w-2 rounded-full bg-accent group-hover:hidden" title="Unsaved changes" /> : null}
              <X size={12} className={dirty ? "hidden group-hover:block" : ""} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function EditorPane({ tab }: { tab: EditorTab }) {
  const editTab = useStudio((s) => s.editTab);
  const saveTab = useStudio((s) => s.saveTab);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const saveRef = useRef(saveTab);
  saveRef.current = saveTab;
  const language = languageFor(tab.path);

  const reveal = (): void => {
    if (tab.line && editorRef.current) {
      editorRef.current.revealLineInCenter(tab.line);
      editorRef.current.setPosition({ lineNumber: tab.line, column: 1 });
    }
  };
  useEffect(reveal, [tab.line, tab.path]);

  if (tab.binary) return <Empty title="Binary file">Studio does not display this file's contents.</Empty>;
  if (tab.mode === "diff") {
    return (
      <DiffEditor
        key={`diff:${tab.path}`}
        theme="studio-dark"
        language={language}
        original={tab.original ?? ""}
        modified={tab.content}
        options={{ ...EDITOR_OPTIONS, readOnly: true, renderSideBySide: true, minimap: { enabled: false } }}
      />
    );
  }
  return (
    <Editor
      key={`edit:${tab.path}`}
      theme="studio-dark"
      path={tab.path}
      language={language}
      value={tab.content}
      options={{ ...EDITOR_OPTIONS, readOnly: tab.readOnly }}
      onChange={(value) => editTab(tab.path, value ?? "")}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current(tab.path));
        reveal();
      }}
    />
  );
}

function ChangedFiles() {
  const changes = useStudio((s) => s.changes);
  const git = useStudio((s) => s.git);
  const openFile = useStudio((s) => s.openFile);
  const session = Object.values(changes).sort((a, b) => b.at - a.at).slice(0, 60);
  return (
    <div className="mx-auto grid h-full max-w-4xl grid-cols-1 gap-4 overflow-y-auto p-6 md:grid-cols-2">
      <div>
        <div className="label mb-2">Changed since Studio opened this project · {session.length}</div>
        {session.length === 0 ? <div className="text-sm text-ink-faint">Nothing yet. Files the agent creates or edits show up here as it works.</div> : null}
        {session.map((change) => (
          <button key={change.path} type="button" disabled={change.kind === "unlink"} onClick={() => void openFile(change.path)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-bg-hover disabled:opacity-50">
            <Badge tone={change.kind === "add" ? "ok" : change.kind === "unlink" ? "bad" : "warn"}>{change.kind === "add" ? "new" : change.kind === "unlink" ? "deleted" : "modified"}</Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{change.path}</span>
            <span className="text-2xs text-ink-ghost">{timeAgo(change.at)}</span>
          </button>
        ))}
      </div>
      <div>
        <div className="label mb-2">Uncommitted changes (git) · {git?.isRepo ? git.files.length : "—"}</div>
        {!git ? null : !git.isRepo ? <div className="text-sm text-ink-faint">{git.note}</div> : git.files.length === 0 ? <div className="text-sm text-ink-faint">Working tree is clean.</div> : null}
        {git?.files.slice(0, 80).map((file) => (
          <button key={file.path} type="button" disabled={file.label === "deleted"} onClick={() => void openFile(file.path, { diff: file.label === "modified" })} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-bg-hover disabled:opacity-50">
            <Badge tone={file.label === "added" || file.label === "untracked" ? "ok" : file.label === "deleted" || file.label === "conflict" ? "bad" : "warn"}>{file.label}</Badge>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ImplementationView() {
  const tabs = useStudio((s) => s.tabs);
  const activePath = useStudio((s) => s.activeTab);
  const saveTab = useStudio((s) => s.saveTab);
  const reloadTab = useStudio((s) => s.reloadTab);
  const setTabMode = useStudio((s) => s.setTabMode);
  const gitRepo = useStudio((s) => s.git?.isRepo === true);
  const tab = tabs.find((t) => t.path === activePath) ?? null;
  const dirty = tab ? tab.content !== tab.saved : false;
  const isMarkdown = tab ? /\.(md|mdx)$/i.test(tab.path) : false;
  const [previews, setPreviews] = useState<Record<string, boolean>>({});
  const preview = tab ? previews[tab.path] === true : false;

  if (tabs.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
          <Code2 size={14} className="text-ink-faint" />
          <h1 className="text-[14px] font-semibold">Implementation</h1>
          <span className="text-xs text-ink-faint">Open a file from the explorer, or pick a changed file below.</span>
        </div>
        <div className="min-h-0 flex-1"><ChangedFiles /></div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TabStrip />
      {tab ? (
        <>
          <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono text-ink-faint" title={tab.path}>{tab.path.split("/").join(" › ")}</span>
            {tab.truncated ? <Badge tone="warn">large file — first 2 MB, read-only</Badge> : null}
            {tab.readOnly && !tab.truncated && !tab.binary ? <Badge>read-only</Badge> : null}
            {tab.staleOnDisk ? (
              <button type="button" className="flex items-center gap-1 text-warn hover:underline" onClick={() => void reloadTab(tab.path)} title="Discard your edits and load the version on disk">
                <AlertTriangle size={12} /> Changed on disk — reload
              </button>
            ) : null}
            {dirty ? <Badge tone="accent">unsaved</Badge> : null}
            <button type="button" className={cx("icon-btn", tab.mode === "edit" && "text-ink")} onClick={() => void setTabMode(tab.path, "edit")} title="Edit" aria-label="Edit mode">
              <Code2 size={13} />
            </button>
            <button type="button" className={cx("icon-btn", tab.mode === "diff" && "text-ink")} disabled={!gitRepo} onClick={() => void setTabMode(tab.path, "diff")} title={gitRepo ? "Compare with the last commit" : "Diff needs a git repository in this folder"} aria-label="Diff mode">
              <Columns2 size={13} />
            </button>
            {isMarkdown ? (
              <button type="button" className={cx("icon-btn", preview && "text-ink")} onClick={() => setPreviews({ ...previews, [tab.path]: !preview })} title="Preview markdown" aria-label="Preview">
                <Eye size={13} />
              </button>
            ) : null}
            <button type="button" className="icon-btn" onClick={() => void reloadTab(tab.path)} title="Reload from disk" aria-label="Reload">
              <RefreshCw size={12} />
            </button>
            <button type="button" className="btn btn-primary h-5 px-2 py-0" disabled={!dirty || tab.readOnly} onClick={() => void saveTab(tab.path)} title="Save (Ctrl+S)">
              <Save size={11} /> Save
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {isMarkdown && preview ? <div className="h-full overflow-y-auto p-5"><Markdown text={tab.content} /></div> : <EditorPane tab={tab} />}
          </div>
        </>
      ) : (
        <Empty title="Select a tab" />
      )}
    </div>
  );
}
