// Adapter around the AI-DLC engine installed in a project. It runs the
// engine's own commands (through Bun for a source-shaped install, or the
// native `aidlc` binary) and reads the records the engine persists under
// aidlc/. It never writes workflow state: the engine and its hooks own that.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type {
  AgentActivity,
  ApprovalGate,
  ArtifactCategory,
  ArtifactFile,
  AuditEvent,
  GraphStage,
  InstallInfo,
  IntentRow,
  Lifecycle,
  Snapshot,
  WorkflowState,
} from "../../../shared/types.ts";
import { cleanEnv, run, which, type RunOptions, type RunResult } from "../proc.ts";
import { parseStateFile } from "./stateFile.ts";

const HARNESS_DIRS = [".claude", ".kiro", ".codex", ".cursor", ".aidlc"] as const;

const STAGE_CATEGORY: Record<string, ArtifactCategory> = {
  "intent-capture": "requirements",
  "market-research": "requirements",
  feasibility: "requirements",
  "scope-definition": "requirements",
  "team-formation": "requirements",
  "approval-handoff": "requirements",
  "practices-discovery": "requirements",
  "requirements-analysis": "requirements",
  "user-stories": "requirements",
  "nfr-requirements": "requirements",
  "rough-mockups": "design",
  "refined-mockups": "design",
  "functional-design": "design",
  "units-generation": "design",
  "delivery-planning": "design",
  "domain-design": "architecture",
  "contract-design": "architecture",
  "nfr-design": "architecture",
  "infrastructure-design": "architecture",
  "reverse-engineering": "architecture",
  "code-generation": "implementation",
  "build-and-test": "testing",
  "performance-validation": "testing",
  "ci-pipeline": "deployment",
  "deployment-pipeline": "deployment",
  "environment-provisioning": "deployment",
  "deployment-execution": "deployment",
  "observability-setup": "operations",
  "incident-response": "operations",
  "feedback-optimization": "operations",
};

export function categorize(stage: string | undefined, fileName: string, phase: string): ArtifactCategory {
  if (/secur|threat|compliance|vulnerab/i.test(fileName)) return "security";
  if (stage && STAGE_CATEGORY[stage]) return STAGE_CATEGORY[stage];
  if (phase === "verification") return "testing";
  if (phase === "codekb") return "architecture";
  return "other";
}

interface EngineCommand {
  kind: "bun" | "native";
  command: string;
  prefix: string[];
  display: string;
}

let nativeProbe: { ok: boolean; error?: string } | null = null;

/** Can the native `aidlc` launcher actually start on this machine? */
export async function probeNativeAidlc(): Promise<{ ok: boolean; path?: string; version?: string; error?: string }> {
  const file = which("aidlc");
  if (!file) {
    nativeProbe = { ok: false, error: "not installed" };
    return { ok: false, error: "aidlc is not on PATH" };
  }
  const result = await run(file, ["version"], { cwd: process.cwd(), env: cleanEnv({ NO_COLOR: "1" }), timeoutMs: 15000 });
  if (result.code === 0) {
    nativeProbe = { ok: true };
    return { ok: true, path: file, version: result.stdout.trim().split(/\r?\n/)[0] };
  }
  const error = (result.error || result.stderr || `exit ${result.code}`).trim().split(/\r?\n/)[0];
  nativeProbe = { ok: false, error };
  return { ok: false, path: file, error };
}

export function nativeAidlcUsable(): boolean {
  return nativeProbe?.ok === true;
}

export class Engine {
  readonly projectDir: string;
  private graphCache: { key: string; value: Lifecycle } | null = null;
  private intentCache: { key: string; space: string | null; intents: IntentRow[] } | null = null;
  private auditCache: { key: string; value: AuditEvent[] } | null = null;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  // ----- install detection -----

  install(): InstallInfo {
    const harnesses: InstallInfo["harnesses"] = [];
    const problems: string[] = [];
    for (const dir of HARNESS_DIRS) {
      const root = path.join(this.projectDir, dir);
      if (!existsSync(root)) continue;
      const bunTool = path.join(root, "tools", "aidlc.ts");
      const marker = existsSync(path.join(root, "aidlc-common")) || existsSync(path.join(root, "skills", "aidlc"));
      if (!existsSync(bunTool) && !marker) continue;
      harnesses.push({ id: this.harnessIdFor(dir), dir, shape: this.shapeOf(root, existsSync(bunTool)) });
    }
    const command = this.command(harnesses);
    if (harnesses.length > 0 && !command) {
      const needsBun = harnesses.some((h) => h.shape === "bun");
      problems.push(
        needsBun
          ? "AI-DLC is set up here, but `bun` was not found on PATH, so its engine cannot run."
          : "AI-DLC is set up here for the native `aidlc` command, which cannot run on this machine, and Bun is not installed either.",
      );
    } else if (command?.kind === "bun" && harnesses[0]?.shape === "native") {
      problems.push(
        "This project's hooks call the native `aidlc` command, which is not running on this machine right now. Studio can read the workflow through Bun, but the harness's hooks will fail until `aidlc` runs (see `aidlc doctor`).",
      );
    }
    return {
      installed: harnesses.length > 0,
      harnesses,
      engine: command ? { kind: command.kind, display: command.display } : null,
      problems,
    };
  }

  /**
   * A native install's hooks call `aidlc engine hook ...`; a source-shaped one
   * calls `bun .../tools/aidlc.ts`. Both ship the tools folder, so the hook
   * registration is what tells them apart.
   */
  private shapeOf(root: string, hasBunTool: boolean): "bun" | "native" {
    for (const file of ["settings.json", "hooks.json", path.join("hooks", "hooks.json")]) {
      try {
        const text = readFileSync(path.join(root, file), "utf8");
        if (/"(?:command|bash|powershell)":\s*"aidlc(?:\.exe)? /.test(text)) return "native";
        if (/tools\/aidlc\.ts/.test(text)) return "bun";
      } catch {
        // not this harness's registration file
      }
    }
    return hasBunTool ? "bun" : "native";
  }

  private harnessIdFor(dir: string): string {
    switch (dir) {
      case ".claude":
        return "claude";
      case ".kiro":
        return "kiro";
      case ".codex":
        return "codex";
      case ".cursor":
        return "cursor";
      default:
        return existsSync(path.join(this.projectDir, ".opencode")) ? "opencode" : "copilot";
    }
  }

  private command(harnesses: InstallInfo["harnesses"]): EngineCommand | null {
    const first = harnesses[0];
    if (!first) return null;
    const bunTool = `${first.dir}/tools/aidlc.ts`;
    const viaBun = (): EngineCommand | null => {
      const bun = which("bun");
      if (!bun || !existsSync(path.join(this.projectDir, bunTool))) return null;
      return { kind: "bun", command: bun, prefix: [bunTool], display: `bun ${bunTool}` };
    };
    if (first.shape === "native") {
      const aidlc = nativeAidlcUsable() ? which("aidlc") : null;
      if (aidlc) return { kind: "native", command: aidlc, prefix: [], display: "aidlc" };
      // The same engine source ships in the project; Bun can run it for Studio's reads.
      return viaBun();
    }
    return viaBun();
  }

  engineDisplay(): string | null {
    return this.install().engine?.display ?? null;
  }

  /** Run one engine command with structured arguments. */
  async exec(args: string[], options: Partial<RunOptions> = {}): Promise<RunResult> {
    const command = this.command(this.install().harnesses);
    if (!command) return { code: null, stdout: "", stderr: "", timedOut: false, error: "The AI-DLC engine is not runnable in this project." };
    return run(command.command, [...command.prefix, ...args], {
      cwd: this.projectDir,
      env: cleanEnv({ NO_COLOR: "1", FORCE_COLOR: undefined }),
      timeoutMs: 120000,
      ...options,
    });
  }

  /** The exact argv Studio would run for an engine command (for the command runner). */
  argv(args: string[]): { command: string; args: string[]; display: string } | null {
    const command = this.command(this.install().harnesses);
    if (!command) return null;
    return { command: command.command, args: [...command.prefix, ...args], display: `${command.display} ${args.join(" ")}` };
  }

  private async json<T>(args: string[]): Promise<T> {
    const result = await this.exec(args);
    if (result.code !== 0) {
      throw new Error((result.error || result.stderr || result.stdout || `engine exited ${result.code}`).trim().slice(0, 600));
    }
    return JSON.parse(result.stdout) as T;
  }

  // ----- lifecycle graph -----

  async lifecycle(): Promise<Lifecycle> {
    const install = this.install();
    const first = install.harnesses[0];
    const stamp = first ? this.mtimeKey([path.join(this.projectDir, first.dir, "tools", "data"), path.join(this.projectDir, first.dir, "aidlc-common", "stages")]) : "";
    const key = `${first?.dir ?? ""}:${stamp}`;
    if (this.graphCache?.key === key) return this.graphCache.value;
    const raw = await this.json<{
      stages: GraphStage[];
      agents: Array<{ slug: string; display_name: string }>;
      scopes: Lifecycle["scopes"];
      artifacts: string[];
    }>(["engine", "graph", "export"]);
    const phases: Lifecycle["phases"] = [];
    for (const stage of raw.stages) {
      let phase = phases.find((p) => p.id === stage.phase);
      if (!phase) {
        phase = { id: stage.phase, stages: [] };
        phases.push(phase);
      }
      const consumes = Array.isArray(stage.consumes) ? stage.consumes : stage.consumes ? [stage.consumes] : [];
      phase.stages.push({
        slug: stage.slug,
        number: stage.number,
        name: stage.name,
        phase: stage.phase,
        execution: stage.execution,
        condition: stage.condition,
        lead_agent: stage.lead_agent,
        support_agents: stage.support_agents ?? [],
        mode: stage.mode,
        produces: stage.produces ?? [],
        consumes,
        sensors: stage.sensors ?? [],
        inputs: stage.inputs,
        outputs: stage.outputs,
      });
    }
    const value: Lifecycle = {
      phases,
      agents: (raw.agents ?? []).map((a) => ({ slug: a.slug, display_name: a.display_name })),
      scopes: raw.scopes ?? {},
      artifacts: raw.artifacts ?? [],
    };
    this.graphCache = { key, value };
    return value;
  }

  private mtimeKey(paths: string[]): string {
    return paths
      .map((p) => {
        try {
          const stat = statSync(p);
          return `${stat.mtimeMs}:${stat.size}`;
        } catch {
          return "-";
        }
      })
      .join("|");
  }

  // ----- intents -----

  private aidlcDir(): string {
    return path.join(this.projectDir, "aidlc");
  }

  async intents(): Promise<{ space: string | null; intents: IntentRow[] }> {
    const spacesDir = path.join(this.aidlcDir(), "spaces");
    const cursors = [path.join(this.aidlcDir(), "active-space")];
    try {
      for (const space of readdirSync(spacesDir)) {
        cursors.push(path.join(spacesDir, space, "intents", "intents.json"), path.join(spacesDir, space, "intents", "active-intent"));
      }
    } catch {
      // no spaces yet
    }
    const key = this.mtimeKey(cursors);
    if (this.intentCache?.key === key) return { space: this.intentCache.space, intents: this.intentCache.intents };
    const raw = await this.json<{ active: string | null; space: string; intents: IntentRow[] }>(["engine", "intent", "list", "--json", "--all"]);
    const intents = (raw.intents ?? []).map((i) => ({ uuid: i.uuid, slug: i.slug, status: i.status, dirName: i.dirName, active: i.active === true }));
    this.intentCache = { key, space: raw.space ?? null, intents };
    return { space: raw.space ?? null, intents };
  }

  recordDir(space: string, dirName: string): string {
    return path.join(this.aidlcDir(), "spaces", space, "intents", dirName);
  }

  state(space: string, dirName: string): WorkflowState | null {
    const record = this.recordDir(space, dirName);
    const file = path.join(record, "aidlc-state.md");
    if (!existsSync(file)) return null;
    const rel = path.relative(this.projectDir, record).replace(/\\/g, "/");
    return parseStateFile(readFileSync(file, "utf8"), rel);
  }

  // ----- audit trail -----

  async audit(space: string, dirName: string): Promise<AuditEvent[]> {
    const auditDir = path.join(this.recordDir(space, dirName), "audit");
    let shards: string[] = [];
    try {
      shards = readdirSync(auditDir).filter((f) => f.endsWith(".md")).map((f) => path.join(auditDir, f));
    } catch {
      return [];
    }
    const key = `${dirName}:${this.mtimeKey(shards)}`;
    if (this.auditCache?.key === key) return this.auditCache.value;
    const raw = await this.json<{ events: Array<{ timestamp?: string; event?: string; fields?: Record<string, string>; heading?: string; body?: string }> }>([
      "engine",
      "audit",
      "history",
    ]);
    const value: AuditEvent[] = (raw.events ?? []).map((e) => ({
      timestamp: e.timestamp ?? "",
      event: e.event ?? "NOTE",
      fields: e.fields ?? {},
      heading: e.heading,
      body: e.body,
    }));
    this.auditCache = { key, value };
    return value;
  }

  // ----- artifacts -----

  artifacts(space: string, dirName: string): ArtifactFile[] {
    const record = this.recordDir(space, dirName);
    const out: ArtifactFile[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 6) return;
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") || entry.name === "audit") continue;
          walk(abs, depth + 1);
        } else if (entry.isFile()) {
          const relToRecord = path.relative(record, abs).replace(/\\/g, "/");
          const parts = relToRecord.split("/");
          if (parts.length === 1) continue; // state file, description, runtime graph
          if (entry.name === "memory.md" || entry.name.endsWith(".tsv")) continue;
          const phase = parts[0];
          const stage = this.stageFromParts(parts);
          let stat: import("node:fs").Stats;
          try {
            stat = statSync(abs);
          } catch {
            continue;
          }
          out.push({
            path: path.relative(this.projectDir, abs).replace(/\\/g, "/"),
            name: entry.name,
            phase,
            stage,
            category: categorize(stage, entry.name, phase),
            size: stat.size,
            mtime: stat.mtimeMs,
          });
        }
      }
    };
    walk(record, 0);
    // Reverse-engineering deliverables live in the space-level code knowledge base.
    const codekb = path.join(this.aidlcDir(), "spaces", space, "codekb");
    const walkKb = (dir: string, depth: number): void => {
      if (depth > 3) return;
      let entries: import("node:fs").Dirent[] = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".")) walkKb(abs, depth + 1);
        } else if (entry.isFile() && /\.(md|json|ya?ml)$/i.test(entry.name)) {
          const stat = statSync(abs);
          out.push({
            path: path.relative(this.projectDir, abs).replace(/\\/g, "/"),
            name: entry.name,
            phase: "codekb",
            stage: "reverse-engineering",
            category: categorize("reverse-engineering", entry.name, "codekb"),
            size: stat.size,
            mtime: stat.mtimeMs,
          });
        }
      }
    };
    walkKb(codekb, 0);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private stageFromParts(parts: string[]): string | undefined {
    // <phase>/<stage>/file, construction/<unit>/<stage>/file, <stage>/reviews/file
    for (let i = parts.length - 2; i >= 1; i--) {
      if (STAGE_CATEGORY[parts[i]]) return parts[i];
    }
    return undefined;
  }

  // ----- derived views -----

  gates(state: WorkflowState | null, lifecycle: Lifecycle | null, artifacts: ArtifactFile[], audit: AuditEvent[]): ApprovalGate[] {
    if (!state) return [];
    const gates: ApprovalGate[] = [];
    for (const stage of state.stages) {
      if (stage.state !== "awaiting_approval" && stage.state !== "revising") continue;
      const graph = lifecycle?.phases.flatMap((p) => p.stages).find((s) => s.slug === stage.slug);
      const since = [...audit].reverse().find((e) => e.event === "STAGE_AWAITING_APPROVAL" && e.fields["Stage"] === stage.slug)?.timestamp;
      gates.push({
        stage: stage.slug,
        stageName: graph?.name ?? stage.slug,
        state: stage.state,
        since,
        artifacts: artifacts.filter((a) => a.stage === stage.slug && !a.path.includes("/reviews/")),
        leadAgent: graph?.lead_agent,
      });
    }
    return gates;
  }

  /** Agent activity recorded in the audit trail (stage leads and dispatched helpers). */
  agentActivity(state: WorkflowState | null, lifecycle: Lifecycle | null, audit: AuditEvent[]): AgentActivity[] {
    const names = new Map((lifecycle?.agents ?? []).map((a) => [a.slug, a.display_name]));
    const display = (slug: string): string => names.get(slug) ?? (slug === "orchestrator" ? "Conductor" : slug);
    const out: AgentActivity[] = [];
    const openStages = new Map<string, AgentActivity>();
    const openSubagents: AgentActivity[] = [];
    let n = 0;
    for (const event of audit) {
      const stage = event.fields["Stage"];
      if (event.event === "STAGE_STARTED" && stage) {
        const agent = event.fields["Agent"] ?? "orchestrator";
        const row: AgentActivity = {
          id: `audit-${n++}`,
          agent,
          displayName: display(agent),
          role: agent === "orchestrator" ? "orchestrator" : "lead",
          stage,
          task: `Lead ${stage}`,
          status: "active",
          startedAt: event.timestamp,
          source: "audit",
        };
        openStages.set(stage, row);
        out.push(row);
      } else if ((event.event === "STAGE_COMPLETED" || event.event === "STAGE_SKIPPED") && stage) {
        const row = openStages.get(stage);
        if (row) {
          row.status = event.event === "STAGE_COMPLETED" ? "completed" : "stopped";
          row.completedAt = event.timestamp;
          openStages.delete(stage);
        }
      } else if (event.event === "SUBAGENT_DISPATCHED") {
        const agent = event.fields["Agent"] ?? event.fields["Subagent"] ?? event.fields["Agent Type"] ?? "subagent";
        const row: AgentActivity = {
          id: `audit-${n++}`,
          agent,
          displayName: display(agent),
          role: /review/i.test(agent) ? "reviewer" : "subagent",
          stage,
          task: event.fields["Details"] ?? event.fields["Description"] ?? event.fields["Role"],
          status: "active",
          startedAt: event.timestamp,
          source: "audit",
        };
        openSubagents.push(row);
        out.push(row);
      } else if (event.event === "SUBAGENT_COMPLETED") {
        const agent = event.fields["Agent"] ?? event.fields["Subagent"] ?? event.fields["Agent Type"];
        const at = openSubagents.findIndex((r) => (agent ? r.agent === agent : true) && (!stage || r.stage === stage));
        const row = at >= 0 ? openSubagents.splice(at, 1)[0] : undefined;
        if (row) {
          row.status = "completed";
          row.completedAt = event.timestamp;
        }
      } else if (event.event === "ARTIFACT_CREATED" || event.event === "ARTIFACT_UPDATED") {
        const row = stage ? openStages.get(stage) : undefined;
        const file = event.fields["File"] ?? event.fields["Path"] ?? event.fields["Artifact"];
        if (row && file) (row.outputs ??= []).push(file);
      } else if (event.event === "ERROR_LOGGED") {
        const row = stage ? openStages.get(stage) : undefined;
        if (row) row.error = event.fields["Details"] ?? event.fields["Error"] ?? "error logged";
      }
    }
    // A stage the state file no longer shows as running is not active, whatever the trail's last row says.
    if (state) {
      const running = new Set(state.stages.filter((s) => ["in_progress", "awaiting_approval", "revising"].includes(s.state)).map((s) => s.slug));
      for (const row of out) {
        if (row.status === "active" && row.role !== "subagent" && row.role !== "reviewer" && row.stage && !running.has(row.stage)) row.status = "stopped";
      }
    }
    return out;
  }

  async snapshot(projectId: string): Promise<Snapshot> {
    const errors: string[] = [];
    const install = this.install();
    const snap: Snapshot = {
      projectId,
      at: new Date().toISOString(),
      install,
      lifecycle: null,
      space: null,
      intents: [],
      state: null,
      audit: [],
      artifacts: [],
      gates: [],
      agents: [],
      errors,
    };
    errors.push(...install.problems);
    if (!install.engine) return snap;
    try {
      snap.lifecycle = await this.lifecycle();
    } catch (error) {
      errors.push(`Could not read the stage graph: ${(error as Error).message}`);
    }
    try {
      const listed = await this.intents();
      snap.space = listed.space;
      snap.intents = listed.intents;
    } catch (error) {
      errors.push(`Could not list intents: ${(error as Error).message}`);
    }
    const active = snap.intents.find((i) => i.active);
    if (active && snap.space) {
      try {
        snap.state = this.state(snap.space, active.dirName);
        snap.artifacts = this.artifacts(snap.space, active.dirName);
      } catch (error) {
        errors.push(`Could not read workflow state: ${(error as Error).message}`);
      }
      try {
        snap.audit = await this.audit(snap.space, active.dirName);
      } catch (error) {
        errors.push(`Could not read the audit trail: ${(error as Error).message}`);
      }
      snap.gates = this.gates(snap.state, snap.lifecycle, snap.artifacts, snap.audit);
      snap.agents = this.agentActivity(snap.state, snap.lifecycle, snap.audit);
    }
    return snap;
  }
}
