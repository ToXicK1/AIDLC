// HTTP client for the Studio API. Auth is the HttpOnly cookie set once from
// the launch link's token.

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T = any>(path: string, init: { method?: string; json?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers: init.json !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      credentials: "same-origin",
      signal: init.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new ApiError(0, "offline", "Studio's server is not reachable. Is it still running?");
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiError(res.status, body?.error ?? "error", body?.message ?? `Request failed (${res.status})`);
  return body as T;
}

const q = (params: Record<string, string | number | boolean | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === false || value === "") continue;
    search.set(key, value === true ? "1" : String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
};

/** Exchange the launch token (URL fragment) for the session cookie. */
export async function signIn(token: string): Promise<void> {
  await api("/auth/session", { json: { token } });
}

export async function bootstrapAuth(): Promise<boolean> {
  const match = /[#&]token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (match) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    try {
      await signIn(match[1]);
    } catch {
      // fall through to the probe below
    }
  }
  try {
    await api("/workspace");
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return false;
    throw error;
  }
}

export const P = (id: string) => ({
  snapshot: () => api(`/projects/${id}/snapshot`),
  init: (harness: string, runtime = "auto") => api(`/projects/${id}/init`, { json: { harness, runtime } }),
  doctor: () => api(`/projects/${id}/doctor`, { method: "POST" }),
  tree: (dir: string) => api(`/projects/${id}/tree${q({ dir })}`),
  file: (path: string, reveal = false) => api(`/projects/${id}/file${q({ path, reveal })}`),
  save: (body: { path: string; content: string; expectedMtime?: number; create?: boolean; confirmSensitive?: boolean }) => api(`/projects/${id}/file`, { method: "PUT", json: body }),
  search: (text: string, regex: boolean, caseSensitive: boolean) => api(`/projects/${id}/search${q({ q: text, regex, case: caseSensitive })}`),
  find: (text: string) => api(`/projects/${id}/find${q({ q: text })}`),
  changes: () => api(`/projects/${id}/changes`),
  gitStatus: () => api(`/projects/${id}/git/status`),
  gitDiff: (path: string) => api(`/projects/${id}/git/diff${q({ path })}`),
  gitOriginal: (path: string) => api(`/projects/${id}/git/original${q({ path })}`),
  conversations: () => api(`/projects/${id}/conversations`),
  newConversation: () => api(`/projects/${id}/conversations`, { method: "POST" }),
  events: (cid: string) => api(`/projects/${id}/conversations/${cid}/events`),
  send: (conversationId: string | null, text: string) => api(`/projects/${id}/chat/send`, { json: { conversationId: conversationId ?? undefined, text } }),
  stop: () => api(`/projects/${id}/chat/stop`, { method: "POST" }),
  answer: (requestId: string, answers: Record<string, string | string[]> | null, stage?: string) => api(`/projects/${id}/chat/answer`, { json: { id: requestId, answers, stage } }),
  permission: (requestId: string, decision: "allow" | "deny", message?: string) => api(`/projects/${id}/chat/permission`, { json: { id: requestId, decision, message } }),
  approve: (stage: string, decision: "approve" | "reject", comment: string) => api(`/projects/${id}/approvals`, { json: { stage, decision, comment } }),
  audit: () => api(`/projects/${id}/audit`),
  commands: () => api(`/projects/${id}/commands`),
  run: (commandId: string) => api(`/projects/${id}/commands/run`, { json: { id: commandId } }),
  kill: (runId: string) => api(`/projects/${id}/commands/${runId}/kill`, { method: "POST" }),
  tests: () => api(`/projects/${id}/tests`),
  logs: () => api(`/projects/${id}/logs`),
  clearLogs: () => api(`/projects/${id}/logs`, { method: "DELETE" }),
  patch: (body: unknown) => api(`/projects/${id}`, { method: "PATCH", json: body }),
  forget: () => api(`/projects/${id}`, { method: "DELETE" }),
  eventsUrl: `/api/projects/${id}/events`,
});

export const Sys = {
  system: (refresh = false) => api(`/system${refresh ? "?refresh=1" : ""}`),
  workspace: () => api("/workspace"),
  saveWorkspace: (workspace: unknown) => api("/workspace", { method: "PUT", json: { workspace } }),
  projects: () => api("/projects"),
  open: (path: string, create = false, name?: string) => api("/projects", { json: { path, create, name } }),
  browse: (path: string) => api(`/fs/browse${q({ path })}`),
};
