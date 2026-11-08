import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isAbsolutePath,
  lastSeparator,
  pathBelow,
  splitSegments,
  tailSegments,
} from "../src/core/path-text.js";

test("isAbsolutePath accepts POSIX, drive and UNC forms", () => {
  assert.equal(isAbsolutePath("/x"), true);
  assert.equal(isAbsolutePath("C:\\x"), true);
  assert.equal(isAbsolutePath("c:/x"), true);
  assert.equal(isAbsolutePath("C:/x\\y"), true);
  assert.equal(isAbsolutePath("\\\\server\\share\\a"), true);
});

test("isAbsolutePath rejects relative paths and a bare drive", () => {
  assert.equal(isAbsolutePath("src/a.ts"), false);
  assert.equal(isAbsolutePath("src\\a.ts"), false);
  assert.equal(isAbsolutePath("C:"), false);
  assert.equal(isAbsolutePath("C:a.ts"), false);
  assert.equal(isAbsolutePath(""), false);
});

test("lastSeparator finds either separator", () => {
  assert.equal(lastSeparator("a/b/c"), 3);
  assert.equal(lastSeparator("a\\b\\c"), 3);
  assert.equal(lastSeparator("C:/x\\y.ts"), 4);
  assert.equal(lastSeparator("c.ts"), -1);
});

test("splitSegments splits on both separators", () => {
  assert.deepEqual(splitSegments("/a/b"), ["", "a", "b"]);
  assert.deepEqual(splitSegments("C:\\a/b"), ["C:", "a", "b"]);
});

test("tailSegments keeps the last non-empty segments", () => {
  assert.equal(tailSegments("/home/u/proj/", 2), "u/proj");
  assert.equal(tailSegments("C:\\Users\\u\\proj", 2), "u/proj");
  assert.equal(tailSegments("C:/Users/u\\proj\\", 2), "u/proj");
  assert.equal(tailSegments("/", 2), "");
});

test("pathBelow on POSIX is a plain, case-sensitive prefix match", () => {
  assert.equal(pathBelow("/w/proj", "/w/proj/src/a.ts"), "src/a.ts");
  assert.equal(pathBelow("/w/proj/", "/w/proj/a.ts"), "a.ts");
  assert.equal(pathBelow("/", "/a.ts"), "a.ts");
  assert.equal(pathBelow("/w/proj", "/w/PROJ/a.ts"), null);
  assert.equal(pathBelow("/w/proj", "/w/proj2/a.ts"), null);
  assert.equal(pathBelow("/w/proj", "/tmp/x"), null);
});

test("pathBelow on Windows keeps the path's separators", () => {
  assert.equal(pathBelow("C:\\proj", "C:\\proj\\src\\a.ts"), "src\\a.ts");
  assert.equal(pathBelow("C:/proj", "C:/proj/src/a.ts"), "src/a.ts");
  assert.equal(pathBelow("C:/proj", "C:\\proj\\a.ts"), "a.ts");
  assert.equal(pathBelow("C:/x", "C:/x\\y\\a.ts"), "y\\a.ts");
});

test("pathBelow on Windows ignores drive and path case and a trailing separator", () => {
  assert.equal(pathBelow("C:/Proj/", "c:\\proj\\a.ts"), "a.ts");
  assert.equal(pathBelow("C:\\proj\\", "C:\\proj\\a.ts"), "a.ts");
  assert.equal(pathBelow("C:\\", "C:\\a.ts"), "a.ts");
  assert.equal(pathBelow("\\\\srv\\share", "\\\\srv\\share\\d\\a.ts"), "d\\a.ts");
});

test("pathBelow on Windows rejects siblings sharing a name prefix and other drives", () => {
  assert.equal(pathBelow("C:\\proj", "C:\\proj2\\a.ts"), null);
  assert.equal(pathBelow("C:\\proj", "C:\\proj"), null);
  assert.equal(pathBelow("C:\\proj", "D:\\proj\\a.ts"), null);
});
