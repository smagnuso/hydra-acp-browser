import { test } from "node:test";
import assert from "node:assert/strict";

const listeners = new Map<string, () => void>();
const doc = {
  visibilityState: "visible",
  focused: true,
  hasFocus() {
    return doc.focused;
  },
  addEventListener(type: string, fn: () => void) {
    listeners.set(type, fn);
  },
  removeEventListener() {},
};
(globalThis as { document?: unknown }).document = doc;
(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= () => 0;

const calls: { url: string; method?: string; body?: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input) === "/api/client-log") {
    return new Response(null, { status: 204 });
  }
  calls.push({ url: String(input), method: init?.method, body: init?.body as string });
  return new Response(null, { status: 204 });
}) as typeof fetch;

const { state } = await import("../src/ui/state.js");
const { markOpenChatRead, initReadTracking } = await import("../src/ui/read-state.js");
initReadTracking();
import type { ChatState, SessionInfo } from "../src/ui/types.js";

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

function openChat(sessionId: string, unread: boolean): void {
  state.view = "chat";
  state.current = { sessionId } as ChatState;
  state.sessions = [{ sessionId, cwd: "/w", unread } as SessionInfo];
}

test("marks the open chat read once for a burst of calls, clearing its dot at once", async () => {
  calls.length = 0;
  openChat("s1", true);
  markOpenChatRead();
  markOpenChatRead();
  markOpenChatRead();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/sessions/s1/read");
  assert.equal(calls[0]?.method, "PATCH");
  assert.deepEqual(JSON.parse(calls[0]?.body ?? ""), { read: true });
  assert.equal(state.sessions[0]?.unread, false);
});

test("leaves a session alone while the tab is hidden or no chat is open", async () => {
  calls.length = 0;
  openChat("s2", true);
  doc.visibilityState = "hidden";
  markOpenChatRead();
  await settle();
  doc.visibilityState = "visible";
  state.view = "list";
  markOpenChatRead();
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(state.sessions[0]?.unread, true);
});

test("leaves a session alone while the window is unfocused", async () => {
  calls.length = 0;
  openChat("s3", true);
  doc.focused = false;
  markOpenChatRead();
  await settle();
  doc.focused = true;
  assert.equal(calls.length, 0);
});

test("leaves a session alone once idle, then marks it on the next input", async () => {
  calls.length = 0;
  openChat("s4", true);
  const realNow = Date.now;
  let offset = 10 * 60_000;
  Date.now = () => realNow() + offset;
  try {
    markOpenChatRead();
    await settle();
    assert.equal(calls.length, 0);
    listeners.get("keydown")?.();
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "/api/sessions/s4/read");
  } finally {
    Date.now = realNow;
    offset = 0;
  }
});

test("never idles when readIdleSeconds is 0", async () => {
  calls.length = 0;
  openChat("s5", true);
  state.readIdleSeconds = 0;
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000;
  try {
    markOpenChatRead();
    await settle();
    assert.equal(calls.length, 1);
  } finally {
    Date.now = realNow;
    state.readIdleSeconds = 180;
  }
});

test("still marks the session read when the chat is left within the debounce", async () => {
  calls.length = 0;
  openChat("s6", true);
  markOpenChatRead();
  state.view = "list";
  state.current = null;
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "/api/sessions/s6/read");
});
