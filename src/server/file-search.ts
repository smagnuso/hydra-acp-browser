// Fuzzy file search for the composer's "@" mentions. Mirrors the TUI's
// cli/src/tui/file-search.ts ranking (no shared package between the two).

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const MAX_FILES = 20000;
const MAX_RESULTS = 20;
const CACHE_TTL_MS = 5000;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const SEGMENT_START = "/._-";

// Subsequence match, null when `query` is not a subsequence of `file`.
// Contiguous runs, segment starts and basename hits score higher.
export function fuzzyScore(query: string, file: string): number | null {
  const q = query.toLowerCase();
  const s = file.toLowerCase();
  if (q.length === 0) {
    return -file.length;
  }
  const body = s.endsWith("/") ? s.slice(0, -1) : s;
  const baseStart = body.lastIndexOf("/") + 1;
  let pos = 0;
  let prev = -2;
  let score = 0;
  for (const ch of q) {
    const idx = s.indexOf(ch, pos);
    if (idx === -1) {
      return null;
    }
    score += 1;
    if (idx === prev + 1) {
      score += 3;
    }
    if (idx === 0 || SEGMENT_START.includes(s[idx - 1] ?? "")) {
      score += 2;
    }
    if (idx >= baseStart) {
      score += 2;
    }
    prev = idx;
    pos = idx + 1;
  }
  if (s.slice(baseStart).startsWith(q)) {
    score += 10;
  }
  return score - file.length * 0.05;
}

// Unique ancestor directories of `files`, each with a trailing "/".
export function withDirectories(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    let idx = file.indexOf("/");
    while (idx !== -1) {
      dirs.add(file.slice(0, idx + 1));
      idx = file.indexOf("/", idx + 1);
    }
  }
  return [...files, ...dirs];
}

export function rankFiles(
  query: string,
  files: string[],
  limit: number = MAX_RESULTS,
): string[] {
  // Results are always forward-slashed; accept a Windows-typed query.
  const q = query.replace(/\\/g, "/");
  const scored: { file: string; score: number }[] = [];
  for (const file of files) {
    const score = fuzzyScore(q, file);
    if (score !== null) {
      scored.push({ file, score });
    }
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.file.length - b.file.length ||
      a.file.localeCompare(b.file),
  );
  return scored.slice(0, limit).map((s) => s.file);
}

async function gitFiles(dir: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout.split("\0").filter((f) => f.length > 0);
  } catch {
    return null;
  }
}

export interface FileListing {
  files: string[];
  // True when the listing stopped at the size cap, so it may be missing files.
  truncated: boolean;
}

// Fallback for a cwd that is not itself a repo. A nested repo is listed
// through git so its .gitignore applies, and is not descended into.
async function walk(root: string, hidden: boolean): Promise<FileListing> {
  const out: string[] = [];
  const queue = [""];
  let truncated = false;
  while (queue.length > 0) {
    if (out.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    const rel = queue.shift() as string;
    let dirents;
    try {
      dirents = await fsp.readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    if (rel !== "" && dirents.some((d) => d.name === ".git")) {
      const nested = await gitFiles(join(root, rel));
      if (nested !== null) {
        for (const f of nested) {
          out.push(`${rel}/${f}`);
        }
        continue;
      }
    }
    for (const d of dirents) {
      if ((!hidden && d.name.startsWith(".")) || SKIP_DIRS.has(d.name)) {
        continue;
      }
      const child = rel === "" ? d.name : `${rel}/${d.name}`;
      if (d.isDirectory()) {
        queue.push(child);
      } else {
        out.push(child);
      }
    }
  }
  return { files: out, truncated };
}

// Tracked and untracked-but-not-ignored files via git, else a bounded walk.
// Paths are cwd-relative and always forward-slashed.
export async function listProjectFiles(cwd: string, hidden = false): Promise<FileListing> {
  const files = await gitFiles(cwd);
  if (files !== null) {
    return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
  }
  return walk(cwd, hidden);
}

// A query naming a dot-entry (".bashr", "src/.en") opts in to hidden files,
// which the directory walk otherwise skips.
export function wantsHidden(query: string): boolean {
  return /(^|\/)\./.test(query.replace(/\\/g, "/"));
}

// For a listing that was cut short: how much of the query is a directory
// path that exists under the cwd ("dnload/foo/ma" -> base "dnload/foo/",
// rest "ma"), so the search can list just that subtree instead.
export async function resolveScope(
  query: string,
  isDir: (rel: string) => Promise<boolean>,
): Promise<{ base: string; rest: string }> {
  const segs = query.split("/");
  const last = segs.pop() ?? "";
  let base = "";
  while (segs.length > 0) {
    const seg = segs[0]!;
    if (seg === "" || seg === "." || seg === "..") {
      break;
    }
    const next = `${base}${seg}/`;
    if (!(await isDir(next))) {
      break;
    }
    base = next;
    segs.shift();
  }
  return { base, rest: [...segs, last].join("/") };
}

// lstat, not stat: a symlinked directory must not lead the scope out of
// the session's cwd.
export async function isRealDirectory(abs: string): Promise<boolean> {
  try {
    return (await fsp.lstat(abs)).isDirectory();
  } catch {
    return false;
  }
}

const cache = new Map<string, { at: number; listing: FileListing }>();

async function cachedListing(
  cwd: string,
  hidden: boolean,
  list: (cwd: string, hidden: boolean) => Promise<FileListing>,
): Promise<FileListing> {
  const now = Date.now();
  const key = `${cwd}\0${hidden ? "h" : "v"}`;
  const hit = cache.get(key);
  if (hit !== undefined && now - hit.at < CACHE_TTL_MS) {
    return hit.listing;
  }
  const raw = await list(cwd, hidden);
  const listing = { files: withDirectories(raw.files), truncated: raw.truncated };
  cache.set(key, { at: now, listing });
  return listing;
}

export async function searchFiles(
  cwd: string,
  query: string,
  list: (cwd: string, hidden: boolean) => Promise<FileListing> = listProjectFiles,
  isDir: (abs: string) => Promise<boolean> = isRealDirectory,
): Promise<{ files: string[]; truncated: boolean }> {
  const hidden = wantsHidden(query);
  const full = await cachedListing(cwd, hidden, list);
  if (full.truncated) {
    // A cut-short listing can't see everywhere; search the typed directory.
    const q = query.replace(/\\/g, "/");
    const scope = await resolveScope(q, (rel) => isDir(join(cwd, rel)));
    if (scope.base !== "") {
      const sub = await cachedListing(join(cwd, scope.base), hidden, list);
      return {
        files: rankFiles(scope.rest, sub.files).map((f) => scope.base + f),
        truncated: sub.truncated,
      };
    }
  }
  return { files: rankFiles(query, full.files), truncated: full.truncated };
}
