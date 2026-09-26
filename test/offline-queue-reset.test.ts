import { test } from "node:test";
import assert from "node:assert/strict";

// See acp-edit-diff.test.ts for why this stub is needed before the static
// imports below run.
(globalThis as { document?: unknown }).document ??= {
  addEventListener() {},
  removeEventListener() {},
};

const { resetChatHistoryState } = await import("../src/ui/acp.js");
import type { ChatState, LogItem, QueueEntry } from "../src/ui/types.js";

function entry(status: QueueEntry["status"], id: string): QueueEntry {
  return { id, text: id, status, aheadAtEnqueue: 0 };
}

function bubble(queueEntry: QueueEntry): LogItem {
  return {
    kind: "stream",
    role: "user",
    text: queueEntry.text,
    closed: true,
    queueEntry,
  } as LogItem;
}

function chatWith(log: LogItem[], promptQueue: QueueEntry[]): ChatState {
  return {
    log,
    promptQueue,
    toolCalls: new Map(),
    pendingPermissions: new Map(),
    queueByMessageId: new Map(),
    ownPromptIds: new Map(),
    unsolicitedTurnOpen: new Set(),
    recentOwnPrompts: [],
    modes: [],
    models: [],
  } as unknown as ChatState;
}

// A prompt held from a previous run was never sent, so a full replay
// cannot bring it back. Wiping it here left flushOfflineQueue nothing to
// dispatch on bridge/ready: the prompt never sent, was never removed from
// IndexedDB, and repainted as a ghost bubble on every cold open.
test("a full replay reset keeps held offline prompts and their bubbles", () => {
  const offline = entry("offline", "e_offline");
  const replayed = { kind: "stream", role: "assistant", text: "old" } as LogItem;
  const c = chatWith([replayed, bubble(offline)], [offline]);

  resetChatHistoryState(c);

  assert.deepEqual(c.promptQueue, [offline]);
  assert.equal(c.log.length, 1);
  assert.equal(c.log[0]?.kind === "stream" && c.log[0].queueEntry, offline);
});

test("a full replay reset still drops everything the replay will restore", () => {
  const offline = entry("offline", "e_offline");
  const queued = entry("queued", "e_queued");
  const c = chatWith([bubble(queued), bubble(offline)], [queued, offline]);

  resetChatHistoryState(c);

  assert.deepEqual(c.promptQueue, [offline]);
  assert.equal(c.log.length, 1);
  assert.equal(c.log[0]?.kind === "stream" && c.log[0].queueEntry, offline);
});
