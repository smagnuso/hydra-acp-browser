import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};

const att = await import("../src/core/attachments.js");
const { state } = await import("../src/core/state.js");
import type { ChatState } from "../src/core/types.js";

const chat = (): ChatState => ({ attachments: [] }) as unknown as ChatState;

test("an image blob becomes a base64 attachment with its mime type and size", async () => {
  const c = chat();
  const bytes = Uint8Array.from([137, 80, 78, 71, 0, 255, 1]);
  await att.addImageAttachments(c, [new Blob([bytes], { type: "image/png" })]);
  assert.equal(c.attachments.length, 1);
  assert.deepEqual(c.attachments[0], {
    mimeType: "image/png",
    data: Buffer.from(bytes).toString("base64"),
    sizeBytes: 7,
  });
});

test("a blob with no type defaults to png", async () => {
  const c = chat();
  await att.addImageAttachments(c, [new Blob([Uint8Array.from([1])])]);
  assert.equal(c.attachments[0]!.mimeType, "image/png");
});

test("a large image encodes identically to Buffer's base64", async () => {
  const c = chat();
  const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
  await att.addImageAttachments(c, [new Blob([bytes], { type: "image/jpeg" })]);
  assert.equal(c.attachments[0]!.data, Buffer.from(bytes).toString("base64"));
});

test("an oversized image is rejected with a warning banner", async () => {
  const c = chat();
  state.banner = null;
  await att.addImageAttachments(c, [
    new Blob([new Uint8Array(att.MAX_ATTACHMENT_BYTES + 1)], { type: "image/png" }),
    new Blob([Uint8Array.from([1])], { type: "image/png" }),
  ]);
  assert.equal(c.attachments.length, 1);
  assert.equal(state.banner?.kind, "warn");
  assert.match(state.banner!.text, /pasted image is 10\.0MB, max 10\.0MB/);
});

test("removeAttachment drops by index", () => {
  const c = chat();
  c.attachments = [
    { mimeType: "a", sizeBytes: 1 },
    { mimeType: "b", sizeBytes: 2 },
    { mimeType: "c", sizeBytes: 3 },
  ];
  att.removeAttachment(c, 1);
  assert.deepEqual(c.attachments.map((a) => a.mimeType), ["a", "c"]);
});

test("size formatting and the data/url source", () => {
  assert.equal(att.formatAttachmentSize(512), "512B");
  assert.equal(att.formatAttachmentSize(2048), "2KB");
  assert.equal(att.formatAttachmentSize(3 * 1024 * 1024), "3.0MB");
  assert.equal(att.attachmentSrc({ mimeType: "image/png", data: "QQ==", sizeBytes: 1 }), "data:image/png;base64,QQ==");
  assert.equal(att.attachmentSrc({ mimeType: "image/png", url: "/x.png", sizeBytes: 1 }), "/x.png");
});
