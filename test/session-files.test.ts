import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _reset, isEditedPath, recordEditedPath } from "../src/server/session-files.js";
import { extractEditedPaths } from "../src/server/file-mentions.js";

function makeRoot(): { root: string; cleanup: () => void } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hydra-acp-sf-")));
  mkdirSync(join(root, "proj"), { recursive: true });
  writeFileSync(join(root, "outside.md"), "hi");
  writeFileSync(join(root, "secret"), "nope");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("only a recorded path is allowed", async () => {
  _reset();
  const { root, cleanup } = makeRoot();
  try {
    recordEditedPath("s1", join(root, "outside.md"));
    assert.equal(await isEditedPath("s1", join(root, "outside.md")), true);
    assert.equal(await isEditedPath("s1", join(root, "secret")), false);
  } finally {
    cleanup();
  }
});

test("a traversal that normalizes elsewhere is refused", async () => {
  // The whole reason the comparison resolves both sides: a string
  // compare would accept this, and it lands on a file never edited.
  _reset();
  const { root, cleanup } = makeRoot();
  try {
    recordEditedPath("s1", join(root, "outside.md"));
    assert.equal(await isEditedPath("s1", `${join(root, "outside.md")}/../secret`), false);
    assert.equal(await isEditedPath("s1", join(root, "proj", "..", "secret")), false);
    // The same file reached by a messier route is still the same file.
    assert.equal(await isEditedPath("s1", join(root, "proj", "..", "outside.md")), true);
  } finally {
    cleanup();
  }
});

test("the allowlist is per session", async () => {
  _reset();
  const { root, cleanup } = makeRoot();
  try {
    recordEditedPath("s1", join(root, "outside.md"));
    assert.equal(await isEditedPath("s2", join(root, "outside.md")), false);
  } finally {
    cleanup();
  }
});

test("an unknown session allows nothing", async () => {
  _reset();
  assert.equal(await isEditedPath("nobody", "/etc/passwd"), false);
});

test("relative paths are never recorded", async () => {
  _reset();
  recordEditedPath("s1", "src/foo.ts");
  assert.equal(await isEditedPath("s1", "src/foo.ts"), false);
});

test("a diff block's path is extracted", () => {
  assert.deepEqual(
    extractEditedPaths({
      sessionUpdate: "tool_call",
      content: [{ type: "diff", path: "/abs/a.ts", oldText: "x", newText: "y" }],
    }),
    ["/abs/a.ts"],
  );
});

test("a write tool's rawInput path is extracted", () => {
  assert.deepEqual(
    extractEditedPaths({ rawInput: { file_path: "/abs/b.ts", old_string: "x", new_string: "y" } }),
    ["/abs/b.ts"],
  );
  assert.deepEqual(extractEditedPaths({ rawInput: { path: "/abs/c.ts", content: "whole" } }), [
    "/abs/c.ts",
  ]);
});

test("a read-only tool naming a path grants nothing", () => {
  // Read/Grep/Glob name paths constantly; treating those as edits would
  // make most of the disk readable through the allowlist.
  assert.deepEqual(extractEditedPaths({ rawInput: { file_path: "/abs/secret" } }), []);
  assert.deepEqual(
    extractEditedPaths({ rawInput: { path: "/abs/secret", pattern: "foo" } }),
    [],
  );
});
