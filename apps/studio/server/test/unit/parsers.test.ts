// State-file parser, artifact categories, test-output parser, persistence.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { categorize } from "../../src/engine/engine.ts";
import { parseStateFile } from "../../src/engine/stateFile.ts";
import { Store, projectIdFor } from "../../src/store.ts";
import { TEST_COMMAND, TestTracker, parseTestOutput, statusOf, stripAnsi } from "../../src/testing.ts";
import { removeDir, tempDir } from "../helpers.ts";

const STATE = `# AI-DLC State Tracking

## Project Information
- **Project**: Build a REST API
- **Scope**: mvp
- **Active Agent**: aidlc-architect-agent

## Phase Progress
<!-- Status values: Pending, Active, Verified, Skipped -->

- **Initialization**: Verified
- **Ideation**: Active
- **Operation**: Skipped

## Stage Progress
<!-- Checkbox states -->

### INITIALIZATION PHASE
- [x] workspace-scaffold \u2014 EXECUTE

### IDEATION PHASE
- [x] intent-capture \u2014 EXECUTE
- [ ] market-research \u2014 SKIP
- [?] feasibility \u2014 EXECUTE
- [R] scope-definition \u2014 EXECUTE
- [S] team-formation \u2014 EXECUTE
- [-] rough-mockups \u2014 EXECUTE
- [ ] approval-handoff \u2014 EXECUTE

## Current Status
- **Lifecycle Phase**: IDEATION
- **Current Stage**: feasibility
- **Next Stage**: scope-definition
- **Status**: Running
- **Last Updated**: 2026-10-13T10:43:59Z
`;

describe("state file parser", () => {
  it("reads every checkbox state, the plan and the cursor", () => {
    const state = parseStateFile(STATE, "aidlc/spaces/default/intents/x");
    const by = Object.fromEntries(state.stages.map((s) => [s.slug, s]));
    assert.equal(by["workspace-scaffold"].state, "completed");
    assert.equal(by["workspace-scaffold"].phase, "initialization");
    assert.equal(by["market-research"].state, "not_in_plan");
    assert.equal(by["feasibility"].state, "awaiting_approval");
    assert.equal(by["scope-definition"].state, "revising");
    assert.equal(by["team-formation"].state, "skipped");
    assert.equal(by["rough-mockups"].state, "in_progress");
    assert.equal(by["approval-handoff"].state, "pending");
    assert.equal(by["approval-handoff"].phase, "ideation");
    assert.equal(state.currentStage, "feasibility");
    assert.equal(state.lifecyclePhase, "IDEATION");
    assert.equal(state.status, "Running");
    assert.equal(state.scope, "mvp");
    assert.equal(state.project, "Build a REST API");
    assert.deepEqual(state.phases, [
      { name: "Initialization", status: "Verified" },
      { name: "Ideation", status: "Active" },
      { name: "Operation", status: "Skipped" },
    ]);
    assert.equal(state.total, 7);
    assert.equal(state.completed, 2);
  });

  it("survives Windows line endings and an empty file", () => {
    const state = parseStateFile(STATE.replace(/\n/g, "\r\n"), "r");
    assert.equal(state.stages.length, 8);
    assert.equal(state.currentStage, "feasibility");
    assert.equal(parseStateFile("", "r").stages.length, 0);
  });

  it("cannot be steered by a multi-line project description", () => {
    const state = parseStateFile(STATE.replace("Build a REST API", "x\n- **Status**: Completed"), "r");
    assert.equal(state.status, "Running");
  });
});

describe("artifact categories", () => {
  it("files artifacts under the workspace that shows them", () => {
    assert.equal(categorize("requirements-analysis", "requirements.md", "inception"), "requirements");
    assert.equal(categorize("domain-design", "components.md", "inception"), "architecture");
    assert.equal(categorize("functional-design", "functional-spec.md", "construction"), "design");
    assert.equal(categorize("code-generation", "code-summary.md", "construction"), "implementation");
    assert.equal(categorize("build-and-test", "build-test-results.md", "construction"), "testing");
    assert.equal(categorize("deployment-execution", "deployment-log.md", "operation"), "deployment");
    assert.equal(categorize("observability-setup", "dashboards.md", "operation"), "operations");
    assert.equal(categorize("nfr-design", "security-controls.md", "construction"), "security");
    assert.equal(categorize(undefined, "phase-check-inception.md", "verification"), "testing");
    assert.equal(categorize(undefined, "notes.md", "archive"), "other");
  });
});

describe("test output parser", () => {
  it("vitest", () => {
    const out = parseTestOutput(" FAIL  src/todo.test.ts > add > rejects empty\n ✓ src/a.test.ts (3)\n\n Test Files  1 failed | 1 passed (2)\n      Tests  1 failed | 12 passed | 2 skipped (15)\n");
    assert.deepEqual(out.summary, { passed: 12, failed: 1, skipped: 2, total: 15 });
    assert.equal(out.failures[0].name, "src/todo.test.ts > add > rejects empty");
    assert.equal(out.failures[0].file, "src/todo.test.ts");
  });
  it("jest", () => {
    const out = parseTestOutput("Tests:       2 failed, 1 skipped, 10 passed, 13 total\nSnapshots:   0 total\n");
    assert.deepEqual(out.summary, { passed: 10, failed: 2, skipped: 1, total: 13 });
  });
  it("pytest", () => {
    const out = parseTestOutput("FAILED tests/test_api.py::test_create - AssertionError: 500 != 201\n========= 1 failed, 5 passed, 1 skipped in 0.42s =========\n");
    assert.deepEqual(out.summary, { passed: 5, failed: 1, skipped: 1, total: 7 });
    assert.deepEqual(out.failures[0], { name: "tests/test_api.py::test_create", file: "tests/test_api.py", message: "AssertionError: 500 != 201" });
  });
  it("node:test", () => {
    const out = parseTestOutput("not ok 2 - done marks a todo\n  ---\n  location: 'C:\\\\p\\\\test\\\\todo.test.js:14:3'\n# tests 5\n# pass 4\n# fail 1\n# skipped 0\n");
    assert.deepEqual(out.summary, { passed: 4, failed: 1, skipped: 0, total: 5 });
    assert.equal(out.failures[0].name, "done marks a todo");
    assert.equal(out.failures[0].line, 14);
  });
  it("bun test", () => {
    const out = parseTestOutput("(fail) store > saves [1.2ms]\n\n 7 pass\n 1 fail\n 14 expect() calls\n");
    assert.deepEqual(out.summary, { passed: 7, failed: 1, total: 8 });
    assert.equal(out.failures[0].name, "store > saves");
  });
  it("go, cargo, dotnet, mocha", () => {
    assert.deepEqual(parseTestOutput("--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\nFAIL\texample.com/x\t0.01s\n").summary, { passed: 1, failed: 1, skipped: 0, total: 2 });
    assert.deepEqual(parseTestOutput("test a::b ... FAILED\ntest result: FAILED. 3 passed; 1 failed; 2 ignored; 0 measured\n").summary, { passed: 3, failed: 1, skipped: 2, total: 6 });
    assert.deepEqual(parseTestOutput("Passed!  - Failed:     0, Passed:     5, Skipped:     1, Total:     6").summary, { failed: 0, passed: 5, skipped: 1, total: 6 });
    assert.deepEqual(parseTestOutput("  5 passing (12ms)\n  1 failing\n").summary, { passed: 5, failed: 1, total: 6 });
  });
  it("reports no counts when it recognises no summary", () => {
    const out = parseTestOutput("Compiling...\nDone.\n");
    assert.equal(out.summary, undefined);
    assert.deepEqual(out.failures, []);
    assert.equal(statusOf(undefined, 0), "passed");
    assert.equal(statusOf(undefined, 1), "error");
    assert.equal(statusOf({ passed: 3, failed: 0 }, 1), "failed");
    assert.equal(statusOf({ passed: 3, failed: 1 }, 0), "failed");
  });
  it("strips colour codes and recognises test commands", () => {
    assert.equal(stripAnsi("\u001b[32m 3 pass\u001b[0m"), " 3 pass");
    for (const cmd of ["npm test", "npm run test:unit", "bun test", "npx vitest run", "python -m pytest -q", "go test ./...", "cargo test", "node --test"]) assert.ok(TEST_COMMAND.test(cmd), cmd);
    for (const cmd of ["npm install", "git status", "ls tests", "cat latest.txt"]) assert.ok(!TEST_COMMAND.test(cmd), cmd);
  });
  it("captures test runs the harness executes in chat", () => {
    let changes = 0;
    const tracker = new TestTracker(() => changes++);
    tracker.observeToolUse("t1", "Bash", { command: "git status" });
    tracker.observeToolResult("t1", "clean", false);
    assert.equal(tracker.list().length, 0);
    tracker.observeToolUse("t2", "Bash", { command: "node --test" });
    tracker.observeToolResult("t2", "# tests 2\n# pass 2\n# fail 0\n", false);
    const run = tracker.list()[0];
    assert.equal(run.source, "harness");
    assert.equal(run.status, "passed");
    assert.deepEqual(run.summary, { passed: 2, failed: 0, total: 2 });
    assert.equal(changes, 1);
  });
});

describe("store", () => {
  let dir: string;
  before(() => {
    dir = tempDir("store");
  });
  after(() => removeDir(dir));

  it("persists projects, conversations, events and the audit trail across instances", () => {
    const store = new Store(dir);
    const project = store.upsertProject("C:\\work\\demo");
    assert.equal(project.id, projectIdFor("C:\\work\\demo"));
    assert.equal(project.name, "demo");
    assert.equal(project.settings.permissionMode, "default");
    store.updateProject(project.id, { harness: "codex", settings: { permissionMode: "plan" } });
    const conv = store.createConversation(project.id, "claude");
    store.appendChatEvent(project.id, { seq: 1, ts: "t", conversationId: conv.id, type: "user", text: "hello", origin: "chat" });
    store.appendChatEvent(project.id, { seq: 2, ts: "t", conversationId: conv.id, type: "assistant", text: "hi" });
    store.updateConversation(project.id, conv.id, { harnessSessionId: "sess-1", title: "First" });
    store.audit("approval.decide", { stage: "requirements-analysis", decision: "approve" }, project.id);
    store.setWorkspace({ [project.id]: { view: "testing" } });

    const reopened = new Store(dir);
    assert.equal(reopened.lastProjectId(), project.id);
    assert.equal(reopened.project(project.id)?.harness, "codex");
    assert.equal(reopened.project(project.id)?.settings.permissionMode, "plan");
    assert.equal(reopened.conversation(project.id, conv.id)?.harnessSessionId, "sess-1");
    assert.deepEqual(reopened.chatEvents(project.id, conv.id).map((e) => e.type), ["user", "assistant"]);
    assert.equal(reopened.auditEntries(project.id)[0].action, "approval.decide");
    assert.deepEqual(reopened.workspace(), { [project.id]: { view: "testing" } });
    assert.throws(() => reopened.chatEvents(project.id, "../../etc/passwd"), /Invalid conversation id/);
    assert.equal(reopened.removeProject(project.id), true);
    assert.equal(reopened.projects().length, 0);
  });

  it("treats Windows paths case-insensitively for identity", { skip: process.platform !== "win32" }, () => {
    assert.equal(projectIdFor("C:\\Work\\Demo"), projectIdFor("c:\\work\\demo"));
  });
});
