// Project setup. Two documented routes (README "Install AI-DLC"):
//   1. native: `aidlc config --harness <name>` when the native command runs;
//   2. manual copy: the complete Bun-shaped runtime/<harness>/ tree copied into
//      the project. Studio takes it from the engine checkout's generated
//      dist/<harness>/ (built with the repo's own `bun scripts/package.ts`).
// Route 2 never overwrites a file the person already has.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv, run, which } from "../proc.ts";
import { harnessById } from "../harness/registry.ts";
import { nativeAidlcUsable, probeNativeAidlc } from "./engine.ts";

export interface InitResult {
  ok: boolean;
  route: "native" | "copy" | "none";
  message: string;
  copied: number;
  skipped: string[];
  log: string;
}

/** The AI-DLC repository checkout Studio lives in (apps/studio/server/src/engine -> repo root). */
export function engineRepoRoot(): string | null {
  const override = process.env.AIDLC_STUDIO_ENGINE_REPO;
  const guess = override ? path.resolve(override) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
  return existsSync(path.join(guess, "core", "tools", "aidlc.ts")) && existsSync(path.join(guess, "scripts", "package.ts")) ? guess : null;
}

async function ensureRuntimeSource(distDir: string, log: string[]): Promise<string | null> {
  const repo = engineRepoRoot();
  if (!repo) {
    log.push("No AI-DLC repository checkout found (set AIDLC_STUDIO_ENGINE_REPO).");
    return null;
  }
  const source = path.join(repo, "dist", distDir);
  if (existsSync(source)) return source;
  const bun = which("bun");
  if (!bun) {
    log.push("bun is not installed, so the runtime projection cannot be generated.");
    return null;
  }
  log.push(`$ bun scripts/package.ts ${distDir}`);
  const built = await run(bun, ["scripts/package.ts", distDir], { cwd: repo, env: cleanEnv({ NO_COLOR: "1" }), timeoutMs: 300000 });
  log.push((built.stdout + built.stderr).trim());
  return built.code === 0 && existsSync(source) ? source : null;
}

function mergeGitignore(source: string, target: string): void {
  const wanted = readFileSync(source, "utf8").split(/\r?\n/);
  const current = readFileSync(target, "utf8");
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = wanted.filter((l) => l.trim() !== "" && !l.trim().startsWith("#") && !have.has(l.trim()));
  if (missing.length === 0) return;
  const block = ["", "# AI-DLC (added by AI-DLC Studio)", ...missing, ""].join("\n");
  writeFileSync(target, current.endsWith("\n") ? current + block : `${current}\n${block}`, "utf8");
}

function copyTree(source: string, target: string, rel: string, result: InitResult): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, to, relPath, result);
    } else if (entry.isFile()) {
      if (existsSync(to)) {
        if (relPath === ".gitignore") mergeGitignore(from, to);
        else result.skipped.push(relPath);
        continue;
      }
      copyFileSync(from, to);
      result.copied++;
    }
  }
}

export async function initProject(projectDir: string, harnessId: string, runtime: "auto" | "native" | "bun" = "auto"): Promise<InitResult> {
  const harness = harnessById(harnessId);
  const log: string[] = [];
  const result: InitResult = { ok: false, route: "none", message: "", copied: 0, skipped: [], log: "" };
  if (!harness) {
    result.message = `Unknown harness: ${harnessId}`;
    return result;
  }

  // Probe now rather than trust an earlier answer: the native command can be
  // blocked or allowed by the machine's policy between two runs.
  if (runtime !== "bun") await probeNativeAidlc();
  if (runtime === "native" && !nativeAidlcUsable()) {
    result.message = "The native `aidlc` command is not running on this machine. Choose the Bun runtime instead.";
    return result;
  }
  if (runtime !== "bun" && nativeAidlcUsable()) {
    const aidlc = which("aidlc");
    if (aidlc) {
      // --yes confirms the explicit choices given here; it never picks values.
      const args = ["config", "--harness", harness.id, "--project-dir", projectDir, "--yes"];
      log.push(`$ aidlc ${args.join(" ")}`);
      const done = await run(aidlc, args, { cwd: projectDir, env: cleanEnv({ NO_COLOR: "1" }), timeoutMs: 300000 });
      log.push((done.stdout + done.stderr).trim());
      if (done.code === 0) {
        result.ok = true;
        result.route = "native";
        result.message = `AI-DLC configured for ${harness.name} with the native aidlc command.`;
        result.log = log.join("\n");
        return result;
      }
      if (runtime === "native") {
        result.message = `aidlc config failed (exit ${done.code}).`;
        result.log = log.join("\n");
        return result;
      }
      log.push(`aidlc config exited ${done.code}; falling back to the Bun runtime copy.`);
    }
  }

  if (!which("bun")) {
    result.message = "Neither the native `aidlc` command nor Bun can run here. Install Bun (https://bun.sh) and try again.";
    result.log = log.join("\n");
    return result;
  }
  const source = await ensureRuntimeSource(harness.distDir, log);
  if (!source) {
    result.message = "The AI-DLC runtime for this harness could not be found or generated.";
    result.log = log.join("\n");
    return result;
  }

  // A settings file the person already has, without AI-DLC's hooks, would
  // leave the harness running none of them. Refuse rather than overwrite it.
  const settingsRel = `${harness.dir}/settings.json`;
  const existingSettings = path.join(projectDir, harness.dir, "settings.json");
  if (existsSync(path.join(source, harness.dir, "settings.json")) && existsSync(existingSettings)) {
    const text = readFileSync(existingSettings, "utf8");
    if (!/aidlc/.test(text)) {
      result.message =
        `${settingsRel} already exists and does not register AI-DLC's hooks. Studio will not overwrite it. ` +
        `Merge the hooks and permissions from ${path.join(source, harness.dir, "settings.json")} into it, then set the project up again.`;
      result.log = log.join("\n");
      return result;
    }
  }

  log.push(`Copying ${source} -> ${projectDir} (existing files are kept)`);
  copyTree(source, projectDir, "", result);
  result.ok = true;
  result.route = "copy";
  result.message =
    `AI-DLC set up for ${harness.name} using the Bun runtime (${result.copied} files copied` +
    (result.skipped.length ? `, ${result.skipped.length} existing files kept` : "") +
    ").";
  result.log = log.join("\n");
  return result;
}
