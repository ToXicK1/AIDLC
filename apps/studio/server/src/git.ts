// Read-only git views for the project. A project inside some other repository
// (a home folder that happens to be a repo, say) is not treated as that
// repository: only a repo rooted at the project folder itself counts.

import { realpathSync } from "node:fs";
import path from "node:path";
import type { GitStatus } from "../../shared/types.ts";
import { cleanEnv, run } from "./proc.ts";
import { isSensitive, resolveInside, toRel } from "./security/paths.ts";

const GIT_ENV = (): NodeJS.ProcessEnv => cleanEnv({ GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });

function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export async function repoState(root: string): Promise<{ isRepo: boolean; note?: string }> {
  const top = await run("git", ["rev-parse", "--show-toplevel"], { cwd: root, env: GIT_ENV(), timeoutMs: 15000 });
  if (top.error) return { isRepo: false, note: "git is not installed." };
  if (top.code !== 0) return { isRepo: false, note: "This folder is not a git repository." };
  const toplevel = top.stdout.trim();
  if (!samePath(toplevel, realpathSync(root))) {
    return { isRepo: false, note: `This folder has no repository of its own (it sits inside ${toplevel}, which Studio leaves alone).` };
  }
  return { isRepo: true };
}

function label(index: string, worktree: string): GitStatus["files"][number]["label"] {
  if (index === "?" && worktree === "?") return "untracked";
  if (index === "U" || worktree === "U" || (index === "A" && worktree === "A") || (index === "D" && worktree === "D")) return "conflict";
  if (index === "R" || worktree === "R") return "renamed";
  if (index === "A") return "added";
  if (index === "D" || worktree === "D") return "deleted";
  return "modified";
}

export async function gitStatus(root: string): Promise<GitStatus> {
  const repo = await repoState(root);
  if (!repo.isRepo) return { isRepo: false, note: repo.note, files: [] };
  const [status, branch] = await Promise.all([
    run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, env: GIT_ENV(), timeoutMs: 30000 }),
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, env: GIT_ENV(), timeoutMs: 15000 }),
  ]);
  const files: GitStatus["files"] = [];
  const parts = status.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const index = entry[0];
    const worktree = entry[1];
    const file = entry.slice(3);
    if (index === "R" || index === "C") i++; // the original name follows
    files.push({ path: file, index, worktree, label: label(index, worktree) });
  }
  return { isRepo: true, branch: branch.code === 0 ? branch.stdout.trim() : undefined, files: files.slice(0, 5000) };
}

export async function gitDiff(root: string, rel: string): Promise<{ diff: string }> {
  const repo = await repoState(root);
  if (!repo.isRepo) return { diff: "" };
  const abs = resolveInside(root, rel);
  const relPath = toRel(root, abs);
  if (isSensitive(relPath)) return { diff: "(diff hidden: this file may hold secrets)" };
  const result = await run("git", ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", relPath], { cwd: root, env: GIT_ENV(), timeoutMs: 30000, maxBuffer: 2 * 1024 * 1024 });
  return { diff: result.stdout };
}

/** The committed (HEAD) content of a file, for the side-by-side diff editor. */
export async function gitOriginal(root: string, rel: string): Promise<{ exists: boolean; content: string }> {
  const repo = await repoState(root);
  if (!repo.isRepo) return { exists: false, content: "" };
  const abs = resolveInside(root, rel);
  const relPath = toRel(root, abs);
  if (isSensitive(relPath)) return { exists: false, content: "" };
  const result = await run("git", ["show", `HEAD:${relPath}`], { cwd: root, env: GIT_ENV(), timeoutMs: 30000, maxBuffer: 2 * 1024 * 1024 });
  return result.code === 0 ? { exists: true, content: result.stdout } : { exists: false, content: "" };
}
