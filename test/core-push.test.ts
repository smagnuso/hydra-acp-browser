import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};

const posts: Array<{ url: string; body: unknown }> = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url === "/api/push/vapid-public-key") {
    return Response.json({ publicKey: "AAAA" });
  }
  posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  return new Response(null, { status: 204 });
}) as typeof fetch;

let subscribed = false;
const registration = {
  pushManager: {
    getSubscription: async () =>
      subscribed
        ? { endpoint: "https://push/x", unsubscribe: async () => void (subscribed = false), toJSON: () => ({ endpoint: "https://push/x" }) }
        : null,
    subscribe: async () => {
      subscribed = true;
      return { endpoint: "https://push/x", toJSON: () => ({ endpoint: "https://push/x" }) };
    },
  },
};
Object.defineProperty(globalThis, "navigator", {
  value: { serviceWorker: { register: async () => registration } },
  configurable: true,
});
const notification = { permission: "default", requestPermission: async () => "granted" };
(globalThis as { Notification?: unknown }).Notification = notification;

const push = await import("../src/core/push.js");
const { state } = await import("../src/core/state.js");

test("turning notifications on subscribes and records the preference", async () => {
  state.notifyOnTurnEnd = false;
  posts.length = 0;
  assert.equal(await push.setNotifications(true), "enabled");
  assert.equal(state.notifyOnTurnEnd, true);
  assert.ok(posts.some((p) => p.url === "/api/push/subscribe"));
});

test("turning them off unsubscribes and clears the preference", async () => {
  posts.length = 0;
  assert.equal(await push.setNotifications(false), "disabled");
  assert.equal(state.notifyOnTurnEnd, false);
  assert.deepEqual(
    posts.filter((p) => p.url === "/api/push/unsubscribe").map((p) => p.body),
    [{ endpoint: "https://push/x" }],
  );
});

test("a denied permission blocks without changing anything", async () => {
  notification.permission = "denied";
  state.notifyOnTurnEnd = false;
  posts.length = 0;
  assert.equal(await push.setNotifications(true), "blocked");
  assert.equal(state.notifyOnTurnEnd, false);
  assert.equal(posts.length, 0);
});

test("resume re-subscribes only when the preference is on and permission granted", async () => {
  notification.permission = "granted";
  state.notifyOnTurnEnd = false;
  subscribed = false;
  posts.length = 0;
  await push.resumeNotifications();
  assert.equal(posts.length, 0);
  state.notifyOnTurnEnd = true;
  await push.resumeNotifications();
  assert.ok(posts.some((p) => p.url === "/api/push/subscribe"));
  notification.permission = "denied";
  posts.length = 0;
  await push.resumeNotifications();
  assert.equal(posts.length, 0);
});

test("trackPresence is safe to call twice", () => {
  push.trackPresence();
  push.trackPresence();
});
