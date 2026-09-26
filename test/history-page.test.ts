import { test } from "node:test";
import assert from "node:assert/strict";

const { historyEntryToFrame, oldestSeqOf } = await import("../src/ui/history-page.js");

test("historyEntryToFrame folds seq and recordedAt into params._meta", () => {
  const frame = historyEntryToFrame({
    method: "session/update",
    params: { update: { sessionUpdate: "prompt_received" }, _meta: { keep: 1 } },
    recordedAt: 50,
    seq: 7,
  });
  assert.deepEqual(frame.params?._meta, {
    keep: 1,
    "hydra-acp": { seq: 7, recordedAt: 50 },
  });
});

test("historyEntryToFrame omits absent seq", () => {
  const frame = historyEntryToFrame({ method: "session/update", params: {}, recordedAt: 5 });
  assert.deepEqual(frame.params?._meta, { "hydra-acp": { recordedAt: 5 } });
});

test("oldestSeqOf ignores entries without seq", () => {
  assert.equal(oldestSeqOf([{ method: "m", params: {} }, { method: "m", params: {}, seq: 9 }, { method: "m", params: {}, seq: 4 }]), 4);
  assert.equal(oldestSeqOf([]), undefined);
});
