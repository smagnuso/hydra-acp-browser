import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileWindow, MAX_WINDOW_LINES } from "../src/server/file-window.js";

function fixture(lineCount: number, marker?: { at: number; text: string }): {
  path: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "hydra-acp-window-"));
  const path = join(dir, "big.ts");
  const lines: string[] = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(marker && i === marker.at ? marker.text : `line ${i}`);
  }
  writeFileSync(path, lines.join("\n") + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a window starts where asked and reports more beyond it", async () => {
  const { path, cleanup } = fixture(5000);
  try {
    const w = await readFileWindow(path, { fromLine: 100, lineCount: 10 });
    assert.equal(w.fromLine, 100);
    assert.deepEqual(w.content.split("\n").slice(0, 2), ["line 100", "line 101"]);
    assert.equal(w.content.split("\n").length, 10);
    assert.equal(w.hasMore, true);
  } finally {
    cleanup();
  }
});

test("the last window reports nothing beyond it", async () => {
  const { path, cleanup } = fixture(50);
  try {
    const w = await readFileWindow(path, { fromLine: 41, lineCount: 100 });
    assert.equal(w.fromLine, 41);
    assert.equal(w.hasMore, false);
    // Trailing newline means a final empty line; the window ends at it.
    assert.match(w.content, /line 50/);
  } finally {
    cleanup();
  }
});

test("locate centres the window on the match and reports its line", async () => {
  const { path, cleanup } = fixture(5000, { at: 3000, text: "  const anchorMe = 1;" });
  try {
    const w = await readFileWindow(path, { locate: "  const anchorMe = 1;", lineCount: 400 });
    assert.equal(w.matchedLine, 3000);
    // Landed above the match rather than at it, so there's context.
    assert.ok(w.fromLine < 3000 && w.fromLine >= 2800, `fromLine was ${w.fromLine}`);
    const offset = 3000 - w.fromLine;
    assert.equal(w.content.split("\n")[offset], "  const anchorMe = 1;");
  } finally {
    cleanup();
  }
});

test("a missing anchor falls back to the top rather than failing", async () => {
  const { path, cleanup } = fixture(500);
  try {
    const w = await readFileWindow(path, { locate: "never appears", lineCount: 20 });
    assert.equal(w.fromLine, 1);
    assert.equal(w.matchedLine, undefined);
    assert.match(w.content, /^line 1\n/);
  } finally {
    cleanup();
  }
});

test("an anchor near the top does not produce a negative offset", async () => {
  const { path, cleanup } = fixture(500, { at: 2, text: "second" });
  try {
    const w = await readFileWindow(path, { locate: "second", lineCount: 50 });
    assert.equal(w.matchedLine, 2);
    assert.equal(w.fromLine, 1);
    assert.equal(w.content.split("\n")[1], "second");
  } finally {
    cleanup();
  }
});

test("lineCount is clamped so one request cannot ask for everything", async () => {
  const { path, cleanup } = fixture(20);
  try {
    const w = await readFileWindow(path, { lineCount: 10_000_000 });
    assert.equal(w.fromLine, 1);
    assert.ok(w.content.split("\n").length <= MAX_WINDOW_LINES);
  } finally {
    cleanup();
  }
});

test("a file far larger than the old cap reads without loading it whole", async () => {
  // 400k lines is well past the 256 KiB byte cap this replaces.
  const { path, cleanup } = fixture(400_000, { at: 399_000, text: "deep marker" });
  try {
    const w = await readFileWindow(path, { locate: "deep marker", lineCount: 100 });
    assert.equal(w.matchedLine, 399_000);
    assert.ok(w.content.split("\n").length <= 100 + 1);
  } finally {
    cleanup();
  }
});
