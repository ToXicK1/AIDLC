// Small shared UI pieces: status marks, markdown, diagrams, dialogs.

import { Check, Copy, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StageState } from "../../../shared/types.ts";
import { useStudio } from "../store.ts";

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(" ");

export const STAGE_STATE: Record<StageState, { label: string; color: string; dot: string }> = {
  pending: { label: "Pending", color: "text-ink-faint", dot: "bg-ink-ghost" },
  in_progress: { label: "In progress", color: "text-info", dot: "bg-info" },
  awaiting_approval: { label: "Awaiting approval", color: "text-wait", dot: "bg-wait" },
  revising: { label: "Revising", color: "text-warn", dot: "bg-warn" },
  completed: { label: "Completed", color: "text-ok", dot: "bg-ok" },
  skipped: { label: "Skipped", color: "text-ink-faint", dot: "bg-ink-ghost" },
  not_in_plan: { label: "Not in plan", color: "text-ink-ghost", dot: "bg-transparent border border-ink-ghost" },
};

export function StateDot({ state, className }: { state: StageState; className?: string }) {
  const meta = STAGE_STATE[state];
  const live = state === "in_progress" || state === "awaiting_approval" || state === "revising";
  return <span title={meta.label} className={cx("inline-block h-2 w-2 shrink-0 rounded-full", meta.dot, live && "pulse", className)} />;
}

export function Badge({ tone = "muted", children, title }: { tone?: "muted" | "ok" | "warn" | "bad" | "info" | "wait" | "accent"; children: ReactNode; title?: string }) {
  const tones = {
    muted: "border-line text-ink-muted",
    ok: "border-ok/30 text-ok bg-ok/5",
    warn: "border-warn/30 text-warn bg-warn/5",
    bad: "border-bad/30 text-bad bg-bad/5",
    info: "border-info/30 text-info bg-info/5",
    wait: "border-wait/30 text-wait bg-wait/5",
    accent: "border-accent/30 text-accent-strong bg-accent/5",
  } as const;
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-px text-2xs font-medium", tones[tone])}>
      {children}
    </span>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[140px] flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      {icon ? <div className="text-ink-ghost">{icon}</div> : null}
      <div className="text-sm font-medium text-ink-muted">{title}</div>
      {children ? <div className="max-w-md text-sm text-ink-faint">{children}</div> : null}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx("inline-block h-3 w-3 animate-spin rounded-full border-2 border-ink-ghost border-t-accent", className)} />;
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cx("icon-btn", className)}
      title="Copy"
      aria-label="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
    </button>
  );
}

export function timeAgo(iso: string | number | undefined): string {
  if (!iso) return "";
  const then = typeof iso === "number" ? iso : Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour12: false });
}

export function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

let mermaidLoad: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  mermaidLoad ??= import("mermaid").then((m) => {
    m.default.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "strict",
      fontFamily: "Inter, Segoe UI, sans-serif",
      themeVariables: { background: "#0d0e11", primaryColor: "#1c1f26", primaryBorderColor: "#3a3f4c", primaryTextColor: "#e6e8ec", lineColor: "#6b7280", secondaryColor: "#16181d", tertiaryColor: "#131519" },
    });
    return m.default;
  });
  return mermaidLoad;
}

export function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSvg(null);
    setError(null);
    loadMermaid()
      .then((mermaid) => mermaid.render(`m${id}`, code))
      .then((result) => {
        if (live) setSvg(result.svg);
      })
      .catch((e: Error) => {
        if (live) setError(e.message?.split("\n")[0] ?? "could not render");
        document.getElementById(`dm${id}`)?.remove();
      });
    return () => {
      live = false;
    };
  }, [code, id]);
  if (error) {
    return (
      <div className="my-2 rounded-md border border-line">
        <div className="border-b border-line px-2 py-1 text-2xs text-warn">Diagram could not be rendered ({error}); showing its source.</div>
        <pre className="overflow-x-auto p-2 font-mono text-xs text-ink-muted">{code}</pre>
      </div>
    );
  }
  if (!svg) return <div className="my-2 flex items-center gap-2 text-xs text-ink-faint"><Spinner /> Rendering diagram…</div>;
  // Mermaid sanitises its output under securityLevel "strict".
  return <div className="mermaid-host my-3 overflow-x-auto rounded-md border border-line bg-bg p-3" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const FILE_REF = /^(?:\.{0,2}\/)?(?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]{1,8}(?::\d+)?$/;

export function Markdown({ text, compact }: { text: string; compact?: boolean }) {
  const openFile = useStudio((s) => s.openFile);
  return (
    <div className={cx("md", compact && "md-compact")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const target = href ?? "";
            if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#")) {
              const [file, line] = target.split(/[:#]L?/);
              return (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void openFile(file.replace(/^\.\//, ""), { line: line ? Number(line) : undefined });
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={target} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          pre({ children }) {
            return <>{children}</>;
          },
          code({ className, children }) {
            const raw = String(children ?? "");
            const language = /language-([\w-]+)/.exec(className ?? "")?.[1];
            const block = language !== undefined || raw.includes("\n");
            if (!block) {
              if (FILE_REF.test(raw) && raw.includes("/")) {
                const [file, line] = raw.split(":");
                return (
                  <code className="cursor-pointer hover:underline" title="Open file" onClick={() => void openFile(file.replace(/^\.\//, ""), { line: line ? Number(line) : undefined })}>
                    {raw}
                  </code>
                );
              }
              return <code>{children}</code>;
            }
            const body = raw.replace(/\n$/, "");
            if (language === "mermaid") return <Mermaid code={body} />;
            return (
              <div className="group my-2 overflow-hidden rounded-md border border-line bg-bg">
                <div className="flex items-center justify-between border-b border-line bg-bg-raised px-2 py-0.5">
                  <span className="font-mono text-2xs text-ink-faint">{language ?? "text"}</span>
                  <CopyButton text={body} />
                </div>
                <pre className="overflow-x-auto p-2.5 font-mono text-[12px] leading-[18px] text-ink">
                  <code>{body}</code>
                </pre>
              </div>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function Modal({ title, onClose, children, width = "max-w-xl", footer }: { title: string; onClose?: () => void; children: ReactNode; width?: string; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-6 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className={cx("flex max-h-[78vh] w-full flex-col rounded-lg border border-line-strong bg-bg-raised shadow-2xl outline-none", width)}>
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          {onClose ? (
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={14} />
            </button>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2.5">{footer}</div> : null}
      </div>
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="label">{children}</h3>
      {right}
    </div>
  );
}

export function Toasts() {
  const toasts = useStudio((s) => s.toasts);
  const dismiss = useStudio((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-9 right-4 z-[60] flex w-[360px] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cx(
            "pointer-events-auto flex items-start gap-2 rounded-md border bg-bg-panel px-3 py-2 text-sm shadow-xl",
            t.kind === "error" ? "border-bad/40 text-bad" : t.kind === "ok" ? "border-ok/30 text-ink" : "border-line text-ink",
          )}
        >
          <span className="min-w-0 flex-1 break-words">{t.text}</span>
          <button type="button" className="icon-btn shrink-0" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
