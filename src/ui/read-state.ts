import { api } from "./api.js";
import { setState, state } from "./state.js";

// Marks the open chat's session read on the daemon when it is on screen:
// on open, after a turn ends in it, and when the tab comes back into view.
// Debounced so a replay's run of turn_completes sends one request.
const DEBOUNCE_MS = 300;
let timer: ReturnType<typeof setTimeout> | undefined;

export function markOpenChatRead(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = undefined;
    sendRead();
  }, DEBOUNCE_MS);
}

function sendRead(): void {
  const sessionId = state.current?.sessionId;
  if (state.view !== "chat" || sessionId === undefined || document.visibilityState !== "visible") {
    return;
  }
  const row = state.sessions.find((s) => s.sessionId === sessionId);
  if (row?.unread) {
    setState({ sessions: state.sessions.map((s) => (s === row ? { ...s, unread: false } : s)) });
  }
  void api(`/api/sessions/${encodeURIComponent(sessionId)}/read`, {
    method: "PATCH",
    body: JSON.stringify({ read: true }),
  }).catch(() => undefined);
}
