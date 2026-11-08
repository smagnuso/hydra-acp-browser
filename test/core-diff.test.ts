import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};

const urls: string[] = [];
const bodies: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  urls.push(String(input));
  bodies.push(String(init?.body ?? ""));
  if (String(input).endsWith("/uncommitted")) {
    return Response.json({ repo: true, files: [{ path: "/w/g.ts", created: true, hunks: [{ oldText: "", newText: "x\n" }] }] });
  }
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
    forwardPanes: [],
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
  c.diffPane = { scope: "session", turn: null, files: [], uncommitted: null, notRepo: false, truncated: false, loading: false, err: null, expanded: [], scrollTop: 0 };
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

test("the uncommitted scope fetches git changes and is what the pane then shows", async () => {
  const c = chat([]);
  diff.openDiff();
  await new Promise((r) => setTimeout(r, 0));
  urls.length = 0;
  diff.setDiffScope("uncommitted");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(urls[0], "/api/sessions/s%201/uncommitted");
  assert.deepEqual(diff.visibleDiffFiles(c).map((f) => f.path), ["/w/g.ts"]);
  assert.equal(c.diffPane!.notRepo, false);
});

test("going back leaves a forward trail that restores panes in order", async () => {
  const c = chat([]);
  diff.openDiff();
  await new Promise((r) => setTimeout(r, 0));
  c.fileOverlay = { path: "", entries: [], preview: null, err: null, previewRaw: false };
  diff.closeTopPane();
  diff.closeTopPane();
  assert.deepEqual(c.forwardPanes, ["files", "diff"]);
  assert.equal(diff.nextForwardPane(c), "diff");
  diff.reopenForwardPane();
  assert.notEqual(c.diffPane, null);
  assert.deepEqual(c.forwardPanes, ["files"]);
  diff.openDiff();
  assert.deepEqual(c.forwardPanes, []);
});

test("a forward gesture defaults to the changes pane when nothing was closed", () => {
  const c = chat([]);
  assert.equal(diff.nextForwardPane(c), "diff");
  c.diffPane = diff.newDiffPane();
  assert.equal(diff.nextForwardPane(c), null);
  c.diffPane = null;
  c.forwardPanes = ["files"];
  assert.equal(diff.nextForwardPane(c), "files");
});

test("fileDiffCounts sums hunks, and splitDiffPath keeps outside paths absolute with ~", () => {
  const file = {
    path: "/w/a.ts",
    created: false,
    hunks: [
      { oldText: "a\n", newText: "a\nb\n" },
      { oldText: "x\ny\n", newText: "x\n" },
    ],
  };
  assert.deepEqual(diff.fileDiffCounts(file), { added: 1, removed: 1 });
  assert.deepEqual(diff.splitDiffPath("/w", "/w/src/a.ts"), { name: "a.ts", dir: "src/" });
  assert.deepEqual(diff.splitDiffPath("/w", "a.ts"), { name: "a.ts", dir: "" });
  assert.deepEqual(diff.splitDiffPath("/w", "/home/sam/x/a.ts"), { name: "a.ts", dir: "~/x/" });
  assert.deepEqual(diff.splitDiffPath("/w", "/srv/x/a.ts"), { name: "a.ts", dir: "/srv/x/" });
});

test("splitDiffPath handles Windows paths and keeps outside ones whole", () => {
  assert.deepEqual(diff.splitDiffPath("C:\\w", "C:\\w\\src\\a.ts"), { name: "a.ts", dir: "src\\" });
  assert.deepEqual(diff.splitDiffPath("C:/W/", "c:\\w\\a.ts"), { name: "a.ts", dir: "" });
  assert.deepEqual(diff.splitDiffPath("C:\\w", "D:\\x\\a.ts"), { name: "a.ts", dir: "D:\\x\\" });
});

test("diffPaneStatus says why the pane is empty", () => {
  const c = chat([]);
  assert.equal(diff.diffPaneStatus(c), null);
  c.diffPane = diff.newDiffPane();
  assert.deepEqual(diff.diffPaneStatus(c), { kind: "loading" });
  c.diffPane.err = "boom";
  assert.deepEqual(diff.diffPaneStatus(c), { kind: "error", error: "boom" });
  c.diffPane.err = null;
  c.diffPane.files = [];
  assert.deepEqual(diff.diffPaneStatus(c), { kind: "empty" });
  c.diffPane.scope = "uncommitted";
  c.diffPane.uncommitted = [];
  c.diffPane.notRepo = true;
  assert.deepEqual(diff.diffPaneStatus(c), { kind: "not-repo" });
  c.diffPane.notRepo = false;
  c.diffPane.uncommitted = [{ path: "/w/a", created: false, hunks: [] }];
  assert.equal(diff.diffPaneStatus(c), null);
});

test("openDiffFile locates the tapped hunk, not always the first", async () => {
  const c = chat([]);
  c.fileOverlay = null;
  const file = {
    path: "/w/a.ts",
    created: false,
    hunks: [
      { oldText: "one\n", newText: "ONE\n" },
      { oldText: "two\n", newText: "TWO\n" },
    ],
  };
  bodies.length = 0;
  diff.openDiffFile(file, 1);
  await new Promise((r) => setTimeout(r, 0));
  const read = bodies.map((b) => (b ? JSON.parse(b) : {})).find((b) => "locate" in b);
  assert.equal(read?.locate, "TWO");
});
