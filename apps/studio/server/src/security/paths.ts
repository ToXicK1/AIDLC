// Filesystem sandbox. Every project file operation resolves its path here, so
// nothing outside the explicitly opened project folder can be read or written.

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export class PathError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PathError";
    this.code = code;
  }
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Normalise a client-supplied project-relative path into safe segments. */
export function toSegments(rel: unknown): string[] {
  if (typeof rel !== "string") throw new PathError("invalid", "Path must be a string.");
  if (rel.length > 1024) throw new PathError("invalid", "Path is too long.");
  if (rel.includes("\0")) throw new PathError("invalid", "Path contains a NUL byte.");
  const unified = rel.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified) || unified.startsWith("~")) {
    throw new PathError("absolute", "Only project-relative paths are accepted.");
  }
  const segments: string[] = [];
  for (const raw of unified.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") throw new PathError("traversal", "Path traversal is not allowed.");
    // Colons address NTFS alternate data streams; trailing dots/spaces are
    // silently stripped by Win32 and would alias another name.
    if (raw.includes(":")) throw new PathError("invalid", "Path segment contains ':'.");
    if (/[. ]$/.test(raw)) throw new PathError("invalid", "Path segment ends with a dot or space.");
    if (WINDOWS_DEVICE.test(raw)) throw new PathError("invalid", "Path names a reserved device.");
    if (/[<>"|?*\x00-\x1f]/.test(raw)) throw new PathError("invalid", "Path segment has an illegal character.");
    segments.push(raw);
  }
  return segments;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve `rel` inside `root`. The deepest existing ancestor is resolved
 * through the filesystem so a symlink or junction cannot lead outside.
 */
export function resolveInside(root: string, rel: unknown): string {
  const segments = toSegments(rel);
  const realRoot = realpathSync(root);
  const target = path.join(realRoot, ...segments);
  if (!isInside(realRoot, target)) throw new PathError("traversal", "Path escapes the project folder.");
  let probe = target;
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = realpathSync(probe);
  if (!isInside(realRoot, realProbe)) {
    throw new PathError("traversal", "Path resolves outside the project folder through a link.");
  }
  return target;
}

/** Project-relative path with forward slashes. */
export function toRel(root: string, abs: string): string {
  return path.relative(realpathSync(root), abs).replace(/\\/g, "/");
}

const SENSITIVE_NAME = [
  /^\.env(\..+)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^credentials(\.json)?$/i,
  /^secrets?(\.(json|ya?ml|toml|txt))?$/i,
  /^settings\.local\.json$/i,
  /\.tfvars(\.json)?$/i,
  /\.tfstate(\.backup)?$/i,
];
const SENSITIVE_DIR = /(^|\/)(\.aws|\.ssh|\.gnupg|\.azure|\.aidlc-sessions)(\/|$)/i;

/** Files Studio never shows or sends unless the person explicitly asks. */
export function isSensitive(rel: string): boolean {
  const unified = rel.replace(/\\/g, "/");
  if (SENSITIVE_DIR.test(unified)) return true;
  const name = unified.split("/").pop() ?? "";
  if (/^\.env\.(example|sample|template)$/i.test(name)) return false;
  return SENSITIVE_NAME.some((re) => re.test(name));
}

/** Validate an absolute folder a person picked as a project root. */
export function validateProjectRoot(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "") throw new PathError("invalid", "A folder path is required.");
  if (input.includes("\0")) throw new PathError("invalid", "Path contains a NUL byte.");
  const abs = path.resolve(input.trim());
  if (!path.isAbsolute(abs)) throw new PathError("invalid", "Project path must be absolute.");
  const parsed = path.parse(abs);
  if (parsed.root === abs) throw new PathError("root", "A drive or filesystem root cannot be opened as a project.");
  return abs;
}
