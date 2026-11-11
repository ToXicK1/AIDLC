// The central workspaces. Each one renders only what the engine, the project
// folder or the harness actually provides; where a source has nothing, the
// view says so instead of filling the space.

import { Activity, AlertTriangle, Bot, CheckCircle2, ChevronRight, CircleDot, FileText, Play, RefreshCw, ShieldCheck, Stethoscope, Wrench, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ApprovalGate, ArtifactCategory, ArtifactFile, AuditEvent, GraphStage, StageState } from "../../../../shared/types.ts";
import { P } from "../../api.ts";
import { pendingRequests, useStudio } from "../../store.ts";
import { QuestionCard } from "../Requests.tsx";
import { Badge, Empty, Mermaid, SectionTitle, Spinner, STAGE_STATE, StateDot, clock, cx, timeAgo, titleCase } from "../ui.tsx";
import { DocViewer, DocWorkspace, ViewHeader, extractMermaid, stageGroup, useFile } from "./common.tsx";

const stagesOf = (snapshot: { lifecycle: { phases: Array<{ stages: GraphStage[] }> } | null } | null): GraphStage[] => snapshot?.lifecycle?.phases.flatMap((p) => p.stages) ?? [];

const NO_GATES: ApprovalGate[] = [];
const NO_AGENTS: Array<{ slug: string; display_name: string }> = [];
const NO_ARTIFACTS: ArtifactFile[] = [];

function NotReady() {
  const snapshot = useStudio((s) => s.snapshot);
  const setDialog = useStudio((s) => s.setDialog);
  if (!snapshot) return <div className="p-6"><Spinner /></div>;
  if (!snapshot.install.installed) {
    return (
      <Empty title="AI-DLC is not set up in this project" icon={<Wrench size={22} />}>
        <p>Set it up to add the engine, stages, agents and hooks for your harness.</p>
        <button type="button" className="btn btn-primary mt-3" onClick={() => setDialog("setup")}>Set up AI-DLC</button>
      </Empty>
    );
  }
  return null;
}

function auditLine(event: AuditEvent): string {
  const f = event.fields;
  const subject = f["Stage"] ?? f["Phase"] ?? f["File"] ?? f["Agent Type"] ?? f["Scope"] ?? "";
  const detail = f["Details"] ?? f["Reason"] ?? "";
  return [subject, detail].filter(Boolean).join(" — ");
}

function eventTone(name: string): string {
  if (/ERROR|FAILED|BLOCKED/.test(name)) return "text-bad";
  if (/REJECTED|REVISING/.test(name)) return "text-warn";
  if (/AWAITING/.test(name)) return "text-wait";
  if (/APPROVED|COMPLETED|VERIFIED|PASSED/.test(name)) return "text-ok";
  return "text-ink-muted";
}

// ---------------------------------------------------------------- Overview

export function Overview() {
  const project = useStudio((s) => s.project);
  const snapshot = useStudio((s) => s.snapshot);
  const system = useStudio((s) => s.system);
  const setView = useStudio((s) => s.setView);
  const setBottom = useStudio((s) => s.setBottom);
  const chatEvents = useStudio((s) => s.chatEvents);
  const tests = useStudio((s) => s.tests.runs);
  const chatStatus = useStudio((s) => s.chatStatus);
  const blocked = NotReady();
  if (!snapshot || blocked) return blocked;
  const state = snapshot.state;
  const stages = stagesOf(snapshot);
  const stageName = (slug: string): string => stages.find((s) => s.slug === slug)?.name ?? (slug || "—");
  const activeAgents = snapshot.agents.filter((a) => a.status === "active");
  const lastResult = [...chatEvents].reverse().find((e) => e.type === "result");
  const lastTest = tests[0];
  const pct = state && state.total > 0 ? Math.round((state.completed / state.total) * 100) : 0;
  const harness = system?.harnesses.find((h) => h.id === project?.harness);
  return (
    <div className="h-full overflow-y-auto">
      <ViewHeader
        title={project?.name ?? "Project"}
        subtitle={state?.project || "No workflow yet — describe what to build in the chat to start one."}
        right={<Badge tone={snapshot.install.engine ? "ok" : "bad"}>{snapshot.install.engine ? `Engine: ${snapshot.install.engine.display}` : "Engine not runnable"}</Badge>}
      />
      <div className="grid grid-cols-12 gap-3 p-4">
        <div className="card col-span-12 p-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
            <Stat label="Lifecycle phase" value={state ? titleCase(state.lifecyclePhase.toLowerCase()) : "—"} />
            <Stat label="Current stage" value={state ? stageName(state.currentStage) : "—"} onClick={state?.currentStage ? () => setView(`stage:${state.currentStage}`) : undefined} />
            <Stat label="Workflow (scope)" value={state?.scope || "—"} />
            <Stat label="Status" value={state?.status || "Not started"} tone={state?.status === "Running" ? "text-info" : state?.status === "Completed" ? "text-ok" : undefined} />
          </div>
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between text-xs text-ink-faint">
              <span>Overall progress</span>
              <span className="tabular-nums">{state ? `${state.completed} of ${state.total} stages · ${pct}%` : "no workflow"}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-bg-active" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
            </div>
            {state ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {state.stages.filter((s) => s.plan === "EXECUTE").map((s) => (
                  <button key={s.slug} type="button" title={`${stageName(s.slug)} — ${STAGE_STATE[s.state].label}`} onClick={() => setView(`stage:${s.slug}`)} className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-2xs text-ink-muted hover:bg-bg-hover">
                    <StateDot state={s.state} /> {stageName(s.slug)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="card col-span-12 p-3 lg:col-span-6">
          <SectionTitle right={snapshot.gates.length > 0 ? <button type="button" className="btn" onClick={() => setView("approvals")}>Review <ChevronRight size={12} /></button> : null}>Pending approvals</SectionTitle>
          {snapshot.gates.length === 0 ? (
            <div className="text-sm text-ink-faint">No stage is waiting for your approval.</div>
          ) : (
            snapshot.gates.map((gate) => (
              <button key={gate.stage} type="button" onClick={() => setView("approvals")} className="mb-1 flex w-full items-center gap-2 rounded-md border border-wait/30 bg-wait/5 px-2.5 py-1.5 text-left hover:bg-wait/10">
                <ShieldCheck size={14} className="shrink-0 text-wait" />
                <span className="min-w-0 flex-1 truncate text-sm">{gate.stageName}</span>
                <span className="text-2xs text-ink-faint">{gate.state === "revising" ? "revising" : gate.since ? `waiting ${timeAgo(gate.since)}` : "waiting"}</span>
              </button>
            ))
          )}
        </div>

        <div className="card col-span-12 p-3 lg:col-span-6">
          <SectionTitle right={<button type="button" className="btn btn-ghost" onClick={() => setBottom(true, "agents")}>Timeline <ChevronRight size={12} /></button>}>Active agents</SectionTitle>
          {activeAgents.length === 0 ? (
            <div className="text-sm text-ink-faint">{chatStatus === "running" ? "The conductor is working in the chat session." : "No agent is active."}</div>
          ) : (
            activeAgents.slice(0, 6).map((agent) => (
              <div key={agent.id} className="mb-1 flex items-center gap-2 text-sm">
                <Bot size={13} className="shrink-0 text-info" />
                <span className="truncate font-medium">{agent.displayName}</span>
                <Badge>{agent.role}</Badge>
                <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">{agent.task ?? (agent.stage ? stageName(agent.stage) : "")}</span>
              </div>
            ))
          )}
        </div>

        <div className="card col-span-12 p-3 lg:col-span-7">
          <SectionTitle right={<button type="button" className="btn btn-ghost" onClick={() => setBottom(true, "logs")}>Logs <ChevronRight size={12} /></button>}>Recent activity</SectionTitle>
          {snapshot.audit.length === 0 ? (
            <div className="text-sm text-ink-faint">The audit trail is empty.</div>
          ) : (
            <div className="space-y-0.5">
              {snapshot.audit.slice(-12).reverse().map((event, i) => (
                <div key={`${event.timestamp}-${i}`} className="flex items-baseline gap-2 text-xs">
                  <span className="w-14 shrink-0 font-mono text-2xs text-ink-ghost">{clock(event.timestamp)}</span>
                  <span className={cx("w-44 shrink-0 truncate font-mono text-2xs", eventTone(event.event))}>{event.event}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-muted">{auditLine(event)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card col-span-12 p-3 lg:col-span-5">
          <SectionTitle>Latest execution results</SectionTitle>
          <div className="space-y-2 text-sm">
            <div className="flex items-start gap-2">
              <Activity size={13} className="mt-0.5 shrink-0 text-ink-faint" />
              {lastResult && lastResult.type === "result" ? (
                <span>
                  Last agent turn: <span className={lastResult.isError ? "text-bad" : "text-ok"}>{lastResult.isError ? `failed${lastResult.text ? `: ${lastResult.text}` : ` (${lastResult.subtype})`}` : "completed"}</span>
                  <span className="text-ink-faint"> · {lastResult.turns ?? "?"} steps{lastResult.durationMs ? ` · ${Math.round(lastResult.durationMs / 1000)}s` : ""} · {timeAgo(lastResult.ts)}</span>
                </span>
              ) : (
                <span className="text-ink-faint">No agent turn in this conversation yet.</span>
              )}
            </div>
            <div className="flex items-start gap-2">
              {lastTest?.status === "failed" || lastTest?.status === "error" ? <XCircle size={13} className="mt-0.5 shrink-0 text-bad" /> : <CheckCircle2 size={13} className={cx("mt-0.5 shrink-0", lastTest ? "text-ok" : "text-ink-faint")} />}
              {lastTest ? (
                <button type="button" className="text-left hover:underline" onClick={() => setView("testing")}>
                  Tests: <span className={lastTest.status === "passed" ? "text-ok" : lastTest.status === "running" ? "text-info" : "text-bad"}>{lastTest.status}</span>
                  {lastTest.summary ? <span className="text-ink-faint"> · {lastTest.summary.passed ?? 0} passed, {lastTest.summary.failed ?? 0} failed</span> : null}
                </button>
              ) : (
                <span className="text-ink-faint">No test run recorded this session.</span>
              )}
            </div>
            <div className="flex items-start gap-2 text-ink-faint">
              <CircleDot size={13} className="mt-0.5 shrink-0" />
              <span>Harness: {harness?.name ?? project?.harness}{harness && !harness.capabilities.chat ? " (driven outside Studio)" : ""}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone, onClick }: { label: string; value: string; tone?: string; onClick?: () => void }) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className={cx("mt-0.5 truncate text-[14px] font-semibold", tone)}>{value}</div>
    </>
  );
  return onClick ? <button type="button" className="min-w-0 text-left hover:opacity-80" onClick={onClick}>{body}</button> : <div className="min-w-0">{body}</div>;
}

// ---------------------------------------------------------------- Requirements

const REQUIREMENT_KINDS: Array<[RegExp, string]> = [
  [/non[- ]?functional|\bnfr\b|quality attribute/i, "Non-functional"],
  [/functional/i, "Functional"],
  [/business|goal|objective|problem|vision|intent/i, "Business"],
  [/user stor|stories|persona/i, "User stories"],
  [/acceptance/i, "Acceptance criteria"],
  [/constraint/i, "Constraints"],
  [/assumption/i, "Assumptions"],
  [/question|open issue|unknown|tbd/i, "Open questions"],
  [/risk|raid/i, "Risks"],
  [/scope|out of scope/i, "Scope"],
  [/stakeholder/i, "Stakeholders"],
];

export const classifyRequirement = (heading: string): string | null => REQUIREMENT_KINDS.find(([re]) => re.test(heading))?.[1] ?? null;

function GateBanner({ category }: { category: ArtifactCategory[] }) {
  const gates = useStudio((s) => s.snapshot?.gates) ?? NO_GATES;
  const setView = useStudio((s) => s.setView);
  const relevant = gates.filter((g) => g.artifacts.some((a) => category.includes(a.category)));
  if (relevant.length === 0) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-wait/30 bg-wait/10 px-4 py-1.5 text-sm">
      <ShieldCheck size={14} className="text-wait" />
      <span className="min-w-0 flex-1 truncate">{relevant.map((g) => g.stageName).join(", ")} {relevant.length === 1 ? "is" : "are"} waiting for your approval.</span>
      <button type="button" className="btn btn-primary" onClick={() => setView("approvals")}>Review and decide</button>
    </div>
  );
}

export function RequirementsView() {
  const snapshot = useStudio((s) => s.snapshot);
  const blocked = NotReady();
  const artifacts = useMemo(() => (snapshot?.artifacts ?? []).filter((a) => a.category === "requirements" && !a.path.includes("/reviews/")), [snapshot?.artifacts]);
  if (!snapshot || blocked) return blocked;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Requirements" subtitle="Intent, scope, requirements and stories the workflow has written. Edits are saved to the artifact file." right={<Badge>{artifacts.length} documents</Badge>} />
      <GateBanner category={["requirements"]} />
      <div className="min-h-0 flex-1">
        <DocWorkspace
          artifacts={artifacts}
          groupBy={stageGroup}
          classify={classifyRequirement}
          preferred={/^requirements\.md$/}
          empty={<Empty title="No requirements yet" icon={<FileText size={22} />}>They appear here when the workflow runs its intent, scope and requirements stages.</Empty>}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Architecture

function DiagramStrip({ path }: { path: string }) {
  const { file } = useFile(path);
  const diagrams = useMemo(() => (file ? extractMermaid(file.content) : []), [file]);
  const [open, setOpen] = useState(true);
  if (diagrams.length === 0) return null;
  return (
    <div className="shrink-0 border-b border-line bg-bg-raised">
      <button type="button" className="flex w-full items-center gap-2 px-4 py-1 text-left text-xs text-ink-muted hover:text-ink" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={12} className={cx("transition-transform", open && "rotate-90")} />
        {diagrams.length} diagram{diagrams.length === 1 ? "" : "s"} in this document
      </button>
      {open ? (
        <div className="flex max-h-[42vh] gap-3 overflow-auto px-4 pb-3">
          {diagrams.map((code, i) => (
            <div key={i} className="min-w-[320px] flex-1"><Mermaid code={code} /></div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const ARCH_KINDS: Array<[RegExp, string]> = [
  [/decision|adr|rationale|trade-?off/i, "Decision record"],
  [/component|module|service|bounded context|domain/i, "Components"],
  [/data ?flow|sequence|interaction/i, "Data flow"],
  [/api|contract|endpoint|interface/i, "API"],
  [/data ?model|database|schema|entit|storage|persist/i, "Data design"],
  [/secur|threat|auth|compliance/i, "Security"],
  [/depend|integration|external/i, "Dependencies"],
  [/technolog|stack|framework|tooling/i, "Technology"],
  [/infrastructure|deploy|topolog|network/i, "Infrastructure"],
];

export function ArchitectureView() {
  const snapshot = useStudio((s) => s.snapshot);
  const blocked = NotReady();
  const artifacts = useMemo(() => (snapshot?.artifacts ?? []).filter((a) => (a.category === "architecture" || a.category === "design" || a.category === "security") && !a.path.includes("/reviews/")), [snapshot?.artifacts]);
  if (!snapshot || blocked) return blocked;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Architecture &amp; Design" subtitle="Components, contracts, decisions and infrastructure design. Mermaid diagrams in the documents are rendered." right={<Badge>{artifacts.length} documents</Badge>} />
      <GateBanner category={["architecture", "design", "security"]} />
      <div className="min-h-0 flex-1">
        <DocWorkspace
          artifacts={artifacts}
          groupBy={stageGroup}
          classify={(heading) => ARCH_KINDS.find(([re]) => re.test(heading))?.[1] ?? null}
          header={(path) => <DiagramStrip path={path} />}
          preferred={/^(architecture|components)\.md$/}
          empty={<Empty title="No architecture or design documents yet" icon={<FileText size={22} />}>They appear when the workflow runs its design stages (domain design, contract design, NFR and infrastructure design), or reverse engineering on existing code.</Empty>}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Artifacts

const CATEGORY_ORDER: ArtifactCategory[] = ["requirements", "architecture", "design", "implementation", "testing", "security", "deployment", "operations", "other"];

export function ArtifactsView() {
  const snapshot = useStudio((s) => s.snapshot);
  const blocked = NotReady();
  const [filter, setFilter] = useState<ArtifactCategory | "all">("all");
  const all = snapshot?.artifacts ?? [];
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of all) map.set(a.category, (map.get(a.category) ?? 0) + 1);
    return map;
  }, [all]);
  const shown = useMemo(() => [...all].filter((a) => filter === "all" || a.category === filter).sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.path.localeCompare(b.path)), [all, filter]);
  if (!snapshot || blocked) return blocked;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Artifacts" subtitle={snapshot.state ? `Everything the workflow wrote under ${snapshot.state.recordDir}` : "Generated documents, organised by kind"} />
      <div className="flex shrink-0 flex-wrap gap-1 border-b border-line px-4 py-1.5">
        <button type="button" className={cx("chip", filter === "all" && "border-accent text-accent-strong")} onClick={() => setFilter("all")}>All · {all.length}</button>
        {CATEGORY_ORDER.filter((c) => c !== "other" || counts.has("other")).map((category) => (
          <button key={category} type="button" disabled={!counts.has(category)} className={cx("chip disabled:opacity-40", filter === category && "border-accent text-accent-strong")} onClick={() => setFilter(category)}>
            {titleCase(category)} · {counts.get(category) ?? 0}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <DocWorkspace
          artifacts={shown}
          groupBy={(a) => (filter === "all" ? titleCase(a.category) : stageGroup(a))}
          empty={<Empty title={all.length === 0 ? "No artifacts yet" : "Nothing in this category"} icon={<FileText size={22} />}>{all.length === 0 ? "Artifacts appear as stages produce them." : "Pick another category."}</Empty>}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Testing

export function TestingView() {
  const snapshot = useStudio((s) => s.snapshot);
  const tests = useStudio((s) => s.tests);
  const runCommand = useStudio((s) => s.runCommand);
  const loadTests = useStudio((s) => s.loadTests);
  const openFile = useStudio((s) => s.openFile);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  useEffect(() => void loadTests(), [loadTests]);
  const reports = useMemo(() => (snapshot?.artifacts ?? []).filter((a) => a.category === "testing"), [snapshot?.artifacts]);
  const run = tests.runs.find((r) => r.id === selected) ?? tests.runs[0];
  const stageState = (slug: string): StageState | undefined => snapshot?.state?.stages.find((s) => s.slug === slug)?.state;
  const buildTest = stageState("build-and-test");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        title="Testing"
        subtitle="Test runs started from Studio or by the agent in chat, and the workflow's validation reports."
        right={
          <span className="flex items-center gap-1.5">
            {buildTest ? <Badge tone={buildTest === "completed" ? "ok" : buildTest === "in_progress" ? "info" : "muted"}>Build &amp; Test stage: {STAGE_STATE[buildTest].label}</Badge> : null}
            {tests.commands.map((command) => (
              <button key={command.id} type="button" className="btn" onClick={() => void runCommand(command.id)} title={command.display}>
                <Play size={12} /> {command.label}
              </button>
            ))}
          </span>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="w-72 shrink-0 overflow-y-auto border-r border-line bg-bg-raised py-1">
          <div className="label px-3 py-1">Test runs · {tests.runs.length}</div>
          {tests.runs.length === 0 ? (
            <div className="px-3 py-1 text-xs text-ink-faint">
              No test run recorded this session.
              {tests.commands.length === 0 ? " Studio found no test command in this project (package.json test script, pytest, cargo, go or dotnet)." : " Run one with the buttons above, or ask the agent to run the tests."}
            </div>
          ) : (
            tests.runs.map((r) => (
              <button key={r.id} type="button" onClick={() => (setSelected(r.id), setDoc(null))} className={cx("flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-bg-hover", !doc && run?.id === r.id && "bg-bg-active")}>
                {r.status === "running" ? <Spinner className="mt-0.5" /> : r.status === "passed" ? <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-ok" /> : <XCircle size={13} className="mt-0.5 shrink-0 text-bad" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-ink">{r.command}</span>
                  <span className="block text-2xs text-ink-faint">{r.source === "harness" ? "run by agent" : "run from Studio"} · {timeAgo(r.startedAt)}{r.summary ? ` · ${r.summary.passed ?? 0}✓ ${r.summary.failed ?? 0}✗` : ""}</span>
                </span>
              </button>
            ))
          )}
          <div className="label mt-2 px-3 py-1">Coverage</div>
          {tests.coverage ? (
            <div className="space-y-1 px-3 text-xs">
              {(["lines", "statements", "functions", "branches"] as const).map((key) => (typeof tests.coverage[key] === "number" ? <div key={key} className="flex justify-between"><span className="text-ink-muted">{titleCase(key)}</span><span className="tabular-nums">{tests.coverage[key]}%</span></div> : null))}
              <div className="text-2xs text-ink-ghost">from {tests.coverage.source}</div>
            </div>
          ) : (
            <div className="px-3 text-xs text-ink-faint">No coverage summary found (looked for coverage/coverage-summary.json).</div>
          )}
          <div className="label mt-2 px-3 py-1">Validation reports · {reports.length}</div>
          {reports.length === 0 ? <div className="px-3 text-xs text-ink-faint">The Build and Test stage has not written reports yet.</div> : null}
          {reports.map((a) => (
            <button key={a.path} type="button" onClick={() => setDoc(a.path)} title={a.path} className={cx("flex w-full items-center gap-2 px-3 py-1 text-left text-sm hover:bg-bg-hover", doc === a.path ? "bg-bg-active text-ink" : "text-ink-muted")}>
              <FileText size={12} className="shrink-0 text-ink-ghost" />
              <span className="truncate">{a.name}</span>
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          {doc ? (
            <DocViewer path={doc} />
          ) : !run ? (
            <Empty title="No test results yet" icon={<CheckCircle2 size={22} />}>Results appear here from real test runs only.</Empty>
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
                <Badge tone={run.status === "passed" ? "ok" : run.status === "running" ? "info" : "bad"}>{run.status}</Badge>
                {run.summary ? (
                  <>
                    <Badge tone="ok">{run.summary.passed ?? 0} passed</Badge>
                    <Badge tone={(run.summary.failed ?? 0) > 0 ? "bad" : "muted"}>{run.summary.failed ?? 0} failed</Badge>
                    {run.summary.skipped ? <Badge>{run.summary.skipped} skipped</Badge> : null}
                    <Badge>{run.summary.total ?? 0} total</Badge>
                  </>
                ) : run.status !== "running" ? (
                  <span className="text-xs text-ink-faint">No summary recognised in the output; status is from the exit code.</span>
                ) : null}
                {run.exitCode !== undefined ? <span className="text-xs text-ink-faint">exit {String(run.exitCode)}</span> : null}
                <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-ink-faint">{run.command}</span>
              </div>
              {run.failures.length > 0 ? (
                <div className="max-h-[38%] shrink-0 overflow-y-auto border-b border-line">
                  <div className="label px-4 py-1.5">Failures · {run.failures.length}</div>
                  {run.failures.map((failure, i) => (
                    <button key={`${failure.name}-${i}`} type="button" disabled={!failure.file} onClick={() => failure.file && void openFile(failure.file.replace(/\\/g, "/"), { line: failure.line })} className="flex w-full items-start gap-2 px-4 py-1 text-left hover:bg-bg-hover disabled:hover:bg-transparent">
                      <XCircle size={12} className="mt-0.5 shrink-0 text-bad" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{failure.name}</span>
                        {failure.message ? <span className="block truncate text-xs text-ink-faint">{failure.message}</span> : null}
                        {failure.file ? <span className="block truncate font-mono text-2xs text-accent-strong">{failure.file}{failure.line ? `:${failure.line}` : ""}</span> : null}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[11.5px] leading-[17px] text-ink-muted">{run.output || (run.status === "running" ? "Running…" : "(no output)")}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Operations

export function OperationsView() {
  const snapshot = useStudio((s) => s.snapshot);
  const project = useStudio((s) => s.project);
  const system = useStudio((s) => s.system);
  const git = useStudio((s) => s.git);
  const setView = useStudio((s) => s.setView);
  const setBottom = useStudio((s) => s.setBottom);
  const [doctor, setDoctor] = useState<{ loading: boolean; report: any; error: string | null }>({ loading: false, report: null, error: null });
  const [doc, setDoc] = useState<string | null>(null);
  const blocked = NotReady();
  if (!snapshot || blocked) return blocked;
  const stages = stagesOf(snapshot);
  const opsSlugs = stages.filter((s) => s.phase === "operation" || s.slug === "ci-pipeline" || s.slug === "build-and-test").map((s) => s.slug);
  const progress = new Map((snapshot.state?.stages ?? []).map((s) => [s.slug, s]));
  const artifacts = snapshot.artifacts.filter((a) => a.category === "deployment" || a.category === "operations");
  const deployLogs = snapshot.audit.filter((e) => e.fields["Stage"] && opsSlugs.includes(e.fields["Stage"])).slice(-40);
  const runDoctor = async (): Promise<void> => {
    if (!project) return;
    setDoctor({ loading: true, report: null, error: null });
    try {
      const data = await P(project.id).doctor();
      setDoctor({ loading: false, report: data.report, error: data.report ? null : (data.raw ?? "Doctor returned no report.") });
    } catch (e) {
      setDoctor({ loading: false, report: null, error: (e as Error).message });
    }
  };
  const checks: Array<{ pass: boolean; label: string; fix?: string }> = doctor.report?.data?.checks ?? [];
  const failing = checks.filter((c) => !c.pass);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Deployment &amp; Operations" subtitle="Build, deployment and operation stages, environment diagnostics and the documents those stages wrote." right={<button type="button" className="btn" onClick={() => void runDoctor()} disabled={doctor.loading}>{doctor.loading ? <Spinner /> : <Stethoscope size={12} />} Run diagnostics</button>} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="card p-3">
            <SectionTitle>Deployment readiness (workflow stages)</SectionTitle>
            {!snapshot.state ? (
              <div className="text-sm text-ink-faint">No workflow is active.</div>
            ) : (
              <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
                {opsSlugs.map((slug) => {
                  const state = progress.get(slug)?.state ?? "not_in_plan";
                  const stage = stages.find((s) => s.slug === slug);
                  return (
                    <button key={slug} type="button" onClick={() => setView(`stage:${slug}`)} className="flex items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-bg-hover">
                      <StateDot state={state} />
                      <span className={cx("min-w-0 flex-1 truncate", state === "not_in_plan" && "text-ink-ghost")}>{stage?.name ?? slug}</span>
                      <span className={cx("text-2xs", STAGE_STATE[state].color)}>{STAGE_STATE[state].label}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {snapshot.state && opsSlugs.every((slug) => (progress.get(slug)?.state ?? "not_in_plan") === "not_in_plan" || !stages.find((s) => s.slug === slug && s.phase === "operation")) && !snapshot.state.stages.some((s) => s.phase === "operation" && s.plan === "EXECUTE") ? (
              <div className="mt-2 text-xs text-ink-faint">This workflow's plan ({snapshot.state.scope}) does not include the Operation phase, so no deployment is tracked.</div>
            ) : null}
          </div>

          <div className="card p-3">
            <SectionTitle>Environment and configuration</SectionTitle>
            <div className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm md:grid-cols-2">
              {Object.entries(system?.tools ?? {}).map(([name, tool]) => (
                <div key={name} className="flex items-center gap-2">
                  {tool.ok ? <CheckCircle2 size={12} className="shrink-0 text-ok" /> : <AlertTriangle size={12} className="shrink-0 text-warn" />}
                  <span className="w-14 shrink-0 font-mono text-xs">{name}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-faint" title={tool.error ?? tool.path}>{tool.ok ? tool.version : tool.error}</span>
                </div>
              ))}
              <div className="flex items-center gap-2">
                {git?.isRepo ? <CheckCircle2 size={12} className="shrink-0 text-ok" /> : <AlertTriangle size={12} className="shrink-0 text-warn" />}
                <span className="w-14 shrink-0 font-mono text-xs">repo</span>
                <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">{git?.isRepo ? `branch ${git.branch ?? "?"} · ${git.files.length} changed` : (git?.note ?? "…")}</span>
              </div>
            </div>
            {doctor.error ? <div className="mt-2 text-xs text-bad">{doctor.error}</div> : null}
            {doctor.report ? (
              <div className="mt-3 border-t border-line pt-2">
                <div className="mb-1 flex items-center gap-2 text-sm">
                  <Badge tone={doctor.report.status === "ok" ? "ok" : failing.length ? "bad" : "warn"}>{doctor.report.status}</Badge>
                  <span className="text-ink-muted">{doctor.report.message}</span>
                </div>
                {failing.map((check, i) => (
                  <div key={i} className="mb-1 rounded border border-bad/30 bg-bad/5 px-2 py-1 text-xs">
                    <div className="text-bad">{check.label}</div>
                    {check.fix ? <div className="text-ink-faint">Fix: {check.fix}</div> : null}
                  </div>
                ))}
                <details className="text-xs text-ink-faint">
                  <summary className="cursor-pointer hover:text-ink">All {checks.length} checks</summary>
                  <div className="mt-1 space-y-0.5">
                    {checks.map((check, i) => (
                      <div key={i} className="flex items-start gap-1.5">
                        {check.pass ? <CheckCircle2 size={11} className="mt-0.5 shrink-0 text-ok" /> : <XCircle size={11} className="mt-0.5 shrink-0 text-bad" />}
                        <span className="break-words">{check.label}</span>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            ) : null}
          </div>

          <div className="card p-3">
            <SectionTitle right={<button type="button" className="btn btn-ghost" onClick={() => setBottom(true, "logs")}>All logs <ChevronRight size={12} /></button>}>Build and deployment events (audit trail)</SectionTitle>
            {deployLogs.length === 0 ? (
              <div className="text-sm text-ink-faint">The engine has recorded no build or deployment stage events.</div>
            ) : (
              deployLogs.reverse().map((event, i) => (
                <div key={i} className="flex items-baseline gap-2 text-xs">
                  <span className="w-14 shrink-0 font-mono text-2xs text-ink-ghost">{clock(event.timestamp)}</span>
                  <span className={cx("w-44 shrink-0 truncate font-mono text-2xs", eventTone(event.event))}>{event.event}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-muted">{auditLine(event)}</span>
                </div>
              ))
            )}
          </div>

          <div className="card p-3">
            <SectionTitle>Runtime health and monitoring</SectionTitle>
            <div className="text-sm text-ink-faint">
              The AI-DLC runtime does not report live service health or monitoring data. What it produces are the observability, incident-response and performance documents below, when those stages run.
            </div>
          </div>
        </div>
        <div className="flex w-[42%] min-w-[280px] shrink-0 flex-col border-l border-line">
          <div className="max-h-[40%] shrink-0 overflow-y-auto border-b border-line bg-bg-raised py-1">
            <div className="label px-3 py-1">Deployment and operations documents · {artifacts.length}</div>
            {artifacts.length === 0 ? <div className="px-3 pb-1 text-xs text-ink-faint">None yet.</div> : null}
            {artifacts.map((a) => (
              <button key={a.path} type="button" onClick={() => setDoc(a.path)} title={a.path} className={cx("flex w-full items-center gap-2 px-3 py-1 text-left text-sm hover:bg-bg-hover", doc === a.path ? "bg-bg-active text-ink" : "text-ink-muted")}>
                <FileText size={12} className="shrink-0 text-ink-ghost" />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="text-2xs text-ink-ghost">{a.stage ? titleCase(a.stage) : ""}</span>
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">{doc ? <DocViewer path={doc} /> : <Empty title="Select a document to preview" />}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Stage detail

export function StageView({ slug }: { slug: string }) {
  const snapshot = useStudio((s) => s.snapshot);
  const setView = useStudio((s) => s.setView);
  const [doc, setDoc] = useState<string | null>(null);
  useEffect(() => setDoc(null), [slug]);
  if (!snapshot) return <div className="p-6"><Spinner /></div>;
  const stage = stagesOf(snapshot).find((s) => s.slug === slug);
  if (!stage) return <Empty title="Unknown stage">The engine's stage graph has no stage named “{slug}”.</Empty>;
  const progress = snapshot.state?.stages.find((s) => s.slug === slug);
  const state: StageState = snapshot.state ? (progress?.state ?? "not_in_plan") : "pending";
  const artifacts = snapshot.artifacts.filter((a) => a.stage === slug);
  const events = snapshot.audit.filter((e) => e.fields["Stage"] === slug);
  const agentName = (id: string): string => snapshot.lifecycle?.agents.find((a) => a.slug === id)?.display_name ?? (id === "orchestrator" ? "Conductor" : id);
  const activity = snapshot.agents.filter((a) => a.stage === slug);
  const gate = snapshot.gates.find((g) => g.stage === slug);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader
        title={`${stage.number} ${stage.name}`}
        subtitle={`${titleCase(stage.phase)} phase · ${stage.execution.toLowerCase()} · runs ${stage.mode}`}
        right={<span className="flex items-center gap-2"><StateDot state={state} /><span className={cx("text-sm font-medium", STAGE_STATE[state].color)}>{snapshot.state ? STAGE_STATE[state].label : "No workflow"}</span></span>}
      />
      {gate ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-wait/30 bg-wait/10 px-4 py-1.5 text-sm">
          <ShieldCheck size={14} className="text-wait" />
          <span className="flex-1">This stage is waiting for your approval.</span>
          <button type="button" className="btn btn-primary" onClick={() => setView("approvals")}>Review and decide</button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="w-[46%] min-w-[300px] shrink-0 space-y-3 overflow-y-auto border-r border-line p-4">
          {stage.condition ? <p className="text-sm text-ink-muted">{stage.condition}</p> : null}
          <div>
            <SectionTitle>Agents</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone="info" title="Lead agent">{agentName(stage.lead_agent)} · lead</Badge>
              {stage.support_agents.map((a) => <Badge key={a}>{agentName(a)}</Badge>)}
            </div>
            {activity.length > 0 ? (
              <div className="mt-2 space-y-0.5">
                {activity.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 text-xs">
                    <span className={cx("h-1.5 w-1.5 rounded-full", a.status === "active" ? "pulse bg-info" : a.status === "completed" ? "bg-ok" : a.status === "failed" ? "bg-bad" : "bg-ink-ghost")} />
                    <span className="truncate">{a.displayName}</span>
                    <span className="text-ink-faint">{a.status}{a.startedAt ? ` · started ${clock(a.startedAt)}` : ""}{a.completedAt ? ` · ended ${clock(a.completedAt)}` : ""}</span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <SectionTitle>Consumes</SectionTitle>
              {stage.consumes.length === 0 ? <div className="text-xs text-ink-faint">Nothing</div> : stage.consumes.map((c) => <div key={c.artifact} className="font-mono text-xs text-ink-muted">{c.artifact}{c.required ? "" : " (optional)"}</div>)}
            </div>
            <div>
              <SectionTitle>Produces</SectionTitle>
              {stage.produces.length === 0 ? <div className="text-xs text-ink-faint">State and audit only</div> : stage.produces.map((p) => <div key={p} className="font-mono text-xs text-ink-muted">{p}</div>)}
            </div>
          </div>
          {stage.sensors.length > 0 ? (
            <div>
              <SectionTitle>Sensors (deterministic checks)</SectionTitle>
              <div className="flex flex-wrap gap-1.5">{stage.sensors.map((s) => <Badge key={s}>{s}</Badge>)}</div>
            </div>
          ) : null}
          <div>
            <SectionTitle>Artifacts written · {artifacts.length}</SectionTitle>
            {artifacts.length === 0 ? <div className="text-xs text-ink-faint">None on disk for this stage.</div> : null}
            {artifacts.map((a) => (
              <button key={a.path} type="button" onClick={() => setDoc(a.path)} title={a.path} className={cx("flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-bg-hover", doc === a.path ? "bg-bg-active" : "text-ink-muted")}>
                <FileText size={12} className="shrink-0 text-ink-ghost" />
                <span className="min-w-0 flex-1 truncate">{a.path.includes("/reviews/") ? `reviews/${a.name}` : a.name}</span>
                <span className="text-2xs text-ink-ghost">{timeAgo(a.mtime)}</span>
              </button>
            ))}
          </div>
          <div>
            <SectionTitle>Audit trail for this stage · {events.length}</SectionTitle>
            {events.length === 0 ? <div className="text-xs text-ink-faint">No events recorded.</div> : null}
            {events.slice(-60).map((event, i) => (
              <div key={i} className="flex items-baseline gap-2 text-xs">
                <span className="w-14 shrink-0 font-mono text-2xs text-ink-ghost">{clock(event.timestamp)}</span>
                <span className={cx("shrink-0 font-mono text-2xs", eventTone(event.event))}>{event.event}</span>
                <span className="min-w-0 flex-1 truncate text-ink-faint">{event.fields["Details"] ?? event.fields["File"] ?? event.fields["Person Reply"] ?? ""}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-1">{doc ? <DocViewer path={doc} /> : <Empty title={artifacts.length ? "Select an artifact to preview" : "Nothing to preview yet"} icon={<FileText size={22} />} />}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Approvals

const DECISION_EVENTS = new Set(["STAGE_AWAITING_APPROVAL", "GATE_APPROVED", "GATE_REJECTED", "STAGE_REVISING", "DECISION_RECORDED", "QUESTION_ANSWERED", "PLAN_APPROVAL_RECORDED", "SUMMARY_CONFIRMATION_RECORDED", "CHANGE_ACCEPTED", "STAGE_SKIPPED", "STAGE_JUMPED"]);

function GateCard({ gate, selectedDoc, onDoc }: { gate: ApprovalGate; selectedDoc: string | null; onDoc: (path: string) => void }) {
  const chatEvents = useStudio((s) => s.chatEvents);
  const conversations = useStudio((s) => s.conversations);
  const chatStatus = useStudio((s) => s.chatStatus);
  const decideGate = useStudio((s) => s.decideGate);
  const sendChat = useStudio((s) => s.sendChat);
  const agents = useStudio((s) => s.snapshot?.lifecycle?.agents) ?? NO_AGENTS;
  const allArtifacts = useStudio((s) => s.snapshot?.artifacts) ?? NO_ARTIFACTS;
  const reviews = useMemo(() => allArtifacts.filter((a) => a.stage === gate.stage && a.path.includes("/reviews/")), [allArtifacts, gate.stage]);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = pendingRequests(chatEvents).questions;
  const hasSession = conversations.some((c) => c.harnessSessionId);
  const working = chatStatus === "running" || chatStatus === "starting";
  const act = async (decision: "approve" | "reject"): Promise<void> => {
    setBusy(true);
    await decideGate(gate.stage, decision, comment);
    setBusy(false);
    setComment("");
  };
  return (
    <div className="card border-wait/40">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <ShieldCheck size={15} className="text-wait" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{gate.stageName}</div>
          <div className="text-xs text-ink-faint">
            {gate.state === "revising" ? "Being revised after a change request" : "Awaiting your approval"}
            {gate.since ? ` · since ${clock(gate.since)} (${timeAgo(gate.since)})` : ""}
            {gate.leadAgent ? ` · led by ${agents.find((a) => a.slug === gate.leadAgent)?.display_name ?? gate.leadAgent}` : ""}
          </div>
        </div>
      </div>
      <div className="space-y-3 p-3">
        <div>
          <SectionTitle>Generated artifacts to review · {gate.artifacts.length}</SectionTitle>
          {gate.artifacts.length === 0 ? <div className="text-xs text-ink-faint">This stage wrote no document under its record folder.</div> : null}
          {[...gate.artifacts, ...reviews].map((a) => (
            <button key={a.path} type="button" onClick={() => onDoc(a.path)} title={a.path} className={cx("flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-bg-hover", selectedDoc === a.path ? "bg-bg-active" : "text-ink-muted")}>
              <FileText size={12} className="shrink-0 text-ink-ghost" />
              <span className="min-w-0 flex-1 truncate">{a.path.includes("/reviews/") ? `Reviewer verdict: ${a.name}` : a.name}</span>
            </button>
          ))}
        </div>
        {pending.length > 0 ? (
          <div className="space-y-2">
            <div className="text-xs text-ink-faint">The workflow is asking this now. Your choice is sent to it exactly as shown.</div>
            {pending.map((q) => <QuestionCard key={q.id} event={q} stage={gate.stage} />)}
          </div>
        ) : gate.state === "revising" ? (
          <div className="text-sm text-ink-muted">The stage is being revised. It will ask for approval again when the revision is ready.</div>
        ) : working ? (
          <div className="flex items-center gap-2 text-sm text-ink-muted"><Spinner /> The agent is working. The gate can be decided when it stops.</div>
        ) : hasSession ? (
          <div>
            <textarea className="input min-h-[60px] resize-y" placeholder="Comments or requested changes (required to request changes)" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Approval comment" />
            <div className="mt-2 flex items-center gap-2">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act("approve")}>
                <CheckCircle2 size={12} /> Approve
              </button>
              <button type="button" className="btn btn-danger" disabled={busy || !comment.trim()} onClick={() => void act("reject")}>
                <XCircle size={12} /> Request changes
              </button>
            </div>
            <div className="mt-1.5 text-2xs text-ink-faint">Your decision is sent as your own reply in the workflow's harness session; the engine records it in its audit trail.</div>
          </div>
        ) : (
          <div>
            <div className="text-sm text-ink-muted">No harness session holds this workflow right now (Studio was restarted, or the work was run elsewhere). Resume it so the workflow presents the gate again, then decide.</div>
            <button type="button" className="btn btn-primary mt-2" onClick={() => void sendChat("/aidlc --resume").catch(() => undefined)}>
              <Play size={12} /> Resume workflow
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ApprovalsView() {
  const snapshot = useStudio((s) => s.snapshot);
  const studioAudit = useStudio((s) => s.studioAudit);
  const loadAudit = useStudio((s) => s.loadAudit);
  const chatEvents = useStudio((s) => s.chatEvents);
  const [doc, setDoc] = useState<string | null>(null);
  useEffect(() => void loadAudit(), [loadAudit, snapshot?.audit.length]);
  const blocked = NotReady();
  if (!snapshot || blocked) return blocked;
  const pending = pendingRequests(chatEvents).questions;
  const engineTrail = snapshot.audit.filter((e) => DECISION_EVENTS.has(e.event));
  const studioTrail = studioAudit.filter((e) => ["approval.decide", "chat.answer", "permission.decide"].includes(e.action));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewHeader title="Approvals" subtitle="Human approval gates. Nothing advances past a gate without your decision." right={<Badge tone={snapshot.gates.length ? "wait" : "muted"}>{snapshot.gates.length} open</Badge>} />
      <div className="flex min-h-0 flex-1">
        <div className="w-[46%] min-w-[320px] shrink-0 space-y-3 overflow-y-auto border-r border-line p-4">
          {snapshot.gates.length === 0 ? (
            <div className="card p-3 text-sm text-ink-faint">
              No stage is waiting for approval according to the engine's state.
              {pending.length > 0 ? " The workflow is asking a question, shown below." : ""}
            </div>
          ) : (
            snapshot.gates.map((gate) => <GateCard key={gate.stage} gate={gate} selectedDoc={doc} onDoc={setDoc} />)
          )}
          {snapshot.gates.length === 0 && pending.map((q) => <QuestionCard key={q.id} event={q} />)}

          <div className="card p-3">
            <SectionTitle>Decision audit trail (engine record)</SectionTitle>
            {engineTrail.length === 0 ? <div className="text-xs text-ink-faint">No gate or decision recorded yet.</div> : null}
            {[...engineTrail].reverse().slice(0, 80).map((event, i) => (
              <div key={i} className="border-b border-line/60 py-1 text-xs last:border-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-2xs text-ink-ghost">{clock(event.timestamp)}</span>
                  <span className={cx("font-mono text-2xs", eventTone(event.event))}>{event.event}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-muted">{event.fields["Stage"] ?? ""}</span>
                  {event.fields["Git Name"] ? <span className="text-2xs text-ink-faint">by {event.fields["Git Name"]}</span> : null}
                </div>
                {event.fields["Person Reply"] || event.fields["Details"] ? <div className="mt-0.5 break-words pl-[58px] text-ink-faint">{event.fields["Person Reply"] ?? event.fields["Details"]}</div> : null}
              </div>
            ))}
          </div>

          <div className="card p-3">
            <SectionTitle>Actions taken through Studio</SectionTitle>
            {studioTrail.length === 0 ? <div className="text-xs text-ink-faint">No approval, answer or permission decision made from Studio yet.</div> : null}
            {studioTrail.slice(0, 80).map((entry, i) => (
              <div key={i} className="flex items-baseline gap-2 py-0.5 text-xs">
                <span className="font-mono text-2xs text-ink-ghost">{clock(entry.ts)}</span>
                <span className="font-mono text-2xs text-accent-strong">{entry.action}</span>
                <span className="min-w-0 flex-1 truncate text-ink-muted">
                  {entry.action === "approval.decide" ? `${String(entry.detail.decision)} ${String(entry.detail.stageName ?? entry.detail.stage)}${entry.detail.comment ? ` — ${String(entry.detail.comment)}` : ""}` : entry.action === "permission.decide" ? `${String(entry.detail.decision)} ${String(entry.detail.tool)}` : String(entry.detail.answers ?? "answered in chat instead")}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-0 flex-1">{doc ? <DocViewer path={doc} /> : <Empty title="Select an artifact to review it here" icon={<FileText size={22} />} />}</div>
      </div>
    </div>
  );
}

export function RefreshHint() {
  const refresh = useStudio((s) => s.refreshSnapshot);
  return (
    <button type="button" className="icon-btn" onClick={() => void refresh()} title="Re-read engine state" aria-label="Refresh">
      <RefreshCw size={12} />
    </button>
  );
}
