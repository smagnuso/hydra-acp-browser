import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};

const m = await import("../src/core/mentions.js");
import type { ChatState } from "../src/core/types.js";

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
    mentionPicker: { start: 4, end: 8, query: "rea", files: ["README.md"], selected: 0 },
  });
  const caret = m.pickMention(c);
  assert.equal(c.composerValue, "see @README.md now");
  assert.equal(caret, 14);
  assert.equal(c.mentionPicker, null);
  assert.equal(c.mentions.get("@README.md"), "README.md");
});

test("pickMention adds a trailing space at end of text and escapes spaces", () => {
  const c = chat({
    composerValue: "@not",
    mentionPicker: { start: 0, end: 4, query: "not", files: ["docs/my notes.md"], selected: 0 },
  });
  m.pickMention(c);
  assert.equal(c.composerValue, "@docs/my\\ notes.md ");
});

test("mentionBlocks links only mentions still in the text", () => {
  const c = chat({ mentions: new Map([["@a.ts", "a.ts"], ["@b.ts", "b.ts"]]) });
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
    mentionPicker: { start: 0, end: 3, query: "sr", files: ["src/"], selected: 0 },
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
