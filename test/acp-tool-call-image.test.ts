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

// Minimal valid ChatState, matching the shape routing.ts's openChat builds
// (mirrors acp-replay-cursor.test.ts's makeChatState).
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
  } as unknown as ChatState;
}

function frame(update: Record<string, unknown>) {
  return {
    method: "session/update",
    params: { sessionId: "s1", update },
  };
}

function images() {
  return state.current!.log.filter((e) => e.kind === "image") as Array<
    Extract<ChatState["log"][number], { kind: "image" }>
  >;
}

// The real frame shape a "View Image" tool call sends (captured from a
// live session that hit this bug): the resource_link is wrapped in a
// {type: "content", content: ...} carrier, the way every tool-call content
// block is wrapped (unlike a message chunk's bare block) — the browser
// used to flatten this to "" and drop it silently.
test("a resource_link image tool call becomes a persistent image bubble", () => {
  state.current = makeChatState();
  handleNotification(
    frame({
      sessionUpdate: "tool_call",
      toolCallId: "exec-1",
      kind: "read",
      title: "View Image /tmp/scratch/staging.png",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "resource_link",
            name: "/tmp/scratch/staging.png",
            uri: "/tmp/scratch/staging.png",
          },
        },
      ],
    }),
  );
  const found = images();
  assert.equal(found.length, 1);
  assert.equal(found[0]!.toolCallId, "exec-1");
  assert.equal(found[0]!.attachments.length, 1);
  assert.equal(
    found[0]!.attachments[0]!.url,
    "/api/files/image?sessionId=s1&path=%2Ftmp%2Fscratch%2Fstaging.png&t=exec-1",
  );
  assert.equal(found[0]!.attachments[0]!.mimeType, "image/png");
});

// The bug this test exists for: an agent that regenerates a file and
// re-views it produces two tool calls naming the same path. Without a
// toolCallId in the URL both bubbles would share one URL, and since an
// "image" LogItem is deliberately uncached (logItemSig has no case for
// it) every later render re-fetches both from whatever the file holds
// NOW — silently overwriting the first bubble's "what the agent saw back
// then" with the second's content.
test("two views of the same path get distinct URLs", () => {
  state.current = makeChatState();
  const view = (toolCallId: string) =>
    handleNotification(
      frame({
        sessionUpdate: "tool_call",
        toolCallId,
        kind: "read",
        title: "View Image /tmp/scratch/diagram.png",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "resource_link", uri: "/tmp/scratch/diagram.png" },
          },
        ],
      }),
    );
  view("exec-a");
  view("exec-b");
  const found = images();
  assert.equal(found.length, 2);
  assert.notEqual(found[0]!.attachments[0]!.url, found[1]!.attachments[0]!.url);
});

test("a resource_link naming a non-image is not rendered as one", () => {
  state.current = makeChatState();
  handleNotification(
    frame({
      sessionUpdate: "tool_call",
      toolCallId: "exec-2",
      kind: "read",
      title: "View notes.txt",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "resource_link", uri: "/tmp/scratch/notes.txt" },
        },
      ],
    }),
  );
  assert.equal(images().length, 0);
  // Falls through to the ordinary transient tool-call tracking instead.
  assert.ok(state.current!.toolCalls.has("exec-2"));
});
