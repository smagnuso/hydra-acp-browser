import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fuzzyScore,
  isRealDirectory,
  listProjectFiles,
  rankFiles,
  resolveScope,
  searchFiles,
  wantsHidden,
  withDirectories,
  type FileListing,
} from "../src/server/file-search.js";

const ok = (list: string[]): FileListing => ({ files: list, truncated: false });

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
  const got = await searchFiles("/nowhere-search-test", "readme", async () => ok(files));
  assert.deepEqual(got.files, ["README.md"]);
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
    const got = (await listProjectFiles(dir)).files.sort();
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
    const got = (await listProjectFiles(dir)).files.sort();
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
  const got = await searchFiles("/nowhere-dir-test", "tui", async () => ok(files));
  assert.equal(got.files[0], "src/tui/");
});

test("a backslash-typed query matches forward-slashed paths", () => {
  assert.equal(rankFiles("src\\tui\\app", files)[0], "src/tui/app.ts");
});

test("wantsHidden is true only when a segment starts with a dot", () => {
  assert.equal(wantsHidden(".bashr"), true);
  assert.equal(wantsHidden("src/.en"), true);
  assert.equal(wantsHidden("bash.rc"), false);
});

test("searchFiles lists hidden files only for a dot query, and caches the two apart", async () => {
  const seen: boolean[] = [];
  const list = async (_cwd: string, hidden: boolean): Promise<FileListing> => {
    seen.push(hidden);
    return ok(hidden ? [".bashrc", "a.txt"] : ["a.txt"]);
  };
  assert.deepEqual((await searchFiles("/nowhere-hidden-test", ".bashr", list)).files, [".bashrc"]);
  assert.deepEqual((await searchFiles("/nowhere-hidden-test", "a.t", list)).files, ["a.txt"]);
  assert.deepEqual(seen, [true, false]);
});

test("the walk includes dotfiles when asked, but never .git or node_modules", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hb-hidden-")));
  try {
    mkdirSync(join(dir, ".config"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".bashrc"), "");
    writeFileSync(join(dir, ".config", "x"), "");
    writeFileSync(join(dir, ".git", "HEAD"), "");
    writeFileSync(join(dir, "a.txt"), "");
    assert.deepEqual((await listProjectFiles(dir)).files.sort(), ["a.txt"]);
    assert.deepEqual((await listProjectFiles(dir, true)).files.sort(), [".bashrc", ".config/x", "a.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("resolveScope takes the longest existing directory prefix and refuses ..", async () => {
  const has = async (rel: string): Promise<boolean> => rel === "dnload/" || rel === "dnload/foo/";
  assert.deepEqual(await resolveScope("dnload/foo/main", has), { base: "dnload/foo/", rest: "main" });
  assert.deepEqual(await resolveScope("dnload/fo/main", has), { base: "dnload/", rest: "fo/main" });
  assert.deepEqual(await resolveScope("main", has), { base: "", rest: "main" });
  assert.deepEqual(await resolveScope("../dnload/x", has), { base: "", rest: "../dnload/x" });
});

test("a truncated listing is searched under the typed directory", async () => {
  const calls: string[] = [];
  const list = async (cwd: string): Promise<FileListing> => {
    calls.push(cwd);
    return cwd.replace(/\\/g, "/").replace(/\/+$/, "").endsWith("dnload/foo")
      ? ok(["main.cpp", "util.cpp"])
      : { files: ["a.txt"], truncated: true };
  };
  const isDir = async (abs: string): Promise<boolean> => {
    const p = abs.replace(/\\/g, "/").replace(/\/+$/, "");
    return p.endsWith("/dnload") || p.endsWith("/dnload/foo");
  };
  const got = await searchFiles("/nowhere-scope-test", "dnload/foo/main", list, isDir);
  assert.deepEqual(got, { files: ["dnload/foo/main.cpp"], truncated: false });
  const plain = await searchFiles("/nowhere-scope-test", "a.t", list, isDir);
  assert.deepEqual(plain, { files: ["a.txt"], truncated: true });
});

test("a complete listing is never narrowed to a directory", async () => {
  const list = async (): Promise<FileListing> => ok(["dnload/foo/main.cpp", "x/dnload/foo/main.cpp"]);
  const got = await searchFiles("/nowhere-complete-test", "dnload/foo/main", list, async () => true);
  assert.equal(got.files.length, 2);
  assert.equal(got.truncated, false);
});

test("isRealDirectory is false for a symlinked directory so scope cannot escape the cwd", async (t) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hb-scope-")));
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "hb-outside-")));
  try {
    mkdirSync(join(dir, "real"));
    try {
      symlinkSync(outside, join(dir, "link"), "dir");
    } catch {
      t.skip("symlinks not permitted here");
      return;
    }
    assert.equal(await isRealDirectory(join(dir, "real")), true);
    assert.equal(await isRealDirectory(join(dir, "link")), false);
    assert.equal(await isRealDirectory(join(dir, "missing")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
