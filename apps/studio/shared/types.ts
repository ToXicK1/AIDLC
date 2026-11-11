// Types shared by the Studio server and web client. Everything here describes
// data read from the real AI-DLC engine, the project folder, or the harness
// stream; nothing is synthesized.

export type StageState =
  | "pending"
  | "in_progress"
  | "awaiting_approval"
  | "revising"
  | "completed"
  | "skipped"
  | "not_in_plan";

export interface GraphStage {
  slug: string;
  number: string;
  name: string;
  phase: string;
  execution: string;
  condition?: string;
  lead_agent: string;
  support_agents: string[];
  mode: string;
  produces: string[];
  consumes: Array<{ artifact: string; required: boolean; conditional_on?: string }>;
  sensors: string[];
  inputs?: string;
  outputs?: string;
}

export interface GraphAgent {
  slug: string;
  display_name: string;
}

export interface Lifecycle {
  phases: Array<{ id: string; stages: GraphStage[] }>;
  agents: GraphAgent[];
  scopes: Record<string, { depth?: string; stages: Record<string, string> }>;
  artifacts: string[];
}

export interface StageProgress {
  slug: string;
  phase: string;
  box: string;
  plan: "EXECUTE" | "SKIP" | "";
  state: StageState;
}

export interface WorkflowState {
  recordDir: string; // project-relative, forward slashes
  sections: Record<string, Record<string, string>>;
  phases: Array<{ name: string; status: string }>;
  stages: StageProgress[];
  project: string;
  scope: string;
  status: string;
  lifecyclePhase: string;
  currentStage: string;
  nextStage: string;
  lastUpdated: string;
  activeAgent: string;
  completed: number;
  total: number;
}

export interface IntentRow {
  uuid: string;
  slug: string;
  status: string;
  dirName: string;
  active: boolean;
}

export interface AuditEvent {
  timestamp: string;
  event: string;
  fields: Record<string, string>;
  heading?: string;
  body?: string;
}

export interface ArtifactFile {
  path: string; // project-relative
  name: string;
  phase: string; // record phase dir (ideation, inception, ...), or "record"
  stage?: string;
  category: ArtifactCategory;
  size: number;
  mtime: number;
}

export type ArtifactCategory =
  | "requirements"
  | "architecture"
  | "design"
  | "implementation"
  | "testing"
  | "security"
  | "deployment"
  | "operations"
  | "other";

export interface HarnessInfo {
  id: string;
  name: string;
  dir: string;
  distDir: string;
  invoke: string;
  capabilities: { configure: boolean; chat: boolean; streaming: boolean; approvals: boolean };
  note?: string;
}

export interface InstallInfo {
  installed: boolean;
  harnesses: Array<{ id: string; dir: string; shape: "bun" | "native" }>;
  engine: { kind: "bun" | "native"; display: string } | null;
  problems: string[];
}

export interface AgentActivity {
  id: string;
  agent: string;
  displayName: string;
  role: "lead" | "support" | "subagent" | "reviewer" | "orchestrator";
  stage?: string;
  task?: string;
  status: "active" | "completed" | "failed" | "stopped";
  startedAt?: string;
  completedAt?: string;
  source: "audit" | "harness";
  outputs?: string[];
  error?: string;
}

export interface ApprovalGate {
  stage: string;
  stageName: string;
  state: "awaiting_approval" | "revising";
  since?: string;
  artifacts: ArtifactFile[];
  leadAgent?: string;
}

export interface Snapshot {
  projectId: string;
  at: string;
  install: InstallInfo;
  lifecycle: Lifecycle | null;
  space: string | null;
  intents: IntentRow[];
  state: WorkflowState | null;
  audit: AuditEvent[];
  artifacts: ArtifactFile[];
  gates: ApprovalGate[];
  agents: AgentActivity[];
  errors: string[];
}

export interface ProjectRecord {
  id: string;
  path: string;
  name: string;
  lastOpened: string;
  harness: string;
  settings: ProjectSettings;
}

export interface ProjectSettings {
  permissionMode: "default" | "acceptEdits" | "plan";
  model: string;
}

export type ChatStatus = "idle" | "starting" | "running" | "waiting_input" | "stopped" | "failed";

export interface AskQuestion {
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export type ChatEvent = { seq: number; ts: string; conversationId: string } & (
  | { type: "user"; text: string; origin: "chat" | "approval" | "action" }
  | { type: "assistant"; text: string; parent?: string | null }
  | { type: "assistant_delta"; text: string; messageId: string }
  | { type: "tool_use"; id: string; name: string; input: unknown; parent?: string | null }
  | { type: "tool_result"; id: string; name: string; text: string; isError: boolean }
  | { type: "question"; id: string; questions: AskQuestion[] }
  | { type: "question_answered"; id: string; answers: Record<string, string | string[]> | null }
  | { type: "permission"; id: string; toolName: string; input: unknown; reason?: string }
  | { type: "permission_decided"; id: string; decision: "allow" | "deny"; message?: string }
  | {
      type: "task";
      taskId: string;
      phase: "started" | "updated" | "finished";
      description?: string;
      subagentType?: string;
      status?: string;
      summary?: string;
    }
  | { type: "session"; harnessSessionId: string; model?: string; permissionMode?: string }
  | { type: "result"; subtype: string; isError: boolean; durationMs?: number; costUsd?: number; turns?: number; text?: string }
  | { type: "error"; message: string }
  | { type: "status"; status: ChatStatus; detail?: string }
);

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  harness: string;
  harnessSessionId?: string;
}

export interface LogLine {
  seq: number;
  ts: string;
  level: "info" | "warn" | "error" | "debug";
  source: string;
  text: string;
}

export interface FsChange {
  path: string;
  kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  at: number;
}

export interface TreeEntry {
  name: string;
  path: string;
  dir: boolean;
  size?: number;
  sensitive?: boolean;
  heavy?: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  note?: string;
  branch?: string;
  files: Array<{ path: string; index: string; worktree: string; label: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflict" }>;
}

export interface CommandSpec {
  id: string;
  label: string;
  group: string;
  display: string;
  description?: string;
}

export interface RunEvent {
  runId: string;
  commandId: string;
  kind: "start" | "stdout" | "stderr" | "exit" | "error";
  text?: string;
  code?: number | null;
  ts: string;
  display?: string;
}

export interface TestRun {
  id: string;
  source: "studio" | "harness";
  command: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  status: "running" | "passed" | "failed" | "error";
  summary?: { passed?: number; failed?: number; skipped?: number; total?: number };
  failures: Array<{ name: string; message?: string; file?: string; line?: number }>;
  output: string;
}

export interface StudioAuditEntry {
  ts: string;
  projectId?: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface SystemInfo {
  platform: string;
  node: string;
  tools: Record<string, { ok: boolean; version?: string; path?: string; error?: string }>;
  engineRepo: string | null;
  harnesses: HarnessInfo[];
  dataDir: string;
}
