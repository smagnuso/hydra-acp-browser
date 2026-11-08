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

// Fallback for a cwd that is not itself a repo. A nested repo is listed
// through git so its .gitignore applies, and is not descended into.
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [""];
  while (queue.length > 0 && out.length < MAX_FILES) {
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
      if (d.name.startsWith(".") || SKIP_DIRS.has(d.name)) {
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
  return out;
}

// Tracked and untracked-but-not-ignored files via git, else a bounded walk.
// Paths are cwd-relative and always forward-slashed.
export async function listProjectFiles(cwd: string): Promise<string[]> {
  const files = await gitFiles(cwd);
  return files !== null ? files.slice(0, MAX_FILES) : walk(cwd);
}

const cache = new Map<string, { at: number; files: string[] }>();

export async function searchFiles(
  cwd: string,
  query: string,
  list: (cwd: string) => Promise<string[]> = listProjectFiles,
): Promise<string[]> {
  const now = Date.now();
  let hit = cache.get(cwd);
  if (hit === undefined || now - hit.at >= CACHE_TTL_MS) {
    hit = { at: now, files: withDirectories(await list(cwd)) };
    cache.set(cwd, hit);
  }
  return rankFiles(query, hit.files);
}
