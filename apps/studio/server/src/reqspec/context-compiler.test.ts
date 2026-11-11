import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkReferences, compileContext, compileHandoff, type ReqSpec } from "./context-compiler";

// FR2 depends on FR1. FR3 and NFR1 are unrelated to FR1/FR2. US1 uses FR1, US2 uses FR3.
const fixture = (): ReqSpec => ({
  schemaVersion: "1.0",
  project: { id: "p", name: "P", problem: "x", goal: "y", scopeIn: ["a"], scopeOut: ["b"] },
  personas: [
    { id: "agent", name: "Agent", need: "n" },
    { id: "admin", name: "Admin", need: "n" }
  ],
  requirements: [
    { id: "FR1", kind: "functional", statement: "s", priority: "must", status: "confirmed", personaRefs: ["agent"], sourceRefs: ["DEC-1"], acceptance: [] },
    { id: "FR2", kind: "functional", statement: "s", priority: "must", status: "confirmed", personaRefs: ["agent"], dependsOn: ["FR1"], sourceRefs: ["DEC-2"], acceptance: [] },
    { id: "FR3", kind: "functional", statement: "s", priority: "must", status: "confirmed", personaRefs: ["admin"], sourceRefs: ["DEC-3"], acceptance: [] },
    { id: "NFR1", kind: "non-functional", statement: "s", priority: "should", status: "confirmed", sourceRefs: ["project.goal"], acceptance: [] }
  ],
  stories: [
    { id: "US1", personaRef: "agent", action: "a", benefit: "b", requirementRefs: ["FR1"], acceptance: [], status: "confirmed" },
    { id: "US2", personaRef: "admin", action: "a", benefit: "b", requirementRefs: ["FR3"], acceptance: [], status: "confirmed" }
  ],
  decisions: [
    { id: "DEC-1", question: "q", answer: "a", status: "confirmed" },
    { id: "DEC-2", question: "q", answer: "a", status: "confirmed" },
    { id: "DEC-3", question: "q", answer: "a", status: "confirmed" },
    { id: "DEC-4", question: "q", answer: "a", status: "proposed" }
  ],
  openQuestions: [
    { id: "Q1", question: "q", status: "open", relatedRefs: ["FR1"] },
    { id: "Q2", question: "q", status: "open", relatedRefs: ["FR3"] },
    { id: "Q3", question: "q", status: "answered", relatedRefs: ["FR1"], answer: "x" }
  ]
});

type Section = "requirements" | "stories" | "decisions" | "personas" | "openQuestions";

function idsOf(envelope: { context: Record<string, unknown> }, section: Section): string[] {
  const items = (envelope.context[section] ?? []) as { id: string }[];
  return items.map((item) => item.id);
}

describe("reference-aware selection", () => {
  test("selecting FR2 pulls in its dependency FR1 and nothing unrelated", () => {
    const result = compileContext(fixture(), { task: "find_ambiguities", requirementIds: ["FR2"] });
    expect(idsOf(result, "requirements")).toEqual(["FR1", "FR2"]);
    expect(idsOf(result, "stories")).toEqual([]);
    expect(idsOf(result, "personas")).toEqual(["agent"]);
    expect(idsOf(result, "decisions")).toEqual(["DEC-1", "DEC-2"]);
    expect(idsOf(result, "openQuestions")).toEqual(["Q1"]);
  });

  test("selecting a story brings its requirement, persona, decision and question", () => {
    const result = compileContext(fixture(), { task: "find_ambiguities", storyIds: ["US2"] });
    expect(idsOf(result, "stories")).toEqual(["US2"]);
    expect(idsOf(result, "requirements")).toEqual(["FR3"]);
    expect(idsOf(result, "personas")).toEqual(["admin"]);
    expect(idsOf(result, "decisions")).toEqual(["DEC-3"]);
    expect(idsOf(result, "openQuestions")).toEqual(["Q2"]);
  });

  test("stories are filtered to the ones that reference the selected requirement", () => {
    const result = compileContext(fixture(), { task: "suggest_acceptance", requirementIds: ["FR1"] });
    expect(idsOf(result, "stories")).toEqual(["US1"]);
  });

  test("no selection sends the whole spec, confirmed decisions and open questions only", () => {
    const result = compileContext(fixture(), { task: "review_completeness" });
    expect(idsOf(result, "requirements")).toEqual(["FR1", "FR2", "FR3", "NFR1"]);
    expect(idsOf(result, "stories")).toEqual(["US1", "US2"]);
    expect(idsOf(result, "personas")).toEqual(["agent", "admin"]);
    expect(idsOf(result, "decisions")).toEqual(["DEC-1", "DEC-2", "DEC-3"]);
    expect(idsOf(result, "openQuestions")).toEqual(["Q1", "Q2"]);
    expect(result.omitted).toEqual([]);
  });

  test("includeDecisions and includeOpenQuestions switch those sections off", () => {
    const result = compileContext(fixture(), {
      task: "find_ambiguities",
      requirementIds: ["FR2"],
      includeDecisions: false,
      includeOpenQuestions: false
    });
    expect(result.context.decisions).toBeUndefined();
    expect(result.context.openQuestions).toBeUndefined();
  });
});

describe("failing loudly", () => {
  test("an unknown requirement id is rejected", () => {
    expect(() => compileContext(fixture(), { task: "find_ambiguities", requirementIds: ["FR99"] })).toThrow(/FR99/);
  });

  test("a dangling reference is reported and blocks compilation", () => {
    const broken = fixture();
    broken.requirements[1].dependsOn = ["FR9"];
    expect(checkReferences(broken).join("\n")).toContain("FR9");
    expect(() => compileContext(broken, { task: "find_ambiguities" })).toThrow(/invalid references/);
  });

  test("a budget too small for the mandatory context is rejected", () => {
    expect(() => compileContext(fixture(), { task: "find_ambiguities", requirementIds: ["FR2"], maxChars: 100 }))
      .toThrow(/too small/);
  });
});

describe("priority budget", () => {
  test("the lowest-priority item is dropped first and reported", () => {
    const big = fixture();
    big.openQuestions[0].question = "x".repeat(400);
    const withoutQuestions = compileContext(big, { task: "find_ambiguities", requirementIds: ["FR2"], includeOpenQuestions: false });
    const budget = JSON.stringify(withoutQuestions).length + 150;

    const bounded = compileContext(big, { task: "find_ambiguities", requirementIds: ["FR2"], maxChars: budget });
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(budget);
    expect(bounded.omitted).toEqual([{ section: "openQuestions", ids: ["Q1"] }]);
    expect(idsOf(bounded, "decisions")).toEqual(["DEC-1", "DEC-2"]);
    expect(idsOf(bounded, "requirements")).toEqual(["FR1", "FR2"]);
  });

  test("a budget that fits everything omits nothing", () => {
    const unbounded = compileContext(fixture(), { task: "find_ambiguities", requirementIds: ["FR2"] });
    const bounded = compileContext(fixture(), {
      task: "find_ambiguities",
      requirementIds: ["FR2"],
      maxChars: JSON.stringify(unbounded).length + 1000
    });
    expect(bounded.omitted).toEqual([]);
    expect(bounded.context).toEqual(unbounded.context);
  });
});

describe("output contract", () => {
  test("patch tasks add questions to the open question list, with no custom operations", () => {
    const result = compileContext(fixture(), { task: "find_ambiguities" });
    expect(result.output).toEqual({
      format: "json-patch",
      allowedOperations: ["add", "replace", "remove"],
      questionsPath: "/openQuestions/-"
    });
  });

  test("the handoff task returns a JSON handoff with no patch operations", () => {
    const result = compileHandoff(fixture());
    expect(result.output).toEqual({ format: "json", shape: "handoff", allowedOperations: [] });
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("shipped example", () => {
  const example = JSON.parse(
    readFileSync(fileURLToPath(new URL("./example.reqspec.json", import.meta.url)), "utf8")
  ) as ReqSpec;

  test("has consistent references", () => {
    expect(checkReferences(example)).toEqual([]);
  });

  test("compiles for every task within the handoff budget", () => {
    for (const task of ["draft_requirements", "find_ambiguities", "suggest_acceptance", "review_completeness"] as const) {
      expect(() => compileContext(example, { task, requirementIds: ["FR1"] })).not.toThrow();
    }
    expect(JSON.stringify(compileHandoff(example)).length).toBeLessThanOrEqual(30000);
  });
});
