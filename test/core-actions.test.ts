import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= () => 0;

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}
const calls: Call[] = [];
let failNext: { status: number; error: string } | null = null;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (url.startsWith("/api/sessions") && method === "GET") {
    return Response.json({
      sessions: [{ sessionId: "s1", cwd: "/w", status: "cold" }],
      cursor: 1,
    });
  }
  calls.push({
    url,
    method,
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
  });
  if (failNext) {
    const f = failNext;
    failNext = null;
    return Response.json({ error: f.error }, { status: f.status });
  }
  if (url === "/api/sessions") {
    return Response.json({ sessionId: "new1" }, { status: 201 });
  }
  return new Response(null, { status: 204 });
}) as typeof fetch;

const { createSession, killSession } = await import("../src/core/actions.js");
const { state } = await import("../src/core/state.js");
import type { SessionInfo } from "../src/core/types.js";

test("createSession requires a cwd for a local create", async () => {
  await assert.rejects(createSession({}), /cwd is required/);
  assert.equal(calls.length, 0);
});

test("createSession posts only the fields it was given", async () => {
  calls.length = 0;
  const made = await createSession({ cwd: "/w", agentId: "claude", name: "n" });
  assert.equal(made.sessionId, "new1");
  assert.deepEqual(calls[0], {
    url: "/api/sessions",
    method: "POST",
    body: { cwd: "/w", agentId: "claude", name: "n" },
  });
});

test("a remote create drops agentId and needs no cwd", async () => {
  calls.length = 0;
  await createSession({ remote: "peer", agentId: "claude", prompt: "hi" });
  assert.deepEqual(calls[0]!.body, { remote: "peer", prompt: "hi" });
});

test("createSession surfaces the server's error message", async () => {
  failNext = { status: 502, error: "daemon down" };
  await assert.rejects(createSession({ cwd: "/w" }), /daemon down/);
});

test("killSession posts the id and flips the card cold at once", async () => {
  calls.length = 0;
  state.sessions = [
    { sessionId: "s1", cwd: "/w", status: "warm", busy: true, awaitingInput: true } as SessionInfo,
    { sessionId: "s2", cwd: "/w", status: "warm" } as SessionInfo,
  ];
  await killSession("s1");
  assert.deepEqual(calls[0], { url: "/api/kill", method: "POST", body: { sessionId: "s1" } });
  const s1 = state.sessions.find((s) => s.sessionId === "s1")!;
  assert.equal(s1.status, "cold");
  assert.equal(s1.busy, false);
  assert.equal(s1.awaitingInput, false);
  assert.equal(state.sessions.find((s) => s.sessionId === "s2")!.status, "warm");
});

test("a failed kill leaves the session untouched and rejects", async () => {
  state.sessions = [{ sessionId: "s1", cwd: "/w", status: "warm" } as SessionInfo];
  failNext = { status: 404, error: "no such session" };
  await assert.rejects(killSession("s1"), /no such session/);
  assert.equal(state.sessions[0]!.status, "warm");
});
