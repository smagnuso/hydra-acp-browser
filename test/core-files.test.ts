import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};

interface Call {
  url: string;
  body: Record<string, unknown>;
}
const calls: Call[] = [];
let reply: (call: Call) => Response = () => Response.json({});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const call = { url: String(input), body: JSON.parse(String(init?.body ?? "{}")) };
  calls.push(call);
  return reply(call);
}) as typeof fetch;

const files = await import("../src/core/files.js");
const { state } = await import("../src/core/state.js");
const { installUiHooks } = await import("../src/core/hooks.js");
import type { ChatState } from "../src/core/types.js";

const events: string[] = [];
installUiHooks({
  beforeFileOverlayOpen: () => events.push("before"),
  afterFileOverlayOpen: () => events.push("after"),
  fileOverlayClosing: () => events.push("closing"),
  captureFileAnchor: (fromLine) => ({ line: fromLine + 1, viewportOffset: 10 }),
  isWideLayout: () => false,
});

function chat(): ChatState {
  const c = { sessionId: "s1", cwd: "/w/proj", fileOverlay: null, savedFileView: null, log: [] } as unknown as ChatState;
  state.current = c;
  state.view = "chat";
  calls.length = 0;
  events.length = 0;
  return c;
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("path helpers", () => {
  assert.equal(files.isImagePath("a/b.PNG"), true);
  assert.equal(files.isImagePath("a/b.ts"), false);
  assert.equal(files.isMarkdownPath("README.md"), true);
  assert.equal(files.relativeToCwd("/w/proj", "/w/proj/src/a.ts"), "src/a.ts");
  assert.equal(files.relativeToCwd("/w/proj", "/tmp/x"), "/tmp/x");
  assert.equal(files.imageUrl("s 1", "a/b.png"), "/api/files/image?sessionId=s%201&path=a%2Fb.png");
  assert.equal(files.windowStartFor(500), 300);
  assert.equal(files.windowStartFor(10), 1);
});

test("listFiles fills the overlay, and an error keeps the path", async () => {
  const c = chat();
  c.fileOverlay = { path: "", entries: [], preview: null, err: null, maximized: true, previewRaw: false };
  reply = () => Response.json({ path: "src", entries: [{ name: "a.ts", kind: "file", size: 1 }] });
  await files.listFiles("src");
  assert.deepEqual(calls[0], { url: "/api/files/list", body: { sessionId: "s1", path: "src" } });
  assert.equal(c.fileOverlay!.path, "src");
  assert.equal(c.fileOverlay!.entries.length, 1);
  assert.equal(c.fileOverlay!.maximized, true);
  reply = () => Response.json({ error: "denied" }, { status: 400 });
  await files.listFiles("nope");
  assert.equal(c.fileOverlay!.path, "nope");
  assert.equal(c.fileOverlay!.err, "denied");
});

test("readFile loads text, and skips the read for an image", async () => {
  const c = chat();
  c.fileOverlay = { path: "src", entries: [], preview: null, err: null, maximized: false, previewRaw: false };
  reply = () => Response.json({ content: "a\nb", fromLine: 1, hasMore: true });
  await files.readFile("src/a.ts");
  assert.deepEqual(c.fileOverlay!.preview, { path: "src/a.ts", content: "a\nb", fromLine: 1, hasMore: true });
  calls.length = 0;
  await files.readFile("src/p.png");
  assert.equal(calls.length, 0);
  assert.deepEqual(c.fileOverlay!.preview, {
    path: "src/p.png",
    isImage: true,
    url: files.imageUrl("s1", "src/p.png"),
  });
});

test("openFileAtLine roots the listing at the file's directory and forces raw for markdown", async () => {
  const c = chat();
  reply = (call) =>
    call.url === "/api/files/list"
      ? Response.json({ path: "docs", entries: [] })
      : Response.json({ content: "x", fromLine: 1, hasMore: false });
  files.openFileAtLine(c, "/w/proj/docs/a.md", 5);
  await settle();
  await settle();
  assert.deepEqual(events.slice(0, 2), ["before", "after"]);
  const list = calls.find((x) => x.url === "/api/files/list")!;
  const read = calls.find((x) => x.url === "/api/files/read")!;
  assert.equal(list.body.path, "docs");
  assert.equal(read.body.path, "docs/a.md");
  assert.equal(read.body.fromLine, 1);
  assert.equal(c.fileOverlay!.previewRaw, true);
  assert.equal(c.fileOverlay!.scrollToLine, 5);
  assert.equal(c.fileOverlay!.highlightLine, 5);
});

test("a file outside the cwd lists the root instead", async () => {
  const c = chat();
  reply = () => Response.json({ path: "", entries: [], content: "x" });
  files.openFileAtLine(c, "/tmp/x/out.ts");
  await settle();
  await settle();
  assert.equal(calls.find((x) => x.url === "/api/files/list")!.body.path, "");
});

test("extendFileWindow appends below, then reports the end", async () => {
  const c = chat();
  c.fileOverlay = {
    path: "",
    entries: [],
    preview: { path: "a.ts", content: "1\n2\n3", fromLine: 1, hasMore: true },
    err: null,
    maximized: false,
    previewRaw: false,
  };
  reply = () => Response.json({ content: "4\n5", fromLine: 4, hasMore: false });
  await files.extendFileWindow("down");
  assert.equal(calls[0]!.body.fromLine, 4);
  const p = c.fileOverlay!.preview as { content: string; fromLine: number; hasMore: boolean };
  assert.equal(p.content, "1\n2\n3\n4\n5");
  assert.equal(p.hasMore, false);
  await files.extendFileWindow("down");
  assert.equal(calls.length, 1);
});

test("extendFileWindow prepends above and keeps the reader's line", async () => {
  const c = chat();
  c.fileOverlay = {
    path: "",
    entries: [],
    preview: { path: "a.ts", content: "500\n501", fromLine: 500, hasMore: false },
    err: null,
    maximized: false,
    previewRaw: false,
  };
  reply = (call) => {
    assert.equal(call.body.fromLine, 100);
    assert.equal(call.body.lineCount, 400);
    return Response.json({ content: Array(400).fill("x").join("\n"), fromLine: 100 });
  };
  await files.extendFileWindow("up");
  const p = c.fileOverlay!.preview as { fromLine: number; content: string };
  assert.equal(p.fromLine, 100);
  assert.deepEqual(c.fileOverlay!.keepLine, { line: 501, viewportOffset: 10 });
});

test("an empty slice past EOF clears hasMore instead of adding a phantom line", async () => {
  const c = chat();
  c.fileOverlay = {
    path: "",
    entries: [],
    preview: { path: "a.ts", content: "1", fromLine: 1, hasMore: true },
    err: null,
    maximized: false,
    previewRaw: false,
  };
  reply = () => Response.json({ content: "" });
  await files.extendFileWindow("down");
  const p = c.fileOverlay!.preview as { content: string; hasMore: boolean };
  assert.equal(p.content, "1");
  assert.equal(p.hasMore, false);
});

test("closeFiles remembers the view and tells the UI before the repaint", async () => {
  const c = chat();
  c.fileOverlay = {
    path: "src",
    entries: [],
    preview: { path: "src/a.ts", content: "x", fromLine: 1, hasMore: false },
    err: null,
    maximized: true,
    previewRaw: true,
  };
  files.closeFiles();
  assert.equal(c.fileOverlay, null);
  assert.deepEqual(c.savedFileView, {
    dirPath: "src",
    previewPath: "src/a.ts",
    previewRaw: true,
    maximized: true,
  });
  assert.deepEqual(events, ["closing"]);
  reply = () => Response.json({ path: "src", entries: [] });
  files.openFiles();
  await settle();
  assert.equal(c.fileOverlay!.maximized, true);
  assert.equal(c.fileOverlay!.previewRaw, true);
});
