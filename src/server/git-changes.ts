import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_BUFFER = 64 * 1024 * 1024;
// Past this much text a file is listed without hunks.
const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 300;

export interface ChangedHunk {
  oldText: string;
  newText: string;
}

export interface ChangedFile {
  // Absolute, so it reads like the paths in the session diff.
  path: string;
  created: boolean;
  deleted?: boolean;
  hunks: ChangedHunk[];
  // Binary, or too large to ship: listed, no hunks.
  omitted?: "binary" | "large";
}

export interface UncommittedChanges {
  repo: boolean;
  files: ChangedFile[];
  // More changed files than MAX_FILES.
  truncated?: boolean;
}

// Optional locks off so polling never holds index.lock against the
// user's own git commands.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotepath=off", ...args],
      { cwd, env: GIT_ENV, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function isRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

async function hasHead(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function hunkText(lines: string[]): string {
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

// Splits `git diff` output into files, one {oldText,newText} per hunk
// (old = context + removed lines, new = context + added lines).
export function parseGitDiff(patch: string, root: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let file: ChangedFile | null = null;
  let inHunk = false;
  let oldLines: string[] = [];
  let newLines: string[] = [];
  let bytes = 0;
  const flushHunk = (): void => {
    if (file && inHunk && (oldLines.length > 0 || newLines.length > 0)) {
      file.hunks.push({ oldText: hunkText(oldLines), newText: hunkText(newLines) });
    }
    oldLines = [];
    newLines = [];
  };
  const flushFile = (): void => {
    flushHunk();
    if (file && bytes > MAX_FILE_BYTES) {
      file.hunks = [];
      file.omitted = "large";
    }
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      const at = line.lastIndexOf(" b/");
      file = { path: join(root, at >= 0 ? line.slice(at + 3) : ""), created: false, hunks: [] };
      files.push(file);
      inHunk = false;
      bytes = 0;
      continue;
    }
    if (!file) {
      continue;
    }
    if (line.startsWith("@@")) {
      flushHunk();
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("new file mode")) {
        file.created = true;
      } else if (line.startsWith("deleted file mode")) {
        file.deleted = true;
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        file.omitted = "binary";
      }
      continue;
    }
    if (line.startsWith("\\")) {
      continue;
    }
    const text = line.slice(1);
    bytes += text.length + 1;
    if (line.startsWith("-")) {
      oldLines.push(text);
    } else if (line.startsWith("+")) {
      newLines.push(text);
    } else if (line.startsWith(" ")) {
      oldLines.push(text);
      newLines.push(text);
    }
  }
  flushFile();
  return files;
}

async function readUntracked(root: string, rel: string): Promise<ChangedFile> {
  const path = join(root, rel);
  const file: ChangedFile = { path, created: true, hunks: [] };
  try {
    const size = (await stat(path)).size;
    if (size > MAX_FILE_BYTES) {
      file.omitted = "large";
      return file;
    }
    const handle = await open(path, "r");
    try {
      const buf = Buffer.alloc(size);
      await handle.read(buf, 0, size, 0);
      if (buf.includes(0)) {
        file.omitted = "binary";
      } else if (size > 0) {
        const text = buf.toString("utf8");
        file.hunks = [{ oldText: "", newText: text.endsWith("\n") ? text : text + "\n" }];
      }
    } finally {
      await handle.close();
    }
  } catch {
    // Vanished or unreadable between ls-files and the read: list it bare.
  }
  return file;
}

// What differs from HEAD under `cwd` (staged or not, untracked included);
// scoped to cwd so no file outside the session's root is named.
export async function uncommittedChanges(cwd: string): Promise<UncommittedChanges> {
  if (!(await isRepo(cwd))) {
    return { repo: false, files: [] };
  }
  const head = await hasHead(cwd);
  const patch = await git(cwd, [
    "diff",
    ...(head ? ["HEAD"] : ["--cached"]),
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "--relative",
    "-U3",
    "--",
    ".",
  ]);
  const files = parseGitDiff(patch, cwd);
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter((p) => p !== "");
  const room = Math.max(0, MAX_FILES - files.length);
  for (const rel of untracked.slice(0, room)) {
    files.push(await readUntracked(cwd, rel));
  }
  const truncated = files.length >= MAX_FILES && untracked.length > room;
  return { repo: true, files: files.slice(0, MAX_FILES), ...(truncated ? { truncated } : {}) };
}
