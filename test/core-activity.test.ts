import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};

const { chatActivity, PHASE_LABEL } = await import("../src/core/activity.js");
import type { ChatState } from "../src/core/types.js";

const tool = (id: string, title: string, status: string) =>
  [id, { toolCallId: id, title, kind: "execute", status, content: "" }] as const;

function chat(o: Partial<Record<string, unknown>> = {}): ChatState {
  return {
    inTurn: false,
    spinner: null,
    toolCalls: new Map(),
    pendingPermissions: new Map(),
    ...o,
  } as unknown as ChatState;
}

test("an idle chat is idle", () => {
  const a = chatActivity(chat());
  assert.equal(a.phase, "idle");
  assert.equal(a.toolCount, 0);
  assert.equal(a.currentTool, undefined);
});

test("a live turn is working, with its start time and tool count", () => {
  const a = chatActivity(
    chat({ inTurn: true, spinner: { toolCallIds: ["a", "b"], expanded: false, startedAt: 1234, sending: false } }),
  );
  assert.equal(a.phase, "working");
  assert.equal(a.startedAt, 1234);
  assert.equal(a.toolCount, 2);
});

test("a prompt the daemon has not confirmed is sending", () => {
  const a = chatActivity(chat({ inTurn: true, spinner: { toolCallIds: [], expanded: false, startedAt: 1, sending: true } }));
  assert.equal(a.phase, "sending");
});

test("a pending permission means waiting, even mid-turn", () => {
  const a = chatActivity(
    chat({ inTurn: true, pendingPermissions: new Map([["t", {}]]), spinner: { toolCallIds: [], expanded: false, startedAt: 1, sending: false } }),
  );
  assert.equal(a.phase, "waiting");
  assert.equal(PHASE_LABEL[a.phase], "Waiting for you");
});

test("the current tool is the latest unfinished one, else the last", () => {
  const toolCalls = new Map([
    tool("a", "Read file", "completed"),
    tool("b", "Run tests", "in_progress"),
    tool("c", "Edit file", "completed"),
  ]);
  const spinner = { toolCallIds: ["a", "b", "c"], expanded: false, startedAt: 1, sending: false };
  assert.equal(chatActivity(chat({ inTurn: true, spinner, toolCalls })).currentTool, "Run tests");
  const allDone = new Map([tool("a", "Read file", "completed"), tool("c", "Edit file", "failed")]);
  assert.equal(
    chatActivity(chat({ inTurn: true, spinner: { ...spinner, toolCallIds: ["a", "c"] }, toolCalls: allDone })).currentTool,
    "Edit file",
  );
});
