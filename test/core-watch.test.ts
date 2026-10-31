import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {}, location: { href: "https://h/", protocol: "https:" } };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};

class FakeWs {
  static OPEN = 1;
  static instances: FakeWs[] = [];
  readyState = 1;
  sent: string[] = [];
  closed = false;
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  constructor(public url: string) {
    FakeWs.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, ev: unknown = {}): void {
    for (const fn of this.listeners.get(type) ?? []) {
      fn(ev);
    }
  }
  receive(frame: unknown): void {
    this.emit("message", { data: JSON.stringify(frame) });
  }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeWs;

const w = await import("../src/core/watch.js");
const { state } = await import("../src/core/state.js");
import type { SessionInfo } from "../src/core/types.js";

const sess = (id: string, o: Partial<SessionInfo> = {}): SessionInfo =>
  ({ sessionId: id, cwd: "/w", awaitingInput: true, status: "warm", ...o }) as SessionInfo;

const permission = (id: number, toolCallId: string) => ({
  jsonrpc: "2.0",
  id,
  method: "session/request_permission",
  params: {
    toolCall: { toolCallId, title: "Run npm test" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  },
});

function reset(): void {
  w.stopPermissionWatching();
  FakeWs.instances.length = 0;
  state.current = null;
  state.view = "list";
}

test("watches only warm awaiting sessions, and not the open chat", () => {
  reset();
  state.sessions = [
    sess("a"),
    sess("b", { awaitingInput: false }),
    sess("c", { status: "cold" }),
    sess("open"),
  ];
  state.view = "chat";
  state.current = { sessionId: "open" } as never;
  w.syncPermissionWatchers();
  assert.equal(FakeWs.instances.length, 1);
  assert.match(FakeWs.instances[0]!.url, /^wss:\/\/h\/ws\?session=a&passive=true$/);
});

test("a permission request is recorded and answered on the same socket", () => {
  reset();
  state.sessions = [sess("a")];
  w.syncPermissionWatchers();
  const ws = FakeWs.instances[0]!;
  ws.receive({ jsonrpc: "2.0", method: "bridge/ready", params: {} });
  ws.receive(permission(7, "tc1"));
  const pending = w.watchedPermissionsFor("a");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.toolCall.title, "Run npm test");
  w.answerWatchedPermission("a", "tc1", "allow");
  assert.deepEqual(JSON.parse(ws.sent[0]!), {
    jsonrpc: "2.0",
    id: 7,
    result: { outcome: { outcome: "selected", optionId: "allow" } },
  });
  assert.equal(w.watchedPermissions().length, 0);
});

test("cancelling replies with the cancelled outcome", () => {
  reset();
  state.sessions = [sess("a")];
  w.syncPermissionWatchers();
  const ws = FakeWs.instances[0]!;
  ws.receive(permission(9, "tc2"));
  w.answerWatchedPermission("a", "tc2", "__cancel__");
  assert.deepEqual(JSON.parse(ws.sent[0]!).result, { outcome: { outcome: "cancelled" } });
});

test("a request answered elsewhere is dropped on permission_resolved", () => {
  reset();
  state.sessions = [sess("a")];
  w.syncPermissionWatchers();
  const ws = FakeWs.instances[0]!;
  ws.receive(permission(1, "tc3"));
  ws.receive({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "permission_resolved", toolCallId: "tc3" } },
  });
  assert.equal(w.watchedPermissions().length, 0);
});

test("a tool that moved past pending also clears the request", () => {
  reset();
  state.sessions = [sess("a")];
  w.syncPermissionWatchers();
  const ws = FakeWs.instances[0]!;
  ws.receive(permission(1, "tc4"));
  ws.receive({
    jsonrpc: "2.0",
    method: "session/update",
    params: { update: { sessionUpdate: "tool_call_update", toolCallId: "tc4", status: "completed" } },
  });
  assert.equal(w.watchedPermissions().length, 0);
});

test("a request without a toolCallId is ignored", () => {
  reset();
  state.sessions = [sess("a")];
  w.syncPermissionWatchers();
  FakeWs.instances[0]!.receive({ jsonrpc: "2.0", id: 1, method: "session/request_permission", params: {} });
  assert.equal(w.watchedPermissions().length, 0);
});

test("watchers close when a session stops awaiting, and when its chat opens", () => {
  reset();
  state.sessions = [sess("a"), sess("b")];
  w.syncPermissionWatchers();
  assert.equal(FakeWs.instances.length, 2);
  state.sessions = [sess("a"), sess("b", { awaitingInput: false })];
  w.syncPermissionWatchers();
  assert.equal(FakeWs.instances[1]!.closed, true);
  assert.equal(FakeWs.instances[0]!.closed, false);
  state.view = "chat";
  state.current = { sessionId: "a" } as never;
  w.syncPermissionWatchers();
  assert.equal(FakeWs.instances[0]!.closed, true);
});

test("the watcher count is capped", () => {
  reset();
  state.sessions = Array.from({ length: w.MAX_PERMISSION_WATCHERS + 5 }, (_, i) => sess(`s${i}`));
  w.syncPermissionWatchers();
  assert.equal(FakeWs.instances.length, w.MAX_PERMISSION_WATCHERS);
});

test("a dropped socket clears its requests, then reconnects", async () => {
  reset();
  state.sessions = [sess("a")];
  w.syncPermissionWatchers();
  const ws = FakeWs.instances[0]!;
  ws.receive(permission(1, "tc5"));
  ws.emit("close");
  assert.equal(w.watchedPermissions().length, 0);
  assert.equal(FakeWs.instances.length, 1);
  w.stopPermissionWatching();
});

test("answering a request that is not pending does nothing", () => {
  reset();
  state.sessions = [sess("a")];
  w.syncPermissionWatchers();
  w.answerWatchedPermission("a", "nope", "allow");
  assert.equal(FakeWs.instances[0]!.sent.length, 0);
});
