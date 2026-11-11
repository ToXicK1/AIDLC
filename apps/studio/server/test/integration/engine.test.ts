// Integration: a real project, set up with the real AI-DLC runtime, read
// through the real engine. No LLM harness is involved, and nothing is mocked.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { which } from "../../src/proc.ts";
import { openEvents, removeDir, startServer, tempDir, type TestServer } from "../helpers.ts";

const hasBun = which("bun") !== null;

describe("AI-DLC engine integration", { skip: hasBun ? false : "bun is not installed", timeout: 600000 }, () => {
  let dataDir: string;
  let projectDir: string;
  let server: TestServer;
  let projectId: string;

  before(async () => {
    dataDir = tempDir("data");
    projectDir = path.join(tempDir("proj"), "inventory-api");
    mkdirSync(projectDir);
    server = await startServer({ dataDir });
  });

  after(async () => {
    await server?.close();
    removeDir(dataDir);
    removeDir(path.dirname(projectDir));
  });

  it("opens a project folder and reports AI-DLC as not set up", async () => {
    const opened = await server.api("/api/projects", { method: "POST", json: { path: projectDir } });
    assert.equal(opened.status, 200);
    projectId = opened.body.project.id;
    const snap = await server.api(`/api/projects/${projectId}/snapshot`);
    assert.equal(snap.status, 200);
    assert.equal(snap.body.install.installed, false);
    assert.equal(snap.body.lifecycle, null);
    assert.equal(snap.body.state, null);
  });

  it("sets the project up for Claude Code with the real runtime", async () => {
    const init = await server.api(`/api/projects/${projectId}/init`, { method: "POST", json: { harness: "claude", runtime: "bun" } });
    assert.equal(init.status, 200, JSON.stringify(init.body.result));
    assert.equal(init.body.result.ok, true);
    assert.ok(existsSync(path.join(projectDir, ".claude", "tools", "aidlc.ts")));
    assert.ok(existsSync(path.join(projectDir, ".claude", "settings.json")));
    assert.ok(existsSync(path.join(projectDir, "aidlc", "spaces", "default", "memory", "org.md")));
    assert.equal(init.body.snapshot.install.installed, true);
    assert.equal(init.body.snapshot.install.harnesses[0].id, "claude");
  });

  it("discovers the lifecycle from the engine's own stage graph", async () => {
    const snap = (await server.api(`/api/projects/${projectId}/snapshot`)).body;
    assert.deepEqual(snap.errors, []);
    const phases = snap.lifecycle.phases.map((p: { id: string }) => p.id);
    assert.ok(phases.includes("inception"));
    assert.ok(phases.includes("construction"));
    const stages = snap.lifecycle.phases.flatMap((p: { stages: Array<{ slug: string }> }) => p.stages);
    assert.ok(stages.length > 10);
    const requirements = stages.find((s: { slug: string }) => s.slug === "requirements-analysis");
    assert.match(requirements.lead_agent, /agent/);
    assert.ok(snap.lifecycle.agents.length > 5);
    assert.ok(Object.keys(snap.lifecycle.scopes).includes("poc"));
    assert.equal(snap.state, null);
  });

  it("does not overwrite existing files when set up again", async () => {
    const marker = path.join(projectDir, ".claude", "settings.json");
    const before = readFileSync(marker, "utf8");
    writeFileSync(marker, before.replace("{", '{\n  "studioTestMarker": true,'), "utf8");
    const again = await server.api(`/api/projects/${projectId}/init`, { method: "POST", json: { harness: "claude", runtime: "bun" } });
    assert.equal(again.body.result.ok, true);
    assert.equal(again.body.result.copied, 0);
    assert.ok(readFileSync(marker, "utf8").includes("studioTestMarker"));
  });

  it("reads workflow state, audit trail and stream updates after the engine creates work", async () => {
    const stream = openEvents(server, projectId);
    await stream.waitFor((e) => e.type === "hello");
    const runtime = server.studio.runtimes.get(projectId)!;
    const created = await runtime.engine.exec(["engine", "intent", "create", "--scope", "poc", "--arguments", "Build a tiny CLI todo app", "--project-type", "greenfield"]);
    assert.equal(created.code, 0, created.stderr);

    // The watcher sees the engine's writes and pushes a fresh snapshot.
    const pushed = await stream.waitFor((e) => e.type === "snapshot" && e.data.state !== null, 60000);
    assert.equal(pushed.data.state.scope, "poc");
    stream.close();

    const snap = (await server.api(`/api/projects/${projectId}/snapshot`)).body;
    assert.equal(snap.intents.length, 1);
    assert.equal(snap.intents[0].active, true);
    assert.equal(snap.state.project, "Build a tiny CLI todo app");
    assert.equal(snap.state.currentStage, "intent-capture");
    assert.equal(snap.state.status, "Running");
    const byState = (state: string): string[] => snap.state.stages.filter((s: { state: string }) => s.state === state).map((s: { slug: string }) => s.slug);
    assert.deepEqual(byState("completed"), ["workspace-scaffold", "workspace-detection", "state-init"]);
    assert.deepEqual(byState("in_progress"), ["intent-capture"]);
    assert.ok(byState("not_in_plan").includes("market-research"));
    assert.ok(byState("pending").includes("code-generation"));
    assert.ok(snap.audit.map((e: { event: string }) => e.event).includes("WORKFLOW_STARTED"));
    assert.deepEqual(snap.gates, []);
    const lead = snap.agents.find((a: { stage: string }) => a.stage === "intent-capture");
    assert.equal(lead.agent, "aidlc-product-agent");
    assert.equal(lead.status, "active");
    assert.equal(lead.source, "audit");
  });

  it("discovers artifacts written into the intent record", async () => {
    const snap = (await server.api(`/api/projects/${projectId}/snapshot`)).body;
    const stageDir = path.join(projectDir, snap.state.recordDir, "inception", "requirements-analysis");
    mkdirSync(stageDir, { recursive: true });
    writeFileSync(path.join(stageDir, "requirements.md"), "# Requirements\n\n## Functional Requirements\n- FR-1 add a todo\n", "utf8");
    const after = (await server.api(`/api/projects/${projectId}/snapshot`)).body;
    const artifact = after.artifacts.find((a: { name: string }) => a.name === "requirements.md");
    assert.equal(artifact.category, "requirements");
    assert.equal(artifact.stage, "requirements-analysis");
    assert.equal(artifact.phase, "inception");
  });

  it("runs allowlisted engine commands and streams their real output", async () => {
    const catalog = (await server.api(`/api/projects/${projectId}/commands`)).body.commands;
    assert.ok(catalog.map((c: { id: string }) => c.id).includes("aidlc:status"));
    const stream = openEvents(server, projectId);
    await stream.waitFor((e) => e.type === "hello");
    const started = await server.api(`/api/projects/${projectId}/commands/run`, { method: "POST", json: { id: "aidlc:status" } });
    assert.equal(started.status, 200);
    const exit = await stream.waitFor((e) => e.type === "run" && e.data.runId === started.body.runId && e.data.kind === "exit", 60000);
    assert.equal(exit.data.code, 0);
    const output = stream.events.filter((e) => e.type === "run" && e.data.kind === "stdout").map((e) => e.data.text).join("");
    assert.match(output, /AI-DLC Workflow Status/);
    assert.match(output, /Intent Capture/);
    stream.close();

    const rejected = await server.api(`/api/projects/${projectId}/commands/run`, { method: "POST", json: { id: "rm -rf /" } });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.message, /allowlist/);
  });

  it("runs the engine doctor", async () => {
    const doctor = await server.api(`/api/projects/${projectId}/doctor`, { method: "POST" });
    assert.equal(doctor.status, 200);
    assert.ok(doctor.body.report.data.checks.length > 10);
  });

  it("refuses an approval when the engine's state shows no open gate", async () => {
    const res = await server.api(`/api/projects/${projectId}/approvals`, { method: "POST", json: { stage: "intent-capture", decision: "approve" } });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /not waiting for approval/);
  });

  it("recovers the project and its persisted workflow state after a restart", async () => {
    await server.close();
    server = await startServer({ dataDir });
    const projects = (await server.api("/api/projects")).body;
    assert.equal(projects.lastProjectId, projectId);
    assert.equal(projects.projects[0].path, projectDir);
    const snap = (await server.api(`/api/projects/${projectId}/snapshot`)).body;
    assert.equal(snap.state.currentStage, "intent-capture");
    assert.ok(snap.audit.length > 3);
  });
});
