// Session-level actions that need no view state, so any UI can call them.
// Failures throw; the caller decides how to surface them.

import { api, importBundle, markSessionKillRequested, pollSessions, tryImportBundleWith409 } from "./api.js";
import { saveLastCwd } from "./cwd-history.js";
import { state, markRailDirty, notifyChange } from "./state.js";

export interface CreateSessionParams {
  cwd?: string;
  // Meaningless for a remote create: the peer applies its own default agent.
  agentId?: string;
  remote?: string;
  name?: string;
  prompt?: string;
}

export async function createSession(
  params: CreateSessionParams,
): Promise<{ sessionId?: string }> {
  // A remote's cwd resolves on the peer, which also supplies its own default.
  if (!params.remote && !params.cwd) {
    throw new Error("cwd is required");
  }
  const body: Record<string, unknown> = {};
  if (params.cwd) {
    body.cwd = params.cwd;
  }
  if (params.remote) {
    body.remote = params.remote;
  } else if (params.agentId) {
    body.agentId = params.agentId;
  }
  if (params.name) {
    body.name = params.name;
  }
  if (params.prompt) {
    body.prompt = params.prompt;
  }
  // Spawns an agent, so generous, but bounded so a stall surfaces as an error.
  const data = await api<{ sessionId?: string }>("/api/sessions", {
    method: "POST",
    body: JSON.stringify(body),
    timeoutMs: 60_000,
  });
  if (!params.remote && params.cwd) {
    saveLastCwd(params.cwd);
  }
  void pollSessions();
  return data ?? {};
}

export async function killSession(sessionId: string): Promise<void> {
  await api("/api/kill", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
  markSessionKillRequested(sessionId);
  // Flip the card cold now: a federated peer's view can lag several seconds.
  const idx = state.sessions.findIndex((x) => x.sessionId === sessionId);
  if (idx >= 0) {
    state.sessions[idx] = {
      ...state.sessions[idx]!,
      status: "cold",
      busy: false,
      awaitingInput: false,
    };
    markRailDirty();
    notifyChange();
  }
  void pollSessions();
}

export async function setSessionTitle(sessionId: string, title: string): Promise<void> {
  await api(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
  void pollSessions();
}

// Positive integer floats the session up the list; null clears it.
export async function setSessionPriority(
  sessionId: string,
  priority: number | null,
): Promise<void> {
  await api(`/api/sessions/${encodeURIComponent(sessionId)}/priority`, {
    method: "PATCH",
    body: JSON.stringify({ priority }),
  });
  void pollSessions();
}

// GET target for a bundle download; the session cookie carries auth.
export function sessionExportUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/export`;
}

export type ImportOutcome =
  | { kind: "imported"; sessionId: string; replaced: boolean }
  | { kind: "cancelled" }
  | { kind: "invalid"; message: string }
  | { kind: "failed"; message: string };

// Imports a *.hydra bundle from its JSON text. If the daemon reports the
// session is already imported (409), confirmReplace decides whether to
// replace it; declining yields "cancelled".
export async function importBundleFromText(
  text: string,
  confirmReplace: (existingSessionId: string) => boolean | Promise<boolean>,
): Promise<ImportOutcome> {
  let bundle: unknown;
  try {
    bundle = JSON.parse(text);
  } catch (err) {
    return { kind: "invalid", message: (err as Error).message };
  }
  const first = await tryImportBundleWith409(bundle);
  if (first.ok) {
    void pollSessions();
    return { kind: "imported", sessionId: first.result.sessionId, replaced: first.result.replaced };
  }
  if (first.status === 409 && first.existingSessionId) {
    if (!(await confirmReplace(first.existingSessionId))) {
      return { kind: "cancelled" };
    }
    try {
      const result = await importBundle(bundle, { replace: true });
      void pollSessions();
      return { kind: "imported", sessionId: result.sessionId, replaced: true };
    } catch (err) {
      return { kind: "failed", message: (err as Error).message };
    }
  }
  return { kind: "failed", message: first.message };
}
