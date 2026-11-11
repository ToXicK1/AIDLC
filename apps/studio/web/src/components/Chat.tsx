// Persistent AI chat. It is the selected project's real harness session:
// messages go to the harness, and everything shown comes back from its stream.

import { AlertTriangle, ArrowUp, Bot, Check, ChevronDown, ChevronRight, FileText, History, Loader2, MessageSquarePlus, Square, Terminal, User, Wrench, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatEvent } from "../../../shared/types.ts";
import { pendingRequests, useStudio } from "../store.ts";
import { PermissionCard, QuestionCard } from "./Requests.tsx";
import { Badge, Markdown, Spinner, clock, cx, timeAgo } from "./ui.tsx";

type ToolUse = Extract<ChatEvent, { type: "tool_use" }>;
type ToolResult = Extract<ChatEvent, { type: "tool_result" }>;

function relPath(file: string, root: string | undefined): string | null {
  const norm = file.replace(/\\/g, "/");
  const base = (root ?? "").replace(/\\/g, "/");
  if (base && norm.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return norm.slice(base.length + 1);
  if (!/^([a-zA-Z]:)?\//.test(norm)) return norm.replace(/^\.\//, "");
  return null;
}

function toolSummary(use: ToolUse): { text: string; file?: string } {
  const input = (use.input ?? {}) as Record<string, unknown>;
  if (typeof input.command === "string") return { text: input.command };
  if (typeof input.file_path === "string") return { text: input.file_path, file: input.file_path };
  if (typeof input.path === "string") return { text: [input.pattern, input.path].filter(Boolean).join(" in ") };
  if (typeof input.pattern === "string") return { text: input.pattern };
  if (typeof input.skill === "string") return { text: `${input.skill}${input.args ? ` ${String(input.args)}` : ""}` };
  if (typeof input.description === "string") return { text: `${input.subagent_type ? `${String(input.subagent_type)}: ` : ""}${input.description}` };
  if (typeof input.query === "string") return { text: input.query };
  if (typeof input.url === "string") return { text: input.url };
  return { text: "" };
}

function ToolRow({ use, result }: { use: ToolUse; result?: ToolResult }) {
  const [open, setOpen] = useState(false);
  const root = useStudio((s) => s.project?.path);
  const openFile = useStudio((s) => s.openFile);
  const summary = toolSummary(use);
  const file = summary.file ? relPath(summary.file, root) : null;
  const Icon = use.name === "Bash" || use.name === "PowerShell" ? Terminal : /Read|Write|Edit|Glob|Grep/.test(use.name) ? FileText : use.name === "Agent" || use.name === "Task" ? Bot : Wrench;
  return (
    <div className={cx("rounded-md border text-xs", result?.isError ? "border-bad/30" : "border-line", use.parent && "ml-4")}>
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={11} className="shrink-0 text-ink-ghost" /> : <ChevronRight size={11} className="shrink-0 text-ink-ghost" />}
          <Icon size={12} className="shrink-0 text-ink-faint" />
          <span className="shrink-0 font-medium text-ink-muted">{use.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">{file ?? summary.text}</span>
        </button>
        {file && /Read|Write|Edit/.test(use.name) ? (
          <button type="button" className="shrink-0 text-2xs text-accent-strong hover:underline" onClick={() => void openFile(file, { diff: use.name !== "Read" })}>
            open
          </button>
        ) : null}
        {!result ? <Loader2 size={11} className="shrink-0 animate-spin text-info" /> : result.isError ? <X size={11} className="shrink-0 text-bad" /> : <Check size={11} className="shrink-0 text-ok" />}
      </div>
      {open ? (
        <div className="space-y-1 border-t border-line p-2">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-ink-muted">{JSON.stringify(use.input, null, 2)}</pre>
          {result ? <pre className={cx("max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-line pt-1 font-mono text-[11px] leading-4", result.isError ? "text-bad" : "text-ink-faint")}>{result.text || "(no output)"}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function Message({ event, results, open }: { event: ChatEvent; results: Map<string, ToolResult>; open: { questions: Set<string>; permissions: Set<string> } }) {
  switch (event.type) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[88%] rounded-lg border border-line bg-bg-active px-3 py-1.5">
            <div className="mb-0.5 flex items-center gap-1 text-2xs text-ink-faint">
              <User size={10} /> You{event.origin === "approval" ? " · approval decision" : ""} · {clock(event.ts)}
            </div>
            <div className="whitespace-pre-wrap break-words text-base">{event.text}</div>
          </div>
        </div>
      );
    case "assistant":
      return (
        <div className={cx(event.parent && "ml-4 border-l border-line pl-2 opacity-80")}>
          {event.parent ? <div className="mb-0.5 text-2xs text-ink-faint">subagent</div> : null}
          <Markdown text={event.text} compact={Boolean(event.parent)} />
        </div>
      );
    case "tool_use":
      if (event.name === "AskUserQuestion") return null;
      return <ToolRow use={event} result={results.get(event.id)} />;
    case "question":
      if (open.questions.has(event.id)) return <QuestionCard event={event} compact />;
      return null;
    case "question_answered":
      return (
        <div className="rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-muted">
          <span className="text-ink-faint">Your answer · {clock(event.ts)}: </span>
          {event.answers === null ? "left unanswered (replied in chat, or the session ended)" : Object.values(event.answers).map((v) => (Array.isArray(v) ? v.join(", ") : v)).join(" · ")}
        </div>
      );
    case "permission":
      if (open.permissions.has(event.id)) return <PermissionCard event={event} />;
      return null;
    case "permission_decided":
      return (
        <div className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-muted">
          Permission <span className={event.decision === "allow" ? "text-ok" : "text-bad"}>{event.decision === "allow" ? "allowed" : "denied"}</span>
          {event.message ? <span className="text-ink-faint"> — {event.message}</span> : null}
        </div>
      );
    case "task":
      if (event.phase === "updated") return null;
      return (
        <div className="flex items-center gap-1.5 text-xs text-ink-faint">
          <Bot size={12} className={event.phase === "started" ? "text-info" : event.status === "completed" ? "text-ok" : "text-warn"} />
          {event.phase === "started" ? `Agent started${event.subagentType ? ` (${event.subagentType})` : ""}: ${event.description ?? ""}` : `Agent ${event.status ?? "finished"}${event.summary ? `: ${event.summary.slice(0, 200)}` : ""}`}
        </div>
      );
    case "result":
      return (
        <div className={cx("flex items-center gap-2 py-0.5 text-2xs", event.isError ? "text-bad" : "text-ink-ghost")}>
          <span className="h-px flex-1 bg-line" />
          {event.isError ? `Turn failed${event.text ? `: ${event.text}` : ` (${event.subtype})`}` : `Turn complete${event.turns ? ` · ${event.turns} steps` : ""}${event.durationMs ? ` · ${Math.round(event.durationMs / 1000)}s` : ""}`}
          <span className="h-px flex-1 bg-line" />
        </div>
      );
    case "error":
      return (
        <div className="flex items-start gap-2 rounded-md border border-bad/40 bg-bad/5 px-2.5 py-1.5 text-sm text-bad">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="break-words">{event.message}</span>
        </div>
      );
    default:
      return null;
  }
}

function ConversationMenu() {
  const conversations = useStudio((s) => s.conversations);
  const current = useStudio((s) => s.conversationId);
  const select = useStudio((s) => s.selectConversation);
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
  const title = conversations.find((c) => c.id === current)?.title ?? "New conversation";
  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <button type="button" className="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-bg-hover" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <History size={13} className="shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        <ChevronDown size={12} className="shrink-0 text-ink-faint" />
      </button>
      {open ? (
        <div role="menu" className="absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-md border border-line-strong bg-bg-panel py-1 shadow-2xl">
          {conversations.length === 0 ? <div className="px-3 py-1.5 text-xs text-ink-faint">No earlier conversations.</div> : null}
          {conversations.map((c) => (
            <button key={c.id} type="button" role="menuitem" className={cx("flex w-full flex-col px-3 py-1 text-left hover:bg-bg-hover", c.id === current && "bg-bg-active")} onClick={() => (setOpen(false), void select(c.id))}>
              <span className="truncate text-sm">{c.title}</span>
              <span className="text-2xs text-ink-faint">{timeAgo(c.updatedAt)}{c.harnessSessionId ? " · resumable" : ""}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const STATUS_LABEL: Record<string, { text: string; tone: "muted" | "info" | "wait" | "bad" }> = {
  idle: { text: "Ready", tone: "muted" },
  starting: { text: "Connecting", tone: "info" },
  running: { text: "Running", tone: "info" },
  waiting_input: { text: "Waiting for you", tone: "wait" },
  stopped: { text: "Session ended", tone: "muted" },
  failed: { text: "Failed", tone: "bad" },
};

export function AIChatPanel() {
  const project = useStudio((s) => s.project);
  const system = useStudio((s) => s.system);
  const snapshot = useStudio((s) => s.snapshot);
  const events = useStudio((s) => s.chatEvents);
  const streamText = useStudio((s) => s.streamText);
  const status = useStudio((s) => s.chatStatus);
  const chatError = useStudio((s) => s.chatError);
  const aidlcMode = useStudio((s) => s.aidlcMode);
  const setAidlcMode = useStudio((s) => s.setAidlcMode);
  const sendChat = useStudio((s) => s.sendChat);
  const stopChat = useStudio((s) => s.stopChat);
  const newConversation = useStudio((s) => s.newConversation);
  const setView = useStudio((s) => s.setView);
  const setDialog = useStudio((s) => s.setDialog);
  const connection = useStudio((s) => s.connection);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const results = useMemo(() => new Map(events.filter((e): e is ToolResult => e.type === "tool_result").map((e) => [e.id, e])), [events]);
  const pending = useMemo(() => pendingRequests(events), [events]);
  const open = useMemo(() => ({ questions: new Set(pending.questions.map((q) => q.id)), permissions: new Set(pending.permissions.map((p) => p.id)) }), [pending]);
  const visible = useMemo(() => events.filter((e) => e.type !== "tool_result" && e.type !== "session" && e.type !== "status"), [events]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, streamText, pending.questions.length, pending.permissions.length]);

  const harness = system?.harnesses.find((h) => h.id === project?.harness);
  const chatSupported = harness ? harness.capabilities.chat : true;
  const installed = snapshot?.install.installed === true;
  const busy = status === "running" || status === "starting";
  const waiting = pending.questions.length + pending.permissions.length > 0;
  const hasWorkflow = Boolean(snapshot?.state) && snapshot?.state?.status !== "Completed";
  const disabled = !project || !chatSupported || !installed || connection !== "live";

  const submit = async (raw: string, forcePlain = false): Promise<void> => {
    const text = raw.trim();
    if (!text || disabled || sending) return;
    const message = !forcePlain && aidlcMode && !text.startsWith("/") ? `/aidlc ${text}` : text;
    setSending(true);
    try {
      await sendChat(message);
      setDraft("");
      stick.current = true;
    } catch {
      // The error is shown above the composer.
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const suggestions: Array<{ label: string; run: () => void }> = [];
  if (installed && chatSupported && !busy && !waiting) {
    if (snapshot?.gates.length) suggestions.push({ label: "Review pending approval", run: () => setView("approvals") });
    if (hasWorkflow) {
      suggestions.push({ label: "Resume workflow", run: () => void submit("/aidlc --resume", true) });
      suggestions.push({ label: "Show workflow status", run: () => void submit("/aidlc --status", true) });
      if (snapshot?.gates.length) suggestions.push({ label: "Explain why the workflow is blocked", run: () => void submit("Explain why the current workflow is blocked.", true) });
    } else {
      suggestions.push({ label: "Check setup (doctor)", run: () => void submit("/aidlc --doctor", true) });
      suggestions.push({ label: "What can AI-DLC do?", run: () => void submit("/aidlc --help", true) });
    }
  }

  return (
    <aside className="flex h-full min-w-0 flex-col bg-bg-raised" aria-label="AI chat">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <ConversationMenu />
        <Badge tone={STATUS_LABEL[status]?.tone ?? "muted"}>
          {busy ? <Spinner className="h-2.5 w-2.5" /> : null}
          {waiting ? "Waiting for you" : (STATUS_LABEL[status]?.text ?? status)}
        </Badge>
        <button type="button" className="icon-btn" onClick={() => void newConversation()} title="New conversation" aria-label="New conversation" disabled={!project}>
          <MessageSquarePlus size={14} />
        </button>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {visible.length === 0 && !streamText ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <Bot size={24} className="text-ink-ghost" />
            <div className="text-sm font-medium text-ink-muted">{project ? `Chat with ${harness?.name ?? "your harness"}` : "Open a project to start"}</div>
            <div className="text-sm text-ink-faint">
              {!project
                ? "The chat runs inside the selected project's AI-DLC session."
                : !installed
                  ? "Set up AI-DLC in this project first."
                  : !chatSupported
                    ? harness?.note
                    : hasWorkflow
                      ? "A workflow is in progress. Resume it, or ask anything about the project."
                      : "Describe what you want to build. AI-DLC proposes a plan, asks for missing decisions, and stops at every approval gate."}
            </div>
            {project && !installed ? <button type="button" className="btn btn-primary mt-1" onClick={() => setDialog("setup")}>Set up AI-DLC</button> : null}
          </div>
        ) : (
          visible.map((event) => <Message key={event.seq} event={event} results={results} open={open} />)
        )}
        {streamText ? <Markdown text={streamText} /> : null}
        {busy && !streamText && !waiting ? (
          <div className="flex items-center gap-2 text-xs text-ink-faint"><Spinner /> {status === "starting" ? "Starting the harness session…" : "Working…"}</div>
        ) : null}
      </div>

      {suggestions.length > 0 ? (
        <div className="flex shrink-0 flex-wrap gap-1 border-t border-line px-3 py-1.5" aria-label="Suggested next actions">
          {suggestions.map((s) => (
            <button key={s.label} type="button" className="chip hover:border-accent hover:text-ink" onClick={s.run}>{s.label}</button>
          ))}
        </div>
      ) : null}

      <div className="shrink-0 border-t border-line p-2">
        {chatError ? (
          <div className="mb-1.5 flex items-start gap-1.5 rounded border border-bad/40 bg-bad/5 px-2 py-1 text-xs text-bad">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span className="break-words">{chatError}</span>
          </div>
        ) : null}
        {waiting ? <div className="mb-1.5 text-xs text-wait">The workflow is waiting for your answer above. You can also reply here in your own words after choosing “Answer in chat instead”.</div> : null}
        <div className={cx("rounded-lg border bg-bg transition-colors focus-within:border-accent", disabled ? "border-line opacity-60" : "border-line-strong")}>
          <textarea
            ref={inputRef}
            className="block max-h-48 min-h-[62px] w-full resize-none bg-transparent px-2.5 py-2 text-base text-ink outline-none placeholder:text-ink-ghost"
            placeholder={disabled ? (connection !== "live" && project ? "Reconnecting to Studio…" : !chatSupported ? "In-app chat is not available for this harness" : "Open and set up a project to chat") : aidlcMode ? "Describe what to build — sent as /aidlc …" : "Reply to the workflow, or ask about the project"}
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit(draft);
              }
            }}
            rows={2}
            aria-label="Message"
          />
          <div className="flex items-center gap-1.5 px-2 pb-1.5">
            <button
              type="button"
              className={cx("chip font-mono", aidlcMode ? "border-accent bg-accent/10 text-accent-strong" : "")}
              onClick={() => setAidlcMode(!aidlcMode)}
              disabled={disabled}
              aria-pressed={aidlcMode}
              title={aidlcMode ? "Your message is sent as an /aidlc request (starts or steers a workflow). Click to send plain messages." : "Your message is sent as typed. Click to send it as an /aidlc request."}
            >
              /aidlc {aidlcMode ? "on" : "off"}
            </button>
            <span className="min-w-0 flex-1 truncate text-2xs text-ink-ghost">Enter to send · Shift+Enter for a new line</span>
            {busy ? (
              <button type="button" className="btn btn-danger h-6 px-2" onClick={() => void stopChat()} title="Stop generation">
                <Square size={10} fill="currentColor" /> Stop
              </button>
            ) : null}
            <button type="button" className="btn btn-primary h-6 w-7 px-0" disabled={disabled || sending || !draft.trim()} onClick={() => void submit(draft)} title="Send" aria-label="Send">
              <ArrowUp size={13} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
