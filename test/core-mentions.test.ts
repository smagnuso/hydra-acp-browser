import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};

const m = await import("../src/core/mentions.js");
import type { ChatState, MentionTarget, SessionInfo } from "../src/core/types.js";

const chat = (over: Partial<ChatState> = {}): ChatState =>
  ({
    sessionId: "s1",
    cwd: "/proj",
    composerValue: "",
    mentions: new Map(),
    mentionPicker: null,
    ...over,
  }) as unknown as ChatState;

test("activeMention finds an @token ending at the caret", () => {
  assert.deepEqual(m.activeMention("look at @src/a", 14), { start: 8, end: 14, query: "src/a" });
  assert.deepEqual(m.activeMention("@", 1), { start: 0, end: 1, query: "" });
});

test("activeMention ignores emails and mid-word @", () => {
  assert.equal(m.activeMention("me@example.com", 14), null);
  assert.equal(m.activeMention("hello world", 11), null);
});

test("activeMention spans an escaped space", () => {
  assert.equal(m.activeMention("@my\\ no", 7)?.query, "my no");
});

test("pickMention inserts the token, records it, and returns the caret", () => {
  const c = chat({
    composerValue: "see @rea now",
    mentionPicker: { start: 4, end: 8, query: "rea", files: ["README.md"], sessions: [], selected: 0, truncated: false },
  });
  const caret = m.pickMention(c);
  assert.equal(c.composerValue, "see @README.md now");
  assert.equal(caret, 14);
  assert.equal(c.mentionPicker, null);
  assert.deepEqual(c.mentions.get("@README.md"), { kind: "file", path: "README.md" });
});

test("pickMention adds a trailing space at end of text and escapes spaces", () => {
  const c = chat({
    composerValue: "@not",
    mentionPicker: { start: 0, end: 4, query: "not", files: ["docs/my notes.md"], sessions: [], selected: 0, truncated: false },
  });
  m.pickMention(c);
  assert.equal(c.composerValue, "@docs/my\\ notes.md ");
});

test("mentionBlocks links only mentions still in the text", () => {
  const c = chat({ mentions: new Map<string, MentionTarget>([["@a.ts", { kind: "file", path: "a.ts" }], ["@b.ts", { kind: "file", path: "b.ts" }]]) });
  assert.deepEqual(m.mentionBlocks(c, "check @a.ts and @b.tsx"), [
    { type: "resource_link", uri: "file:///proj/a.ts", name: "a.ts" },
  ]);
});

test("fileUri handles Windows cwds and encodes spaces", () => {
  assert.equal(m.fileUri("C:\\proj\\", "my notes.md"), "file:///C:/proj/my%20notes.md");
  assert.equal(m.fileUri("/proj", "a b/c.ts"), "file:///proj/a%20b/c.ts");
});

test("picking a directory inserts it as text, records no link, and keeps drilling", () => {
  const c = chat({
    composerValue: "@sr",
    mentionPicker: { start: 0, end: 3, query: "sr", files: ["src/"], sessions: [], selected: 0, truncated: false },
  });
  const caret = m.pickMention(c);
  assert.equal(c.composerValue, "@src/");
  assert.equal(caret, 5);
  assert.equal(c.mentions.size, 0);
  assert.equal(c.mentionPicker?.query, "src/");
});

test("fileUri keeps the host of a UNC cwd", () => {
  assert.equal(m.fileUri("\\\\srv\\share\\proj", "a b.ts"), "file://srv/share/proj/a%20b.ts");
});

const sess = (over: Partial<SessionInfo>): SessionInfo => ({
  sessionId: "hydra_session_ab12cd34",
  cwd: "/home/u/proj",
  updatedAt: "2026-11-01T00:00:00Z",
  ...over,
});

test("slugify lowercases, cuts a long title at a word boundary, hard-cuts one long word", () => {
  assert.equal(m.slugify("Fix the Login Bug!"), "fix-the-login-bug");
  assert.equal(m.slugify("Codex @ handling in TUI and browser prompts"), "codex-handling-in-tui");
  assert.equal(m.slugify("a" + "b".repeat(40)), "a" + "b".repeat(23));
});

test("a session token is the slug plus a short id", () => {
  assert.equal(m.sessionMentionToken("hydra_session_ab12cd34", "Fix login"), "@fix-login-ab12");
  assert.equal(m.sessionMentionToken("hydra_session_ff00aa", ""), "@session-ff00");
});

test("sessionMentionItems matches title, cwd and id, newest first", () => {
  const a = sess({ sessionId: "hydra_session_aaaa1111", title: "Fix login bug", updatedAt: "2026-11-01T00:00:00Z" });
  const b = sess({ sessionId: "hydra_session_bbbb2222", title: "Login redesign", updatedAt: "2026-11-05T00:00:00Z" });
  const c = sess({ sessionId: "hydra_session_cccc3333", title: "Unrelated", cwd: "/home/u/auth-service" });
  assert.deepEqual(m.sessionMentionItems("login", [a, b, c]).map((x) => x.id), [
    "hydra_session_bbbb2222",
    "hydra_session_aaaa1111",
  ]);
  assert.equal(m.sessionMentionItems("fix-login", [a, b, c]).length, 1);
  assert.equal(m.sessionMentionItems("auth-serv", [a, b, c]).length, 1);
  assert.equal(m.sessionMentionItems("cccc", [a, b, c]).length, 1);
});

test("sessionMentionItems skips the current chat, federated sessions and path-shaped queries", () => {
  const a = sess({ sessionId: "hydra_session_aaaa1111", title: "Login" });
  const peer = sess({ sessionId: "peer:hydra_session_bbbb2222", title: "Login", remote: "peer" });
  assert.equal(m.sessionMentionItems("login", [a], { excludeId: "hydra_session_aaaa1111" }).length, 0);
  assert.equal(m.sessionMentionItems("login", [peer]).length, 0);
  assert.equal(m.sessionMentionItems("src/login", [a]).length, 0);
  assert.equal(m.sessionMentionItems(".login", [a]).length, 0);
});

test("mentionItems puts sessions right after the first two files, and leaves room for both", () => {
  const files = Array.from({ length: 30 }, (_, i) => `f${i}.ts`);
  const session = { kind: "session" as const, id: "s1", title: "T", cwd: "/p" };
  const items = m.mentionItems({ files, sessions: [session] });
  assert.equal(items.length, 16);
  assert.deepEqual(items[0], { kind: "file", path: "f0.ts" });
  assert.deepEqual(items[1], { kind: "file", path: "f1.ts" });
  assert.deepEqual(items[2], session);
  assert.deepEqual(items[3], { kind: "file", path: "f2.ts" });
  assert.equal(items.filter((i) => i.kind === "file").length, 15);
  assert.equal(m.mentionItems({ files, sessions: [] }).length, 30);
});

test("picking a session inserts its token, records the target, and returns the caret", () => {
  const session = { kind: "session" as const, id: "hydra_session_ab12cd34", title: "Fix login", cwd: "/p" };
  const c = chat({
    composerValue: "see @fix now",
    mentionPicker: { start: 4, end: 8, query: "fix", files: [], sessions: [session], selected: 0, truncated: false },
  });
  const caret = m.pickMention(c);
  assert.equal(c.composerValue, "see @fix-login-ab12 now");
  assert.equal(caret, 19);
  assert.deepEqual(c.mentions.get("@fix-login-ab12"), {
    kind: "session",
    id: "hydra_session_ab12cd34",
    title: "Fix login",
  });
  assert.equal(c.mentionPicker, null);
});

test("a picker holding only sessions is still navigable", () => {
  const s1 = { kind: "session" as const, id: "a", title: "A", cwd: "/p" };
  const s2 = { kind: "session" as const, id: "b", title: "B", cwd: "/p" };
  const c = chat({
    mentionPicker: { start: 0, end: 1, query: "", files: [], sessions: [s1, s2], selected: 0, truncated: false },
  });
  m.moveMentionSelection(c, 1);
  assert.equal(c.mentionPicker?.selected, 1);
  m.moveMentionSelection(c, 1);
  assert.equal(c.mentionPicker?.selected, 0);
});

test("a session mention goes out as a hydra:// resource_link", () => {
  const c = chat({
    mentions: new Map<string, MentionTarget>([
      ["@fix-login-ab12", { kind: "session", id: "hydra_session_ab12cd34", title: "Fix login" }],
      ["@session-ff00", { kind: "session", id: "hydra_session_ff00aa", title: "" }],
    ]),
  });
  assert.deepEqual(m.mentionBlocks(c, "see @fix-login-ab12 and @session-ff00"), [
    {
      type: "resource_link",
      uri: "hydra://sessions/hydra_session_ab12cd34",
      name: "Fix login",
      description:
        "Hydra session hydra_session_ab12cd34; read it with: hydra session transcript hydra_session_ab12cd34",
      mimeType: "text/markdown",
    },
    {
      type: "resource_link",
      uri: "hydra://sessions/hydra_session_ff00aa",
      name: "hydra_session_ff00aa",
      description:
        "Hydra session hydra_session_ff00aa; read it with: hydra session transcript hydra_session_ff00aa",
      mimeType: "text/markdown",
    },
  ]);
  assert.deepEqual(m.mentionBlocks(c, "nothing here"), []);
});

test("a title match ranks above a cwd-only match, whatever the recency", () => {
  const inCwd = sess({ sessionId: "hydra_session_eeee5555", title: "Unrelated work", cwd: "/home/u/hydra-acp", updatedAt: "2026-11-09T00:00:00Z" });
  const inTitle = sess({ sessionId: "hydra_session_ffff6666", title: "Hydra summarizer", cwd: "/home/u/other", updatedAt: "2026-11-01T00:00:00Z" });
  assert.deepEqual(m.sessionMentionItems("hydra", [inCwd, inTitle]).map((x) => x.id), [
    "hydra_session_ffff6666",
    "hydra_session_eeee5555",
  ]);
});
