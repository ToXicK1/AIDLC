// Component tests: lifecycle navigation, workspace switching, chat
// interactions, questions and approvals. State is set directly on the store;
// store actions are replaced with recorders, so no server is involved.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatEvent, Snapshot } from "../../shared/types.ts";
import { MainWorkspace } from "../src/App.tsx";
import { AIChatPanel } from "../src/components/Chat.tsx";
import { QuestionCard } from "../src/components/Requests.tsx";
import { LifecycleNavigator } from "../src/components/Sidebar.tsx";
import { classifyRequirement } from "../src/components/views/Views.tsx";
import { extractMermaid, splitSections } from "../src/components/views/common.tsx";
import { pendingRequests, useStudio } from "../src/store.ts";

const initial = useStudio.getState();

const stage = (slug: string, number: string, name: string, phase: string) => ({
  slug,
  number,
  name,
  phase,
  execution: "ALWAYS",
  lead_agent: "aidlc-product-agent",
  support_agents: [],
  mode: "inline",
  produces: [],
  consumes: [],
  sensors: [],
});

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    projectId: "p1",
    at: "2026-11-11T00:00:00Z",
    install: { installed: true, harnesses: [{ id: "claude", dir: ".claude", shape: "bun" }], engine: { kind: "bun", display: "bun .claude/tools/aidlc.ts" }, problems: [] },
    lifecycle: {
      phases: [
        { id: "ideation", stages: [stage("intent-capture", "1.1", "Intent Capture & Framing", "ideation"), stage("market-research", "1.2", "Market Research", "ideation")] },
        { id: "inception", stages: [stage("requirements-analysis", "2.3", "Requirements Analysis", "inception")] },
        { id: "construction", stages: [stage("code-generation", "3.5", "Code Generation", "construction")] },
      ],
      agents: [{ slug: "aidlc-product-agent", display_name: "Product Agent" }],
      scopes: {},
      artifacts: [],
    },
    space: "default",
    intents: [{ uuid: "u", slug: "todo", status: "in-flight", dirName: "261110-todo", active: true }],
    state: {
      recordDir: "aidlc/spaces/default/intents/261110-todo",
      sections: {},
      phases: [
        { name: "Ideation", status: "Verified" },
        { name: "Inception", status: "Active" },
        { name: "Construction", status: "Pending" },
      ],
      stages: [
        { slug: "intent-capture", phase: "ideation", box: "x", plan: "EXECUTE", state: "completed" },
        { slug: "market-research", phase: "ideation", box: " ", plan: "SKIP", state: "not_in_plan" },
        { slug: "requirements-analysis", phase: "inception", box: "?", plan: "EXECUTE", state: "awaiting_approval" },
        { slug: "code-generation", phase: "construction", box: " ", plan: "EXECUTE", state: "pending" },
      ],
      project: "Build a todo CLI",
      scope: "poc",
      status: "Running",
      lifecyclePhase: "INCEPTION",
      currentStage: "requirements-analysis",
      nextStage: "code-generation",
      lastUpdated: "2026-11-11T00:00:00Z",
      activeAgent: "aidlc-product-agent",
      completed: 1,
      total: 3,
    },
    audit: [{ timestamp: "2026-11-11T00:00:00Z", event: "STAGE_AWAITING_APPROVAL", fields: { Stage: "requirements-analysis" } }],
    artifacts: [{ path: "aidlc/spaces/default/intents/261110-todo/inception/requirements-analysis/requirements.md", name: "requirements.md", phase: "inception", stage: "requirements-analysis", category: "requirements", size: 10, mtime: 1 }],
    gates: [
      {
        stage: "requirements-analysis",
        stageName: "Requirements Analysis",
        state: "awaiting_approval",
        since: "2026-11-11T00:00:00Z",
        leadAgent: "aidlc-product-agent",
        artifacts: [{ path: "aidlc/spaces/default/intents/261110-todo/inception/requirements-analysis/requirements.md", name: "requirements.md", phase: "inception", stage: "requirements-analysis", category: "requirements", size: 10, mtime: 1 }],
      },
    ],
    agents: [],
    errors: [],
    ...overrides,
  };
}

const project = { id: "p1", path: "C:\\work\\todo", name: "todo", lastOpened: "2026-11-11T00:00:00Z", harness: "claude", settings: { permissionMode: "default" as const, model: "" } };
const system = {
  platform: "win32",
  node: "v25",
  tools: { bun: { ok: true, version: "1.4" }, claude: { ok: true, version: "2.1" }, git: { ok: true, version: "2.5" } },
  engineRepo: "C:\\repo",
  dataDir: "C:\\data",
  harnesses: [
    { id: "claude", name: "Claude Code", dir: ".claude", distDir: "claude", invoke: "/aidlc", capabilities: { configure: true, chat: true, streaming: true, approvals: true } },
    { id: "codex", name: "Codex CLI", dir: ".codex", distDir: "codex", invoke: "$aidlc", capabilities: { configure: true, chat: false, streaming: false, approvals: false }, note: "Studio has no in-app chat adapter for this harness yet." },
  ],
};

function seed(extra: Partial<ReturnType<typeof useStudio.getState>> = {}): void {
  useStudio.setState({ ...initial, auth: "ok", project, system, snapshot: snapshot(), connection: "live", loadAudit: async () => undefined, loadTests: async () => undefined, ...extra }, true);
}

const ev = <T extends ChatEvent["type"]>(seq: number, type: T, rest: Omit<Extract<ChatEvent, { type: T }>, "seq" | "ts" | "conversationId" | "type">): ChatEvent => ({ seq, ts: "2026-11-11T00:00:00Z", conversationId: "c1", type, ...rest }) as unknown as ChatEvent;

beforeEach(() => seed());
afterEach(() => cleanup());

/** Let async handlers (and the busy state they set) settle. */
const settle = (): Promise<void> => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("document helpers", () => {
  it("splits a requirements document into sections and classifies them", () => {
    const doc = "Intro text\n\n# Requirements\n\n## Functional Requirements\n- FR-1\n\n## Non-Functional Requirements\n- NFR-1\n\n```md\n## not a heading\n```\n\n## Open Questions\n- Q1\n";
    const { intro, sections } = splitSections(doc);
    expect(intro).toBe("Intro text");
    expect(sections.map((s) => s.heading)).toEqual(["Requirements", "Functional Requirements", "Non-Functional Requirements", "Open Questions"]);
    expect(sections[2].body).toContain("## not a heading");
    expect(classifyRequirement("Functional Requirements")).toBe("Functional");
    expect(classifyRequirement("Non-Functional Requirements")).toBe("Non-functional");
    expect(classifyRequirement("User Stories")).toBe("User stories");
    expect(classifyRequirement("Acceptance Criteria")).toBe("Acceptance criteria");
    expect(classifyRequirement("Constraints")).toBe("Constraints");
    expect(classifyRequirement("Assumptions")).toBe("Assumptions");
    expect(classifyRequirement("Open Questions")).toBe("Open questions");
    expect(classifyRequirement("Appendix")).toBeNull();
  });

  it("finds mermaid diagrams in a document", () => {
    expect(extractMermaid("text\n```mermaid\ngraph TD\n  A-->B\n```\n```js\nx\n```\n```mermaid\nsequenceDiagram\n```")).toEqual(["graph TD\n  A-->B", "sequenceDiagram"]);
  });

  it("tracks which questions and permissions are still open", () => {
    const events = [
      ev(1, "question", { id: "q1", questions: [] }),
      ev(2, "question_answered", { id: "q1", answers: { a: "b" } }),
      ev(3, "question", { id: "q2", questions: [] }),
      ev(4, "permission", { id: "p1", toolName: "Bash", input: {} }),
      ev(5, "permission_decided", { id: "p1", decision: "deny" }),
      ev(6, "permission", { id: "p2", toolName: "Bash", input: {} }),
    ];
    const pending = pendingRequests(events);
    expect(pending.questions.map((q) => q.id)).toEqual(["q2"]);
    expect(pending.permissions.map((p) => p.id)).toEqual(["p2"]);
  });
});

describe("lifecycle navigator", () => {
  it("shows the engine's phases and stages with their real state", () => {
    render(<LifecycleNavigator />);
    expect(screen.getByText("Ideation")).toBeTruthy();
    expect(screen.getByText("Inception")).toBeTruthy();
    expect(screen.getByText("Intent Capture & Framing")).toBeTruthy();
    expect(screen.getByText("Requirements Analysis")).toBeTruthy();
    expect(screen.getByTitle("Completed")).toBeTruthy();
    expect(screen.getByTitle("Awaiting approval")).toBeTruthy();
    expect(screen.getByLabelText("Approval required")).toBeTruthy();
    expect(screen.getByText("Verified")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("hides stages outside the plan until asked", () => {
    render(<LifecycleNavigator />);
    expect(screen.queryByText("Market Research")).toBeNull();
    fireEvent.click(screen.getByText("Show stages not in this plan"));
    expect(screen.getByText("Market Research")).toBeTruthy();
    expect(screen.getByTitle("Not in plan")).toBeTruthy();
  });

  it("opens a stage in the workspace when clicked", () => {
    render(<LifecycleNavigator />);
    fireEvent.click(screen.getByText("Requirements Analysis"));
    expect(useStudio.getState().view).toBe("stage:requirements-analysis");
  });

  it("says so when AI-DLC is not set up, and when no workflow exists", () => {
    seed({ snapshot: snapshot({ install: { installed: false, harnesses: [], engine: null, problems: [] }, lifecycle: null, state: null, gates: [] }) });
    const { unmount } = render(<LifecycleNavigator />);
    expect(screen.getByText("AI-DLC is not set up in this project yet.")).toBeTruthy();
    unmount();
    seed({ snapshot: snapshot({ state: null, gates: [], intents: [] }) });
    render(<LifecycleNavigator />);
    expect(screen.getByText(/No workflow yet/)).toBeTruthy();
    expect(screen.getByText("Market Research")).toBeTruthy();
  });
});

describe("workspace switching", () => {
  it("switches between workspaces from the tab bar and keeps the chat state", () => {
    seed({ chatEvents: [ev(1, "user", { text: "hello", origin: "chat" })], conversationId: "c1" });
    render(<MainWorkspace />);
    const tabs = screen.getByRole("tablist", { name: "Workspaces" });
    expect(within(tabs).getByRole("tab", { name: /Overview/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Overall progress")).toBeTruthy();

    fireEvent.click(within(tabs).getByRole("tab", { name: /Requirements/ }));
    expect(useStudio.getState().view).toBe("requirements");
    expect(screen.getByRole("heading", { name: "Requirements" })).toBeTruthy();
    expect(screen.getByText(/waiting for your approval/)).toBeTruthy();

    fireEvent.click(within(tabs).getByRole("tab", { name: /Architecture/ }));
    expect(screen.getByText("No architecture or design documents yet")).toBeTruthy();

    fireEvent.click(within(tabs).getByRole("tab", { name: /Testing/ }));
    expect(screen.getByText(/No test run recorded this session/)).toBeTruthy();

    fireEvent.click(within(tabs).getByRole("tab", { name: /Artifacts/ }));
    expect(screen.getByText("All · 1")).toBeTruthy();

    fireEvent.click(within(tabs).getByRole("tab", { name: /Deploy & Ops/ }));
    expect(screen.getByText(/does not report live service health/)).toBeTruthy();

    expect(useStudio.getState().chatEvents.length).toBe(1);
    expect(useStudio.getState().conversationId).toBe("c1");
  });

  it("badges the Approvals tab with the number of open gates", () => {
    render(<MainWorkspace />);
    const tab = screen.getByRole("tab", { name: /Approvals/ });
    expect(within(tab).getByText("1")).toBeTruthy();
  });

  it("shows setup instead of empty data when AI-DLC is missing", () => {
    seed({ snapshot: snapshot({ install: { installed: false, harnesses: [], engine: null, problems: [] }, lifecycle: null, state: null, gates: [], artifacts: [] }) });
    render(<MainWorkspace />);
    expect(screen.getByText("AI-DLC is not set up in this project")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up AI-DLC" }));
    expect(useStudio.getState().dialog).toBe("setup");
  });
});

describe("approvals", () => {
  it("presents the gate with its artifacts and sends the person's decision", async () => {
    const decisions: Array<[string, string, string]> = [];
    seed({ view: "approvals", conversations: [{ id: "c1", title: "t", createdAt: "", updatedAt: "", harness: "claude", harnessSessionId: "s1" }], decideGate: async (s, d, c) => void decisions.push([s, d, c]) });
    render(<MainWorkspace />);
    expect(screen.getByText("Requirements Analysis")).toBeTruthy();
    expect(screen.getByText(/Awaiting your approval/)).toBeTruthy();
    expect(screen.getByText(/led by Product Agent/)).toBeTruthy();
    expect(screen.getByText("requirements.md")).toBeTruthy();
    expect(screen.getByText("STAGE_AWAITING_APPROVAL")).toBeTruthy();

    const reject = screen.getByRole("button", { name: /Request changes/ }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Approval comment"), { target: { value: "Add offline mode" } });
    expect(reject.disabled).toBe(false);
    fireEvent.click(reject);
    await settle();
    expect(decisions).toEqual([["requirements-analysis", "reject", "Add offline mode"]]);

    fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }));
    await settle();
    expect(decisions[1][1]).toBe("approve");
  });

  it("shows the workflow's own question instead of generic buttons when it is asking", () => {
    const answers: unknown[] = [];
    seed({
      view: "approvals",
      conversationId: "c1",
      chatEvents: [ev(1, "question", { id: "q9", questions: [{ header: "Approval", question: "Requirements Analysis complete. How would you like to proceed?", options: [{ label: "Approve", description: "Continue" }, { label: "Request Changes" }] }] })],
      answerQuestion: async (id, a, stageSlug) => void answers.push([id, a, stageSlug]),
    });
    render(<MainWorkspace />);
    expect(screen.queryByLabelText("Approval comment")).toBeNull();
    const submit = screen.getByRole("button", { name: /Submit answer/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Request Changes/ }));
    fireEvent.click(submit);
    expect(answers).toEqual([["q9", { "Requirements Analysis complete. How would you like to proceed?": "Request Changes" }, "requirements-analysis"]]);
  });

  it("offers to resume when no harness session holds the workflow, and never decides by itself", () => {
    const sent: string[] = [];
    seed({ view: "approvals", conversations: [], sendChat: async (text) => void sent.push(text) });
    render(<MainWorkspace />);
    expect(screen.queryByRole("button", { name: /^Approve$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Resume workflow/ }));
    expect(sent).toEqual(["/aidlc --resume"]);
  });

  it("waits while the agent is working", () => {
    seed({ view: "approvals", chatStatus: "running", conversations: [{ id: "c1", title: "t", createdAt: "", updatedAt: "", harness: "claude", harnessSessionId: "s1" }] });
    render(<MainWorkspace />);
    expect(screen.getByText(/The agent is working/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Approve$/ })).toBeNull();
  });
});

describe("question card", () => {
  const question = ev(1, "question", {
    id: "q1",
    questions: [
      { header: "Purpose", question: "What is this for?", options: [{ label: "Demo" }, { label: "Real tool" }] },
      { question: "Which features?", options: [{ label: "Add" }, { label: "List" }], multiSelect: true },
    ],
  }) as Extract<ChatEvent, { type: "question" }>;

  it("requires every question to be answered, then submits exactly what was chosen", () => {
    const calls: unknown[] = [];
    seed({ answerQuestion: async (id, a) => void calls.push([id, a]) });
    render(<QuestionCard event={question} />);
    const submit = screen.getByRole("button", { name: /Submit answer/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Demo" }));
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Add" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "List" }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(calls).toEqual([["q1", { "What is this for?": "Demo", "Which features?": ["Add", "List"] }]]);
  });

  it("accepts the person's own words and lets them answer in chat instead", async () => {
    const calls: unknown[] = [];
    seed({ answerQuestion: async (id, a) => void calls.push([id, a]) });
    render(<QuestionCard event={{ ...question, questions: [question.questions[0]] }} />);
    fireEvent.change(screen.getByLabelText("Own answer: What is this for?"), { target: { value: "A teaching aid" } });
    fireEvent.click(screen.getByRole("button", { name: /Submit answer/ }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Answer in chat instead/ }));
    await settle();
    expect(calls).toEqual([
      ["q1", { "What is this for?": "A teaching aid" }],
      ["q1", null],
    ]);
  });
});

describe("chat panel", () => {
  it("sends a first message as an /aidlc request and later ones as plain replies", async () => {
    const sent: string[] = [];
    seed({ snapshot: snapshot({ state: null, gates: [] }), sendChat: async (text) => void sent.push(text) });
    render(<AIChatPanel />);
    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Build a user authentication system." } });
    fireEvent.keyDown(input, { key: "Enter" });
    await settle();
    expect(sent).toEqual(["/aidlc Build a user authentication system."]);

    fireEvent.click(screen.getByRole("button", { name: /\/aidlc on/ }));
    fireEvent.change(input, { target: { value: "Explain why the current workflow is blocked." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(sent[1]).toBe("Explain why the current workflow is blocked.");
  });

  it("keeps Shift+Enter for new lines and never sends an empty message", () => {
    const sent: string[] = [];
    seed({ sendChat: async (text) => void sent.push(text) });
    render(<AIChatPanel />);
    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(sent).toEqual([]);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders the conversation: user text, markdown, tool calls and turn results", () => {
    seed({
      conversationId: "c1",
      chatEvents: [
        ev(1, "user", { text: "/aidlc Build it", origin: "chat" }),
        ev(2, "assistant", { text: "I'll start with **requirements**.\n\n```js\nconst x = 1;\n```" }),
        ev(3, "tool_use", { id: "t1", name: "Bash", input: { command: "node --test" } }),
        ev(4, "tool_result", { id: "t1", name: "Bash", text: "# pass 3", isError: false }),
        ev(5, "result", { subtype: "success", isError: false, turns: 4, durationMs: 12000 }),
      ],
    });
    render(<AIChatPanel />);
    expect(screen.getByText("/aidlc Build it")).toBeTruthy();
    expect(screen.getByText("requirements").tagName).toBe("STRONG");
    expect(screen.getByText("const x = 1;")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy" }).length).toBe(1);
    expect(screen.getByText("node --test")).toBeTruthy();
    expect(screen.getByText(/Turn complete · 4 steps · 12s/)).toBeTruthy();
  });

  it("shows streaming text and a Stop button while the agent runs", () => {
    let stopped = 0;
    seed({ chatStatus: "running", streamText: "Thinking about the data model", conversationId: "c1", stopChat: async () => void stopped++ });
    render(<AIChatPanel />);
    expect(screen.getByText("Thinking about the data model")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    expect(stopped).toBe(1);
  });

  it("surfaces an open question and a permission request in the conversation", () => {
    const decided: unknown[] = [];
    seed({
      conversationId: "c1",
      chatStatus: "waiting_input",
      chatEvents: [
        ev(1, "question", { id: "q1", questions: [{ question: "Proceed?", options: [{ label: "Approve" }] }] }),
        ev(2, "permission", { id: "p1", toolName: "Bash", input: { command: "npm install left-pad" }, reason: "not pre-approved" }),
      ],
      decidePermission: async (id, d, m) => void decided.push([id, d, m]),
    });
    render(<AIChatPanel />);
    expect(screen.getByText("Proceed?")).toBeTruthy();
    expect(screen.getByText("npm install left-pad")).toBeTruthy();
    expect(screen.getAllByText("Waiting for you").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Reason for denying"), { target: { value: "no new dependencies" } });
    fireEvent.click(screen.getByRole("button", { name: /Deny/ }));
    expect(decided).toEqual([["p1", "deny", "no new dependencies"]]);
  });

  it("offers next actions drawn from the real state", () => {
    const sent: string[] = [];
    seed({ sendChat: async (text) => void sent.push(text) });
    render(<AIChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Review pending approval" }));
    expect(useStudio.getState().view).toBe("approvals");
    fireEvent.click(screen.getByRole("button", { name: "Show workflow status" }));
    expect(sent).toEqual(["/aidlc --status"]);
  });

  it("disables chat honestly when it cannot work", () => {
    seed({ project: { ...project, harness: "codex" } });
    const { unmount } = render(<AIChatPanel />);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(/no in-app chat adapter/)).toBeTruthy();
    unmount();
    seed({ connection: "reconnecting" });
    render(<AIChatPanel />);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).placeholder).toMatch(/Reconnecting/);
  });
});
