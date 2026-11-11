// Builds the web client into dist/ with tools that need no native add-ons:
// Tailwind's JavaScript CLI for styles and Bun's bundler for the app and the
// Monaco editor workers. Pass --watch to rebuild on change.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const dist = path.join(root, "dist");
const assets = path.join(dist, "assets");

function findBun() {
  const tool = process.platform === "win32" ? "where.exe" : "which";
  const found = spawnSync(tool, ["bun"], { encoding: "utf8" });
  const line = found.stdout?.split(/\r?\n/).find((l) => l.trim());
  if (found.status !== 0 || !line) {
    console.error("Bun is required to build AI-DLC Studio (https://bun.sh).");
    process.exit(1);
  }
  return line.trim();
}

const bun = findBun();
const tailwind = [path.join(root, "node_modules", "tailwindcss", "lib", "cli.js"), "-c", "tailwind.config.cjs", "-i", "web/src/styles.css", "-o", "dist/assets/app.css"];
const monaco = "node_modules/monaco-editor/esm/vs";
const workers = [
  `${monaco}/editor/editor.worker.js`,
  `${monaco}/language/json/json.worker.js`,
  `${monaco}/language/css/css.worker.js`,
  `${monaco}/language/html/html.worker.js`,
  `${monaco}/language/typescript/ts.worker.js`,
];
const define = ["--define", `process.env.NODE_ENV=${JSON.stringify(watch ? "development" : "production")}`];
const appArgs = [
  "build",
  "web/src/main.tsx",
  "--outdir",
  "dist/assets",
  "--target",
  "browser",
  "--splitting",
  "--entry-naming",
  "[name].[ext]",
  "--chunk-naming",
  "chunks/[name]-[hash].[ext]",
  "--asset-naming",
  "files/[name]-[hash].[ext]",
  "--public-path",
  "/assets/",
  ...define,
];
const workerArgs = ["build", ...workers, "--outdir", "dist/assets/workers", "--target", "browser", "--format", "iife", "--entry-naming", "[name].[ext]", "--minify", ...define];

function runSync(command, args, label) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${label} failed.`);
    process.exit(result.status ?? 1);
  }
  console.log(`  ${label} done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (!watch) rmSync(dist, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });
copyFileSync(path.join(root, "web", "index.html"), path.join(dist, "index.html"));

if (!existsSync(path.join(assets, "workers", "editor.worker.js")) || !watch) runSync(bun, workerArgs, "editor workers");

if (watch) {
  const children = [
    spawn(process.execPath, [...tailwind, "--watch"], { cwd: root, stdio: "inherit" }),
    spawn(bun, [...appArgs, "--watch"], { cwd: root, stdio: "inherit" }),
  ];
  const stop = () => {
    for (const child of children) child.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} else {
  runSync(process.execPath, [...tailwind, "--minify"], "styles");
  runSync(bun, [...appArgs, "--minify"], "app bundle");
  console.log(`\n  Built ${path.relative(process.cwd(), dist) || "dist"}`);
}
