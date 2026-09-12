import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCandidates, findFileMentions } from "../src/server/file-mentions.js";

// realpath.native for the same reason test/files.test.ts does it: the
// production path resolves before comparing, so an unresolved fixture
// path asserts against a spelling the code never returns.
function makeRoot(): { cwd: string; cleanup: () => void } {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hydra-acp-mentions-")));
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src/foo.ts"), "a\nb\nc\n");
  writeFileSync(join(cwd, "README.md"), "# hi\n");
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("a real relative path is confirmed", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    const m = await findFileMentions(cwd, "see src/foo.ts for detail");
    assert.deepEqual(m, [{ raw: "src/foo.ts", relPath: "src/foo.ts" }]);
  } finally {
    cleanup();
  }
});

test("a line suffix is carried, a column is dropped", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    const m = await findFileMentions(cwd, "see src/foo.ts:42 and src/foo.ts:7:3");
    assert.deepEqual(m, [
      { raw: "src/foo.ts:42", relPath: "src/foo.ts", line: 42 },
      { raw: "src/foo.ts:7:3", relPath: "src/foo.ts", line: 7 },
    ]);
  } finally {
    cleanup();
  }
});

test("an absolute path inside cwd resolves to the same relative path", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    const m = await findFileMentions(cwd, `see ${join(cwd, "src/foo.ts")} now`);
    assert.equal(m.length, 1);
    assert.equal(m[0]!.relPath, "src/foo.ts");
  } finally {
    cleanup();
  }
});

test("an absolute path outside cwd is refused", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    assert.deepEqual(await findFileMentions(cwd, "look at /etc/passwd please"), []);
  } finally {
    cleanup();
  }
});

test("missing paths, directories and prose are all refused", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    assert.deepEqual(await findFileMentions(cwd, "src/nope.ts is gone"), []);
    // A directory exists but isn't openable in the preview.
    assert.deepEqual(await findFileMentions(cwd, "everything under src/ really"), []);
    assert.deepEqual(await findFileMentions(cwd, "e.g. Node.js and version 1.2.3"), []);
  } finally {
    cleanup();
  }
});

test("a bare filename in the root resolves", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    const m = await findFileMentions(cwd, "documented in README.md");
    assert.deepEqual(m, [{ raw: "README.md", relPath: "README.md" }]);
  } finally {
    cleanup();
  }
});

test("trailing sentence punctuation is not part of the path", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    const m = await findFileMentions(cwd, "it lives in src/foo.ts. Also (src/foo.ts:9).");
    assert.deepEqual(m, [
      { raw: "src/foo.ts", relPath: "src/foo.ts" },
      { raw: "src/foo.ts:9", relPath: "src/foo.ts", line: 9 },
    ]);
  } finally {
    cleanup();
  }
});

test("a repeated mention is emitted once", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    const m = await findFileMentions(cwd, "src/foo.ts then src/foo.ts then src/foo.ts");
    assert.deepEqual(m, [{ raw: "src/foo.ts", relPath: "src/foo.ts" }]);
  } finally {
    cleanup();
  }
});

test("URLs do not yield candidates that could resolve", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    const m = await findFileMentions(cwd, "https://example.com/src/foo.ts is remote");
    assert.deepEqual(m, []);
  } finally {
    cleanup();
  }
});

test("extractCandidates requires a separator or a lettered extension", () => {
  const paths = extractCandidates("a/b Node.js 1.2.3 plain ./rel.ts /abs/x.ts").map((c) => c.path);
  assert.deepEqual(paths, ["a/b", "Node.js", "./rel.ts", "/abs/x.ts"]);
});

test("a bare #L fragment keeps the line, unlike the TUI's bare tokens", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    const m = await findFileMentions(cwd, "see src/foo.ts#L2 now");
    // raw spans the whole reference so nothing dangles outside the link.
    assert.deepEqual(m, [{ raw: "src/foo.ts#L2", relPath: "src/foo.ts", line: 2 }]);
  } finally {
    cleanup();
  }
});

test("a bare #L range keeps both ends", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    assert.deepEqual(await findFileMentions(cwd, "see src/foo.ts#L2-L3 now"), [
      { raw: "src/foo.ts#L2-L3", relPath: "src/foo.ts", line: 2, lineEnd: 3 },
    ]);
    assert.deepEqual(await findFileMentions(cwd, "lenient src/foo.ts#L2-3 too"), [
      { raw: "src/foo.ts#L2-3", relPath: "src/foo.ts", line: 2, lineEnd: 3 },
    ]);
  } finally {
    cleanup();
  }
});

test("a #L fragment on a path that isn't there yields nothing", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    assert.deepEqual(await findFileMentions(cwd, "src/nope.ts#L12 is gone"), []);
  } finally {
    cleanup();
  }
});

test("a non-#L fragment is not treated as a path reference", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    assert.deepEqual(await findFileMentions(cwd, "see README.md#installation"), []);
  } finally {
    cleanup();
  }
});

test("sentence punctuation after a #L fragment is trimmed", async () => {
  const { cwd, cleanup } = makeRoot();
  try {
    assert.deepEqual(await findFileMentions(cwd, "it is at src/foo.ts#L2."), [
      { raw: "src/foo.ts#L2", relPath: "src/foo.ts", line: 2 },
    ]);
  } finally {
    cleanup();
  }
});
