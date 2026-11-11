// Controlled process execution. No shell strings: a command is an executable
// plus an argument array. Windows .cmd shims are run through cmd.exe only with
// arguments from a strict character set, so nothing can be injected.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
  maxBuffer?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onSpawn?: (child: ChildProcess) => void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

// Variables a parent Claude Code session exports. Passing them on would make
// the engine and the harness believe they run inside that other session.
const SESSION_ENV = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PROJECT_DIR|CLAUDE_AGENT_SDK_.*|CLAUDE_CONFIG_DIR_OVERRIDE)$/;

export function cleanEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || SESSION_ENV.test(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

const whichCache = new Map<string, string | null>();

/** Resolve an executable name to a full path using the OS lookup. */
export function which(name: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  if (whichCache.has(name)) return whichCache.get(name) ?? null;
  const tool = process.platform === "win32" ? "where.exe" : "which";
  const found = spawnSync(tool, [name], { encoding: "utf8", windowsHide: true });
  let resolved: string | null = null;
  if (found.status === 0) {
    const lines = found.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (process.platform === "win32") {
      resolved = lines.find((l) => /\.(exe|com)$/i.test(l)) ?? lines.find((l) => /\.(cmd|bat)$/i.test(l)) ?? null;
    } else {
      resolved = lines[0] ?? null;
    }
  }
  whichCache.set(name, resolved);
  return resolved;
}

export function clearWhichCache(): void {
  whichCache.clear();
}

// No spaces, quotes, %, &, |, ^ or redirection: cmd.exe keeps the launcher's
// own quotes only when they are the sole pair on the line, and it expands
// %NAME% even inside quotes.
const SAFE_CMD_ARG = /^[A-Za-z0-9_@+=:,./\\-]+$/;

interface Resolved {
  file: string;
  args: string[];
}

function resolveCommand(command: string, args: string[]): Resolved {
  for (const arg of args) {
    if (typeof arg !== "string" || arg.includes("\0")) throw new Error("Invalid process argument.");
  }
  const file = path.isAbsolute(command) ? command : which(command);
  if (!file || !existsSync(file)) throw new Error(`Command not found: ${command}`);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    for (const arg of args) {
      if (!SAFE_CMD_ARG.test(arg)) throw new Error(`Argument not allowed for a .cmd launcher: ${arg}`);
    }
    const comspec = process.env.ComSpec ?? "cmd.exe";
    return { file: comspec, args: ["/d", "/c", file, ...args] };
  }
  return { file, args };
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
  } catch {
    // The process already ended.
  }
}

export function spawnControlled(command: string, args: string[], options: RunOptions): ChildProcess {
  const resolved = resolveCommand(command, args);
  return spawn(resolved.file, resolved.args, {
    cwd: options.cwd,
    env: options.env ?? cleanEnv(),
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export function run(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnControlled(command, args, options);
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: (error as Error).message });
      return;
    }
    options.onSpawn?.(child);
    const max = options.maxBuffer ?? 16 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, options.timeoutMs)
      : undefined;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < max) stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < max) stderr += chunk;
      options.onStderr?.(chunk);
    });
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.on("error", (error) => finish({ code: null, stdout, stderr, timedOut, error: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut }));
    if (options.stdin !== undefined) child.stdin?.write(options.stdin);
    child.stdin?.end();
  });
}
