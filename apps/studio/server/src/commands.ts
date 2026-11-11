// The command runner behind the Terminal panel. It is an allowlist, not a
// shell: the catalog is built server-side from the engine's own read-only
// commands, read-only git views, and the scripts the project itself declares.
// A client can only ask for a catalog id; it never supplies a command line.

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { CommandSpec, RunEvent } from "../../shared/types.ts";
import type { Engine } from "./engine/engine.ts";
import { cleanEnv, killTree, spawnControlled, which } from "./proc.ts";
import { redact } from "./security/redact.ts";

export interface CommandDef extends CommandSpec {
  command: string;
  args: string[];
  isTest?: boolean;
}

function packageManager(projectDir: string): string {
  if (existsSync(path.join(projectDir, "bun.lock")) || existsSync(path.join(projectDir, "bun.lockb"))) return "bun";
  if (existsSync(path.join(projectDir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(projectDir, "yarn.lock"))) return "yarn";
  return "npm";
}

export function buildCatalog(projectDir: string, engine: Engine): CommandDef[] {
  const defs: CommandDef[] = [];

  const engineCommands: Array<[string, string, string[], string]> = [
    ["aidlc:status", "Workflow status", ["engine", "status"], "Where the active workflow stands (read-only)."],
    ["aidlc:doctor", "Doctor", ["doctor", "--offline"], "Check this machine and project."],
    ["aidlc:intents", "List intents", ["engine", "intent", "list", "--all"], "Pieces of work in the active space."],
    ["aidlc:config", "Workflow settings", ["engine", "config", "list"], "The active workflow's settings."],
    ["aidlc:turns", "Your recorded turns", ["engine", "audit", "turns"], "Each of your turns the audit trail recorded."],
    ["aidlc:runtime", "Runtime summary", ["engine", "runtime", "summary"], "Stage outcomes, sensors and duration."],
    ["aidlc:version", "Engine version", ["version"], "Engine and runtime versions."],
  ];
  for (const [id, label, args, description] of engineCommands) {
    const argv = engine.argv(args);
    if (argv) defs.push({ id, label, group: "AI-DLC", display: argv.display, description, command: argv.command, args: argv.args });
  }

  if (which("git")) {
    defs.push(
      { id: "git:status", label: "git status", group: "Git", display: "git status -sb", command: "git", args: ["status", "-sb"] },
      { id: "git:log", label: "git log", group: "Git", display: "git log --oneline -n 20", command: "git", args: ["--no-pager", "log", "--oneline", "-n", "20"] },
      { id: "git:diffstat", label: "git diff --stat", group: "Git", display: "git diff --stat", command: "git", args: ["--no-pager", "diff", "--stat"] },
    );
  }

  const pkgFile = path.join(projectDir, "package.json");
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as { scripts?: Record<string, unknown> };
      const pm = packageManager(projectDir);
      if (which(pm)) {
        for (const name of Object.keys(pkg.scripts ?? {}).slice(0, 60)) {
          if (!/^[A-Za-z0-9:_.-]+$/.test(name)) continue;
          const isTest = /^test(\b|:|$)/.test(name);
          defs.push({
            id: `script:${name}`,
            label: `${pm} run ${name}`,
            group: isTest ? "Tests" : "Project scripts",
            display: `${pm} run ${name}`,
            description: "Declared in package.json",
            command: pm,
            args: ["run", name],
            isTest,
          });
        }
      }
    } catch {
      // An unreadable package.json contributes no scripts.
    }
  }

  const has = (name: string): boolean => existsSync(path.join(projectDir, name));
  const hasPython = which("python") ? "python" : which("python3") ? "python3" : which("py") ? "py" : null;
  if (hasPython && (has("pytest.ini") || has("pyproject.toml") || has("tests") || has("conftest.py") || has("setup.cfg"))) {
    defs.push({ id: "test:pytest", label: "pytest", group: "Tests", display: `${hasPython} -m pytest`, command: hasPython, args: ["-m", "pytest"], isTest: true });
  }
  if (has("Cargo.toml") && which("cargo")) defs.push({ id: "test:cargo", label: "cargo test", group: "Tests", display: "cargo test", command: "cargo", args: ["test"], isTest: true });
  if (has("go.mod") && which("go")) defs.push({ id: "test:go", label: "go test", group: "Tests", display: "go test -v ./...", command: "go", args: ["test", "-v", "./..."], isTest: true });
  let dotnetProject = false;
  try {
    dotnetProject = readdirSync(projectDir).some((f) => /\.(sln|csproj)$/i.test(f));
  } catch {
    dotnetProject = false;
  }
  if (dotnetProject && which("dotnet")) defs.push({ id: "test:dotnet", label: "dotnet test", group: "Tests", display: "dotnet test", command: "dotnet", args: ["test"], isTest: true });

  return defs;
}

export interface RunnerHost {
  emit(event: RunEvent): void;
  onTestStart(runId: string, display: string): void;
  onTestOutput(runId: string, chunk: string): void;
  onTestExit(runId: string, code: number | null): void;
}

const MAX_CONCURRENT = 4;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

export class CommandRunner {
  private readonly active = new Map<string, { child: ChildProcess; def: CommandDef; timer: ReturnType<typeof setTimeout> }>();
  private readonly projectDir: string;
  private readonly engine: Engine;
  private readonly host: RunnerHost;

  constructor(projectDir: string, engine: Engine, host: RunnerHost) {
    this.projectDir = projectDir;
    this.engine = engine;
    this.host = host;
  }

  catalog(): CommandDef[] {
    return buildCatalog(this.projectDir, this.engine);
  }

  running(): Array<{ runId: string; commandId: string }> {
    return [...this.active.entries()].map(([runId, entry]) => ({ runId, commandId: entry.def.id }));
  }

  start(commandId: string): { runId: string; display: string } {
    const def = this.catalog().find((c) => c.id === commandId);
    if (!def) throw new Error("That command is not in this project's allowlist.");
    if (this.active.size >= MAX_CONCURRENT) throw new Error("Too many commands are running. Wait for one to finish or stop it.");
    const runId = randomUUID();
    const now = (): string => new Date().toISOString();
    let child: ChildProcess;
    try {
      child = spawnControlled(def.command, def.args, { cwd: this.projectDir, env: cleanEnv({ NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" }) });
    } catch (error) {
      this.host.emit({ runId, commandId, kind: "start", ts: now(), display: def.display });
      this.host.emit({ runId, commandId, kind: "error", ts: now(), text: (error as Error).message });
      return { runId, display: def.display };
    }
    const timer = setTimeout(() => {
      this.host.emit({ runId, commandId, kind: "stderr", ts: now(), text: "\n[Studio] Stopped: the command ran longer than 30 minutes.\n" });
      killTree(child.pid);
    }, RUN_TIMEOUT_MS);
    this.active.set(runId, { child, def, timer });
    this.host.emit({ runId, commandId, kind: "start", ts: now(), display: def.display });
    if (def.isTest) this.host.onTestStart(runId, def.display);
    child.stdin?.end();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const forward = (kind: "stdout" | "stderr") => (chunk: string) => {
      const text = redact(chunk);
      this.host.emit({ runId, commandId, kind, ts: now(), text });
      if (def.isTest) this.host.onTestOutput(runId, text);
    };
    child.stdout?.on("data", forward("stdout"));
    child.stderr?.on("data", forward("stderr"));
    let done = false;
    const finish = (code: number | null, error?: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.active.delete(runId);
      if (error) this.host.emit({ runId, commandId, kind: "error", ts: now(), text: error });
      this.host.emit({ runId, commandId, kind: "exit", ts: now(), code });
      if (def.isTest) this.host.onTestExit(runId, code);
    };
    child.on("error", (error) => finish(null, error.message));
    child.on("close", (code) => finish(code));
    return { runId, display: def.display };
  }

  kill(runId: string): boolean {
    const entry = this.active.get(runId);
    if (!entry) return false;
    killTree(entry.child.pid);
    return true;
  }

  dispose(): void {
    for (const entry of this.active.values()) {
      clearTimeout(entry.timer);
      killTree(entry.child.pid);
    }
    this.active.clear();
  }
}
