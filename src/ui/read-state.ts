import { api } from "./api.js";
import { setState, state } from "./state.js";

// Marks the open chat's session read on the daemon when a person is looking:
// on open, after a turn ends in it, and when the window comes back into
// focus. The tab must be visible, the window focused, and input seen within
// readIdleSeconds (0 disables the check); an abandoned window leaves the
// session unread for an active client to mark. Debounced so a replay's run
// of turn_completes sends one request. Whether the person is looking is
// decided when the mark is requested, not when the debounce fires, so
// swiping out of the chat right after a turn ends still marks it.
const DEBOUNCE_MS = 300;
const INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"];
let lastInputAt = Date.now();
let timer: ReturnType<typeof setTimeout> | undefined;
let pendingId: string | undefined;

export function markOpenChatRead(): void {
  const sessionId = seenSessionId();
  if (sessionId === undefined) {
    return;
  }
  if (timer !== undefined) {
    clearTimeout(timer);
    if (pendingId !== undefined && pendingId !== sessionId) {
      sendRead(pendingId);
    }
  }
  pendingId = sessionId;
  timer = setTimeout(() => {
    timer = undefined;
    pendingId = undefined;
    sendRead(sessionId);
  }, DEBOUNCE_MS);
}

function isIdle(now = Date.now()): boolean {
  const idleMs = state.readIdleSeconds * 1000;
  return idleMs > 0 && now - lastInputAt > idleMs;
}

// Input after an idle stretch marks the open chat read; the first sight of
// a session that finished while nobody was looking.
function noteInput(): void {
  const now = Date.now();
  const wasIdle = isIdle(now);
  if (!wasIdle && now - lastInputAt < 1000) {
    return;
  }
  lastInputAt = now;
  if (wasIdle) {
    markOpenChatRead();
  }
}

export function initReadTracking(): void {
  for (const type of INPUT_EVENTS) {
    document.addEventListener(type, noteInput, { capture: true, passive: true });
  }
  window.addEventListener("focus", () => {
    lastInputAt = Date.now();
    markOpenChatRead();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && document.hasFocus()) {
      lastInputAt = Date.now();
    }
  });
}

// Mobile read-marking failures only reproduce on a real phone, so each
// decision is recorded in the extension log via /api/client-log.
function logRead(line: string): void {
  void fetch("/api/client-log", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ line: `read: ${line}` }),
    keepalive: true,
  }).catch(() => undefined);
}

function seenSessionId(): string | undefined {
  const sessionId = state.current?.sessionId;
  if (state.view !== "chat") {
    return undefined;
  }
  const why: string[] = [];
  if (document.visibilityState !== "visible") {
    why.push(`vis=${document.visibilityState}`);
  }
  if (!document.hasFocus()) {
    why.push("nofocus");
  }
  if (isIdle()) {
    why.push(`idle=${Math.round((Date.now() - lastInputAt) / 1000)}s`);
  }
  if (why.length > 0) {
    logRead(`skip ${sessionId ?? "-"} ${why.join(" ")}`);
    return undefined;
  }
  return sessionId;
}

function sendRead(sessionId: string): void {
  const row = state.sessions.find((s) => s.sessionId === sessionId);
  if (row?.unread) {
    setState({ sessions: state.sessions.map((s) => (s === row ? { ...s, unread: false } : s)) });
  }
  void api(`/api/sessions/${encodeURIComponent(sessionId)}/read`, {
    method: "PATCH",
    body: JSON.stringify({ read: true }),
  })
    .then(() => logRead(`sent ${sessionId}`))
    .catch((err: unknown) => logRead(`failed ${sessionId} ${String(err)}`));
}
