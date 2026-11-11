// Secret redaction for everything Studio logs, streams or stores: process
// output, tool inputs/results, and execution logs.

const MASK = "[redacted]";

const PATTERNS: Array<[RegExp, string | ((m: string, ...g: string[]) => string)]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{30,}/g, MASK],
  [/\bhf_[A-Za-z0-9]{30,}/g, MASK],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, (_m, scheme) => `${scheme} ${MASK}`],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]+)@/gi, (_m, head) => `${head}:${MASK}@`],
  // NAME=value / "name": "value" where the name says it is a secret
  [
    /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)([^\s"',;]{6,})\3/gi,
    (m, name, sep, quote, value) => (/^\$|^\[redacted\]|^<|^your[-_]/i.test(value) ? m : `${name}${sep}${quote}${MASK}${quote}`),
  ],
];

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

let envSecrets: string[] | null = null;
function secretEnvValues(): string[] {
  if (envSecrets) return envSecrets;
  const values = new Set<string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 12) continue;
    if (SECRET_ENV_NAME.test(name) && !/^(SSH_AUTH_SOCK|GPG_AGENT_INFO)$/.test(name)) values.add(value);
  }
  envSecrets = [...values].sort((a, b) => b.length - a.length);
  return envSecrets;
}

/** Forget cached environment secrets (tests change process.env). */
export function resetRedactionCache(): void {
  envSecrets = null;
}

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const value of secretEnvValues()) {
    if (out.includes(value)) out = out.split(value).join(MASK);
  }
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, replacement as never);
  }
  return out;
}

/** Redact every string inside a JSON-like value and cap string length. */
export function redactDeep(value: unknown, maxString = 8000, depth = 0): unknown {
  if (typeof value === "string") {
    const clean = redact(value);
    return clean.length > maxString ? `${clean.slice(0, maxString)}\n… [${clean.length - maxString} more characters]` : clean;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redactDeep(v, maxString, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactDeep(inner, maxString, depth + 1);
  }
  return out;
}
