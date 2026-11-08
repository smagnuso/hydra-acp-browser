import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitDiff, uncommittedChanges } from "../src/server/git-changes.js";

const sh = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" });
};

function repo(): { dir: string; cleanup: () => void } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hb-git-")));
  sh(dir, "init", "-q");
  sh(dir, "config", "user.email", "t@example.com");
  sh(dir, "config", "user.name", "t");
  sh(dir, "config", "commit.gpgsign", "false");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) };
}

test("parseGitDiff builds old and new text per hunk and flags new files", () => {
  const patch = [
    "diff --git a/a.ts b/a.ts",
    "index 1..2 100644",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,3 @@",
    " keep",
    "-old",
    "+new",
    " tail",
    "@@ -10,1 +10,2 @@",
    " ctx",
    "+extra",
    "diff --git a/n.ts b/n.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/n.ts",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/img.png b/img.png",
    "Binary files a/img.png and b/img.png differ",
    "",
  ].join("\n");
  const files = parseGitDiff(patch, "/r");
  assert.deepEqual(files.map((f) => f.path), [join("/r", "a.ts"), join("/r", "n.ts"), join("/r", "img.png")]);
  assert.deepEqual(files[0]!.hunks, [
    { oldText: "keep\nold\ntail\n", newText: "keep\nnew\ntail\n" },
    { oldText: "ctx\n", newText: "ctx\nextra\n" },
  ]);
  assert.equal(files[1]!.created, true);
  assert.deepEqual(files[1]!.hunks, [{ oldText: "", newText: "hello\n" }]);
  assert.equal(files[2]!.omitted, "binary");
});

test("uncommittedChanges sees tracked, staged and untracked edits under cwd only", async () => {
  const { dir, cleanup } = repo();
  try {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "sub/b.txt"), "b\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "init");
    writeFileSync(join(dir, "a.txt"), "one\nTWO\n");
    writeFileSync(join(dir, "sub/b.txt"), "b\nmore\n");
    writeFileSync(join(dir, "sub/new.txt"), "fresh\n");

    const all = await uncommittedChanges(dir);
    assert.equal(all.repo, true);
    assert.deepEqual(all.files.map((f) => f.path).sort(), [join(dir, "a.txt"), join(dir, "sub/b.txt"), join(dir, "sub/new.txt")]);

    const scoped = await uncommittedChanges(join(dir, "sub"));
    assert.deepEqual(scoped.files.map((f) => f.path).sort(), [join(dir, "sub/b.txt"), join(dir, "sub/new.txt")]);
    const fresh = scoped.files.find((f) => f.path.endsWith("new.txt"))!;
    assert.equal(fresh.created, true);
    assert.deepEqual(fresh.hunks, [{ oldText: "", newText: "fresh\n" }]);
  } finally {
    cleanup();
  }
});

test("uncommittedChanges reports a non-repository", async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "hb-nogit-")));
  try {
    assert.deepEqual(await uncommittedChanges(dir), { repo: false, files: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The server joins with the host's path module, so on Windows every file
// path is backslashed; win32.join reproduces that string on any host.
test("Windows git-changes paths display as project-relative names through the front-end helpers", async () => {
  const { win32 } = await import("node:path");
  const { relativeToCwd } = await import("../src/core/files.js");
  const { splitDiffPath } = await import("../src/core/diff.js");
  const serverPath = (root: string, rel: string): string => win32.join(root, rel);
  for (const [cwd, root] of [
    ["C:\\proj", "C:\\proj"],
    ["C:/proj", "C:\\proj"],
    ["c:\\Proj\\", "C:\\proj"],
  ] as const) {
    const nested = serverPath(root, "src/ui/a.ts");
    assert.equal(nested, "C:\\proj\\src\\ui\\a.ts");
    assert.equal(relativeToCwd(cwd, nested), "src\\ui\\a.ts");
    assert.deepEqual(splitDiffPath(cwd, nested), { name: "a.ts", dir: "src\\ui\\" });
    assert.deepEqual(splitDiffPath(cwd, serverPath(root, "top.ts")), { name: "top.ts", dir: "" });
  }
  assert.deepEqual(splitDiffPath("C:\\proj", "C:\\other\\x.ts"), { name: "x.ts", dir: "C:\\other\\" });
});
