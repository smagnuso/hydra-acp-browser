// Permission watching for sessions that are not open. A board-style UI
// wants to show and answer permission requests for every session that is
// waiting on you, without attaching a full chat to each. This opens one
// light socket per awaiting session (the open chat is excluded, it already
// owns its own) and keeps only pending permission requests from it.

import { state, subscribe, notifyChange } from "./state.js";
import { platform } from "./platform.js";
import { getPushEndpoint, tabIsHidden } from "./notifications.js";
import type { PermissionEntry } from "./types.js";

export interface WatchedPermission extends PermissionEntry {
  sessionId: string;
}

interface Watcher {
  sessionId: string;
  ws: WebSocket | null;
  pending: Map<string, WatchedPermission>;
  attempt: number;
  retry: ReturnType<typeof setTimeout> | undefined;
  stopped: boolean;
}

export const MAX_PERMISSION_WATCHERS = 12;
const RETRY_MS = [3_000, 6_000, 12_000, 30_000];

const watchers = new Map<string, Watcher>();
let lastSessions: unknown;
let lastCurrentId: string | undefined;
let unsubscribe: (() => void) | undefined;
let presenceHooked = false;

export function watchedPermissions(): WatchedPermission[] {
  const out: WatchedPermission[] = [];
  for (const w of watchers.values()) {
    out.push(...w.pending.values());
  }
  return out;
}

export function watchedPermissionsFor(sessionId: string): WatchedPermission[] {
  return [...(watchers.get(sessionId)?.pending.values() ?? [])];
}

function wantedSessionIds(): string[] {
  const openId = state.view === "chat" ? state.current?.sessionId : undefined;
  return state.sessions
    .filter((s) => s.awaitingInput && s.status !== "cold" && s.sessionId !== openId)
    .slice(0, MAX_PERMISSION_WATCHERS)
    .map((s) => s.sessionId);
}

export function syncPermissionWatchers(): void {
  const currentId = state.view === "chat" ? state.current?.sessionId : undefined;
  if (state.sessions === lastSessions && currentId === lastCurrentId) {
    return;
  }
  lastSessions = state.sessions;
  lastCurrentId = currentId;
  const wanted = new Set(wantedSessionIds());
  let changed = false;
  for (const [id, w] of watchers) {
    if (!wanted.has(id)) {
      stopWatcher(w);
      watchers.delete(id);
      changed = true;
    }
  }
  for (const id of wanted) {
    if (!watchers.has(id)) {
      const w: Watcher = {
        sessionId: id,
        ws: null,
        pending: new Map(),
        attempt: 0,
        retry: undefined,
        stopped: false,
      };
      watchers.set(id, w);
      connect(w);
    }
  }
  if (changed) {
    notifyChange();
  }
}

// Call once at startup; keeps the watchers in step with the session list.
export function startPermissionWatching(): () => void {
  if (!presenceHooked) {
    presenceHooked = true;
    platform.onVisibilityChange(refreshWatcherPresence);
    platform.onWindowFocus(refreshWatcherPresence);
  }
  unsubscribe?.();
  unsubscribe = subscribe(syncPermissionWatchers);
  syncPermissionWatchers();
  return stopPermissionWatching;
}

export function stopPermissionWatching(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  for (const w of watchers.values()) {
    stopWatcher(w);
  }
  watchers.clear();
  lastSessions = undefined;
  lastCurrentId = undefined;
}

function stopWatcher(w: Watcher): void {
  w.stopped = true;
  if (w.retry !== undefined) {
    clearTimeout(w.retry);
  }
  w.ws?.close();
  w.ws = null;
}

function connect(w: Watcher): void {
  const page = platform.pageLocation();
  const url = new URL("/ws", page.href);
  url.protocol = page.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session", w.sessionId);
  url.searchParams.set("passive", "true");
  const ws = new WebSocket(url.toString());
  w.ws = ws;
  ws.addEventListener("message", (ev) => {
    if (w.ws !== ws) {
      return;
    }
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    handleFrame(w, frame);
  });
  ws.addEventListener("close", () => {
    if (w.stopped || w.ws !== ws) {
      return;
    }
    w.ws = null;
    if (w.pending.size > 0) {
      w.pending.clear();
      notifyChange();
    }
    const delay = RETRY_MS[Math.min(w.attempt, RETRY_MS.length - 1)]!;
    w.attempt += 1;
    w.retry = setTimeout(() => {
      if (!w.stopped) {
        connect(w);
      }
    }, delay);
  });
  ws.addEventListener("error", () => {
    // close follows and drives the retry
  });
}

function handleFrame(w: Watcher, frame: Record<string, unknown>): void {
  const method = frame.method;
  if (method === "bridge/ready") {
    w.attempt = 0;
    void announcePresence(w);
    return;
  }
  if (method === "session/request_permission" && frame.id !== undefined) {
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
    const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : "";
    if (!toolCallId) {
      return;
    }
    w.pending.set(toolCallId, {
      sessionId: w.sessionId,
      requestId: frame.id as string | number,
      toolCallId,
      toolCall: toolCall as PermissionEntry["toolCall"],
      options: (params.options as PermissionEntry["options"]) ?? [],
    });
    notifyChange();
    return;
  }
  if (method === "session/update") {
    const update = ((frame.params ?? {}) as Record<string, unknown>).update as
      | Record<string, unknown>
      | undefined;
    const toolCallId = typeof update?.toolCallId === "string" ? update.toolCallId : undefined;
    if (!toolCallId || !w.pending.has(toolCallId)) {
      return;
    }
    const kind = update?.sessionUpdate;
    const status = typeof update?.status === "string" ? update.status : undefined;
    // Resolved elsewhere (RFD #533), or the tool moved past pending.
    if (kind === "permission_resolved" || (kind === "tool_call_update" && status && status !== "pending")) {
      w.pending.delete(toolCallId);
      notifyChange();
    }
  }
}

// optionId "__cancel__" cancels, same as the open chat's respondPermission.
export function answerWatchedPermission(
  sessionId: string,
  toolCallId: string,
  optionId: string,
): void {
  const w = watchers.get(sessionId);
  const entry = w?.pending.get(toolCallId);
  if (!w || !entry || !w.ws || w.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  w.ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: entry.requestId,
      result: {
        outcome:
          optionId === "__cancel__"
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId },
      },
    }),
  );
  w.pending.delete(toolCallId);
  notifyChange();
}

// Tells the server which device this socket belongs to and whether it is
// being looked at, the same two signals a chat socket reports, so a
// "waiting on you" push goes to this device and is skipped when the board
// is on screen.
async function announcePresence(w: Watcher): Promise<void> {
  const endpoint = await getPushEndpoint();
  const ws = w.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN || w.stopped) {
    return;
  }
  ws.send(
    JSON.stringify({ jsonrpc: "2.0", method: "bridge/push-endpoint", params: { endpoint: endpoint ?? null } }),
  );
  ws.send(
    JSON.stringify({ jsonrpc: "2.0", method: "bridge/visibility", params: { visible: !tabIsHidden() } }),
  );
}

// Call after the push subscription changes or the page's visibility does.
export function refreshWatcherPresence(): void {
  for (const w of watchers.values()) {
    if (w.ws?.readyState === WebSocket.OPEN) {
      void announcePresence(w);
    }
  }
}
