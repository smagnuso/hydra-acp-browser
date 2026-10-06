import { test } from "node:test";
import assert from "node:assert/strict";

const doc = {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
};
(globalThis as { document?: unknown }).document = doc;
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= () => 0;

const calls: { url: string; method?: string; body?: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(input), method: init?.method, body: init?.body as string });
  return new Response(null, { status: 204 });
}) as typeof fetch;

const { state } = await import("../src/ui/state.js");
const { markOpenChatRead } = await import("../src/ui/read-state.js");
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
