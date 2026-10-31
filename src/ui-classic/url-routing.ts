// Hash-based routing: the URL fragment that survives reloads and
// back/forward navigation. Browser-UI specific; routing.ts reaches it
// only through uiHooks.

import { state } from "../core/state.js";
import { openChat, closeChat } from "../core/routing.js";

// Reflect the current session in the URL fragment so a reload (or
// copy-pasted link) drops the user back into the same chat.
export function buildSessionHash(sessionId: string): string {
  return `#/session/${encodeURIComponent(sessionId)}`;
}

// The installed PWA registers as the OS handler for web+hydra:// links
// (manifest protocol_handlers). Per the Web App Manifest spec, clicking
// one launches us at /?protocol_launch=<encoded original URL> rather
// than navigating the browser to the custom scheme directly. Rewrite
// that into our own hash route before applyHashRoute runs, matching the
// web+hydra://sessions/<id> shape hydra-acp-reviewer/planner already
// emit as hydra://sessions/<id> links elsewhere in the ecosystem.
export function applyProtocolLaunch(): void {
  const params = new URLSearchParams(window.location.search);
  const launch = params.get("protocol_launch");
  if (!launch) {
    return;
  }
  // Scrub the query string immediately so a reload or copy-pasted URL
  // doesn't replay the same redirect.
  history.replaceState(null, "", window.location.pathname + window.location.hash);
  let parsed: URL;
  try {
    parsed = new URL(launch);
  } catch {
    return;
  }
  if (parsed.protocol !== "web+hydra:" || parsed.hostname !== "sessions") {
    return;
  }
  const sessionId = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!sessionId) {
    return;
  }
  window.location.hash = buildSessionHash(sessionId);
}

// pushState (not replaceState) so the browser's back/forward buttons
// step through chat ↔ list transitions. The "already matches" guard
// makes the case where applyHashRoute is the caller (hashchange after
// a user-initiated back/forward) a no-op — the URL is already where
// it needs to be, so we skip the push and don't double up history.
// hashWriting still defends against a re-entrant applyHashRoute if a
// future browser variant queues hashchange synchronously off pushState.
let hashWriting = false;
// Set for a navigation that restores state rather than expressing an
// intent to navigate — currently just the boot-time last-session
// restore. Such a navigation must REPLACE the current history entry:
// pushing one means the restored session becomes a phantom step that
// Back walks into on the way out of the app, which made Back behave
// differently depending on how the page was reached.
let replaceNextHash = false;

// Installed PWA (no browser chrome, so no Back button — Back is the edge
// swipe). iOS does not reliably keep a standalone app alive across a
// history back: the gesture unwinds past our entry and the whole app cold
// boots, which is a multi-second freeze while the bundle parses, the
// cache hydrates, frames replay and the socket reconnects.
//
// Measured, not inferred: the diagnostics counters only reset on a fresh
// page load, and a back that had been sitting at node-hit:19217 came back
// reading 178.
//
// So in standalone we keep exactly one history entry. Back then does what
// the platform intends — leaves the app — instead of restarting it, and
// chat <-> list stays with the in-app control, which never touched
// history anyway. Browsers are unaffected: both Safari and Chrome paint
// this transition instantly, because there the entry is browser history,
// not the app's whole lifetime.
function isStandalonePwa(): boolean {
  try {
    return (
      window.matchMedia?.("(display-mode: standalone)").matches === true ||
      (navigator as unknown as { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

function setLocationHash(hash: string): void {
  if (window.location.hash === hash) return;
  hashWriting = true;
  const write =
    replaceNextHash || isStandalonePwa() ? history.replaceState : history.pushState;
  replaceNextHash = false;
  try {
    write.call(
      history,
      null,
      "",
      hash || window.location.pathname + window.location.search,
    );
  } finally {
    queueMicrotask(() => {
      hashWriting = false;
    });
  }
}

export function applyHashRoute(opts: { initialLoad?: boolean } = {}): void {
  if (hashWriting) return;
  const hash = window.location.hash;
  // The `(?:\?...)?` tail is tolerated but ignored — old bookmarks and
  // protocol-launch links from before session/attach could resurrect a
  // cold session on its own may still carry a `?load=true` suffix.
  const m = hash.match(/^#\/session\/([^?]+)(?:\?(.*))?$/);
  if (m) {
    const sessionId = decodeURIComponent(m[1]!);
    if (state.view === "chat" && state.current?.sessionId === sessionId) {
      return;
    }
    openChat(sessionId, { passive: opts.initialLoad === true });
    return;
  }
  if (state.view !== "list") {
    closeChat();
  }
}

export function navigateToSession(sessionId: string): void {
  setLocationHash(buildSessionHash(sessionId));
}

export function navigateToList(): void {
  setLocationHash("");
}

export function replaceNextNavigation(): void {
  replaceNextHash = true;
}
