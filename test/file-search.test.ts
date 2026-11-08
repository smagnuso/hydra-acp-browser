import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fuzzyScore, listProjectFiles, rankFiles, searchFiles, withDirectories } from "../src/server/file-search.js";

const files = [
  "src/tui/file-completion.ts",
  "src/tui/file-search.ts",
  "src/tui/app.ts",
  "README.md",
  "docs/my notes.md",
];

test("fuzzyScore is null for a non-subsequence and case-insensitive otherwise", () => {
  assert.equal(fuzzyScore("zzz", "src/app.ts"), null);
  assert.notEqual(fuzzyScore("readme", "README.md"), null);
});

test("fuzzyScore prefers contiguous basename matches", () => {
  assert.ok((fuzzyScore("app", "src/tui/app.ts") as number) > (fuzzyScore("app", "src/a/p/p.ts") as number));
});

test("rankFiles ranks basename prefix hits first and honors the limit", () => {
  assert.equal(rankFiles("file-s", files)[0], "src/tui/file-search.ts");
  assert.equal(rankFiles("", files, 2).length, 2);
});

test("searchFiles ranks the injected listing", async () => {
  const got = await searchFiles("/nowhere-search-test", "readme", async () => files);
  assert.deepEqual(got, ["README.md"]);
});

test("listProjectFiles walks a non-git dir, skipping dotdirs and node_modules", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hb-search-")));
  try {
    mkdirSync(join(dir, "sub"));
    mkdirSync(join(dir, "node_modules"));
    mkdirSync(join(dir, ".hidden"));
    writeFileSync(join(dir, "a.txt"), "");
    writeFileSync(join(dir, "sub", "b.txt"), "");
    writeFileSync(join(dir, "node_modules", "c.txt"), "");
    writeFileSync(join(dir, ".hidden", "d.txt"), "");
    const got = (await listProjectFiles(dir)).sort();
    assert.deepEqual(got, ["a.txt", "sub/b.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("listProjectFiles lists a nested repo through git so its .gitignore applies", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hb-nested-")));
  try {
    const sub = join(dir, "pkg");
    mkdirSync(join(sub, "dist"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: sub, stdio: "ignore" });
    writeFileSync(join(sub, ".gitignore"), "dist/\n");
    writeFileSync(join(sub, "src.ts"), "");
    writeFileSync(join(sub, "dist", "out.js"), "");
    writeFileSync(join(dir, "top.txt"), "");
    const got = (await listProjectFiles(dir)).sort();
    assert.deepEqual(got, ["pkg/.gitignore", "pkg/src.ts", "top.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("withDirectories adds each ancestor directory once, with a trailing slash", () => {
  assert.deepEqual(withDirectories(["a/b/c.ts", "a/d.ts", "e.ts"]), [
    "a/b/c.ts",
    "a/d.ts",
    "e.ts",
    "a/",
    "a/b/",
  ]);
});

test("searchFiles finds a directory by its name", async () => {
  const got = await searchFiles("/nowhere-dir-test", "tui", async () => files);
  assert.equal(got[0], "src/tui/");
});

test("a backslash-typed query matches forward-slashed paths", () => {
  assert.equal(rankFiles("src\\tui\\app", files)[0], "src/tui/app.ts");
});
