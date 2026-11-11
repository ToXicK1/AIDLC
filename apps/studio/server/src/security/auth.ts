// Local-only access control. Studio binds to loopback, and every /api call
// must carry the per-launch token (HttpOnly cookie or Bearer header). Host and
// Origin are checked so a web page or a DNS-rebinding name cannot drive it.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const COOKIE_NAME = "aidlc_studio";

export interface AuthConfig {
  token: string;
  /** host:port values the browser may use to reach Studio. */
  allowedHosts: Set<string>;
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export function allowedHostsFor(ports: number[]): Set<string> {
  const hosts = new Set<string>();
  for (const port of ports) {
    hosts.add(`127.0.0.1:${port}`);
    hosts.add(`localhost:${port}`);
    hosts.add(`[::1]:${port}`);
  }
  return hosts;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieToken(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === COOKIE_NAME) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

export function hostGuard(config: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!config.allowedHosts.has(host)) {
      res.status(403).json({ error: "forbidden_host", message: "Studio only answers on its loopback address." });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        originHost = "";
      }
      if (!config.allowedHosts.has(originHost)) {
        res.status(403).json({ error: "forbidden_origin", message: "Cross-origin requests are not accepted." });
        return;
      }
    } else if (req.method !== "GET" && req.method !== "HEAD" && req.headers["sec-fetch-site"] === "cross-site") {
      res.status(403).json({ error: "forbidden_origin", message: "Cross-site requests are not accepted." });
      return;
    }
    next();
  };
}

export function requireAuth(config: AuthConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = bearerToken(req) ?? cookieToken(req);
    if (!presented || !safeEqual(presented, config.token)) {
      res.status(401).json({ error: "unauthorized", message: "Open Studio from the launch link, or paste the access token." });
      return;
    }
    next();
  };
}

/** POST /api/auth/session { token } -> sets the HttpOnly session cookie. */
export function sessionHandler(config: AuthConfig) {
  return (req: Request, res: Response): void => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!token || !safeEqual(token, config.token)) {
      res.status(401).json({ error: "unauthorized", message: "That access token is not valid for this Studio launch." });
      return;
    }
    res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(config.token)}; HttpOnly; SameSite=Strict; Path=/`);
    res.json({ ok: true });
  };
}
