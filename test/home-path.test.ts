import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { expandTilde } from "../src/util/home-path.js";
import { expandHome } from "../src/util/paths.js";
import { expandHome as expandSessionCwd } from "../src/server/routes-sessions.js";

const posixHome = "/home/u";
const winHome = "C:\\Users\\u";

test("expandTilde: bare ~ is the home dir", () => {
  assert.equal(expandTilde("~", posixHome), posixHome);
  assert.equal(expandTilde("~", winHome), winHome);
});

test("expandTilde: ~/ prefix expands", () => {
  assert.equal(expandTilde("~/proj", posixHome), "/home/u/proj");
  assert.equal(expandTilde("~/proj", winHome), "C:\\Users\\u/proj");
});

test("expandTilde: ~\\ prefix expands", () => {
  assert.equal(expandTilde("~\\proj", winHome), "C:\\Users\\u\\proj");
  assert.equal(expandTilde("~\\a\\b", posixHome), "/home/u\\a\\b");
});

test("expandTilde: ~name and other inputs stay as-is", () => {
  assert.equal(expandTilde("~foo", posixHome), "~foo");
  assert.equal(expandTilde("~foo/bar", posixHome), "~foo/bar");
  assert.equal(expandTilde("/abs/~/x", posixHome), "/abs/~/x");
  assert.equal(expandTilde("C:\\x", winHome), "C:\\x");
  assert.equal(expandTilde("rel/path", posixHome), "rel/path");
});

test("paths.expandHome: handles ~, ~/ and ~\\ and leaves ~foo", () => {
  const home = homedir();
  assert.equal(expandHome("~"), home);
  assert.ok(expandHome("~/proj").startsWith(home));
  assert.notEqual(expandHome("~/proj"), "~/proj");
  assert.ok(expandHome("~\\proj").startsWith(home));
  assert.notEqual(expandHome("~\\proj"), "~\\proj");
  assert.equal(expandHome("~foo"), "~foo");
});

test("routes-sessions expandHome: handles ~, ~/ and ~\\ and leaves ~foo", () => {
  const home = homedir();
  assert.equal(expandSessionCwd("~"), home);
  assert.equal(expandSessionCwd("~/proj"), home + "/proj");
  assert.equal(expandSessionCwd("~\\proj"), home + "\\proj");
  assert.equal(expandSessionCwd("~foo"), "~foo");
});
