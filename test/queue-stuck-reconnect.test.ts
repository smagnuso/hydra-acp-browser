import { test } from "node:test";
import assert from "node:assert/strict";

// See acp-edit-diff.test.ts for why this stub is needed before the static
// imports below run.
(globalThis as { document?: unknown }).document ??= {
  addEventListener() {},
  removeEventListener() {},
};

const { state } = await import("../src/ui/state.js");
const { handleNotification, hydrateQueueFromSnapshot } = await import(
  "../src/ui/acp.js"
);
import type { ChatState, QueueEntry } from "../src/ui/types.js";

function makeChatState(): ChatState {
  return {
    sessionId: "s1",
    title: "",
    cwd: "",
    agentId: "",
    ws: null,
    ready: false,
    log: [],
    toolCalls: new Map(),
    pendingPermissions: new Map(),
    pendingRequestById: new Map(),
    responseHandlers: new Map(),
    spinner: null,
    plan: null,
    mode: null,
    model: null,
    modes: [],
    models: [],
    contextUsed: null,
    contextSize: null,
    cost: null,
    fileOverlay: null,
    savedFileView: null,
    composerValue: "",
    busy: false,
    recentOwnPrompts: [],
    history: [],
    historyIndex: null,
    historyDraft: null,
    _lastMetaFp: "",
    promptQueue: [],
    queueByMessageId: new Map(),
    ownPromptIds: new Map(),
    inTurn: false,
    idleListeners: [],
    readyListeners: [],
    currentPlanEntry: null,
    daemonSupportsAmend: false,
    headerExpanded: false,
    unsolicitedTurnOpen: new Set(),
    ownClientId: "me",
  } as unknown as ChatState;
}

function frame(update: Record<string, unknown>) {
  return {
    method: "session/update",
    params: { sessionId: "s1", update },
  };
}

function promptReceived(messageId: string, text: string) {
  return frame({
    sessionUpdate: "prompt_received",
    messageId,
    prompt: [{ type: "text", text }],
  });
}

function agentChunk(text: string, messageId: string) {
  return frame({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    messageId,
  });
}

function turnComplete() {
  return frame({ sessionUpdate: "turn_complete", messageId: "tc_" + Math.random() });
}

// What queue.ts's dispatchPrompt leaves behind for a send that lands
// while another turn is running: an unbound "queued" entry plus its
// bubble at the tail of the log.
function enqueueOwn(text: string): QueueEntry {
  const c = state.current!;
  const entry: QueueEntry = {
    id: "p_" + text,
    text,
    status: "queued",
    aheadAtEnqueue: 1,
  };
  c.promptQueue.push(entry);
  c.log.push({ kind: "stream", role: "user", text, closed: true, queueEntry: entry });
  return entry;
}

function bindOwn(messageId: string, text: string, position: number): void {
  handleNotification({
    method: "hydra-acp/prompt_queue/added",
    params: {
      sessionId: "s1",
      messageId,
      originator: { clientId: "me" },
      prompt: [{ type: "text", text }],
      position,
    },
  });
}

function shape(): string[] {
  return state.current!.log.map((e) => {
    if (e.kind === "stream") {
      return `${e.role}:${e.text}`;
    }
    return e.kind;
  });
}

// The reported bug. A prompt queued behind a running turn is bound by
// prompt_queue/added, then the socket drops before the daemon's
// prompt_queue/removed{started} for it arrives. Queue notifications are
// never recorded, so the reconnect delta replays the prompt's
// prompt_received and its reply but can never replay "started". The
// entry stayed "queued", the chip stayed on, and because a queued
// bubble is the splice point for all later turn content, every reply
// from then on landed above it.
test("a replayed prompt_received starts a bound entry's turn", () => {
  state.current = makeChatState();
  handleNotification(promptReceived("m_a", "first"));
  handleNotification(agentChunk("reply a", "r_a"));
  const b = enqueueOwn("second");
  bindOwn("m_b", "second", 1);
  handleNotification(turnComplete());
  assert.equal(b.status, "queued");

  // The reconnect delta: no removed{started}, just the recorded frames.
  handleNotification(promptReceived("m_b", "second"));
  assert.equal(b.status, "processing");
  handleNotification(agentChunk("reply b", "r_b"));
  handleNotification(turnComplete());

  assert.equal(b.status, "done");
  assert.deepEqual(shape(), [
    "user:first",
    "turn-stamp",
    "agent:reply a",
    "user:second",
    "turn-stamp",
    "agent:reply b",
  ]);
});

// The same drop, but the delta's cursor skipped the prompt frame too.
// The attach response's queue snapshot no longer lists the entry, and
// that absence is the only signal left that it ran.
test("a bound entry missing from the reattach snapshot is settled", () => {
  state.current = makeChatState();
  const stuck = enqueueOwn("gone");
  bindOwn("m_gone", "gone", 1);
  const waiting = enqueueOwn("still there");
  bindOwn("m_wait", "still there", 2);

  hydrateQueueFromSnapshot([
    { messageId: "m_wait", position: 1, prompt: [{ type: "text", text: "still there" }] },
  ]);

  assert.equal(stuck.status, "done");
  assert.equal(waiting.status, "queued");
});

test("an empty snapshot settles every bound waiting entry", () => {
  state.current = makeChatState();
  const a = enqueueOwn("a");
  bindOwn("m_a", "a", 1);
  const unbound = enqueueOwn("never acked");

  hydrateQueueFromSnapshot([]);

  assert.equal(a.status, "done");
  // Unbound entries are cancelUnboundQueued's business, not this pass's.
  assert.equal(unbound.status, "queued");
});
