// HTTP API: access control, project and file routes, and the chat flow
// (messages, questions, permissions, stop, session persistence) against a
// scripted harness adapter.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { FakeHarness, openEvents, removeDir, startServer, tempDir, type TestServer } from "../helpers.ts";

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("access control", () => {
  let dataDir: string;
  let server: TestServer;
  before(async () => {
    dataDir = tempDir("auth");
    server = await startServer({ dataDir, watch: false });
  });
  after(async () => {
    await server.close();
    removeDir(dataDir);
  });

  it("answers health without a token but nothing else", async () => {
    assert.equal((await server.api("/api/health", { noAuth: true })).status, 200);
    for (const route of ["/api/projects", "/api/system", "/api/workspace", "/api/fs/browse"]) {
      const res = await server.api(route, { noAuth: true });
      assert.equal(res.status, 401, route);
    }
    assert.equal((await server.api("/api/projects", { noAuth: true, headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await server.api("/api/projects")).status, 200);
  });

  it("exchanges the launch token for an HttpOnly, SameSite=Strict cookie", async () => {
    const bad = await server.api("/api/auth/session", { method: "POST", noAuth: true, json: { token: "nope" } });
    assert.equal(bad.status, 401);
    const res = await fetch(`${server.base}/api/auth/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: server.token }) });
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const viaCookie = await fetch(`${server.base}/api/projects`, { headers: { Cookie: cookie.split(";")[0] } });
    assert.equal(viaCookie.status, 200);
  });

  it("rejects foreign Host and Origin headers (DNS rebinding, cross-site requests)", async () => {
    // fetch() will not send a forged Host header, so speak HTTP directly.
    const rebound = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: server.port, path: "/api/projects", headers: { Host: "evil.example", Authorization: `Bearer ${server.token}` } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(rebound.status, 403);
    assert.match(rebound.body, /forbidden_host/);
    const crossSite = await server.api("/api/projects", { method: "POST", json: { path: "C:\\x" }, headers: { Origin: "https://evil.example" } });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.body.error, "forbidden_origin");
    const sameOrigin = await server.api("/api/projects", { headers: { Origin: server.base } });
    assert.equal(sameOrigin.status, 200);
  });

  it("sets defensive headers and never serves API data cacheably", async () => {
    const res = await fetch(`${server.base}/api/health`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  it("returns clean errors for bad input", async () => {
    const notJson = await fetch(`${server.base}/api/projects`, { method: "POST", headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(notJson.status, 400);
    assert.equal((await server.api("/api/nope")).status, 404);
    assert.equal((await server.api("/api/projects/doesnotexist/snapshot")).status, 404);
    assert.equal((await server.api("/api/projects", { method: "POST", json: { path: "" } })).status, 400);
    assert.equal((await server.api("/api/projects", { method: "POST", json: { path: path.join(dataDir, "missing-folder") } })).status, 404);
  });
});

describe("projects, files and chat", () => {
  let dataDir: string;
  let projectDir: string;
  let server: TestServer;
  let harness: FakeHarness;
  let id: string;
  const p = (suffix: string): string => `/api/projects/${id}${suffix}`;

  before(async () => {
    dataDir = tempDir("api");
    projectDir = tempDir("api-proj");
    mkdirSync(path.join(projectDir, "src"));
    writeFileSync(path.join(projectDir, "src", "index.js"), "console.log('hi');\n");
    writeFileSync(path.join(projectDir, ".env"), "TOKEN=abc123456789\n");
    writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "node build.js", "bad name; rm": "x" } }));
    harness = new FakeHarness();
    server = await startServer({ dataDir, adapters: [harness], watch: false });
    const opened = await server.api("/api/projects", { method: "POST", json: { path: projectDir } });
    id = opened.body.project.id;
  });
  after(async () => {
    await server.close();
    removeDir(dataDir);
    removeDir(projectDir);
  });

  it("creates a new project folder only inside an existing parent, and never reuses a non-empty one", async () => {
    const parent = tempDir("new-parent");
    const created = await server.api("/api/projects", { method: "POST", json: { path: path.join(parent, "fresh"), create: true, name: "Fresh" } });
    assert.equal(created.status, 200);
    assert.ok(existsSync(path.join(parent, "fresh")));
    assert.equal(created.body.project.name, "Fresh");
    assert.equal((await server.api("/api/projects", { method: "POST", json: { path: path.join(parent, "a", "b"), create: true } })).status, 400);
    assert.equal((await server.api("/api/projects", { method: "POST", json: { path: projectDir, create: true } })).status, 409);
    assert.equal((await server.api(`/api/projects/${created.body.project.id}`, { method: "DELETE" })).body.ok, true);
    assert.ok(existsSync(path.join(parent, "fresh")), "forgetting a project never deletes its folder");
    removeDir(parent);
  });

  it("reports a project without AI-DLC honestly", async () => {
    const snap = (await server.api(p("/snapshot"))).body;
    assert.equal(snap.install.installed, false);
    assert.equal(snap.lifecycle, null);
    assert.deepEqual(snap.intents, []);
    assert.deepEqual(snap.gates, []);
    assert.deepEqual(snap.agents, []);
  });

  it("serves the tree and files inside the project only", async () => {
    const tree = (await server.api(p("/tree?dir="))).body.entries;
    assert.deepEqual(tree.map((e: { name: string }) => e.name), ["src", ".env", "package.json"]);
    assert.equal((await server.api(p("/file?path=src/index.js"))).body.content, "console.log('hi');\n");
    for (const bad of ["../outside.txt", "..%5C..%5CWindows%5Cwin.ini", "C:%5CWindows%5Cwin.ini", "/etc/passwd", "src/../../x"]) {
      const res = await server.api(p(`/file?path=${bad}`));
      assert.ok(res.status === 403 || res.status === 400, `${bad} -> ${res.status}`);
    }
    assert.equal((await server.api(p("/tree?dir=../"))).status, 403);
    assert.equal((await server.api(p("/file?path=src/nope.js"))).status, 404);
  });

  it("keeps .env out of reach unless revealed on purpose", async () => {
    const hidden = await server.api(p("/file?path=.env"));
    assert.equal(hidden.status, 403);
    assert.equal(hidden.body.error, "sensitive");
    assert.equal((await server.api(p("/file?path=.env&reveal=1"))).body.content, "TOKEN=abc123456789\n");
    assert.equal((await server.api(p("/search?q=abc123456789"))).body.hits.length, 0);
  });

  it("saves files with conflict detection and refuses writes outside", async () => {
    const file = (await server.api(p("/file?path=src/index.js"))).body;
    const saved = await server.api(p("/file"), { method: "PUT", json: { path: "src/index.js", content: "console.log('saved');\n", expectedMtime: file.mtime } });
    assert.equal(saved.status, 200);
    assert.equal(readFileSync(path.join(projectDir, "src", "index.js"), "utf8"), "console.log('saved');\n");
    const stale = await server.api(p("/file"), { method: "PUT", json: { path: "src/index.js", content: "x", expectedMtime: file.mtime - 10000 } });
    assert.equal(stale.status, 409);
    assert.equal((await server.api(p("/file"), { method: "PUT", json: { path: "../evil.js", content: "x", create: true } })).status, 403);
    assert.equal((await server.api(p("/file"), { method: "PUT", json: { path: ".git/hooks/pre-commit", content: "x", create: true } })).status, 403);
  });

  it("offers only allowlisted commands and rejects anything else", async () => {
    const commands = (await server.api(p("/commands"))).body.commands as Array<{ id: string; display: string }>;
    const ids = commands.map((c) => c.id);
    assert.ok(ids.includes("script:test"));
    assert.ok(ids.includes("script:build"));
    assert.ok(!ids.some((i) => i.includes("rm")), "a script with an unsafe name is not offered");
    assert.ok(!ids.some((i) => i.startsWith("aidlc:")), "no engine commands without an installed engine");
    for (const attempt of ["powershell -c whoami", "script:test && whoami", "../x", ""]) {
      const res = await server.api(p("/commands/run"), { method: "POST", json: { id: attempt } });
      assert.equal(res.status, 400, attempt);
    }
  });

  it("treats a project inside another repository as not a repository", async () => {
    const git = (await server.api(p("/git/status"))).body;
    assert.equal(git.isRepo, false);
    assert.ok(typeof git.note === "string" && git.note.length > 0);
  });

  it("sends chat through the harness, persists it, and records the harness session", async () => {
    const stream = openEvents(server, id);
    await stream.waitFor((e) => e.type === "hello");
    harness.onSend = (text, cb) => {
      cb.onEvent({ type: "assistant_delta", text: "Work", messageId: "m1" });
      cb.onEvent({ type: "assistant", text: `Working on: ${text}` });
      cb.onEvent({ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789" } });
      cb.onEvent({ type: "tool_result", id: "tool-1", name: "Bash", text: "ok", isError: false });
      cb.onEvent({ type: "result", subtype: "success", isError: false, turns: 2 });
    };
    const sent = await server.api(p("/chat/send"), { method: "POST", json: { text: "/aidlc Build a user authentication system" } });
    assert.equal(sent.status, 200);
    const convId = sent.body.conversation.id;
    await stream.waitFor((e) => e.type === "chat" && e.data.type === "result");
    assert.deepEqual(harness.sent, ["/aidlc Build a user authentication system"]);
    assert.equal(harness.starts[0].projectDir, projectDir);
    assert.equal(harness.starts[0].settings.permissionMode, "default");

    const live = stream.events.filter((e) => e.type === "chat").map((e) => e.data.type);
    assert.ok(live.includes("assistant_delta"), "streaming deltas reach the client");
    const events = (await server.api(p(`/conversations/${convId}/events`))).body.events as Array<{ type: string; text?: string }>;
    assert.deepEqual(events.map((e) => e.type).filter((t) => t !== "session"), ["user", "assistant", "tool_use", "tool_result", "result"]);
    assert.equal(events.filter((e) => e.type === "session").length, 1);
    assert.ok(!events.some((e) => e.type === "assistant_delta"), "deltas are not persisted");
    const conversations = (await server.api(p("/conversations"))).body;
    assert.equal(conversations.conversations[0].title, "Build a user authentication system");
    assert.equal(conversations.conversations[0].harnessSessionId, "fake-session-1");
    assert.equal(conversations.chat.status, "idle");
    const logs = (await server.api(p("/logs"))).body.lines as Array<{ text: string }>;
    assert.ok(logs.some((l) => l.text.startsWith("Bash: echo")));
    assert.ok(!JSON.stringify(logs).includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "secrets are redacted from logs");
    stream.close();
  });

  it("holds a harness question until the person answers it, and validates the answer", async () => {
    const convId = (await server.api(p("/conversations"))).body.conversations[0].id;
    const questions = [{ header: "Gate", question: "Approve the requirements?", options: [{ label: "Approve" }, { label: "Request Changes" }] }];
    let answered: unknown = "pending";
    harness.onSend = (_text, cb) => {
      void cb.askQuestion("q-1", questions, new AbortController().signal).then((answers) => {
        answered = answers;
        cb.onEvent({ type: "result", subtype: "success", isError: false });
      });
    };
    await server.api(p("/chat/send"), { method: "POST", json: { conversationId: convId, text: "continue" } });
    await tick();
    assert.equal(answered, "pending", "the question is not answered by Studio");
    let status = (await server.api(p("/conversations"))).body.chat;
    assert.equal(status.status, "waiting_input");
    assert.deepEqual(status.pendingQuestions, ["q-1"]);

    const missing = await server.api(p("/chat/answer"), { method: "POST", json: { id: "q-1", answers: {} } });
    assert.equal(missing.status, 400);
    assert.equal((await server.api(p("/chat/answer"), { method: "POST", json: { id: "q-unknown", answers: {} } })).status, 404);
    assert.equal(answered, "pending");

    const ok = await server.api(p("/chat/answer"), { method: "POST", json: { id: "q-1", answers: { "Approve the requirements?": "Approve" } } });
    assert.equal(ok.status, 200);
    await tick();
    assert.deepEqual(answered, { "Approve the requirements?": "Approve" });
    status = (await server.api(p("/conversations"))).body.chat;
    assert.deepEqual(status.pendingQuestions, []);
    assert.equal((await server.api(p("/chat/answer"), { method: "POST", json: { id: "q-1", answers: { "Approve the requirements?": "Approve" } } })).status, 404, "an answer cannot be replayed");
    const audit = (await server.api(p("/audit"))).body.entries as Array<{ action: string }>;
    assert.ok(audit.some((e) => e.action === "chat.answer"));
  });

  it("asks the person before a tool the settings do not pre-approve, and honours a denial", async () => {
    const convId = (await server.api(p("/conversations"))).body.conversations[0].id;
    let decision: unknown = "pending";
    harness.onSend = (_text, cb) => {
      void cb.askPermission("p-1", "Bash", { command: "rm -rf build" }, "not pre-approved", new AbortController().signal).then((d) => {
        decision = d;
      });
    };
    await server.api(p("/chat/send"), { method: "POST", json: { conversationId: convId, text: "clean up" } });
    await tick();
    assert.equal(decision, "pending");
    assert.equal((await server.api(p("/chat/permission"), { method: "POST", json: { id: "p-1", decision: "maybe" } })).status, 400);
    const denied = await server.api(p("/chat/permission"), { method: "POST", json: { id: "p-1", decision: "deny", message: "keep the build folder" } });
    assert.equal(denied.status, 200);
    await tick();
    assert.deepEqual(decision, { allow: false, message: "keep the build folder" });
    const audit = (await server.api(p("/audit"))).body.entries as Array<{ action: string; detail: { decision?: string; tool?: string } }>;
    const entry = audit.find((e) => e.action === "permission.decide");
    assert.equal(entry?.detail.decision, "deny");
    assert.equal(entry?.detail.tool, "Bash");
  });

  it("stops generation and treats open requests as unanswered", async () => {
    const convId = (await server.api(p("/conversations"))).body.conversations[0].id;
    let answered: unknown = "pending";
    harness.onSend = (_text, cb) => {
      void cb.askQuestion("q-2", [{ question: "Pick", options: [{ label: "A" }] }], new AbortController().signal).then((a) => {
        answered = a;
      });
    };
    await server.api(p("/chat/send"), { method: "POST", json: { conversationId: convId, text: "go" } });
    await tick();
    const stopped = await server.api(p("/chat/stop"), { method: "POST" });
    assert.equal(stopped.status, 200);
    await tick();
    assert.equal(harness.interrupted, 1);
    assert.equal(answered, null, "a stop never answers a question on the person's behalf");
    assert.equal((await server.api(p("/conversations"))).body.chat.status, "idle");
  });

  it("rejects empty messages and unknown conversations", async () => {
    assert.equal((await server.api(p("/chat/send"), { method: "POST", json: { text: "   " } })).status, 400);
    assert.equal((await server.api(p("/chat/send"), { method: "POST", json: { conversationId: "00000000-0000-0000-0000-000000000000", text: "hi" } })).status, 404);
  });

  it("resumes the recorded harness session after a restart, with history intact", async () => {
    const before = (await server.api(p("/conversations"))).body.conversations[0];
    const eventsBefore = (await server.api(p(`/conversations/${before.id}/events`))).body.events.length;
    await server.close();
    harness = new FakeHarness();
    server = await startServer({ dataDir, adapters: [harness], watch: false });
    const conversations = (await server.api(p("/conversations"))).body;
    assert.equal(conversations.conversations[0].id, before.id);
    assert.equal(conversations.chat.status, "idle");
    const restored = (await server.api(p(`/conversations/${before.id}/events`))).body.events as Array<{ type: string; id?: string; answers?: unknown }>;
    assert.ok(restored.length >= eventsBefore);
    await server.api(p("/chat/send"), { method: "POST", json: { conversationId: before.id, text: "/aidlc --resume" } });
    assert.equal(harness.starts[0].resume, "fake-session-1");
    assert.deepEqual(harness.sent, ["/aidlc --resume"]);
  });

  it("carries a gate decision into the harness session as the person's reply, and only for an open gate", async () => {
    // The engine's guards (rightly) refuse to open a gate without real stage
    // output, so this test supplies the engine's view of an open gate and
    // checks everything Studio does with it.
    const runtime = server.studio.runtimes.get(id)!;
    const real = runtime.snapshot.bind(runtime);
    let gateOpen = true;
    runtime.snapshot = async () => {
      const snap = await real();
      return gateOpen ? { ...snap, gates: [{ stage: "requirements-analysis", stageName: "Requirements Analysis", state: "awaiting_approval" as const, artifacts: [] }] } : snap;
    };
    harness.sent.length = 0;
    harness.onSend = null;

    const wrongStage = await server.api(p("/approvals"), { method: "POST", json: { stage: "code-generation", decision: "approve" } });
    assert.equal(wrongStage.status, 409);
    const noReason = await server.api(p("/approvals"), { method: "POST", json: { stage: "requirements-analysis", decision: "reject" } });
    assert.equal(noReason.status, 400);
    assert.equal((await server.api(p("/approvals"), { method: "POST", json: { stage: "requirements-analysis", decision: "maybe" } })).status, 400);
    assert.deepEqual(harness.sent, [], "nothing reaches the harness for a refused decision");

    const rejected = await server.api(p("/approvals"), { method: "POST", json: { stage: "requirements-analysis", decision: "reject", comment: "Add an offline mode" } });
    assert.equal(rejected.status, 200);
    const approved = await server.api(p("/approvals"), { method: "POST", json: { stage: "requirements-analysis", decision: "approve" } });
    assert.equal(approved.status, 200);
    assert.deepEqual(harness.sent, ["Request changes: Add an offline mode", "Approve"]);

    const events = (await server.api(p(`/conversations/${approved.body.conversation.id}/events`))).body.events as Array<{ type: string; origin?: string; text?: string }>;
    assert.equal(events.filter((e) => e.type === "user" && e.origin === "approval").length, 2);
    const audit = (await server.api(p("/audit"))).body.entries as Array<{ action: string; detail: { decision?: string; stage?: string; comment?: string } }>;
    const decisions = audit.filter((e) => e.action === "approval.decide");
    assert.deepEqual(decisions.map((d) => d.detail.decision).sort(), ["approve", "reject"]);
    assert.equal(decisions.find((d) => d.detail.decision === "reject")?.detail.comment, "Add an offline mode");

    gateOpen = false;
    const closed = await server.api(p("/approvals"), { method: "POST", json: { stage: "requirements-analysis", decision: "approve" } });
    assert.equal(closed.status, 409, "a gate the engine no longer shows as open cannot be approved");
    assert.equal(harness.sent.length, 2);
    runtime.snapshot = real;
  });

  it("explains when the selected harness has no in-app chat", async () => {
    await server.api(`/api/projects/${id}`, { method: "PATCH", json: { harness: "codex" } });
    const res = await server.api(p("/chat/send"), { method: "POST", json: { text: "hello" } });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /no in-app chat adapter/);
    assert.equal((await server.api(`/api/projects/${id}`, { method: "PATCH", json: { harness: "not-a-harness" } })).status, 400);
    const modes = await server.api(`/api/projects/${id}`, { method: "PATCH", json: { harness: "claude", settings: { permissionMode: "bypassPermissions" } } });
    assert.equal(modes.body.project.settings.permissionMode, "default", "a permission-bypass mode cannot be set");
  });
});
