// Chat manager: one harness session per project, a persisted event log per
// conversation, and the pending questions / permission requests the person
// must answer. Approvals travel through here too, as the person's own reply
// in the harness session, which is how an AI-DLC gate is decided.

import type { AskQuestion, ChatEvent, ChatStatus, Conversation, ProjectRecord } from "../../shared/types.ts";
import { harnessById } from "./harness/registry.ts";
import type { HarnessAdapter, HarnessEvent, HarnessSession } from "./harness/types.ts";
import { redact } from "./security/redact.ts";
import type { Store } from "./store.ts";

interface PendingQuestion {
  id: string;
  conversationId: string;
  questions: AskQuestion[];
  resolve: (answers: Record<string, string | string[]> | null) => void;
}

interface PendingPermission {
  id: string;
  conversationId: string;
  toolName: string;
  input: unknown;
  resolve: (decision: { allow: boolean; message?: string }) => void;
}

export interface ChatHost {
  project(): ProjectRecord;
  emit(event: ChatEvent): void;
  log(level: "info" | "warn" | "error" | "debug", source: string, text: string): void;
  /** A harness event that other parts of Studio observe (tests, agents). */
  observe(event: HarnessEvent): void;
}

export class ChatError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class ChatManager {
  private session: HarnessSession | null = null;
  private sessionConversation: string | null = null;
  private status: ChatStatus = "idle";
  private seq = 0;
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly store: Store;
  private readonly host: ChatHost;
  private readonly adapters: Map<string, HarnessAdapter>;

  constructor(store: Store, host: ChatHost, adapters: HarnessAdapter[]) {
    this.store = store;
    this.host = host;
    this.adapters = new Map(adapters.map((a) => [a.id, a]));
  }

  private get projectId(): string {
    return this.host.project().id;
  }

  getStatus(): { status: ChatStatus; conversationId: string | null; pendingQuestions: string[]; pendingPermissions: string[] } {
    return {
      status: this.status,
      conversationId: this.sessionConversation,
      pendingQuestions: [...this.questions.keys()],
      pendingPermissions: [...this.permissions.keys()],
    };
  }

  conversations(): Conversation[] {
    return this.store.conversations(this.projectId);
  }

  events(conversationId: string): ChatEvent[] {
    const events = this.store.chatEvents(this.projectId, conversationId);
    // A question or permission the log shows as open is only still open if
    // this process holds its resolver; after a restart it is closed.
    const answeredQ = new Set(events.filter((e) => e.type === "question_answered").map((e) => (e as { id: string }).id));
    const decidedP = new Set(events.filter((e) => e.type === "permission_decided").map((e) => (e as { id: string }).id));
    const extra: ChatEvent[] = [];
    for (const event of events) {
      if (event.type === "question" && !answeredQ.has(event.id) && !this.questions.has(event.id)) {
        extra.push({ ...this.stamp(conversationId), type: "question_answered", id: event.id, answers: null } as ChatEvent);
      }
      if (event.type === "permission" && !decidedP.has(event.id) && !this.permissions.has(event.id)) {
        extra.push({ ...this.stamp(conversationId), type: "permission_decided", id: event.id, decision: "deny", message: "Session ended before a decision." } as ChatEvent);
      }
    }
    return [...events, ...extra];
  }

  newConversation(): Conversation {
    void this.endSession("New conversation started.");
    return this.store.createConversation(this.projectId, this.host.project().harness);
  }

  private stamp(conversationId: string): { seq: number; ts: string; conversationId: string } {
    // Time-based and strictly increasing, so sequence numbers stay unique
    // across Studio restarts that append to the same conversation log.
    this.seq = Math.max(this.seq + 1, Date.now() * 1000);
    return { seq: this.seq, ts: new Date().toISOString(), conversationId };
  }

  private publish(conversationId: string, event: HarnessEvent, persist = true): ChatEvent {
    const full = { ...this.stamp(conversationId), ...event } as ChatEvent;
    if (persist) this.store.appendChatEvent(this.projectId, full);
    this.host.emit(full);
    return full;
  }

  private setStatus(conversationId: string, status: ChatStatus, detail?: string): void {
    this.status = status;
    this.publish(conversationId, { type: "status", status, detail }, false);
  }

  private adapter(): HarnessAdapter {
    const harnessId = this.host.project().harness;
    const adapter = this.adapters.get(harnessId);
    if (!adapter) {
      const info = harnessById(harnessId);
      throw new ChatError(409, info?.note ?? `No in-app chat adapter exists for harness "${harnessId}".`);
    }
    const reason = adapter.unavailableReason();
    if (reason) throw new ChatError(409, reason);
    return adapter;
  }

  private ensureSession(conversation: Conversation): HarnessSession {
    if (this.session?.alive && this.sessionConversation === conversation.id) return this.session;
    if (this.session?.alive) void this.session.close();
    const adapter = this.adapter();
    const project = this.host.project();
    const convId = conversation.id;
    this.setStatus(convId, "starting");
    this.host.log("info", "harness", `Starting ${adapter.id} session in ${project.path}${conversation.harnessSessionId ? ` (resuming ${conversation.harnessSessionId})` : ""}`);
    const session = adapter.start({
      projectDir: project.path,
      settings: project.settings,
      resume: conversation.harnessSessionId,
      callbacks: {
        onEvent: (event) => this.onHarnessEvent(convId, event),
        onLog: (level, text) => this.host.log(level, "harness", text),
        askQuestion: (id, questions, signal) =>
          new Promise((resolve) => {
            const done = (answers: Record<string, string | string[]> | null): void => {
              if (!this.questions.delete(id)) return;
              this.publish(convId, { type: "question_answered", id, answers });
              if (this.status === "waiting_input" && this.questions.size + this.permissions.size === 0) this.setStatus(convId, "running");
              resolve(answers);
            };
            this.questions.set(id, { id, conversationId: convId, questions, resolve: done });
            signal.addEventListener("abort", () => done(null), { once: true });
            this.publish(convId, { type: "question", id, questions });
            this.setStatus(convId, "waiting_input", "question");
          }),
        askPermission: (id, toolName, input, reason, signal) =>
          new Promise((resolve) => {
            const done = (decision: { allow: boolean; message?: string }): void => {
              if (!this.permissions.delete(id)) return;
              this.publish(convId, { type: "permission_decided", id, decision: decision.allow ? "allow" : "deny", message: decision.message });
              if (this.status === "waiting_input" && this.questions.size + this.permissions.size === 0) this.setStatus(convId, "running");
              resolve(decision);
            };
            this.permissions.set(id, { id, conversationId: convId, toolName, input, resolve: done });
            signal.addEventListener("abort", () => done({ allow: false, message: "Cancelled." }), { once: true });
            this.publish(convId, { type: "permission", id, toolName, input, reason });
            this.setStatus(convId, "waiting_input", "permission");
          }),
        onClosed: (error) => {
          if (this.session === session) {
            this.session = null;
            this.sessionConversation = null;
          }
          this.cancelPending(convId);
          if (error) {
            this.publish(convId, { type: "error", message: error });
            this.host.log("error", "harness", error);
            this.setStatus(convId, "failed", error);
          } else if (this.status !== "failed") {
            this.setStatus(convId, "stopped");
          }
        },
      },
    });
    this.session = session;
    this.sessionConversation = convId;
    return session;
  }

  private cancelPending(conversationId: string): void {
    for (const q of [...this.questions.values()]) if (q.conversationId === conversationId) q.resolve(null);
    for (const p of [...this.permissions.values()]) if (p.conversationId === conversationId) p.resolve({ allow: false, message: "Session ended." });
  }

  private onHarnessEvent(conversationId: string, event: HarnessEvent): void {
    this.host.observe(event);
    if (event.type === "assistant_delta") {
      this.publish(conversationId, event, false);
      return;
    }
    if (event.type === "session") {
      this.store.updateConversation(this.projectId, conversationId, { harnessSessionId: event.harnessSessionId });
    }
    if (event.type === "tool_use") {
      const input = event.input as Record<string, unknown> | undefined;
      const summary = typeof input?.command === "string" ? input.command : typeof input?.file_path === "string" ? input.file_path : "";
      this.host.log("info", "tool", `${event.name}${summary ? `: ${String(summary).slice(0, 300)}` : ""}`);
    }
    this.publish(conversationId, event);
    if (event.type === "result") {
      if (event.isError) this.host.log("error", "harness", `Turn ended with ${event.subtype}${event.text ? `: ${event.text}` : ""}`);
      this.setStatus(conversationId, "idle");
    } else if ((event.type === "assistant" || event.type === "tool_use") && this.status === "idle") {
      // A background task reported and the session resumed on its own.
      this.setStatus(conversationId, "running");
    }
  }

  /** Send the person's message into the harness session. */
  send(conversationId: string | undefined, text: string, origin: "chat" | "approval" | "action" = "chat"): Conversation {
    const message = text.trim();
    if (!message) throw new ChatError(400, "Message is empty.");
    if (message.length > 60000) throw new ChatError(400, "Message is too long.");
    let conversation = conversationId ? this.store.conversation(this.projectId, conversationId) : undefined;
    if (conversationId && !conversation) throw new ChatError(404, "Conversation not found.");
    conversation ??= this.store.createConversation(this.projectId, this.host.project().harness);
    const session = this.ensureSession(conversation);
    if (conversation.title === "New conversation") {
      const title = message.replace(/^\/aidlc\s*/, "").replace(/\s+/g, " ").slice(0, 60) || message.slice(0, 60);
      conversation = this.store.updateConversation(this.projectId, conversation.id, { title: redact(title) }) ?? conversation;
    } else {
      this.store.updateConversation(this.projectId, conversation.id, {});
    }
    this.publish(conversation.id, { type: "user", text: redact(message), origin });
    // Before the send: the harness may ask a question straight away, and that
    // "waiting for you" state must not be overwritten.
    this.setStatus(conversation.id, "running");
    session.send(message);
    return conversation;
  }

  async stop(): Promise<void> {
    if (!this.session || !this.sessionConversation) return;
    const convId = this.sessionConversation;
    this.cancelPending(convId);
    await this.session.interrupt();
    this.host.log("info", "harness", "Turn interrupted by the user.");
    this.setStatus(convId, "idle", "interrupted");
  }

  async endSession(reason: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.host.log("info", "harness", reason);
    await session.close();
  }

  answerQuestion(id: string, answers: Record<string, string | string[]> | null): void {
    const pending = this.questions.get(id);
    if (!pending) throw new ChatError(404, "That question is no longer open.");
    if (answers !== null) {
      for (const q of pending.questions) {
        const value = answers[q.question];
        const ok = typeof value === "string" ? value.trim() !== "" : Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
        if (!ok) throw new ChatError(400, `No answer given for: ${q.question}`);
      }
    }
    pending.resolve(answers);
  }

  decidePermission(id: string, allow: boolean, message?: string): { toolName: string; input: unknown } {
    const pending = this.permissions.get(id);
    if (!pending) throw new ChatError(404, "That permission request is no longer open.");
    pending.resolve({ allow, message });
    return { toolName: pending.toolName, input: pending.input };
  }

  openQuestions(): Array<{ id: string; conversationId: string; questions: AskQuestion[] }> {
    return [...this.questions.values()].map((q) => ({ id: q.id, conversationId: q.conversationId, questions: q.questions }));
  }

  activeConversationId(): string | null {
    return this.sessionConversation;
  }

  async dispose(): Promise<void> {
    await this.endSession("Studio is shutting down.");
  }
}
