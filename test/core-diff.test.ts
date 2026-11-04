import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};

const urls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  urls.push(String(input));
  return Response.json([{ path: "/w/a.ts", created: false, hunks: [{ oldText: "x", newText: "y" }] }]);
}) as typeof fetch;

const diff = await import("../src/core/diff.js");
const { state } = await import("../src/core/state.js");
import type { ChatState } from "../src/core/types.js";

const user = (text: string) => ({ kind: "stream", role: "user", text, closed: true });
const edit = (path: string, oldText: string, newText: string, status = "completed") => ({
  kind: "edit-diff",
  toolCallId: path + newText,
  diff: { path, oldText, newText },
  status,
  expanded: false,
});

function chat(log: unknown[]): ChatState {
  const c = {
    sessionId: "s 1",
    cwd: "/w",
    fileOverlay: null,
    diffPane: null,
    savedFileView: null,
    log,
  } as unknown as ChatState;
  state.current = c;
  state.view = "chat";
  urls.length = 0;
  return c;
}

test("turnDiffs groups edits per prompt and per file, skipping failures", () => {
  const c = chat([
    user("one"),
    edit("/w/a.ts", "a", "b"),
    edit("/w/a.ts", "b", "c"),
    edit("/w/b.ts", "", "new"),
    edit("/w/c.ts", "q", "r", "failed"),
    user("no edits here"),
    user("two"),
    edit("/w/a.ts", "c", "d"),
  ]);
  const turns = diff.turnDiffs(c);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.prompt, "one");
  assert.deepEqual(turns[0]!.files.map((f) => f.path), ["/w/a.ts", "/w/b.ts"]);
  assert.equal(turns[0]!.files[0]!.hunks.length, 2);
  assert.equal(turns[0]!.files[1]!.created, true);
  assert.equal(turns[1]!.prompt, "two");
});

test("turn scope follows the latest turn until stepped back", () => {
  const c = chat([user("one"), edit("/w/a.ts", "a", "b"), user("two"), edit("/w/z.ts", "a", "b")]);
  diff.openDiff();
  c.diffPane!.files = [];
  diff.setDiffScope("turn");
  assert.deepEqual(diff.visibleDiffFiles(c).map((f) => f.path), ["/w/z.ts"]);
  diff.stepDiffTurn(-1);
  assert.deepEqual(diff.visibleDiffFiles(c).map((f) => f.path), ["/w/a.ts"]);
  diff.stepDiffTurn(-1);
  assert.equal(c.diffPane!.turn, 0);
  diff.stepDiffTurn(1);
  assert.equal(c.diffPane!.turn, null);
});

test("openDiff fetches the folded session diff", async () => {
  const c = chat([]);
  diff.openDiff();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(urls[0], "/api/sessions/s%201/diff?fold=true");
  assert.equal(c.diffPane!.files![0]!.path, "/w/a.ts");
  assert.equal(c.diffPane!.loading, false);
});

test("closeTopPane pops the file viewer before the diff", () => {
  const c = chat([]);
  c.diffPane = { scope: "session", turn: null, files: [], loading: false, err: null, expanded: [], scrollTop: 0 };
  c.fileOverlay = { path: "", entries: [], preview: null, err: null, previewRaw: false };
  diff.closeTopPane();
  assert.equal(c.fileOverlay, null);
  assert.notEqual(c.diffPane, null);
  diff.closeTopPane();
  assert.equal(c.diffPane, null);
  assert.equal(diff.hasOpenPane(c), false);
});

test("closing the pane keeps its data, and a refetch reuses unchanged files", async () => {
  const c = chat([]);
  diff.openDiff();
  await new Promise((r) => setTimeout(r, 0));
  const first = c.diffPane!.files!;
  diff.toggleDiffFile("/w/a.ts");
  diff.closeDiff();
  assert.equal(c.diffPane, null);
  diff.openDiff();
  assert.equal(c.diffPane!.files, first);
  assert.deepEqual(c.diffPane!.expanded, ["/w/a.ts"]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.diffPane!.files, first);
});
