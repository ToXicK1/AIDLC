// Project file services: tree listing, read, write and search. Every path is
// resolved through the sandbox in security/paths.ts.

import * as fsModule from "node:fs";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TreeEntry } from "../../shared/types.ts";
import { PathError, isSensitive, resolveInside, toRel } from "./security/paths.ts";

export const HEAVY_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
  "coverage",
  ".gradle",
  "bin",
  "obj",
]);

const MAX_READ = 2 * 1024 * 1024;
const MAX_WRITE = 5 * 1024 * 1024;

export function listDir(root: string, rel: string): TreeEntry[] {
  const dir = resolveInside(root, rel);
  const entries: TreeEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const abs = path.join(dir, entry.name);
    const relPath = toRel(root, abs);
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, path: relPath, dir: true, heavy: HEAVY_DIRS.has(entry.name) || undefined, sensitive: isSensitive(`${relPath}/x`) || undefined });
    } else {
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      entries.push({ name: entry.name, path: relPath, dir: false, size, sensitive: isSensitive(relPath) || undefined });
    }
  }
  return entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.dir ? -1 : 1));
}

function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true;
  return false;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  mtime: number;
  binary: boolean;
  truncated: boolean;
  sensitive: boolean;
}

export function readFile(root: string, rel: string, reveal: boolean): FileContent {
  const abs = resolveInside(root, rel);
  const stat = statSync(abs);
  if (!stat.isFile()) throw new PathError("not_file", "That path is not a file.");
  const relPath = toRel(root, abs);
  const sensitive = isSensitive(relPath);
  if (sensitive && !reveal) {
    throw new PathError("sensitive", "This file may hold secrets. Studio shows it only when you explicitly ask.");
  }
  if (stat.size > MAX_READ) {
    const buffer = Buffer.alloc(MAX_READ);
    const fd = fsModule.openSync(abs, "r");
    try {
      fsModule.readSync(fd, buffer, 0, MAX_READ, 0);
    } finally {
      fsModule.closeSync(fd);
    }
    const binary = looksBinary(buffer);
    return { path: relPath, content: binary ? "" : buffer.toString("utf8"), size: stat.size, mtime: stat.mtimeMs, binary, truncated: true, sensitive };
  }
  const buffer = readFileSync(abs);
  const binary = looksBinary(buffer);
  return { path: relPath, content: binary ? "" : buffer.toString("utf8"), size: stat.size, mtime: stat.mtimeMs, binary, truncated: false, sensitive };
}

export interface WriteOptions {
  /** mtime the editor loaded; a newer file on disk is a conflict. */
  expectedMtime?: number;
  create?: boolean;
  confirmSensitive?: boolean;
}

export function writeFile(root: string, rel: string, content: string, options: WriteOptions = {}): { path: string; mtime: number; created: boolean } {
  if (typeof content !== "string") throw new PathError("invalid", "Content must be text.");
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE) throw new PathError("too_large", "File is too large to save from Studio.");
  const abs = resolveInside(root, rel);
  const relPath = toRel(root, abs);
  if (relPath === "") throw new PathError("invalid", "A file path is required.");
  if (relPath.split("/").includes(".git")) throw new PathError("protected", "Studio does not write inside .git.");
  if (isSensitive(relPath) && !options.confirmSensitive) {
    throw new PathError("sensitive", "This file may hold secrets. Confirm to save it from Studio.");
  }
  const exists = existsSync(abs);
  if (exists) {
    const stat = statSync(abs);
    if (!stat.isFile()) throw new PathError("not_file", "That path is not a file.");
    if (options.expectedMtime !== undefined && Math.abs(stat.mtimeMs - options.expectedMtime) > 2) {
      throw new PathError("conflict", "The file changed on disk since it was opened. Reload it before saving.");
    }
  } else {
    if (!options.create) throw new PathError("not_found", "The file does not exist.");
    mkdirSync(path.dirname(abs), { recursive: true });
  }
  writeFileSync(abs, content, "utf8");
  return { path: relPath, mtime: statSync(abs).mtimeMs, created: !exists };
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
}

const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|txt|ya?ml|toml|ini|cfg|py|rb|go|rs|java|kt|cs|c|h|cpp|hpp|html?|css|scss|less|sql|sh|ps1|bat|cmd|xml|gradle|tf|vue|svelte|php|swift|dockerfile|graphql|proto)$/i;

export function searchFiles(root: string, query: string, options: { regex?: boolean; caseSensitive?: boolean; maxHits?: number } = {}): { hits: SearchHit[]; truncated: boolean; filesScanned: number } {
  if (typeof query !== "string" || query.length === 0) return { hits: [], truncated: false, filesScanned: 0 };
  if (query.length > 300) throw new PathError("invalid", "Search text is too long.");
  const maxHits = options.maxHits ?? 300;
  let matcher: RegExp;
  try {
    matcher = new RegExp(options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options.caseSensitive ? "" : "i");
  } catch {
    throw new PathError("invalid", "That regular expression is not valid.");
  }
  const base = resolveInside(root, "");
  const hits: SearchHit[] = [];
  let filesScanned = 0;
  let truncated = false;
  const deadline = Date.now() + 8000;
  const walk = (dir: string, depth: number): void => {
    if (truncated || depth > 12) return;
    let entries: fsModule.Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (HEAVY_DIRS.has(entry.name)) continue;
        walk(abs, depth + 1);
      } else if (entry.isFile()) {
        const rel = toRel(root, abs);
        if (isSensitive(rel)) continue;
        if (!TEXT_EXT.test(entry.name) && !/^(Dockerfile|Makefile|README|LICENSE)$/i.test(entry.name)) continue;
        let stat: fsModule.Stats;
        try {
          stat = statSync(abs);
        } catch {
          continue;
        }
        if (stat.size > 1024 * 1024) continue;
        filesScanned++;
        if (filesScanned > 20000 || Date.now() > deadline) {
          truncated = true;
          return;
        }
        let text: string;
        try {
          text = readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const found = matcher.exec(lines[i]);
          if (found) {
            hits.push({ path: rel, line: i + 1, column: found.index + 1, text: lines[i].slice(0, 240) });
            if (hits.length >= maxHits) {
              truncated = true;
              return;
            }
          }
        }
      }
    }
  };
  walk(base, 0);
  return { hits, truncated, filesScanned };
}

/** Find files whose name contains the query (quick open). */
export function findFiles(root: string, query: string, max = 100): string[] {
  const needle = query.toLowerCase();
  const out: string[] = [];
  const base = resolveInside(root, "");
  const walk = (dir: string, depth: number): void => {
    if (out.length >= max || depth > 12) return;
    let entries: fsModule.Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= max) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!HEAVY_DIRS.has(entry.name)) walk(abs, depth + 1);
      } else if (entry.isFile()) {
        const rel = toRel(root, abs);
        if (rel.toLowerCase().includes(needle)) out.push(rel);
      }
    }
  };
  walk(base, 0);
  return out;
}
