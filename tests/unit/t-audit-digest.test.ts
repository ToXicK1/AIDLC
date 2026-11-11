// covers: function:parseAuditText, function:renderIntentDigest, function:renderIndex, function:buildDigest
//
// t-audit-digest — aidlc-digest.ts, the compact read-only digest of the audit
// shards. Mechanism: none (in-process; the end-to-end case builds a temp
// project tree and reads it back through the same engine reader the digest uses).
//
// WHAT THIS PINS. The digest is what an external tool reads instead of the full
// audit, so it must (1) read blocks in timestamp order across shards, (2) keep the
// latest stage status and the artifact write counts, (3) keep the person's words in
// decisions, (4) cut only long values, and (5) be byte-identical when rebuilt from
// unchanged shards.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDigest,
  parseAuditText,
  renderIndex,
  renderIntentDigest,
} from "../../core/tools/aidlc-digest.ts";

const block = (fields: Record<string, string>): string =>
  "\n## Heading\n" + Object.entries(fields).map(([k, v]) => `**${k}**: ${v}\n`).join("") + "\n---\n";

describe("parseAuditText", () => {
  test("orders blocks by timestamp, keeps the first Timestamp and Event, and drops header-only blocks", () => {
    const text = "# AI-DLC Audit Log\n" +
      block({ Timestamp: "2026-11-10T10:20:00Z", Event: "STAGE_AWAITING_APPROVAL", Stage: "requirements-analysis" }) +
      block({ Timestamp: "2026-11-10T10:12:05Z", Event: "STAGE_STARTED", Stage: "requirements-analysis" }) +
      // An older version wrote Timestamp twice; the first one is the reading.
      "\n## Heading\n**Timestamp**: 2026-11-10T10:13:00Z\n**Timestamp**: 2026-11-10T10:99:99Z\n**Event**: HUMAN_TURN\n\n---\n" +
      // A block with no Event line is not an event.
      "\n## Orphan\n**Note**: no event here\n\n---\n";
    const events = parseAuditText(text);
    expect(events.map((e) => e.event)).toEqual(["STAGE_STARTED", "HUMAN_TURN", "STAGE_AWAITING_APPROVAL"]);
    expect(events.map((e) => e.ts)).toEqual([
      "2026-11-10T10:12:05Z",
      "2026-11-10T10:13:00Z",
      "2026-11-10T10:20:00Z",
    ]);
  });
});

describe("renderIntentDigest", () => {
  const events = parseAuditText(
    block({ Timestamp: "2026-11-10T10:12:05Z", Event: "STAGE_STARTED", Stage: "requirements-analysis", Agent: "product" }) +
    block({ Timestamp: "2026-11-10T10:14:00Z", Event: "ARTIFACT_CREATED", Tool: "Write", File: "req.md" }) +
    block({ Timestamp: "2026-11-10T10:18:00Z", Event: "ARTIFACT_UPDATED", Tool: "Edit", File: "req.md" }) +
    block({ Timestamp: "2026-11-10T10:25:10Z", Event: "GATE_APPROVED", Stage: "requirements-analysis", "User Input": "Approve, keep exact match" }) +
    block({ Timestamp: "2026-11-10T10:25:11Z", Event: "STAGE_COMPLETED", Stage: "requirements-analysis", Details: "FR1 FR2" }) +
    block({ Timestamp: "2026-11-10T10:30:00Z", Event: "STAGE_STARTED", Stage: "user-stories", Agent: "product", Details: "x".repeat(300) }),
  );
  const meta = { slug: "search", dirName: "search-ab12", space: "main", status: "Running", scope: "feature", active: true };

  test("reports the latest status per stage, write counts per artifact, and the person's words", () => {
    const body = renderIntentDigest(events, meta);
    expect(body).toContain("- requirements-analysis: completed (2026-11-10T10:25:11Z)");
    expect(body).toContain("- user-stories: started (2026-11-10T10:30:00Z)");
    expect(body).toContain("- req.md: first 2026-11-10T10:14:00Z, last 2026-11-10T10:18:00Z, 2 writes");
    expect(body).toContain("- 2026-11-10T10:25:10Z GATE_APPROVED Stage=requirements-analysis User Input=Approve, keep exact match");
    expect(body).toContain("- Status: Running (active), scope feature");
  });

  test("cuts only values longer than the limit, and says so with an ellipsis", () => {
    const body = renderIntentDigest(events, meta);
    const timelineLine = body.split("\n").find((line) => line.includes("Details=xxx")) as string;
    expect(timelineLine.endsWith("…")).toBe(true);
    expect(timelineLine.length).toBeLessThan(300);
  });

  test("is byte-identical when rebuilt from the same events", () => {
    expect(renderIntentDigest(events, meta)).toBe(renderIntentDigest(events, meta));
  });
});

describe("renderIndex", () => {
  test("lists each intent with its status and last event, and says when there are none", () => {
    expect(renderIndex("main", [])).toContain("No intents recorded.");
    const index = renderIndex("main", [
      { dirName: "search-ab12", slug: "search", status: "Running", events: 6, last: "2026-11-10T10:25:11Z", active: true },
    ]);
    expect(index).toContain("- [search](search-ab12.md): Running (active), 6 events, last 2026-11-10T10:25:11Z");
  });
});

describe("buildDigest end to end", () => {
  const root = mkdtempSync(join(tmpdir(), "aidlc-digest-"));
  const intentDir = join(root, "aidlc", "spaces", "main", "intents", "search-ab12");
  mkdirSync(join(intentDir, "audit"), { recursive: true });
  writeFileSync(join(intentDir, "aidlc-state.md"), "# state\n");
  writeFileSync(
    join(intentDir, "audit", "laptop-a1.md"),
    "# AI-DLC Audit Log\n" +
      block({ Timestamp: "2026-11-10T10:12:05Z", Event: "STAGE_STARTED", Stage: "requirements-analysis" }) +
      block({ Timestamp: "2026-11-10T10:25:11Z", Event: "STAGE_COMPLETED", Stage: "requirements-analysis" }),
  );

  test("writes one file per intent and an index under aidlc/digest/<space>/, and rebuilds identically", () => {
    const first = buildDigest(root, "main");
    expect(first.written.map((p) => p.replace(/\\/g, "/"))).toEqual([
      "aidlc/digest/main/search-ab12.md",
      "aidlc/digest/main/INDEX.md",
    ]);
    const digestFile = join(root, "aidlc", "digest", "main", "search-ab12.md");
    const once = readFileSync(digestFile, "utf-8");
    expect(once).toContain("- requirements-analysis: completed (2026-11-10T10:25:11Z)");

    buildDigest(root, "main");
    expect(readFileSync(digestFile, "utf-8")).toBe(once);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));
});
