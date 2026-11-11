// Shared pieces for the document workspaces (requirements, architecture,
// artifacts): live file loading, the document viewer/editor, artifact lists.

import { ExternalLink, FileText, Pencil, Save, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ArtifactFile } from "../../../../shared/types.ts";
import { ApiError, P } from "../../api.ts";
import { useStudio } from "../../store.ts";
import { Badge, Empty, Markdown, Spinner, cx, timeAgo, titleCase } from "../ui.tsx";

export interface LoadedFile {
  path: string;
  content: string;
  mtime: number;
  binary: boolean;
  truncated: boolean;
}

/** Load a project file and reload it whenever it changes on disk. */
export function useFile(path: string | null): { file: LoadedFile | null; error: string | null; loading: boolean; reload(): void } {
  const projectId = useStudio((s) => s.project?.id);
  const changedAt = useStudio((s) => (path ? s.changes[path]?.at : undefined));
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path || !projectId) {
      setFile(null);
      setError(null);
      return;
    }
    let live = true;
    setLoading(true);
    P(projectId)
      .file(path)
      .then((data) => {
        if (!live) return;
        setFile(data);
        setError(null);
      })
      .catch((e: Error) => {
        if (!live) return;
        setError(e instanceof ApiError && e.status === 404 ? "This file no longer exists." : e.message);
        setFile(null);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, projectId, changedAt, tick]);
  return { file, error, loading, reload: () => setTick((t) => t + 1) };
}

export interface DocSection {
  heading: string;
  level: number;
  body: string;
}

/** Split a markdown document at its top two heading levels. */
export function splitSections(markdown: string): { intro: string; sections: DocSection[] } {
  const lines = markdown.split(/\r?\n/);
  const sections: DocSection[] = [];
  const intro: string[] = [];
  let current: DocSection | null = null;
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence ? /^(#{1,2})\s+(.+?)\s*#*$/.exec(line) : null;
    if (heading) {
      current = { heading: heading[2], level: heading[1].length, body: "" };
      sections.push(current);
    } else if (current) {
      current.body += `${line}\n`;
    } else {
      intro.push(line);
    }
  }
  return { intro: intro.join("\n").trim(), sections };
}

export function extractMermaid(markdown: string): string[] {
  return [...markdown.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)].map((m) => m[1].trim());
}

export function DocViewer({ path, classify, header }: { path: string; classify?: (heading: string) => string | null; header?: React.ReactNode }) {
  const { file, error, loading } = useFile(path);
  const projectId = useStudio((s) => s.project?.id);
  const openFile = useStudio((s) => s.openFile);
  const toast = useStudio((s) => s.toast);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setEditing(false), [path]);

  const isMarkdown = /\.(md|mdx|markdown)$/i.test(path);
  const parsed = useMemo(() => (file && isMarkdown ? splitSections(file.content) : null), [file, isMarkdown]);

  const save = async (): Promise<void> => {
    if (!projectId || !file) return;
    setSaving(true);
    try {
      await P(projectId).save({ path, content: draft, expectedMtime: file.mtime });
      setEditing(false);
      toast("ok", `Saved ${path}`);
    } catch (e) {
      toast("error", e instanceof ApiError && e.code === "conflict" ? "The document changed on disk while you were editing. Copy your text, cancel, and edit the new version." : (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-1.5">
        <FileText size={13} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-muted" title={path}>{path}</span>
        {loading ? <Spinner /> : null}
        {file ? <span className="text-2xs text-ink-ghost">updated {timeAgo(file.mtime)}</span> : null}
        {editing ? (
          <>
            <button type="button" className="btn btn-primary" disabled={saving || draft === file?.content} onClick={() => void save()}>
              <Save size={12} /> Save
            </button>
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              <X size={12} /> Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" disabled={!file || file.binary || file.truncated} onClick={() => (setDraft(file?.content ?? ""), setEditing(true))}>
              <Pencil size={12} /> Edit
            </button>
            <button type="button" className="btn" onClick={() => void openFile(path)} title="Open in the code editor">
              <ExternalLink size={12} /> Editor
            </button>
          </>
        )}
      </div>
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <Empty title="Could not open this document">{error}</Empty>
        ) : !file ? (
          <div className="p-4"><Spinner /></div>
        ) : editing ? (
          <textarea className="h-full w-full resize-none bg-bg p-4 font-mono text-[12.5px] leading-5 text-ink outline-none" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} aria-label="Document source" />
        ) : file.binary ? (
          <Empty title="Binary file">Studio does not preview this file type.</Empty>
        ) : parsed && classify ? (
          <div className="space-y-3 p-4">
            {parsed.intro ? <Markdown text={parsed.intro} /> : null}
            {parsed.sections.map((section, i) => {
              const kind = classify(section.heading);
              return (
                <section key={`${section.heading}-${i}`} className={cx("card", section.level === 1 && "border-transparent bg-transparent")}>
                  <div className={cx("flex items-center gap-2", section.level === 1 ? "pb-1" : "border-b border-line px-3 py-2")}>
                    <h2 className={cx("min-w-0 flex-1 font-semibold", section.level === 1 ? "text-[17px]" : "text-[13.5px]")}>{section.heading}</h2>
                    {kind ? <Badge tone="accent">{kind}</Badge> : null}
                  </div>
                  {section.body.trim() ? <div className={section.level === 1 ? "" : "px-3 py-2"}><Markdown text={section.body} /></div> : null}
                </section>
              );
            })}
          </div>
        ) : isMarkdown ? (
          <div className="p-4"><Markdown text={file.content} /></div>
        ) : (
          <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-5 text-ink">{file.content}</pre>
        )}
      </div>
    </div>
  );
}

export function ArtifactList({ artifacts, selected, onSelect, groupBy }: { artifacts: ArtifactFile[]; selected: string | null; onSelect: (path: string) => void; groupBy: (a: ArtifactFile) => string }) {
  const groups = useMemo(() => {
    const map = new Map<string, ArtifactFile[]>();
    for (const artifact of artifacts) {
      const key = groupBy(artifact);
      map.set(key, [...(map.get(key) ?? []), artifact]);
    }
    return [...map.entries()];
  }, [artifacts, groupBy]);
  return (
    <div className="h-full overflow-y-auto py-1">
      {groups.map(([group, items]) => (
        <div key={group} className="mb-1">
          <div className="label px-3 py-1">{group} <span className="text-ink-ghost">· {items.length}</span></div>
          {items.map((artifact) => (
            <button
              key={artifact.path}
              type="button"
              onClick={() => onSelect(artifact.path)}
              title={artifact.path}
              className={cx("flex w-full items-center gap-2 px-3 py-1 text-left text-sm hover:bg-bg-hover", selected === artifact.path ? "bg-bg-active text-ink" : "text-ink-muted")}
            >
              <FileText size={12} className="shrink-0 text-ink-ghost" />
              <span className="min-w-0 flex-1 truncate">{artifact.name}</span>
              <span className="shrink-0 text-2xs text-ink-ghost">{timeAgo(artifact.mtime)}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** List on the left, document on the right. */
export function DocWorkspace({
  artifacts,
  groupBy,
  empty,
  classify,
  header,
  preferred,
}: {
  artifacts: ArtifactFile[];
  groupBy: (a: ArtifactFile) => string;
  empty: React.ReactNode;
  classify?: (heading: string) => string | null;
  header?: (path: string) => React.ReactNode;
  preferred?: RegExp;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (selected && artifacts.some((a) => a.path === selected)) return;
    const first = (preferred ? artifacts.find((a) => preferred.test(a.name)) : undefined) ?? artifacts[0];
    setSelected(first?.path ?? null);
  }, [artifacts, selected, preferred]);
  if (artifacts.length === 0) return <>{empty}</>;
  return (
    <div className="flex h-full min-h-0">
      <div className="w-64 shrink-0 border-r border-line bg-bg-raised">
        <ArtifactList artifacts={artifacts} selected={selected} onSelect={setSelected} groupBy={groupBy} />
      </div>
      <div className="min-w-0 flex-1">{selected ? <DocViewer path={selected} classify={classify} header={header?.(selected)} /> : null}</div>
    </div>
  );
}

export const stageGroup = (a: ArtifactFile): string => (a.stage ? titleCase(a.stage) : titleCase(a.phase));

export function ViewHeader({ title, subtitle, right }: { title: string; subtitle?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[14px] font-semibold">{title}</h1>
        {subtitle ? <div className="truncate text-xs text-ink-faint">{subtitle}</div> : null}
      </div>
      {right}
    </div>
  );
}
