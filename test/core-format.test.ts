import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const f = await import("../src/core/format.js");
const { permissionDetails } = await import("../src/core/permission.js");
const cwdHistory = await import("../src/core/cwd-history.js");
import type { ChatState } from "../src/core/types.js";

test("model and agent labels", () => {
  assert.equal(f.shortenModel("openai/gpt-4o-mini"), "gpt-4o-mini");
  assert.equal(f.shortenModel("claude-opus"), "claude-opus");
  assert.equal(f.shortenModel(undefined), undefined);
  assert.equal(f.agentWithModel("claude", "anthropic/opus"), "claude•opus");
  assert.equal(f.agentWithModel(undefined, undefined), "?");
});

test("durations match the TUI's abbreviations", () => {
  const min = 60_000;
  assert.equal(f.formatDuration(30_000), "<1m");
  assert.equal(f.formatDuration(12 * min), "12m");
  assert.equal(f.formatDuration(3 * 60 * min), "3h");
  assert.equal(f.formatDuration(2 * 24 * 60 * min), "2d");
  assert.equal(f.formatDuration(35 * 24 * 60 * min), "5w");
  assert.equal(f.formatDuration(330 * 24 * 60 * min), "11mo");
  assert.equal(f.formatDuration(800 * 24 * 60 * min), "2y");
  assert.equal(f.formatRelativeAge(undefined), "?");
  assert.equal(f.formatRelativeAge("nope"), "?");
  assert.equal(f.formatRelativeAge(new Date(0).toISOString(), 3 * 60 * 60_000), "3h");
});

test("token counts and elapsed time", () => {
  assert.equal(f.fmtTokens(999), "999");
  assert.equal(f.fmtTokens(1500), "1.5k");
  assert.equal(f.fmtTokens(20_000), "20k");
  assert.equal(f.fmtTokens(1_500_000), "1.5M");
  assert.equal(f.fmtTokens(Number.NaN), "?");
  assert.equal(f.formatElapsed(45_000), "45s");
  assert.equal(f.formatElapsed(125_000), "2m 5s");
  assert.equal(f.formatElapsed(3_725_000), "1h 2m");
});

test("cost accepts a bare number or either nested shape", () => {
  assert.equal(f.fmtCost(0.5), "$0.500");
  assert.equal(f.fmtCost(0.001), "$0.0010");
  assert.equal(f.fmtCost(12), "$12.00");
  assert.equal(f.fmtCost({ amount: 2, currency: "EUR" }), "2.00 EUR");
  assert.equal(f.fmtCost({ total: { amount: 3, currency: "USD" } }), "$3.00");
  assert.equal(f.fmtCost({}), null);
  assert.equal(f.fmtCost(null), null);
});

test("path labels", () => {
  assert.equal(f.baseName("a/b/c.ts"), "c.ts");
  assert.equal(f.baseName("c.ts"), "c.ts");
  assert.equal(f.dirName("src/server/a.ts", "/home/u/p"), "src/server");
  assert.equal(f.dirName("/home/u/x/a.ts", "/home/u/p"), "~/x");
  assert.equal(f.dirName("a.ts", "/home/u/p"), "~/p");
});

test("turnAgentParts collects agent text after a stamp until the next turn", () => {
  const stamp = { kind: "turn-stamp", elapsedMs: 1, toolCount: 0, endedAt: 1 } as const;
  const c = {
    log: [
      { kind: "stream", role: "agent", text: "before" },
      stamp,
      { kind: "stream", role: "agent", text: "one" },
      { kind: "system", text: "note" },
      { kind: "stream", role: "agent", text: "two" },
      { kind: "stream", role: "user", text: "next" },
      { kind: "stream", role: "agent", text: "later" },
    ],
  } as unknown as ChatState;
  assert.deepEqual(f.turnAgentParts(c, stamp as never), ["one", "two"]);
  assert.deepEqual(f.turnAgentParts(c, { kind: "system", text: "x" } as never), []);
});

test("permission details list kind, de-duplicated paths, command, url and a note", () => {
  const rows = permissionDetails({
    kind: "edit",
    locations: [{ path: "/a" }, { path: "/a" }, { nope: 1 }],
    rawInput: { file_path: "/a", filePath: "/b", command: "ls", url: "http://x", description: "why" },
  });
  assert.deepEqual(rows, [
    { label: "kind", value: "edit" },
    { label: "path", value: "/a" },
    { label: "path", value: "/b" },
    { label: "command", value: "ls" },
    { label: "url", value: "http://x" },
    { value: "why", note: true },
  ]);
  assert.deepEqual(permissionDetails({}), []);
});

test("cwd history is most-recent-first, de-duplicated, capped, and migrates the old key", () => {
  store.clear();
  assert.deepEqual(cwdHistory.loadCwdHistory(), []);
  store.set("hydra-acp-browser:lastCwd", "/old");
  assert.deepEqual(cwdHistory.loadCwdHistory(), ["/old"]);
  cwdHistory.saveLastCwd("/a");
  cwdHistory.saveLastCwd("/b");
  cwdHistory.saveLastCwd("/a");
  assert.deepEqual(cwdHistory.loadCwdHistory(), ["/a", "/b", "/old"]);
  assert.equal(cwdHistory.loadLastCwd(), "/a");
  assert.equal(store.has("hydra-acp-browser:lastCwd"), false);
  for (let i = 0; i < 30; i++) {
    cwdHistory.saveLastCwd(`/d${i}`);
  }
  assert.equal(cwdHistory.loadCwdHistory().length, 20);
  assert.equal(cwdHistory.loadLastCwd(), "/d29");
});
