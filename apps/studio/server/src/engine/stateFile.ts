// Parser for an intent's aidlc-state.md, the engine's durable workflow cursor
// (docs/guide/10-state-and-audit.md). Studio only ever reads this file; the
// engine and its hooks are the only writers.

import type { StageProgress, StageState, WorkflowState } from "../../../shared/types.ts";

const BOX_STATE: Record<string, StageState> = {
  " ": "pending",
  "-": "in_progress",
  "?": "awaiting_approval",
  R: "revising",
  x: "completed",
  X: "completed",
  S: "skipped",
};

export function parseStateFile(text: string, recordDir: string): WorkflowState {
  const sections: Record<string, Record<string, string>> = {};
  const phases: Array<{ name: string; status: string }> = [];
  const stages: StageProgress[] = [];
  let section = "";
  let stagePhase = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const h2 = /^## (.+)$/.exec(line);
    if (h2) {
      section = h2[1].trim();
      sections[section] ??= {};
      continue;
    }
    if (section === "Stage Progress") {
      const h3 = /^### (.+?)(?: PHASE)?$/.exec(line);
      if (h3) {
        stagePhase = h3[1].trim().toLowerCase();
        continue;
      }
      // "- [x] slug <dash> EXECUTE": the separator is an em dash in the file.
      const row = /^- \[(.)\] ([a-z0-9][a-z0-9-]*)(?:\s+\S+\s+(EXECUTE|SKIP))?/.exec(line);
      if (row) {
        const plan = (row[3] as "EXECUTE" | "SKIP" | undefined) ?? "";
        const box = row[1];
        let state = BOX_STATE[box] ?? "pending";
        if (plan === "SKIP" && state === "pending") state = "not_in_plan";
        stages.push({ slug: row[2], phase: stagePhase, box, plan, state });
      }
      continue;
    }
    const kv = /^- \*\*(.+?)\*\*:\s?(.*)$/.exec(line);
    if (kv && section) {
      sections[section][kv[1].trim()] = kv[2].trim();
      if (section === "Phase Progress") phases.push({ name: kv[1].trim(), status: kv[2].trim() });
    }
  }

  const info = sections["Project Information"] ?? {};
  const current = sections["Current Status"] ?? {};
  const planned = stages.filter((s) => s.plan !== "SKIP");
  return {
    recordDir,
    sections,
    phases,
    stages,
    project: info["Project"] ?? "",
    scope: info["Scope"] ?? "",
    status: current["Status"] ?? "",
    lifecyclePhase: current["Lifecycle Phase"] ?? "",
    currentStage: current["Current Stage"] ?? "",
    nextStage: current["Next Stage"] ?? "",
    lastUpdated: current["Last Updated"] ?? "",
    activeAgent: info["Active Agent"] ?? "",
    completed: planned.filter((s) => s.state === "completed").length,
    total: planned.length,
  };
}
