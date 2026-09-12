import { test } from "node:test";
import assert from "node:assert/strict";

// See acp-edit-diff.test.ts for why this stub is needed before the static
// imports below run.
(globalThis as { document?: unknown }).document ??= {
  addEventListener() {},
  removeEventListener() {},
};
// onFileMentions calls render() for real. Left inert here (the callback
// is never invoked) so these tests assert the state and the markup the
// renderer would consume, without needing a DOM to paint into.
(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame ??= () => 0;

const { state } = await import("../src/ui/state.js");
const { handleNotification } = await import("../src/ui/acp.js");
const { renderMarkdown, linkifyFilePaths } = await import("../src/ui/markdown.js");
import type { ChatState } from "../src/ui/types.js";

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
    fileMentions: new Map(),
    fileMentionsVersion: 0,
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
  return { method: "session/update", params: { sessionId: "s1", update } };
}

function agentChunk(text: string, messageId: string) {
  return frame({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    messageId,
  });
}

function mentionFrame(messageId: string, mentions: unknown[]) {
  return frame({ sessionUpdate: "agent_message_links", messageId, mentions });
}

function streams() {
  return state.current!.log.filter((e) => e.kind === "stream") as Array<
    Extract<ChatState["log"][number], { kind: "stream" }>
  >;
}

test("a mention frame populates the lookup without touching message text", () => {
  state.current = makeChatState();
  handleNotification(agentChunk("see src/foo.ts:42 for detail", "m1"));
  handleNotification(
    mentionFrame("m1", [{ raw: "src/foo.ts:42", relPath: "src/foo.ts", line: 42 }]),
  );
  // The text the daemon sent is what stays in the log: the history
  // cache, the reconnect cursor and session export all read it.
  assert.equal(streams()[0]!.text, "see src/foo.ts:42 for detail");
  assert.equal(state.current.fileMentions.get("src/foo.ts:42")?.line, 42);
  assert.equal(state.current.fileMentionsVersion, 1);
});

test("one messageId spanning two bubbles links both", () => {
  // The case that rules out rewriting text server-side: a tool call
  // closes the first bubble, and the continuation carries the same id.
  state.current = makeChatState();
  handleNotification(agentChunk("first, see src/foo.ts", "m1"));
  handleNotification(
    frame({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "pending" }),
  );
  handleNotification(agentChunk("then also src/foo.ts", "m1"));
  handleNotification(mentionFrame("m1", [{ raw: "src/foo.ts", relPath: "src/foo.ts" }]));

  const bubbles = streams().filter((s) => s.role === "agent");
  assert.equal(bubbles.length, 2, "tool call should have split the bubbles");
  const mentions = state.current.fileMentions;
  for (const b of bubbles) {
    const html = linkifyFilePaths(renderMarkdown(b.text), mentions);
    assert.match(html, /class="file-link"/);
  }
});

test("an unconfirmed path in the same message stays plain", () => {
  state.current = makeChatState();
  handleNotification(agentChunk("real src/foo.ts and fake src/nope.ts", "m1"));
  handleNotification(mentionFrame("m1", [{ raw: "src/foo.ts", relPath: "src/foo.ts" }]));
  const html = linkifyFilePaths(renderMarkdown(streams()[0]!.text), state.current.fileMentions);
  assert.match(html, /class="file-link"[^>]*>src\/foo\.ts</);
  assert.doesNotMatch(html, /src\/nope\.ts<\/a>/);
});

test("a malformed mention frame is ignored", () => {
  state.current = makeChatState();
  handleNotification(agentChunk("see src/foo.ts", "m1"));
  handleNotification(mentionFrame("m1", [{ raw: 42 }, { relPath: "x" }, null, "nope"]));
  assert.equal(state.current.fileMentions.size, 0);
  assert.equal(state.current.fileMentionsVersion, 0);
});

test("a redelivered mention frame does not re-bump the version", () => {
  // Every attach replay re-sends these; bumping the render-invalidation
  // counter each time would throw away the whole markdown cache for
  // nothing.
  state.current = makeChatState();
  handleNotification(agentChunk("see src/foo.ts", "m1"));
  const dup = [{ raw: "src/foo.ts", relPath: "src/foo.ts" }];
  handleNotification(mentionFrame("m1", dup));
  handleNotification(mentionFrame("m1", dup));
  assert.equal(state.current.fileMentionsVersion, 1);
});
