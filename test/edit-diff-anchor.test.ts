import { test } from "node:test";
import assert from "node:assert/strict";

const { editAnchor, findAnchorLine } = await import("../src/ui/edit-diff.js");

test("the anchor is the first line of newText that differs", () => {
  const a = editAnchor({
    path: "a.ts",
    oldText: "keep\nold line\ntail\n",
    newText: "keep\nnew line\ntail\n",
  });
  assert.deepEqual(a, { anchor: "new line", span: 1 });
});

test("the span covers the whole changed run, not just its first line", () => {
  const a = editAnchor({
    path: "a.ts",
    oldText: "keep\nx\ntail\n",
    newText: "keep\none\ntwo\nthree\ntail\n",
  });
  assert.deepEqual(a, { anchor: "one", span: 3 });
});

test("a pure insertion anchors on the inserted text", () => {
  const a = editAnchor({ path: "a.ts", oldText: "", newText: "added\n" });
  assert.deepEqual(a, { anchor: "added", span: 1 });
});

test("a blank first-changed line yields no anchor", () => {
  // It would match the first empty line in the file, which is worse than
  // opening at the top with no highlight.
  assert.equal(editAnchor({ path: "a.ts", oldText: "a\n", newText: "\na\n" }), null);
});

test("a pure deletion yields no anchor", () => {
  assert.equal(editAnchor({ path: "a.ts", oldText: "gone\n", newText: "" }), null);
});

test("identical texts yield no anchor", () => {
  assert.equal(editAnchor({ path: "a.ts", oldText: "same\n", newText: "same\n" }), null);
});

test("findAnchorLine returns a 1-based line", () => {
  assert.equal(findAnchorLine("one\ntwo\nthree\n", "two"), 2);
  assert.equal(findAnchorLine("one\ntwo\n", "nope"), null);
});

test("findAnchorLine requires a full-line match, like the TUI", () => {
  // Substring matches would land on the wrong line constantly, and the
  // comparison is whitespace-exact: indentation is part of the line. Safe
  // because the anchor came from the edit that was actually applied.
  assert.equal(findAnchorLine("prefix const x = 1;\n", "const x = 1;"), null);
  assert.equal(findAnchorLine("const x = 1;\n  x\n", "x"), null);
  assert.equal(findAnchorLine("const x = 1;\n  x\n", "  x"), 2);
});

test("findAnchorLine takes the first of several matches", () => {
  assert.equal(findAnchorLine("dup\nmid\ndup\n", "dup"), 1);
});

test("a huge patch's tint span is capped", () => {
  const newText = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const a = editAnchor({ path: "a.ts", oldText: "x\n", newText });
  assert.equal(a?.anchor, "line 0");
  assert.equal(a?.span, 40, "300 shaded lines would fill a phone screen");
});
