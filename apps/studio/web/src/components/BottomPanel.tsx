// Bottom panel: Terminal (allowlisted command runner), Execution Logs, Agent
// Activity, Problems, Test Results, Git Changes.

import { AlertTriangle, Bot, CheckCircle2, ChevronDown, CircleSlash, Play, Square, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentActivity, LogLine } from "../../../shared/types.ts";
import { type BottomTab, useStudio } from "../store.ts";
import { Badge, Empty, clock, cx, timeAgo, titleCase } from "./ui.tsx";

function useStickyScroll(dep: unknown): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = (): void => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return ref;
}

// ---------- Terminal ----------

function TerminalTab() {
  const term = useStudio((s) => s.term);
  const commands = useStudio((s) => s.commands);
  const runs = useStudio((s) => s.runs);
  const runCommand = useStudio((s) => s.runCommand);
  const killRun = useStudio((s) => s.killRun);
  const clearTerm = useStudio((s) => s.clearTerm);
  const loadCommands = useStudio((s) => s.loadCommands);
  const [input, setInput] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const ref = useStickyScroll(term.length);
  const running = Object.entries(runs).filter(([, r]) => r.running);
  useEffect(() => void loadCommands(), [loadCommands]);

  const matches = useMemo(() => {
    const needle = input.trim().toLowerCase();
    if (!needle) return [];
    return commands.filter((c) => c.display.toLowerCase().includes(needle) || c.label.toLowerCase().includes(needle) || c.id.toLowerCase().includes(needle)).slice(0, 8);
  }, [input, commands]);

  const submit = (): void => {
    const needle = input.trim().toLowerCase();
    if (!needle) return;
    const exact = commands.find((c) => c.display.toLowerCase() === needle || c.id.toLowerCase() === needle) ?? (matches.length === 1 ? matches[0] : undefined);
    if (!exact) {
      setNote(matches.length > 1 ? "More than one allowed command matches. Pick one from the list." : "That is not one of this project's allowed commands. This terminal runs a fixed list (engine, git and the project's own scripts), not arbitrary shell input. To run anything else, ask the agent in chat or use your own terminal.");
      return;
    }
    setNote(null);
    setInput("");
    void runCommand(exact.id);
  };

  const groups = useMemo(() => {
    const map = new Map<string, typeof commands>();
    for (const c of commands) map.set(c.group, [...(map.get(c.group) ?? []), c]);
    return [...map.entries()];
  }, [commands]);

  return (
    <div className="flex h-full min-h-0">
      <div className="w-56 shrink-0 overflow-y-auto border-r border-line py-1">
        {groups.length === 0 ? <div className="px-3 py-1 text-xs text-ink-faint">No commands available. Set up AI-DLC or open a project with scripts.</div> : null}
        {groups.map(([group, items]) => (
          <div key={group}>
            <div className="label px-3 py-1">{group}</div>
            {items.map((c) => (
              <button key={c.id} type="button" title={c.description ? `${c.display}\n${c.description}` : c.display} onClick={() => void runCommand(c.id)} className="flex w-full items-center gap-1.5 px-3 py-[3px] text-left text-xs text-ink-muted hover:bg-bg-hover hover:text-ink">
                <Play size={10} className="shrink-0 text-ink-ghost" />
                <span className="truncate">{c.label}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={ref} className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[17px]" role="log" aria-label="Terminal output">
          {term.length === 0 ? <div className="text-ink-ghost">Run a command from the list, or type to filter. Output is the real process output.</div> : null}
          {term.map((line) => (
            <div key={line.id} className={cx("whitespace-pre-wrap break-words", line.kind === "cmd" ? "mt-1 font-semibold text-accent-strong" : line.kind === "err" ? "text-bad" : line.kind === "info" ? "text-ink-ghost" : "text-ink-muted")}>
              {line.text || " "}
            </div>
          ))}
        </div>
        {note ? <div className="border-t border-line px-3 py-1 text-xs text-warn">{note}</div> : null}
        {matches.length > 0 && input ? (
          <div className="border-t border-line bg-bg-panel py-0.5">
            {matches.map((c) => (
              <button key={c.id} type="button" className="flex w-full items-center gap-2 px-3 py-0.5 text-left font-mono text-xs text-ink-muted hover:bg-bg-hover" onClick={() => (setInput(""), setNote(null), void runCommand(c.id))}>
                <span className="truncate">{c.display}</span>
                <span className="font-sans text-2xs text-ink-ghost">{c.group}</span>
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1">
          <span className="font-mono text-xs text-accent-strong">$</span>
          <input
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink outline-none placeholder:text-ink-ghost"
            placeholder="Type to find an allowed command, Enter to run"
            value={input}
            onChange={(e) => (setInput(e.target.value), setNote(null))}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            aria-label="Command"
            spellCheck={false}
          />
          {running.map(([runId, r]) => (
            <button key={runId} type="button" className="btn btn-danger h-5 px-1.5 py-0 text-2xs" onClick={() => void killRun(runId)} title={`Stop ${r.commandId}`}>
              <Square size={9} fill="currentColor" /> {r.commandId}
            </button>
          ))}
          <button type="button" className="icon-btn" onClick={clearTerm} title="Clear terminal" aria-label="Clear terminal">
            <Trash2 size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Logs ----------

const LEVEL_CLASS: Record<LogLine["level"], string> = { info: "text-ink-muted", warn: "text-warn", error: "text-bad", debug: "text-ink-ghost" };

function LogsTab() {
  const logs = useStudio((s) => s.logs);
  const clearLogs = useStudio((s) => s.clearLogs);
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<"all" | "info" | "warn" | "error">("info");
  const [source, setSource] = useState("all");
  const sources = useMemo(() => ["all", ...new Set(logs.map((l) => l.source))], [logs]);
  const shown = useMemo(() => {
    const needle = filter.toLowerCase();
    return logs.filter((l) => {
      if (level === "info" && l.level === "debug") return false;
      if (level === "warn" && (l.level === "debug" || l.level === "info")) return false;
      if (level === "error" && l.level !== "error") return false;
      if (source !== "all" && l.source !== source) return false;
      return !needle || l.text.toLowerCase().includes(needle);
    });
  }, [logs, filter, level, source]);
  const ref = useStickyScroll(shown.length);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1">
        <input className="input h-6 max-w-xs py-0 text-xs" placeholder="Filter logs" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter logs" />
        <select className="input h-6 w-auto py-0 text-xs" value={level} onChange={(e) => setLevel(e.target.value as typeof level)} aria-label="Minimum level">
          <option value="all">All levels (with debug)</option>
          <option value="info">Info and above</option>
          <option value="warn">Warnings and errors</option>
          <option value="error">Errors only</option>
        </select>
        <select className="input h-6 w-auto py-0 text-xs" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
          {sources.map((s) => <option key={s} value={s}>{s === "all" ? "All sources" : s}</option>)}
        </select>
        <span className="flex-1 text-right text-2xs text-ink-ghost">{shown.length} of {logs.length} lines · secrets are redacted</span>
        <button type="button" className="icon-btn" onClick={() => void clearLogs()} title="Clear logs" aria-label="Clear logs">
          <Trash2 size={12} />
        </button>
      </div>
      <div ref={ref} className="min-h-0 flex-1 overflow-auto px-3 py-1 font-mono text-[11.5px] leading-[17px]" role="log" aria-label="Execution logs">
        {shown.length === 0 ? <div className="py-1 font-sans text-xs text-ink-ghost">No log lines{logs.length ? " match the filter" : " yet. Engine events, tool calls, hook results and command runs appear here as they happen"}.</div> : null}
        {shown.map((line) => (
          <div key={line.seq} className="flex gap-2">
            <span className="shrink-0 text-ink-ghost">{clock(line.ts)}</span>
            <span className="w-16 shrink-0 truncate text-ink-faint">{line.source}</span>
            <span className={cx("min-w-0 flex-1 whitespace-pre-wrap break-words", LEVEL_CLASS[line.level])}>{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Agent activity ----------

const AGENT_STATUS: Record<AgentActivity["status"], { tone: "info" | "ok" | "bad" | "muted"; bar: string }> = {
  active: { tone: "info", bar: "bg-info" },
  completed: { tone: "ok", bar: "bg-ok/70" },
  failed: { tone: "bad", bar: "bg-bad" },
  stopped: { tone: "muted", bar: "bg-ink-ghost" },
};

function AgentsTab() {
  const snapshot = useStudio((s) => s.snapshot);
  const setView = useStudio((s) => s.setView);
  const openFile = useStudio((s) => s.openFile);
  const [showRoster, setShowRoster] = useState(false);
  const rows = snapshot?.agents ?? [];
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const times = rows.flatMap((r) => [r.startedAt ? Date.parse(r.startedAt) : NaN, r.completedAt ? Date.parse(r.completedAt) : NaN]).filter((t) => !Number.isNaN(t));
  const start = times.length ? Math.min(...times) : now;
  const end = Math.max(now, ...times);
  const span = Math.max(1, end - start);
  const roster = snapshot?.lifecycle?.agents ?? [];
  const activeBySlug = new Map(rows.filter((r) => r.status === "active").map((r) => [r.agent, r]));
  if (!snapshot) return <Empty title="No project state" />;
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-auto">
        {rows.length === 0 ? (
          <Empty title="No agent activity recorded" icon={<Bot size={20} />}>Agents appear here from the engine's audit trail (stage leads, dispatched helpers, reviewers) and from the live harness session.</Empty>
        ) : (
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-bg-raised text-left text-2xs uppercase tracking-wider text-ink-faint">
              <tr>
                <th className="px-3 py-1 font-semibold">Agent</th>
                <th className="px-2 py-1 font-semibold">Role</th>
                <th className="px-2 py-1 font-semibold">Stage</th>
                <th className="px-2 py-1 font-semibold">Task</th>
                <th className="px-2 py-1 font-semibold">Status</th>
                <th className="px-2 py-1 font-semibold">Start</th>
                <th className="px-2 py-1 font-semibold">End</th>
                <th className="w-[26%] px-2 py-1 font-semibold">Timeline</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((row) => {
                const s = row.startedAt ? Date.parse(row.startedAt) : start;
                const e = row.completedAt ? Date.parse(row.completedAt) : row.status === "active" ? now : s;
                const left = ((s - start) / span) * 100;
                const width = Math.max(1.2, ((e - s) / span) * 100);
                return (
                  <tr key={row.id} className="border-t border-line/60 align-top hover:bg-bg-hover">
                    <td className="px-3 py-1">
                      <div className="flex items-center gap-1.5">
                        <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", AGENT_STATUS[row.status].bar, row.status === "active" && "pulse")} />
                        <span className="font-medium text-ink">{row.displayName}</span>
                      </div>
                      {row.error ? <div className="mt-0.5 pl-3 text-bad">{row.error}</div> : null}
                      {row.outputs?.length ? (
                        <div className="mt-0.5 flex flex-wrap gap-x-2 pl-3">
                          {row.outputs.slice(0, 6).map((out, i) => (/[\\/]/.test(out) && out.length < 200 ? <button key={i} type="button" className="max-w-[220px] truncate font-mono text-2xs text-accent-strong hover:underline" onClick={() => void openFile(out.replace(/\\/g, "/"))}>{out.split(/[\\/]/).pop()}</button> : <span key={i} className="max-w-[320px] truncate text-2xs text-ink-faint">{out}</span>))}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-2 py-1 text-ink-muted">{row.role}<span className="text-ink-ghost"> · {row.source}</span></td>
                    <td className="px-2 py-1">{row.stage ? <button type="button" className="text-ink-muted hover:text-ink hover:underline" onClick={() => setView(`stage:${row.stage}`)}>{titleCase(row.stage)}</button> : "—"}</td>
                    <td className="max-w-[240px] truncate px-2 py-1 text-ink-faint" title={row.task}>{row.task ?? "—"}</td>
                    <td className="px-2 py-1"><Badge tone={AGENT_STATUS[row.status].tone}>{row.status}</Badge></td>
                    <td className="px-2 py-1 font-mono text-2xs text-ink-faint">{row.startedAt ? clock(row.startedAt) : "—"}</td>
                    <td className="px-2 py-1 font-mono text-2xs text-ink-faint">{row.completedAt ? clock(row.completedAt) : "—"}</td>
                    <td className="px-2 py-1">
                      <div className="relative h-3 rounded bg-bg-active">
                        <div className={cx("absolute top-0.5 h-2 rounded", AGENT_STATUS[row.status].bar)} style={{ left: `${Math.min(98.8, left)}%`, width: `${Math.min(100 - Math.min(98.8, left), width)}%` }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="w-52 shrink-0 overflow-y-auto border-l border-line py-1">
        <button type="button" className="flex w-full items-center gap-1 px-3 py-1 text-left" onClick={() => setShowRoster(!showRoster)} aria-expanded={showRoster}>
          <ChevronDown size={11} className={cx("text-ink-faint transition-transform", !showRoster && "-rotate-90")} />
          <span className="label">Agent roster · {roster.length}</span>
        </button>
        {showRoster
          ? roster.map((agent) => {
              const active = activeBySlug.get(agent.slug);
              return (
                <div key={agent.slug} className="flex items-center gap-1.5 px-3 py-[3px] text-xs" title={agent.slug}>
                  <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", active ? "pulse bg-info" : "bg-ink-ghost")} />
                  <span className={cx("truncate", active ? "text-ink" : "text-ink-faint")}>{agent.display_name}</span>
                </div>
              );
            })
          : <div className="px-3 text-2xs text-ink-ghost">{activeBySlug.size} active now</div>}
      </div>
    </div>
  );
}

// ---------- Problems ----------

export function useProblems(): Array<{ severity: "error" | "warn"; source: string; text: string; action?: () => void; ts?: string }> {
  const snapshot = useStudio((s) => s.snapshot);
  const logs = useStudio((s) => s.logs);
  const tests = useStudio((s) => s.tests.runs);
  const chatError = useStudio((s) => s.chatError);
  const system = useStudio((s) => s.system);
  const setView = useStudio((s) => s.setView);
  const openFile = useStudio((s) => s.openFile);
  return useMemo(() => {
    const out: Array<{ severity: "error" | "warn"; source: string; text: string; action?: () => void; ts?: string }> = [];
    for (const error of snapshot?.errors ?? []) out.push({ severity: "error", source: "engine", text: error });
    if (system) {
      if (!system.tools.bun?.ok) out.push({ severity: "error", source: "environment", text: `Bun is required to run the AI-DLC engine: ${system.tools.bun?.error ?? "not found"}` });
      if (!system.tools.claude?.ok) out.push({ severity: "warn", source: "environment", text: `Claude Code: ${system.tools.claude?.error ?? "not found"}` });
      if (!system.tools.git?.ok) out.push({ severity: "warn", source: "environment", text: `git: ${system.tools.git?.error ?? "not found"}` });
      if (system.tools.aidlc && !system.tools.aidlc.ok && system.tools.aidlc.path) out.push({ severity: "warn", source: "environment", text: `The native aidlc command cannot run here (${system.tools.aidlc.error}). Studio uses the Bun runtime instead.` });
    }
    if (chatError) out.push({ severity: "error", source: "chat", text: chatError });
    const latest = tests[0];
    if (latest && (latest.status === "failed" || latest.status === "error")) {
      if (latest.failures.length === 0) out.push({ severity: "error", source: "tests", text: `${latest.command} ${latest.status} (exit ${String(latest.exitCode ?? "?")})`, action: () => setView("testing") });
      for (const failure of latest.failures.slice(0, 50)) {
        out.push({ severity: "error", source: "tests", text: `${failure.name}${failure.message ? ` — ${failure.message}` : ""}`, action: () => (failure.file ? void openFile(failure.file.replace(/\\/g, "/"), { line: failure.line }) : setView("testing")) });
      }
    }
    for (const event of (snapshot?.audit ?? []).filter((e) => /ERROR_LOGGED|_FAILED|_BLOCKED|COULD_NOT_RUN/.test(e.event)).slice(-30)) {
      out.push({ severity: /BLOCKED|COULD_NOT_RUN/.test(event.event) ? "warn" : "error", source: "audit", ts: event.timestamp, text: `${event.event} ${event.fields["Stage"] ?? ""} ${event.fields["Details"] ?? event.fields["Reason"] ?? ""}`.trim(), action: event.fields["Stage"] ? () => setView(`stage:${event.fields["Stage"]}`) : undefined });
    }
    for (const line of logs.filter((l) => l.level === "error").slice(-30)) out.push({ severity: "error", source: line.source, text: line.text, ts: line.ts });
    return out;
  }, [snapshot, logs, tests, chatError, system, setView, openFile]);
}

function ProblemsTab() {
  const problems = useProblems();
  if (problems.length === 0) return <Empty title="No problems detected" icon={<CheckCircle2 size={20} />}>Engine errors, environment issues, failing tests and error log lines are listed here.</Empty>;
  return (
    <div className="h-full overflow-auto py-1">
      {problems.map((p, i) => (
        <button key={i} type="button" disabled={!p.action} onClick={p.action} className="flex w-full items-start gap-2 px-3 py-1 text-left text-xs hover:bg-bg-hover disabled:hover:bg-transparent">
          {p.severity === "error" ? <XCircle size={12} className="mt-0.5 shrink-0 text-bad" /> : <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" />}
          <span className="w-20 shrink-0 text-ink-faint">{p.source}</span>
          <span className="min-w-0 flex-1 break-words text-ink-muted">{p.text}</span>
          {p.ts ? <span className="shrink-0 font-mono text-2xs text-ink-ghost">{clock(p.ts)}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ---------- Tests ----------

function TestsTab() {
  const tests = useStudio((s) => s.tests);
  const setView = useStudio((s) => s.setView);
  const runCommand = useStudio((s) => s.runCommand);
  if (tests.runs.length === 0) {
    return (
      <Empty title="No test run yet" icon={<CircleSlash size={20} />}>
        {tests.commands.length ? (
          <span className="flex flex-wrap justify-center gap-1.5">
            {tests.commands.map((c) => <button key={c.id} type="button" className="btn" onClick={() => void runCommand(c.id)}><Play size={11} /> {c.label}</button>)}
          </span>
        ) : "Studio found no test command in this project. Test commands the agent runs in chat are captured here too."}
      </Empty>
    );
  }
  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-bg-raised text-left text-2xs uppercase tracking-wider text-ink-faint">
          <tr>
            <th className="px-3 py-1 font-semibold">Status</th>
            <th className="px-2 py-1 font-semibold">Command</th>
            <th className="px-2 py-1 font-semibold">Passed</th>
            <th className="px-2 py-1 font-semibold">Failed</th>
            <th className="px-2 py-1 font-semibold">Skipped</th>
            <th className="px-2 py-1 font-semibold">Run by</th>
            <th className="px-2 py-1 font-semibold">When</th>
          </tr>
        </thead>
        <tbody>
          {tests.runs.map((run) => (
            <tr key={run.id} className="cursor-pointer border-t border-line/60 hover:bg-bg-hover" onClick={() => setView("testing")}>
              <td className="px-3 py-1"><Badge tone={run.status === "passed" ? "ok" : run.status === "running" ? "info" : "bad"}>{run.status}</Badge></td>
              <td className="max-w-[420px] truncate px-2 py-1 font-mono text-ink-muted">{run.command}</td>
              <td className="px-2 py-1 tabular-nums text-ok">{run.summary?.passed ?? "—"}</td>
              <td className={cx("px-2 py-1 tabular-nums", (run.summary?.failed ?? 0) > 0 ? "text-bad" : "text-ink-faint")}>{run.summary?.failed ?? "—"}</td>
              <td className="px-2 py-1 tabular-nums text-ink-faint">{run.summary?.skipped ?? "—"}</td>
              <td className="px-2 py-1 text-ink-faint">{run.source === "harness" ? "agent" : "you"}</td>
              <td className="px-2 py-1 text-ink-faint">{timeAgo(run.startedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Git ----------

function GitTab() {
  const git = useStudio((s) => s.git);
  const changes = useStudio((s) => s.changes);
  const openFile = useStudio((s) => s.openFile);
  const refreshGit = useStudio((s) => s.refreshGit);
  useEffect(() => void refreshGit(), [refreshGit]);
  const session = Object.values(changes).sort((a, b) => b.at - a.at);
  return (
    <div className="grid h-full min-h-0 grid-cols-2">
      <div className="min-h-0 overflow-auto border-r border-line py-1">
        <div className="label px-3 py-1">Uncommitted changes{git?.isRepo ? ` · ${git.branch ?? ""} · ${git.files.length}` : ""}</div>
        {!git ? null : !git.isRepo ? <div className="px-3 text-xs text-ink-faint">{git.note}</div> : git.files.length === 0 ? <div className="px-3 text-xs text-ink-faint">Working tree is clean.</div> : null}
        {git?.files.map((file) => (
          <button key={file.path} type="button" disabled={file.label === "deleted"} onClick={() => void openFile(file.path, { diff: file.label === "modified" })} className="flex w-full items-center gap-2 px-3 py-[3px] text-left text-xs hover:bg-bg-hover disabled:opacity-50">
            <span className={cx("w-16 shrink-0", file.label === "added" || file.label === "untracked" ? "text-ok" : file.label === "deleted" || file.label === "conflict" ? "text-bad" : "text-warn")}>{file.label}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-ink-muted">{file.path}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 overflow-auto py-1">
        <div className="label px-3 py-1">Changed on disk this session · {session.length}</div>
        {session.length === 0 ? <div className="px-3 text-xs text-ink-faint">No file has changed since Studio opened this project.</div> : null}
        {session.slice(0, 300).map((change) => (
          <button key={change.path} type="button" disabled={change.kind === "unlink"} onClick={() => void openFile(change.path)} className="flex w-full items-center gap-2 px-3 py-[3px] text-left text-xs hover:bg-bg-hover disabled:opacity-50">
            <span className={cx("w-16 shrink-0", change.kind === "add" ? "text-ok" : change.kind === "unlink" ? "text-bad" : "text-warn")}>{change.kind === "add" ? "created" : change.kind === "unlink" ? "deleted" : "modified"}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-ink-muted">{change.path}</span>
            <span className="shrink-0 text-2xs text-ink-ghost">{timeAgo(change.at)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const TABS: Array<{ id: BottomTab; label: string }> = [
  { id: "terminal", label: "Terminal" },
  { id: "logs", label: "Execution Logs" },
  { id: "agents", label: "Agent Activity" },
  { id: "problems", label: "Problems" },
  { id: "tests", label: "Test Results" },
  { id: "git", label: "Git Changes" },
];

export function BottomPanel() {
  const tab = useStudio((s) => s.bottomTab);
  const setBottom = useStudio((s) => s.setBottom);
  const problems = useProblems();
  const activeAgents = useStudio((s) => (s.snapshot?.agents ?? []).filter((a) => a.status === "active").length);
  const failing = useStudio((s) => (s.tests.runs[0]?.status === "failed" || s.tests.runs[0]?.status === "error" ? 1 : 0));
  const errors = problems.filter((p) => p.severity === "error").length;
  const count: Partial<Record<BottomTab, { n: number; tone: "bad" | "info" | "warn" }>> = {
    problems: problems.length ? { n: problems.length, tone: errors ? "bad" : "warn" } : undefined,
    agents: activeAgents ? { n: activeAgents, tone: "info" } : undefined,
    tests: failing ? { n: failing, tone: "bad" } : undefined,
  };
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-raised">
      <div className="flex h-8 shrink-0 items-center border-b border-line px-1" role="tablist" aria-label="Execution panel">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setBottom(true, t.id)} className={cx("flex h-full items-center gap-1.5 border-b-2 px-2.5 text-xs", tab === t.id ? "border-accent text-ink" : "border-transparent text-ink-faint hover:text-ink")}>
            {t.label}
            {count[t.id] ? <Badge tone={count[t.id]!.tone}>{count[t.id]!.n}</Badge> : null}
          </button>
        ))}
        <span className="flex-1" />
        <button type="button" className="icon-btn" onClick={() => setBottom(false)} title="Collapse panel" aria-label="Collapse panel">
          <ChevronDown size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1" role="tabpanel">
        {tab === "terminal" ? <TerminalTab /> : tab === "logs" ? <LogsTab /> : tab === "agents" ? <AgentsTab /> : tab === "problems" ? <ProblemsTab /> : tab === "tests" ? <TestsTab /> : <GitTab />}
      </div>
    </div>
  );
}
