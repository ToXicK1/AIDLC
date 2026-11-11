import type { AiContextEnvelope } from "./context-compiler";

// Compact text form of a context envelope. Each collection is a table: one header line
// names its columns once, then one line per item. Keys are never repeated per item.
//   - Within a cell: "|" separates columns, ";" separates list items, "\" escapes both.
//   - Acceptance criteria are written as: Given ... When ... Then ...
// Encoding only; there is no decoder yet.

function escapeCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/;/g, "\\;").replace(/\r?\n/g, "\\n");
}

function encodeValue(key: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return escapeCell(value);
  if (Array.isArray(value)) {
    if (key === "acceptance") {
      return value
        .map((c: { given: string; when: string; then: string }) => `Given ${escapeCell(c.given)} When ${escapeCell(c.when)} Then ${escapeCell(c.then)}`)
        .join(";");
    }
    return value.map((item) => escapeCell(String(item))).join(";");
  }
  return escapeCell(String(value));
}

function encodeTable(name: string, rows: Record<string, unknown>[]): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  const lines = [`@${name} ${columns.join("|")}`];
  for (const row of rows) {
    lines.push(columns.map((col) => encodeValue(col, row[col])).join("|"));
  }
  return lines;
}

export function encodeCompact(envelope: AiContextEnvelope): string {
  const lines: string[] = [];
  lines.push(`@reqspec ${envelope.protocol} task=${envelope.task}`);
  lines.push("@instructions");
  for (const line of envelope.instructions) lines.push(`- ${line}`);
  const out = envelope.output;
  lines.push(`@output format=${out.format} ops=${out.allowedOperations.join(",")}${out.questionsPath ? ` questions=${out.questionsPath}` : ""}${out.shape ? ` shape=${out.shape}` : ""}`);
  if (envelope.omitted.length > 0) {
    lines.push(`@omitted ${envelope.omitted.map((o) => `${o.section}=${o.ids.join(",")}`).join(" ")}`);
  }

  const context = envelope.context;
  const project = context.project as Record<string, unknown> | undefined;
  if (project) {
    lines.push("@project");
    for (const [key, value] of Object.entries(project)) lines.push(`${key}: ${encodeValue(key, value)}`);
  }
  for (const [name, value] of Object.entries(context)) {
    if (name === "project") continue;
    lines.push(...encodeTable(name, value as Record<string, unknown>[]));
  }
  return lines.join("\n");
}
