// Test results. Two real sources only: a test command the person runs from
// Studio, and a test command the harness ran in chat (its Bash tool output).
// Counts come from parsing the runner's own summary; when no summary is
// recognised the run is reported with its exit status and raw log only.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { TestRun } from "../../shared/types.ts";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

export const TEST_COMMAND = /\b(vitest|jest|mocha|pytest|py\.test|unittest|playwright|cypress|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\S*|bun\s+test|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+(?:\S+\s+)*test|gradle\w*\s+(?:\S+\s+)*test|node\s+--test|tsc\b.*--noEmit)\b/i;

type Summary = NonNullable<TestRun["summary"]>;

function num(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number.parseInt(value, 10);
}

function pick(text: string, re: RegExp): number | undefined {
  const all = [...text.matchAll(re)];
  const last = all[all.length - 1];
  return last ? num(last[1]) : undefined;
}

export function parseTestOutput(raw: string): { summary?: Summary; failures: TestRun["failures"] } {
  const text = stripAnsi(raw);
  const failures: TestRun["failures"] = [];
  let summary: Summary | undefined;

  const set = (s: Summary): void => {
    const clean: Summary = {};
    for (const key of ["passed", "failed", "skipped", "total"] as const) {
      if (typeof s[key] === "number" && !Number.isNaN(s[key])) clean[key] = s[key];
    }
    if (Object.keys(clean).length === 0) return;
    if (clean.total === undefined) clean.total = (clean.passed ?? 0) + (clean.failed ?? 0) + (clean.skipped ?? 0);
    summary = clean;
  };

  // vitest:  Tests  1 failed | 12 passed | 2 skipped (15)
  const vitest = /^\s*Tests\s+(.+?)\s*\((\d+)\)\s*$/m.exec(text);
  // jest:    Tests:       1 failed, 2 skipped, 10 passed, 13 total
  const jest = /^\s*Tests:\s+(.+?),?\s*(\d+) total\s*$/m.exec(text);
  // pytest:  ==== 2 failed, 5 passed, 1 skipped in 0.12s ====
  const pytest = /^=+ (.*?(?:passed|failed|error|skipped|no tests ran).*?) in [\d.]+s.*=+\s*$/m.exec(text);
  // cargo:   test result: FAILED. 3 passed; 1 failed; 0 ignored;
  const cargo = [...text.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)];
  // dotnet:  Failed: 0, Passed: 5, Skipped: 0, Total: 5
  const dotnet = /Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/.exec(text);

  if (vitest) {
    const body = vitest[1];
    set({ passed: num(/(\d+) passed/.exec(body)?.[1]), failed: num(/(\d+) failed/.exec(body)?.[1]) ?? 0, skipped: num(/(\d+) (?:skipped|todo)/.exec(body)?.[1]), total: num(vitest[2]) });
  } else if (jest) {
    const body = jest[1];
    set({ passed: num(/(\d+) passed/.exec(body)?.[1]) ?? 0, failed: num(/(\d+) failed/.exec(body)?.[1]) ?? 0, skipped: num(/(\d+) (?:skipped|todo|pending)/.exec(body)?.[1]), total: num(jest[2]) });
  } else if (pytest) {
    const body = pytest[1];
    const failed = (num(/(\d+) failed/.exec(body)?.[1]) ?? 0) + (num(/(\d+) errors?/.exec(body)?.[1]) ?? 0);
    set({ passed: num(/(\d+) passed/.exec(body)?.[1]) ?? 0, failed, skipped: num(/(\d+) skipped/.exec(body)?.[1]) });
  } else if (cargo.length > 0) {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    for (const m of cargo) {
      passed += Number(m[1]);
      failed += Number(m[2]);
      skipped += Number(m[3]);
    }
    set({ passed, failed, skipped });
  } else if (dotnet) {
    set({ failed: num(dotnet[1]), passed: num(dotnet[2]), skipped: num(dotnet[3]), total: num(dotnet[4]) });
  } else if (/^# tests \d+/m.test(text) || /^# pass \d+/m.test(text)) {
    // node:test and TAP
    set({ passed: pick(text, /^# pass (\d+)/gm), failed: pick(text, /^# fail (\d+)/gm) ?? 0, skipped: pick(text, /^# skip(?:ped)? (\d+)/gm), total: pick(text, /^# tests (\d+)/gm) });
  } else if (/^\s*\d+ pass\s*$/m.test(text)) {
    // bun test
    set({ passed: pick(text, /^\s*(\d+) pass\s*$/gm), failed: pick(text, /^\s*(\d+) fail\s*$/gm) ?? 0, skipped: pick(text, /^\s*(\d+) skip\s*$/gm) });
  } else if (/^\s*\d+ passing/m.test(text)) {
    // mocha
    set({ passed: pick(text, /^\s*(\d+) passing/gm), failed: pick(text, /^\s*(\d+) failing/gm) ?? 0, skipped: pick(text, /^\s*(\d+) pending/gm) });
  } else if (/^(?:=== RUN|--- (?:PASS|FAIL|SKIP)|ok\s+\S+|FAIL\s+\S+)/m.test(text)) {
    // go test
    const passed = [...text.matchAll(/^\s*--- PASS:/gm)].length;
    const failed = [...text.matchAll(/^\s*--- FAIL:/gm)].length;
    const skipped = [...text.matchAll(/^\s*--- SKIP:/gm)].length;
    if (passed + failed + skipped > 0) set({ passed, failed, skipped });
  }

  const add = (name: string, extra: Partial<TestRun["failures"][number]> = {}): void => {
    const clean = name.trim();
    if (!clean || failures.length >= 200 || failures.some((f) => f.name === clean)) return;
    failures.push({ name: clean, ...extra });
  };
  for (const m of text.matchAll(/^FAILED (\S+?)(?:::(\S+))?(?: - (.*))?$/gm)) {
    add(m[2] ? `${m[1]}::${m[2]}` : m[1], { file: m[1], message: m[3] });
  }
  for (const m of text.matchAll(/^\s*(?:FAIL|❯)\s+(\S+\.(?:test|spec)\.[a-z]+)(?:\s+>\s+(.+?))?(?:\s+\[.*\]|\s+\d+ms)?\s*$/gm)) {
    add(m[2] ? `${m[1]} > ${m[2]}` : m[1], { file: m[1] });
  }
  for (const m of text.matchAll(/^\s*[×✕✗]\s+(.+?)(?:\s+\(?\d+(?:\.\d+)?\s*m?s\)?)?\s*$/gm)) add(m[1]);
  for (const m of text.matchAll(/^\s*--- FAIL: (\S+)/gm)) add(m[1]);
  for (const m of text.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)) add(m[1]);
  for (const m of text.matchAll(/^not ok \d+ -? ?(.+)$/gm)) add(m[1]);
  for (const m of text.matchAll(/^test (\S+) \.\.\. FAILED$/gm)) add(m[1]);

  // Attach the first "file:line" that follows a failure name in the log.
  for (const failure of failures) {
    if (failure.line !== undefined) continue;
    const at = text.indexOf(failure.name.split(" > ").pop() ?? failure.name);
    if (at < 0) continue;
    const window = text.slice(at, at + 1500);
    const loc = /((?:[A-Za-z]:)?[\w./\\-]+\.(?:[cm]?[jt]sx?|py|go|rs|cs|java|rb)):(\d+)/.exec(window);
    if (loc) {
      failure.file ??= loc[1];
      failure.line = Number(loc[2]);
    }
  }
  return { summary, failures };
}

export function statusOf(summary: Summary | undefined, exitCode: number | null | undefined, isError = false): TestRun["status"] {
  if (summary && (summary.failed ?? 0) > 0) return "failed";
  if (exitCode !== undefined && exitCode !== null && exitCode !== 0) return summary ? "failed" : "error";
  if (exitCode === null) return "error";
  if (isError) return "failed";
  return "passed";
}

export interface Coverage {
  source: string;
  lines?: number;
  statements?: number;
  functions?: number;
  branches?: number;
}

/** Coverage only when the project's own tooling wrote a summary Studio can read. */
export function readCoverage(projectDir: string): Coverage | null {
  const file = path.join(projectDir, "coverage", "coverage-summary.json");
  if (!existsSync(file)) return null;
  try {
    const total = (JSON.parse(readFileSync(file, "utf8")) as { total?: Record<string, { pct?: number }> }).total;
    if (!total) return null;
    return { source: "coverage/coverage-summary.json", lines: total.lines?.pct, statements: total.statements?.pct, functions: total.functions?.pct, branches: total.branches?.pct };
  } catch {
    return null;
  }
}

const MAX_OUTPUT = 400000;

export class TestTracker {
  private runs: TestRun[] = [];
  private readonly pendingTools = new Map<string, { command: string; startedAt: string }>();
  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  list(): TestRun[] {
    return this.runs;
  }

  private push(run: TestRun): void {
    this.runs = [run, ...this.runs.filter((r) => r.id !== run.id)].slice(0, 40);
    this.onChange();
  }

  begin(id: string, command: string): void {
    this.push({ id, source: "studio", command, startedAt: new Date().toISOString(), status: "running", failures: [], output: "" });
  }

  append(id: string, chunk: string): void {
    const run = this.runs.find((r) => r.id === id);
    if (run && run.output.length < MAX_OUTPUT) run.output += chunk;
  }

  finish(id: string, exitCode: number | null): void {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return;
    const parsed = parseTestOutput(run.output);
    run.exitCode = exitCode;
    run.finishedAt = new Date().toISOString();
    run.summary = parsed.summary;
    run.failures = parsed.failures;
    run.status = statusOf(parsed.summary, exitCode);
    this.onChange();
  }

  /** Watch the harness stream for test commands it runs itself. */
  observeToolUse(id: string, name: string, input: unknown): void {
    if (name !== "Bash" && name !== "PowerShell") return;
    const command = (input as { command?: unknown } | undefined)?.command;
    if (typeof command === "string" && TEST_COMMAND.test(command)) {
      this.pendingTools.set(id, { command: command.slice(0, 500), startedAt: new Date().toISOString() });
    }
  }

  observeToolResult(id: string, text: string, isError: boolean): void {
    const pending = this.pendingTools.get(id);
    if (!pending) return;
    this.pendingTools.delete(id);
    const parsed = parseTestOutput(text);
    this.push({
      id: `harness-${id}`,
      source: "harness",
      command: pending.command,
      startedAt: pending.startedAt,
      finishedAt: new Date().toISOString(),
      status: statusOf(parsed.summary, undefined, isError),
      summary: parsed.summary,
      failures: parsed.failures,
      output: text.slice(0, MAX_OUTPUT),
    });
  }
}
