// The two things the harness asks the person: a question (AI-DLC gates and
// clarifications arrive this way) and a permission to run a tool. Rendered in
// the chat and in the approval panel; answered only by the person.

import { Check, HelpCircle, MessageSquare, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import type { AskQuestion, ChatEvent } from "../../../shared/types.ts";
import { useStudio } from "../store.ts";
import { Badge, cx } from "./ui.tsx";

type QuestionEvent = Extract<ChatEvent, { type: "question" }>;
type PermissionEvent = Extract<ChatEvent, { type: "permission" }>;

function QuestionBlock({ q, value, onChange }: { q: AskQuestion; value: string | string[] | undefined; onChange: (v: string | string[]) => void }) {
  const [other, setOther] = useState("");
  const labels = q.options.map((o) => o.label);
  const isOther = typeof value === "string" && value !== "" && !labels.includes(value);
  const picked = (label: string): boolean => (Array.isArray(value) ? value.includes(label) : value === label);
  const toggle = (label: string): void => {
    if (q.multiSelect) {
      const current = Array.isArray(value) ? value : [];
      onChange(current.includes(label) ? current.filter((l) => l !== label) : [...current, label]);
    } else {
      onChange(label);
    }
  };
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1 text-sm font-medium text-ink">
        {q.header ? <span className="mr-1.5"><Badge tone="wait">{q.header}</Badge></span> : null}
        {q.question}
      </legend>
      {q.options.map((option) => (
        <button
          key={option.label}
          type="button"
          role={q.multiSelect ? "checkbox" : "radio"}
          aria-checked={picked(option.label)}
          aria-label={option.label}
          onClick={() => toggle(option.label)}
          className={cx("flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors", picked(option.label) ? "border-accent bg-accent/10" : "border-line bg-bg hover:bg-bg-hover")}
        >
          <span className={cx("mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border", q.multiSelect ? "rounded-sm" : "rounded-full", picked(option.label) ? "border-accent bg-accent text-bg" : "border-ink-ghost")}>
            {picked(option.label) ? <Check size={10} strokeWidth={3} /> : null}
          </span>
          <span className="min-w-0">
            <span className="block text-sm text-ink">{option.label}</span>
            {option.description ? <span className="block text-xs text-ink-faint">{option.description}</span> : null}
          </span>
        </button>
      ))}
      {!q.multiSelect ? (
        <input
          className={cx("input", isOther && "border-accent")}
          placeholder="Or type your own answer…"
          value={isOther ? (value as string) : other}
          onChange={(e) => {
            setOther(e.target.value);
            onChange(e.target.value);
          }}
          onFocus={() => other && onChange(other)}
          aria-label={`Own answer: ${q.question}`}
        />
      ) : null}
    </fieldset>
  );
}

export function QuestionCard({ event, stage, compact }: { event: QuestionEvent; stage?: string; compact?: boolean }) {
  const answerQuestion = useStudio((s) => s.answerQuestion);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [busy, setBusy] = useState(false);
  const complete = event.questions.every((q) => {
    const v = answers[q.question];
    return typeof v === "string" ? v.trim() !== "" : Array.isArray(v) && v.length > 0;
  });
  const submit = async (value: Record<string, string | string[]> | null): Promise<void> => {
    setBusy(true);
    await answerQuestion(event.id, value, stage);
    setBusy(false);
  };
  return (
    <div className={cx("rounded-lg border border-wait/40 bg-wait/5", compact ? "p-2.5" : "p-3")} role="group" aria-label="Question from the workflow">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-wait">
        <HelpCircle size={13} /> The workflow needs your decision
      </div>
      <div className="space-y-3">
        {event.questions.map((q) => (
          <QuestionBlock key={q.question} q={q} value={answers[q.question]} onChange={(v) => setAnswers({ ...answers, [q.question]: v })} />
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="btn btn-primary" disabled={!complete || busy} onClick={() => void submit(answers)}>
          <Check size={12} /> Submit answer
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void submit(null)} title="Leave the question unanswered and reply in your own words in the chat">
          <MessageSquare size={12} /> Answer in chat instead
        </button>
      </div>
    </div>
  );
}

function summarizeInput(toolName: string, input: unknown): { title: string; body: string } {
  const data = (input ?? {}) as Record<string, unknown>;
  if (typeof data.command === "string") return { title: "Run command", body: data.command };
  if (typeof data.file_path === "string") return { title: `${toolName} file`, body: data.file_path };
  if (typeof data.url === "string") return { title: "Fetch URL", body: data.url };
  if (typeof data.plan === "string") return { title: "Proposed plan", body: data.plan };
  return { title: toolName, body: JSON.stringify(data, null, 2) };
}

export function PermissionCard({ event }: { event: PermissionEvent }) {
  const decide = useStudio((s) => s.decidePermission);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const { title, body } = summarizeInput(event.toolName, event.input);
  const act = async (decision: "allow" | "deny"): Promise<void> => {
    setBusy(true);
    await decide(event.id, decision, decision === "deny" ? note : undefined);
    setBusy(false);
  };
  return (
    <div className="rounded-lg border border-warn/40 bg-warn/5 p-3" role="group" aria-label="Permission request">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-warn">
        <ShieldAlert size={13} /> Permission needed: {event.toolName}
      </div>
      <div className="text-xs text-ink-muted">{title}{event.reason ? ` — ${event.reason}` : ""}</div>
      <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-bg p-2 font-mono text-[11.5px] leading-[17px] text-ink">{body}</pre>
      <input className="input mt-2" placeholder="If you deny: tell the agent what to do instead (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Reason for denying" />
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act("allow")}>
          <Check size={12} /> Allow once
        </button>
        <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void act("deny")}>
          <X size={12} /> Deny
        </button>
      </div>
    </div>
  );
}
