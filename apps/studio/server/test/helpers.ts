// Test helpers: a Studio server on an ephemeral loopback port with its own
// data dir, and a scripted harness adapter for chat-flow tests.

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createApp, type StudioApp } from "../src/app.ts";
import type { HarnessAdapter, HarnessCallbacks, HarnessSession, HarnessStartOptions } from "../src/harness/types.ts";
import { Store } from "../src/store.ts";

export function tempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `aidlc-studio-${prefix}-`));
}

export function removeDir(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // Windows can hold a handle for a moment after a process exits.
    }
  }
}

export interface TestServer {
  studio: StudioApp;
  store: Store;
  base: string;
  token: string;
  port: number;
  api(pathname: string, init?: RequestInit & { json?: unknown; noAuth?: boolean }): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

export async function startServer(options: { dataDir: string; adapters?: HarnessAdapter[]; watch?: boolean }): Promise<TestServer> {
  const token = "t".repeat(64);
  const store = new Store(options.dataDir);
  const allowedHosts = new Set<string>();
  const studio = createApp({ store, auth: { token, allowedHosts }, adapters: options.adapters, watch: options.watch });
  const server: Server = await new Promise((resolve) => {
    const s = studio.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  allowedHosts.add(`127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;
  return {
    studio,
    store,
    base,
    token,
    port,
    async api(pathname, init = {}) {
      const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
      if (!init.noAuth) headers.Authorization = `Bearer ${token}`;
      let body = init.body;
      if (init.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(init.json);
      }
      const res = await fetch(`${base}${pathname}`, { ...init, headers, body });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: res.status, body: parsed };
    },
    async close() {
      await studio.dispose();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Collect Server-Sent Events from a project stream until closed. */
export function openEvents(server: TestServer, projectId: string): { events: Array<{ type: string; data: any }>; waitFor(pred: (e: { type: string; data: any }) => boolean, ms?: number): Promise<{ type: string; data: any }>; close(): void } {
  const controller = new AbortController();
  const events: Array<{ type: string; data: any }> = [];
  const waiters: Array<{ pred: (e: { type: string; data: any }) => boolean; resolve: (e: { type: string; data: any }) => void }> = [];
  void (async () => {
    try {
      const res = await fetch(`${server.base}/api/projects/${projectId}/events`, { headers: { Authorization: `Bearer ${server.token}` }, signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at: number;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!type || !data) continue;
          const event = { type, data: JSON.parse(data) };
          events.push(event);
          for (const waiter of [...waiters]) {
            if (waiter.pred(event)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve(event);
            }
          }
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    events,
    waitFor(pred, ms = 20000) {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for a stream event")), ms);
        waiters.push({
          pred,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
    close: () => controller.abort(),
  };
}

/** A scripted harness: records what it was sent and lets a test drive callbacks. */
export class FakeHarness implements HarnessAdapter {
  readonly id = "claude";
  starts: HarnessStartOptions[] = [];
  sent: string[] = [];
  callbacks: HarnessCallbacks | null = null;
  interrupted = 0;
  closed = 0;
  onSend: ((text: string, cb: HarnessCallbacks) => void) | null = null;
  unavailable: string | null = null;

  unavailableReason(): string | null {
    return this.unavailable;
  }

  start(options: HarnessStartOptions): HarnessSession {
    this.starts.push(options);
    this.callbacks = options.callbacks;
    let alive = true;
    const self = this;
    queueMicrotask(() => options.callbacks.onEvent({ type: "session", harnessSessionId: options.resume ?? `fake-session-${this.starts.length}`, model: "fake" }));
    return {
      get alive() {
        return alive;
      },
      send(text: string) {
        self.sent.push(text);
        self.onSend?.(text, options.callbacks);
      },
      async interrupt() {
        self.interrupted++;
      },
      async close() {
        if (!alive) return;
        alive = false;
        self.closed++;
        options.callbacks.onClosed();
      },
    };
  }
}
