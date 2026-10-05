import { test } from "node:test";
import assert from "node:assert/strict";

// See acp-edit-diff.test.ts for why this stub is needed before the static
// imports below run.
(globalThis as { document?: unknown }).document ??= {
  addEventListener() {},
  removeEventListener() {},
};

const { state } = await import("../src/ui/state.js");
const { handleNotification } = await import("../src/ui/acp.js");
import type { ChatState } from "../src/ui/types.js";

// Minimal valid ChatState, matching the shape routing.ts's openChat builds.
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
    ownPromptIds: new Set(),
    inTurn: false,
    idleListeners: [],
    readyListeners: [],
    currentPlanEntry: null,
    daemonSupportsAmend: false,
    headerExpanded: false,
    unsolicitedTurnOpen: false,
  };
}

function frame(update: Record<string, unknown>) {
  return {
    method: "session/update",
    params: { sessionId: "s1", update },
  };
}

function sourcedChunk(text: string, sourceSessionId: string, taskId?: string) {
  return frame({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text },
    _meta: {
      "hydra-acp": {
        sourceSessionId,
        ...(taskId ? { planner: { taskId } } : {}),
      },
    },
  });
}

function streamBubbles() {
  return state.current!.log.filter((e) => e.kind === "stream");
}

test("forwarded worker chunks carry their source and merge per source", () => {
  state.current = makeChatState();
  handleNotification(sourcedChunk("a", "w1", "T5"));
  handleNotification(sourcedChunk("b", "w1", "T5"));
  handleNotification(sourcedChunk("c", "w2", "T6"));
  const bubbles = streamBubbles();
  assert.equal(bubbles.length, 2);
  assert.equal(bubbles[0]!.text, "ab");
  assert.deepEqual(bubbles[0]!.source, { sessionId: "w1", label: "T5" });
  assert.deepEqual(bubbles[1]!.source, { sessionId: "w2", label: "T6" });
});

test("a chunk sourced from the current session has no source", () => {
  state.current = makeChatState();
  handleNotification(sourcedChunk("own", "s1"));
  assert.equal(streamBubbles()[0]!.source, undefined);
});

test("a planner notice with only a task id gets a label-only source", () => {
  state.current = makeChatState();
  handleNotification(
    frame({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "done" },
      _meta: { "hydra-acp": { planner: { event: "task-completed", taskId: "T3" } } },
    }),
  );
  assert.deepEqual(streamBubbles()[0]!.source, { sessionId: undefined, label: "T3" });
});

test("a forwarded worker edit carries its source onto the edit block", () => {
  state.current = makeChatState();
  handleNotification(
    frame({
      sessionUpdate: "tool_call",
      toolCallId: "T2:abc",
      kind: "edit",
      title: "Edit",
      status: "pending",
      content: [{ type: "diff", path: "/a.ts", oldText: "x", newText: "y" }],
      _meta: {
        "hydra-acp": { sourceSessionId: "w1", planner: { taskId: "T2" } },
      },
    }),
  );
  const item = state.current!.log.find((e) => e.kind === "edit-diff");
  assert.ok(item && item.kind === "edit-diff");
  assert.deepEqual(item.source, { sessionId: "w1", label: "T2" });
});
