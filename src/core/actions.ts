// Session-level actions that need no view state, so any UI can call them.
// Failures throw; the caller decides how to surface them.

import { api, markSessionKillRequested, pollSessions } from "./api.js";
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
