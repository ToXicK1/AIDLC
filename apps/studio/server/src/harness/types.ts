// The harness abstraction. The UI and the chat manager talk only to this
// interface, so another harness gains in-app chat by adding one adapter.

import type { AskQuestion, ChatEvent, ProjectSettings } from "../../../shared/types.ts";

type Distribute<T> = T extends unknown ? Omit<T, "seq" | "ts" | "conversationId"> : never;
/** A chat event before the manager stamps its sequence, time and conversation. */
export type HarnessEvent = Distribute<ChatEvent>;

export interface HarnessCallbacks {
  onEvent(event: HarnessEvent): void;
  onLog(level: "info" | "warn" | "error" | "debug", text: string): void;
  /** The harness asks the person a question. null = they chose to answer in chat instead. */
  askQuestion(id: string, questions: AskQuestion[], signal: AbortSignal): Promise<Record<string, string | string[]> | null>;
  /** The harness asks to run a tool the project's settings do not pre-approve. */
  askPermission(id: string, toolName: string, input: unknown, reason: string | undefined, signal: AbortSignal): Promise<{ allow: boolean; message?: string }>;
  /** The harness process ended (error set when it did not end cleanly). */
  onClosed(error?: string): void;
}

export interface HarnessStartOptions {
  projectDir: string;
  settings: ProjectSettings;
  /** Harness-native session id to continue, when one was recorded. */
  resume?: string;
  callbacks: HarnessCallbacks;
}

export interface HarnessSession {
  send(text: string): void;
  /** Stop the current turn but keep the session. */
  interrupt(): Promise<void>;
  /** End the session and its whole process tree. */
  close(): Promise<void>;
  readonly alive: boolean;
}

export interface HarnessAdapter {
  readonly id: string;
  /** Null when the harness can run here; otherwise why not. */
  unavailableReason(): string | null;
  start(options: HarnessStartOptions): HarnessSession;
}
