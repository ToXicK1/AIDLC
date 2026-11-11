// Claude Code adapter. It drives the person's installed Claude Code through
// the Claude Agent SDK, the same way the engine's own test suite does
// (tests/harness/sdk-drive.ts):
//   - the prompt is a user-message stream held open across turns, so the
//     session can ask questions and request permissions at any point;
//   - AskUserQuestion and permission requests arrive through canUseTool and are
//     answered by the person in Studio, never by Studio itself;
//   - project settings are loaded, so AI-DLC's hooks (human-turn recording,
//     audit, guards, the Stop hook that continues the workflow) all run.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { type Options, type PermissionResult, query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AskQuestion } from "../../../shared/types.ts";
import { cleanEnv, killTree, which } from "../proc.ts";
import { redact, redactDeep } from "../security/redact.ts";
import type { HarnessAdapter, HarnessCallbacks, HarnessSession, HarnessStartOptions } from "./types.ts";

/** The installed Claude Code executable, preferred over the SDK's bundled copy. */
export function findClaudeExecutable(): string | null {
  const override = process.env.AIDLC_STUDIO_CLAUDE_PATH;
  if (override && existsSync(override)) return override;
  const found = which("claude");
  if (!found) return null;
  if (/\.(cmd|bat|ps1)$/i.test(found)) {
    // The npm shim sits beside node_modules/@anthropic-ai/claude-code/bin/claude.exe.
    const exe = path.join(path.dirname(found), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    return existsSync(exe) ? exe : null;
  }
  return found;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "image") return "[image]";
      return "";
    })
    .join("");
}

const MAX_RESULT = 20000;

class ClaudeSession implements HarnessSession {
  private readonly queue: string[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  private ended = false;
  private readonly abort = new AbortController();
  private child: ChildProcess | undefined;
  private run: Query | undefined;
  private readonly toolNames = new Map<string, string>();
  private readonly callbacks: HarnessCallbacks;
  private requestCounter = 0;

  constructor(options: HarnessStartOptions) {
    this.callbacks = options.callbacks;
    void this.loop(options);
  }

  get alive(): boolean {
    return !this.ended;
  }

  send(text: string): void {
    if (this.closed) return;
    this.queue.push(text);
    this.release();
  }

  async interrupt(): Promise<void> {
    try {
      await this.run?.interrupt();
    } catch (error) {
      this.callbacks.onLog("warn", `Interrupt failed: ${(error as Error).message}`);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.release();
    this.abort.abort();
    // The SDK's abort ends the CLI alone; on Windows its tool children survive.
    killTree(this.child?.pid);
  }

  private release(): void {
    const resume = this.wake;
    this.wake = undefined;
    resume?.();
  }

  private async *messages(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.queue.length > 0) {
        yield {
          type: "user",
          message: { role: "user", content: this.queue.shift()! },
          parent_tool_use_id: null,
        } as SDKUserMessage;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private async loop(start: HarnessStartOptions): Promise<void> {
    const cb = this.callbacks;
    const executable = findClaudeExecutable();
    const options: Options = {
      cwd: start.projectDir,
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: start.settings.permissionMode,
      includePartialMessages: true,
      includeHookEvents: true,
      abortController: this.abort,
      env: cleanEnv() as Record<string, string>,
      stderr: (data: string) => {
        const line = redact(data).trim();
        if (line) cb.onLog("debug", line);
      },
      spawnClaudeCodeProcess: (spawnOptions) => {
        const child = spawn(spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env as NodeJS.ProcessEnv,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          signal: spawnOptions.signal,
        });
        this.child = child;
        return child as never;
      },
      canUseTool: async (toolName, input, permission): Promise<PermissionResult> => {
        const id = `req-${Date.now()}-${++this.requestCounter}`;
        if (toolName === "AskUserQuestion") {
          const questions = ((input as { questions?: AskQuestion[] }).questions ?? []).map((q) => ({
            header: q.header,
            question: q.question,
            options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
            multiSelect: q.multiSelect === true,
          }));
          const answers = await cb.askQuestion(id, questions, permission.signal);
          if (answers === null) {
            return {
              behavior: "deny",
              message:
                "The user wants to clarify these questions. They will reply in their next chat message. " +
                "Take their response into account and then reformulate the questions if appropriate.",
            };
          }
          return { behavior: "allow", updatedInput: { ...(input as object), answers } };
        }
        const reason = (permission as { decisionReason?: string }).decisionReason;
        const decision = await cb.askPermission(id, toolName, redactDeep(input), reason, permission.signal);
        return decision.allow
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: decision.message?.trim() || "The user declined this action in AI-DLC Studio." };
      },
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      ...(start.settings.model ? { model: start.settings.model } : {}),
      ...(start.resume ? { resume: start.resume } : {}),
    };

    let failure: string | undefined;
    try {
      const run = query({ prompt: this.messages(), options });
      this.run = run;
      for await (const msg of run) this.handle(msg as unknown as Record<string, unknown>);
    } catch (error) {
      if (!this.closed) failure = redact((error as Error).message ?? String(error));
    } finally {
      this.ended = true;
      this.closed = true;
      this.release();
      killTree(this.child?.pid);
      cb.onClosed(failure);
    }
  }

  private handle(msg: Record<string, unknown>): void {
    const cb = this.callbacks;
    const parent = (msg.parent_tool_use_id as string | null | undefined) ?? null;
    switch (msg.type) {
      case "system": {
        const subtype = msg.subtype as string | undefined;
        if (subtype === "init") {
          cb.onEvent({
            type: "session",
            harnessSessionId: String(msg.session_id ?? ""),
            model: typeof msg.model === "string" ? msg.model : undefined,
            permissionMode: typeof msg.permissionMode === "string" ? msg.permissionMode : undefined,
          });
          cb.onLog("info", `Claude Code ${String(msg.claude_code_version ?? "")} session ${String(msg.session_id ?? "")} (model ${String(msg.model ?? "?")})`);
        } else if (subtype === "task_started") {
          cb.onEvent({
            type: "task",
            taskId: String(msg.task_id),
            phase: "started",
            description: typeof msg.description === "string" ? redact(msg.description) : undefined,
            subagentType: typeof msg.subagent_type === "string" ? msg.subagent_type : undefined,
            status: "running",
          });
        } else if (subtype === "task_updated") {
          const status = (msg.patch as { status?: unknown } | undefined)?.status;
          if (typeof status === "string") cb.onEvent({ type: "task", taskId: String(msg.task_id), phase: "updated", status });
        } else if (subtype === "task_notification") {
          cb.onEvent({
            type: "task",
            taskId: String(msg.task_id),
            phase: "finished",
            status: typeof msg.status === "string" ? msg.status : undefined,
            summary: typeof msg.summary === "string" ? redact(msg.summary).slice(0, 4000) : undefined,
          });
        } else if (subtype === "hook_response") {
          const outcome = String(msg.outcome ?? msg.exit_code ?? "");
          cb.onLog(outcome === "error" ? "warn" : "debug", `hook ${String(msg.hook_event ?? "")} ${String(msg.hook_name ?? "")} ${outcome}`.trim());
        } else if (subtype === "compact_boundary") {
          cb.onLog("info", "Conversation context was compacted by Claude Code.");
        }
        break;
      }
      case "stream_event": {
        if (parent) break;
        const event = msg.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          cb.onEvent({ type: "assistant_delta", text: event.delta.text, messageId: String(msg.uuid ?? "") });
        }
        break;
      }
      case "assistant": {
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        if (!Array.isArray(content)) break;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            cb.onEvent({ type: "assistant", text: redact(block.text), parent });
          } else if (block.type === "tool_use" && typeof block.id === "string") {
            const name = typeof block.name === "string" ? block.name : "";
            this.toolNames.set(block.id, name);
            cb.onEvent({ type: "tool_use", id: block.id, name, input: redactDeep(block.input ?? {}), parent });
          }
        }
        break;
      }
      case "user": {
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        if (!Array.isArray(content)) break;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block.type !== "tool_result") continue;
          const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          let text = redact(textOf(block.content));
          if (text.length > MAX_RESULT) text = `${text.slice(0, MAX_RESULT)}\n… [${text.length - MAX_RESULT} more characters]`;
          cb.onEvent({ type: "tool_result", id, name: this.toolNames.get(id) ?? "", text, isError: block.is_error === true });
        }
        break;
      }
      case "result": {
        const errors = Array.isArray(msg.errors) ? (msg.errors as unknown[]).map(String).join("; ") : undefined;
        cb.onEvent({
          type: "result",
          subtype: String(msg.subtype ?? ""),
          isError: msg.is_error === true,
          durationMs: typeof msg.duration_ms === "number" ? msg.duration_ms : undefined,
          costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
          turns: typeof msg.num_turns === "number" ? msg.num_turns : undefined,
          text: msg.is_error === true ? redact(errors ?? (typeof msg.result === "string" ? msg.result : "")) : undefined,
        });
        break;
      }
      default:
        break;
    }
  }
}

export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  unavailableReason(): string | null {
    return findClaudeExecutable() ? null : "Claude Code was not found on PATH. Install it (npm install -g @anthropic-ai/claude-code) and sign in with `claude`.";
  },
  start(options: HarnessStartOptions): HarnessSession {
    return new ClaudeSession(options);
  },
};
