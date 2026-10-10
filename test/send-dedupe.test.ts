import { test } from "node:test";
import assert from "node:assert/strict";

// See acp-edit-diff.test.ts for why this stub is needed before the static
// imports below run.
(globalThis as { document?: unknown }).document ??= {
  addEventListener() {},
  removeEventListener() {},
};

const { isDuplicateSubmit } = await import("../src/ui/queue.js");

// Field trail: the rescue sent a prompt and the user's impatient re-tap
// sent the same text again 7ms later.
test("the same text from the same chat right after a send is a duplicate", () => {
  assert.equal(isDuplicateSubmit("s_dup", "hello", 1000), false);
  assert.equal(isDuplicateSubmit("s_dup", "hello", 1007), true);
});

test("a deliberate repeat after the window still goes out", () => {
  assert.equal(isDuplicateSubmit("s_later", "again", 1000), false);
  assert.equal(isDuplicateSubmit("s_later", "again", 2600), false);
});

test("different text or a different chat is never a duplicate", () => {
  assert.equal(isDuplicateSubmit("s_a", "one", 1000), false);
  assert.equal(isDuplicateSubmit("s_a", "two", 1001), false);
  assert.equal(isDuplicateSubmit("s_b", "two", 1002), false);
});
