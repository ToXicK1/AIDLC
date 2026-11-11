// Development launcher: the API server in Node watch mode plus a watching
// client build. The server itself serves the built client from dist/.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const children = [
  spawn(process.execPath, ["scripts/build.mjs", "--watch"], { cwd: root, stdio: "inherit" }),
  spawn(process.execPath, ["--watch-path=server/src", "--watch-path=shared", "server/src/index.ts", "--open"], { cwd: root, stdio: "inherit" }),
];

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exit(0);
}
for (const child of children) child.on("exit", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
