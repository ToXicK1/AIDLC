// The Studio HTTP API. REST for project and workflow management, one
// Server-Sent Events stream per project for everything live.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { SystemInfo } from "../../shared/types.ts";
import { ChatError } from "./chat.ts";
import { probeNativeAidlc } from "./engine/engine.ts";
import { engineRepoRoot, initProject } from "./engine/install.ts";
import { findFiles, listDir, readFile, searchFiles, writeFile } from "./files.ts";
import { gitDiff, gitOriginal, gitStatus } from "./git.ts";
import { findClaudeExecutable } from "./harness/claude.ts";
import { HARNESSES, harnessById } from "./harness/registry.ts";
import type { HarnessAdapter } from "./harness/types.ts";
import { cleanEnv, run, which } from "./proc.ts";
import { ProjectRuntime } from "./project.ts";
import { type AuthConfig, hostGuard, requireAuth, sessionHandler } from "./security/auth.ts";
import { PathError, validateProjectRoot } from "./security/paths.ts";
import { redact } from "./security/redact.ts";
import type { Store } from "./store.ts";
import { readCoverage } from "./testing.ts";

export interface AppOptions {
  store: Store;
  auth: AuthConfig;
  /** Built web client to serve (production). */
  staticDir?: string;
  adapters?: HarnessAdapter[];
  watch?: boolean;
}

export interface StudioApp {
  app: express.Express;
  runtimes: Map<string, ProjectRuntime>;
  dispose(): Promise<void>;
}

const PATH_STATUS: Record<string, number> = {
  invalid: 400,
  absolute: 400,
  traversal: 403,
  sensitive: 403,
  protected: 403,
  root: 400,
  not_file: 400,
  not_found: 404,
  conflict: 409,
  too_large: 413,
};

async function toolVersion(command: string, args: string[]): Promise<{ ok: boolean; version?: string; path?: string; error?: string }> {
  const file = path.isAbsolute(command) ? command : which(command);
  if (!file) return { ok: false, error: "not found on PATH" };
  const result = await run(file, args, { cwd: os.homedir(), env: cleanEnv({ NO_COLOR: "1" }), timeoutMs: 15000 });
  if (result.code === 0) return { ok: true, path: file, version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] };
  return { ok: false, path: file, error: redact((result.error || result.stderr || `exit ${result.code}`).trim().split(/\r?\n/)[0]) };
}

export function createApp(options: AppOptions): StudioApp {
  const { store, auth } = options;
  const app = express();
  const runtimes = new Map<string, ProjectRuntime>();
  let systemInfo: Promise<SystemInfo> | null = null;

  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(hostGuard(auth));
  app.use(express.json({ limit: "6mb" }));

  const api = express.Router();
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, name: "aidlc-studio" });
  });
  app.post("/api/auth/session", sessionHandler(auth));
  app.use("/api", requireAuth(auth), api);

  const runtimeFor = (id: string): ProjectRuntime => {
    const existing = runtimes.get(id);
    if (existing) return existing;
    const record = store.project(id);
    if (!record) throw new ChatError(404, "Project not found. Open it again from the project list.");
    if (!existsSync(record.path)) throw new ChatError(410, `The project folder no longer exists: ${record.path}`);
    const runtime = new ProjectRuntime(record, store, { adapters: options.adapters, watch: options.watch });
    runtimes.set(id, runtime);
    return runtime;
  };

  const wrap =
    (handler: (req: Request, res: Response) => unknown | Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      Promise.resolve()
        .then(() => handler(req, res))
        .catch(next);
    };

  const str = (value: unknown): string => (typeof value === "string" ? value : "");

  // ----- system -----

  const loadSystem = async (): Promise<SystemInfo> => {
    const claude = findClaudeExecutable();
    const [bun, git, claudeInfo, native] = await Promise.all([
      toolVersion("bun", ["--version"]),
      toolVersion("git", ["--version"]),
      claude ? toolVersion(claude, ["--version"]) : Promise.resolve({ ok: false, error: "not found on PATH" }),
      probeNativeAidlc(),
    ]);
    return {
      platform: `${process.platform} ${os.release()}`,
      node: process.version,
      tools: { bun, git, claude: claudeInfo, aidlc: native },
      engineRepo: engineRepoRoot(),
      harnesses: HARNESSES,
      dataDir: store.dir,
    };
  };

  api.get(
    "/system",
    wrap(async (req, res) => {
      if (!systemInfo || req.query.refresh === "1") systemInfo = loadSystem();
      res.json(await systemInfo);
    }),
  );

  api.get(
    "/workspace",
    wrap((_req, res) => {
      res.json({ workspace: store.workspace(), lastProjectId: store.lastProjectId() });
    }),
  );

  api.put(
    "/workspace",
    wrap((req, res) => {
      const value = req.body?.workspace;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChatError(400, "workspace must be an object.");
      if (JSON.stringify(value).length > 200000) throw new ChatError(413, "Workspace state is too large.");
      store.setWorkspace(value as Record<string, unknown>);
      res.json({ ok: true });
    }),
  );

  // Folder picker: directory names only, never file contents.
  api.get(
    "/fs/browse",
    wrap((req, res) => {
      const requested = str(req.query.path);
      if (!requested) {
        const drives: Array<{ name: string; path: string }> = [];
        if (process.platform === "win32") {
          for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
            const root = `${letter}:\\`;
            if (existsSync(root)) drives.push({ name: root, path: root });
          }
        } else {
          drives.push({ name: "/", path: "/" });
        }
        res.json({ path: "", parent: null, home: os.homedir(), dirs: drives });
        return;
      }
      if (requested.includes("\0")) throw new PathError("invalid", "Path contains a NUL byte.");
      const abs = path.resolve(requested);
      const stat = statSync(abs);
      if (!stat.isDirectory()) throw new PathError("invalid", "That path is not a folder.");
      const dirs: Array<{ name: string; path: string }> = [];
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith("$")) continue;
        dirs.push({ name: entry.name, path: path.join(abs, entry.name) });
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      const parent = path.dirname(abs);
      res.json({ path: abs, parent: parent === abs ? "" : parent, home: os.homedir(), dirs: dirs.slice(0, 2000) });
    }),
  );

  // ----- projects -----

  api.get(
    "/projects",
    wrap((_req, res) => {
      res.json({
        projects: store.projects().map((p) => ({ ...p, exists: existsSync(p.path) })),
        lastProjectId: store.lastProjectId(),
      });
    }),
  );

  api.post(
    "/projects",
    wrap((req, res) => {
      const root = validateProjectRoot(req.body?.path);
      const create = req.body?.create === true;
      if (!existsSync(root)) {
        if (!create) throw new ChatError(404, `Folder not found: ${root}`);
        if (!existsSync(path.dirname(root))) throw new ChatError(400, `The parent folder does not exist: ${path.dirname(root)}`);
        mkdirSync(root);
        store.audit("project.create", { path: root });
      } else if (!statSync(root).isDirectory()) {
        throw new ChatError(400, "That path is not a folder.");
      } else if (create && readdirSync(root).length > 0) {
        throw new ChatError(409, "That folder already exists and is not empty. Use Open Existing Project instead.");
      }
      const record = store.upsertProject(root, str(req.body?.name) || undefined);
      store.audit("project.open", { path: root }, record.id);
      runtimeFor(record.id);
      res.json({ project: record });
    }),
  );

  api.patch(
    "/projects/:id",
    wrap((req, res) => {
      const body = req.body ?? {};
      const patch: Parameters<Store["updateProject"]>[1] = {};
      if (typeof body.name === "string") patch.name = body.name.slice(0, 120);
      if (typeof body.harness === "string") {
        if (!harnessById(body.harness)) throw new ChatError(400, "Unknown harness.");
        patch.harness = body.harness;
      }
      if (body.settings && typeof body.settings === "object") {
        const settings: Record<string, string> = {};
        if (["default", "acceptEdits", "plan"].includes(body.settings.permissionMode)) settings.permissionMode = body.settings.permissionMode;
        if (typeof body.settings.model === "string" && /^[A-Za-z0-9._:\[\]-]{0,80}$/.test(body.settings.model)) settings.model = body.settings.model;
        patch.settings = settings as never;
      }
      const record = store.updateProject(str(req.params.id), patch);
      if (!record) throw new ChatError(404, "Project not found.");
      store.audit("project.settings", { patch }, record.id);
      const runtime = runtimes.get(record.id);
      if (runtime && (patch.harness || patch.settings)) void runtime.chat.endSession("Project settings changed; the next message starts a session with them.");
      res.json({ project: record });
    }),
  );

  api.delete(
    "/projects/:id",
    wrap(async (req, res) => {
      const runtime = runtimes.get(str(req.params.id));
      if (runtime) {
        await runtime.dispose();
        runtimes.delete(str(req.params.id));
      }
      const removed = store.removeProject(str(req.params.id));
      store.audit("project.forget", { removed }, str(req.params.id));
      res.json({ ok: removed });
    }),
  );

  const project = express.Router({ mergeParams: true });
  api.use("/projects/:id", project);
  const rt = (req: Request): ProjectRuntime => runtimeFor(str(req.params.id));

  project.get(
    "/snapshot",
    wrap(async (req, res) => {
      res.json(await rt(req).snapshot());
    }),
  );

  project.get("/events", (req, res, next) => {
    try {
      rt(req).attach(res);
    } catch (error) {
      next(error);
    }
  });

  project.post(
    "/init",
    wrap(async (req, res) => {
      const runtime = rt(req);
      const harnessId = str(req.body?.harness) || runtime.record().harness;
      if (!harnessById(harnessId)) throw new ChatError(400, "Unknown harness.");
      runtime.log("info", "setup", `Setting up AI-DLC for ${harnessId}…`);
      const route = ["auto", "native", "bun"].includes(str(req.body?.runtime)) ? (str(req.body?.runtime) as "auto" | "native" | "bun") : "auto";
      const result = await initProject(runtime.projectDir, harnessId, route);
      runtime.log(result.ok ? "info" : "error", "setup", `${result.message}\n${result.log}`);
      store.audit("project.init", { harness: harnessId, ok: result.ok, route: result.route, copied: result.copied, skipped: result.skipped.length }, runtime.id);
      if (result.ok) store.updateProject(runtime.id, { harness: harnessId });
      const snapshot = await runtime.snapshot(true);
      res.status(result.ok ? 200 : 409).json({ result, snapshot });
    }),
  );

  project.post(
    "/doctor",
    wrap(async (req, res) => {
      const runtime = rt(req);
      const result = await runtime.engine.exec(["doctor", "--json", "--offline"], { timeoutMs: 180000 });
      let report: unknown = null;
      try {
        report = JSON.parse(result.stdout);
      } catch {
        report = null;
      }
      runtime.log("info", "engine", `doctor: ${(report as { message?: string } | null)?.message ?? (result.error || result.stderr || "no result").trim()}`);
      store.audit("engine.doctor", { code: result.code }, runtime.id);
      res.json({ ok: result.code === 0, report, raw: report ? undefined : redact(result.stdout + result.stderr + (result.error ?? "")) });
    }),
  );

  project.get(
    "/status-text",
    wrap(async (req, res) => {
      const result = await rt(req).engine.exec(["engine", "status"]);
      res.json({ text: redact(result.stdout || result.stderr || result.error || "") });
    }),
  );

  // ----- files -----

  project.get(
    "/tree",
    wrap((req, res) => {
      res.json({ entries: listDir(rt(req).projectDir, str(req.query.dir)) });
    }),
  );

  project.get(
    "/file",
    wrap((req, res) => {
      res.json(readFile(rt(req).projectDir, str(req.query.path), req.query.reveal === "1"));
    }),
  );

  project.put(
    "/file",
    wrap((req, res) => {
      const runtime = rt(req);
      const body = req.body ?? {};
      const saved = writeFile(runtime.projectDir, str(body.path), body.content, {
        expectedMtime: typeof body.expectedMtime === "number" ? body.expectedMtime : undefined,
        create: body.create === true,
        confirmSensitive: body.confirmSensitive === true,
      });
      store.audit("file.save", { path: saved.path, created: saved.created }, runtime.id);
      res.json(saved);
    }),
  );

  project.get(
    "/search",
    wrap((req, res) => {
      res.json(searchFiles(rt(req).projectDir, str(req.query.q), { regex: req.query.regex === "1", caseSensitive: req.query.case === "1" }));
    }),
  );

  project.get(
    "/find",
    wrap((req, res) => {
      const q = str(req.query.q);
      res.json({ files: q ? findFiles(rt(req).projectDir, q) : [] });
    }),
  );

  project.get(
    "/changes",
    wrap((req, res) => {
      res.json({ changes: rt(req).sessionChanges() });
    }),
  );

  // ----- git -----

  project.get(
    "/git/status",
    wrap(async (req, res) => {
      res.json(await gitStatus(rt(req).projectDir));
    }),
  );
  project.get(
    "/git/diff",
    wrap(async (req, res) => {
      res.json(await gitDiff(rt(req).projectDir, str(req.query.path)));
    }),
  );
  project.get(
    "/git/original",
    wrap(async (req, res) => {
      res.json(await gitOriginal(rt(req).projectDir, str(req.query.path)));
    }),
  );

  // ----- chat -----

  project.get(
    "/conversations",
    wrap((req, res) => {
      const runtime = rt(req);
      res.json({ conversations: runtime.chat.conversations(), chat: runtime.chat.getStatus() });
    }),
  );

  project.post(
    "/conversations",
    wrap((req, res) => {
      const runtime = rt(req);
      const conversation = runtime.chat.newConversation();
      store.audit("chat.new", { conversationId: conversation.id }, runtime.id);
      res.json({ conversation });
    }),
  );

  project.get(
    "/conversations/:cid/events",
    wrap((req, res) => {
      const runtime = rt(req);
      res.json({ events: runtime.chat.events(str(req.params.cid)), chat: runtime.chat.getStatus() });
    }),
  );

  project.post(
    "/chat/send",
    wrap((req, res) => {
      const runtime = rt(req);
      const conversation = runtime.chat.send(str(req.body?.conversationId) || undefined, str(req.body?.text), "chat");
      store.audit("chat.send", { conversationId: conversation.id, length: str(req.body?.text).length }, runtime.id);
      res.json({ conversation });
    }),
  );

  project.post(
    "/chat/stop",
    wrap(async (req, res) => {
      const runtime = rt(req);
      await runtime.chat.stop();
      store.audit("chat.stop", {}, runtime.id);
      res.json({ ok: true });
    }),
  );

  project.post(
    "/chat/answer",
    wrap((req, res) => {
      const runtime = rt(req);
      const answers = req.body?.answers === null ? null : (req.body?.answers as Record<string, string | string[]>);
      if (answers !== null && (typeof answers !== "object" || Array.isArray(answers))) throw new ChatError(400, "answers must be an object or null.");
      runtime.chat.answerQuestion(str(req.body?.id), answers);
      store.audit("chat.answer", { id: str(req.body?.id), answers: answers === null ? null : redact(JSON.stringify(answers)).slice(0, 2000), viaGate: str(req.body?.stage) || undefined }, runtime.id);
      res.json({ ok: true });
    }),
  );

  project.post(
    "/chat/permission",
    wrap((req, res) => {
      const runtime = rt(req);
      const allow = req.body?.decision === "allow";
      if (!allow && req.body?.decision !== "deny") throw new ChatError(400, "decision must be allow or deny.");
      const decided = runtime.chat.decidePermission(str(req.body?.id), allow, str(req.body?.message) || undefined);
      store.audit("permission.decide", { tool: decided.toolName, decision: allow ? "allow" : "deny", input: JSON.stringify(decided.input ?? {}).slice(0, 1500) }, runtime.id);
      res.json({ ok: true });
    }),
  );

  // ----- approvals -----
  // A gate is decided by the person's own reply in the harness session; the
  // engine records it (GATE_APPROVED / GATE_REJECTED). Studio only carries the
  // reply and keeps its own trail of who clicked what.

  project.post(
    "/approvals",
    wrap(async (req, res) => {
      const runtime = rt(req);
      const stage = str(req.body?.stage);
      const decision = str(req.body?.decision);
      const comment = str(req.body?.comment).trim();
      if (decision !== "approve" && decision !== "reject") throw new ChatError(400, "decision must be approve or reject.");
      if (decision === "reject" && !comment) throw new ChatError(400, "Say what should change so the stage can be revised.");
      const snapshot = await runtime.snapshot();
      const gate = snapshot.gates.find((g) => g.stage === stage);
      if (!gate) throw new ChatError(409, "That stage is not waiting for approval according to the engine's state.");
      if (runtime.chat.openQuestions().length > 0) {
        throw new ChatError(409, "The workflow is asking a question right now. Answer it in the approval panel or the chat.");
      }
      const conversations = runtime.chat.conversations();
      const target = runtime.chat.activeConversationId() ?? conversations.find((c) => c.harnessSessionId)?.id;
      if (!target) {
        throw new ChatError(409, "No harness session holds this workflow. Use Resume workflow so the gate is asked again, then decide it.");
      }
      const message = decision === "approve" ? (comment ? `Approve. ${comment}` : "Approve") : `Request changes: ${comment}`;
      const conversation = runtime.chat.send(target, message, "approval");
      store.audit("approval.decide", { stage, stageName: gate.stageName, decision, comment, conversationId: conversation.id }, runtime.id);
      res.json({ ok: true, conversation });
    }),
  );

  project.get(
    "/audit",
    wrap((req, res) => {
      res.json({ entries: store.auditEntries(rt(req).id) });
    }),
  );

  // ----- commands, tests, logs -----

  project.get(
    "/commands",
    wrap((req, res) => {
      const runtime = rt(req);
      res.json({
        commands: runtime.runner.catalog().map(({ id, label, group, display, description }) => ({ id, label, group, display, description })),
        running: runtime.runner.running(),
      });
    }),
  );

  project.post(
    "/commands/run",
    wrap((req, res) => {
      const runtime = rt(req);
      let started: { runId: string; display: string };
      try {
        started = runtime.runner.start(str(req.body?.id));
      } catch (error) {
        throw new ChatError(400, (error as Error).message);
      }
      store.audit("command.run", { id: str(req.body?.id), display: started.display }, runtime.id);
      res.json(started);
    }),
  );

  project.post(
    "/commands/:runId/kill",
    wrap((req, res) => {
      const runtime = rt(req);
      const ok = runtime.runner.kill(str(req.params.runId));
      store.audit("command.kill", { runId: str(req.params.runId), ok }, runtime.id);
      res.json({ ok });
    }),
  );

  project.get(
    "/tests",
    wrap((req, res) => {
      const runtime = rt(req);
      res.json({
        runs: runtime.tests.list(),
        coverage: readCoverage(runtime.projectDir),
        commands: runtime.runner.catalog().filter((c) => c.isTest).map(({ id, label, display }) => ({ id, label, display })),
      });
    }),
  );

  project.get(
    "/logs",
    wrap((req, res) => {
      res.json({ lines: rt(req).logLines() });
    }),
  );

  project.delete(
    "/logs",
    wrap((req, res) => {
      rt(req).clearLogs();
      res.json({ ok: true });
    }),
  );

  api.use((_req, res) => {
    res.status(404).json({ error: "not_found", message: "No such API route." });
  });

  if (options.staticDir && existsSync(options.staticDir)) {
    app.use(express.static(options.staticDir, { index: "index.html", fallthrough: true }));
    // A missing asset is a 404, never the app shell: a client built before
    // the last rebuild must fail cleanly, not load HTML as a script.
    app.use("/assets", (_req, res) => {
      res.status(404).type("text/plain").send("Not found");
    });
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(options.staticDir!, "index.html"));
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof PathError) {
      res.status(PATH_STATUS[error.code] ?? 400).json({ error: error.code, message: error.message });
      return;
    }
    if (error instanceof ChatError) {
      res.status(error.status).json({ error: "request_failed", message: error.message });
      return;
    }
    const err = error as NodeJS.ErrnoException & { status?: number; type?: string };
    if (err?.code === "ENOENT") {
      res.status(404).json({ error: "not_found", message: "File or folder not found." });
      return;
    }
    if (err?.code === "EACCES" || err?.code === "EPERM") {
      res.status(403).json({ error: "forbidden", message: "Windows denied access to that path." });
      return;
    }
    if (err?.type === "entity.parse.failed" || err?.status === 400) {
      res.status(400).json({ error: "bad_request", message: "The request body is not valid JSON." });
      return;
    }
    if (err?.type === "entity.too.large") {
      res.status(413).json({ error: "too_large", message: "The request is too large." });
      return;
    }
    res.status(500).json({ error: "internal", message: redact(err?.message ?? "Unexpected server error.") });
  });

  return {
    app,
    runtimes,
    async dispose(): Promise<void> {
      await Promise.all([...runtimes.values()].map((r) => r.dispose()));
      runtimes.clear();
    },
  };
}
