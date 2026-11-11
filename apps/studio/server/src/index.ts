// AI-DLC Studio server entry point. Loopback only, token-protected.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { allowedHostsFor, newToken } from "./security/auth.ts";
import { Store } from "./store.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(here, "..", "..");

function intEnv(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 && value < 65536 ? value : fallback;
}

const port = intEnv("AIDLC_STUDIO_PORT", 4317);
const devPort = process.env.AIDLC_STUDIO_DEV_PORT ? intEnv("AIDLC_STUDIO_DEV_PORT", 5173) : null;
const token = process.env.AIDLC_STUDIO_TOKEN && /^[A-Za-z0-9_-]{32,}$/.test(process.env.AIDLC_STUDIO_TOKEN) ? process.env.AIDLC_STUDIO_TOKEN : newToken();
const staticDir = path.join(studioRoot, "dist");
const store = new Store();

const studio = createApp({
  store,
  auth: { token, allowedHosts: allowedHostsFor(devPort ? [port, devPort] : [port]) },
  staticDir: existsSync(path.join(staticDir, "index.html")) ? staticDir : undefined,
});

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else {
      spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // The link is printed below; the person can open it themselves.
  }
}

const server = studio.app.listen(port, "127.0.0.1", () => {
  const uiPort = devPort ?? port;
  const url = `http://127.0.0.1:${uiPort}/#token=${token}`;
  const hasUi = devPort !== null || existsSync(path.join(staticDir, "index.html"));
  console.log("");
  console.log("  AI-DLC Studio");
  console.log(`  API      http://127.0.0.1:${port}`);
  console.log(`  Data     ${store.dir}`);
  if (hasUi) {
    console.log(`  Open     ${url}`);
  } else {
    console.log("  UI       not built yet - run `npm run build`, or use `npm run dev`.");
    console.log(`  Token    ${token}`);
  }
  console.log("");
  console.log("  The link carries a one-launch access token. Do not share it.");
  console.log("");
  if (hasUi && process.argv.includes("--open")) openBrowser(url);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Set AIDLC_STUDIO_PORT to another port, or stop the other Studio.`);
  } else {
    console.error(error.message);
  }
  process.exit(1);
});

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  console.log("\n  Stopping AI-DLC Studio…");
  server.close();
  server.closeAllConnections?.();
  await studio.dispose().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGBREAK", () => void shutdown());
process.on("uncaughtException", (error) => {
  console.error("Unexpected error:", error.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason instanceof Error ? reason.message : reason);
});
