import { stat, realpath } from "node:fs/promises";
import { relative } from "node:path";
import { resolveScopedPath } from "./routes-files.js";

export interface FileMention {
  raw: string;
  relPath: string;
  line?: number;
  lineEnd?: number;
}

interface Candidate {
  raw: string;
  path: string;
  line?: number;
  lineEnd?: number;
}

// Path-ish runs of text. Deliberately loose: the stat check below is the
// real filter, so a prose match like "e.g." costs one syscall and is
// then dropped. ":" is only admitted as a trailing ":line[:col]" so a
// URL splits into pieces that can never resolve inside the cwd.
const TOKEN_RE = /[A-Za-z0-9_@./+#-]{2,}(?::\d+){0,2}/g;
const LINE_SUFFIX_RE = /^(.+?)(?::(\d+))(?::\d+)?$/;
// GitHub-style fragment, the form the file-links skill tells agents to
// emit and the TUI already parses (cli's screen.ts:5096). Matching is
// identical to the TUI's; we additionally capture the range end.
const LINE_FRAGMENT_RE = /^(.*?)#L(\d+)(?:-L?(\d+))?$/;
// Trailing punctuation nearly always belongs to the sentence, not the
// path — same reasoning (and same shape) as linkifyPlain's URL trim.
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"]+$/;
const MAX_CANDIDATE_LENGTH = 512;

// Either a path separator or a dot-extension starting with a letter. The
// letter requirement is what keeps version strings ("1.2.3") and bare
// decimals out, while still admitting a lone "README.md".
function qualifies(path: string): boolean {
  if (path.length === 0 || path.length > MAX_CANDIDATE_LENGTH) return false;
  if (/^[./]+$/.test(path)) return false;
  if (path.includes("/")) return true;
  return /\.[A-Za-z][A-Za-z0-9]*$/.test(path);
}

export function extractCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const token = m[0].replace(TRAILING_PUNCT_RE, "");
    const candidate = parseCandidate(token);
    if (candidate) out.push(candidate);
  }
  return out;
}

function parseCandidate(token: string): Candidate | null {
  const frag = LINE_FRAGMENT_RE.exec(token);
  if (frag) {
    const path = frag[1]!;
    if (!qualifies(path)) return null;
    const end = frag[3];
    return {
      raw: token,
      path,
      line: Number(frag[2]),
      ...(end === undefined ? {} : { lineEnd: Number(end) }),
    };
  }
  // A "#" that isn't a #L fragment means this isn't a path reference.
  if (token.includes("#")) return null;
  const suffix = LINE_SUFFIX_RE.exec(token);
  const path = suffix ? suffix[1]! : token;
  if (!qualifies(path)) return null;
  return suffix
    ? { raw: token, path, line: Number(suffix[2]) }
    : { raw: token, path };
}

// Paths this tool call edited, read the same way the client's
// extractEditDiff reads them: a content[] diff block, or the tool's raw
// input. Feeds session-files.ts's allowlist, so it is deliberately
// conservative — a Read or Grep that merely names a path must not make
// that path readable, hence the isWrite check below.
export function extractEditedPaths(update: unknown): string[] {
  if (!update || typeof update !== "object") return [];
  const u = update as Record<string, unknown>;
  const out: string[] = [];
  const content = u.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "diff" && typeof b.path === "string" && b.path) out.push(b.path);
    }
  }
  const rawInput = u.rawInput;
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const r = rawInput as Record<string, unknown>;
    const isWrite =
      typeof r.old_string === "string" ||
      typeof r.oldString === "string" ||
      typeof r.content === "string";
    if (isWrite) {
      for (const key of ["file_path", "filePath", "path"]) {
        const v = r[key];
        if (typeof v === "string" && v) out.push(v);
      }
    }
  }
  return out;
}

// Best-effort flatten of an ACP content blob, mirroring the client's
// contentToText. Duplicated rather than imported so the server bundle
// doesn't pull in the UI's markdown module.
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentToText).join("");
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
    if (typeof c.content === "string") return c.content;
  }
  return "";
}

// Candidates that resolve to a real file inside the session's cwd. Both
// relative and absolute mentions go through resolveScopedPath, which
// treats an absolute input as itself and joins a relative one against
// cwd, then rejects anything that escapes the tree — so an absolute path
// pointing elsewhere on the daemon's host is never linkable.
export async function findFileMentions(cwd: string, text: string): Promise<FileMention[]> {
  const candidates = extractCandidates(text);
  if (candidates.length === 0) return [];
  let cwdReal: string;
  try {
    cwdReal = await realpath(cwd);
  } catch {
    return [];
  }
  const mentions: FileMention[] = [];
  const emitted = new Set<string>();
  // Scoped to this scan only: one file mentioned twenty times costs one
  // stat, and nothing survives the call, so a file created or deleted
  // mid-session is re-checked on the next turn.
  const resolved = new Map<string, string | null>();
  for (const c of candidates) {
    if (emitted.has(c.raw)) continue;
    emitted.add(c.raw);
    let relPath = resolved.get(c.path);
    if (relPath === undefined) {
      relPath = await resolveToRelative(cwd, cwdReal, c.path);
      resolved.set(c.path, relPath);
    }
    if (relPath === null) continue;
    mentions.push({
      raw: c.raw,
      relPath,
      ...(c.line === undefined ? {} : { line: c.line }),
      ...(c.lineEnd === undefined ? {} : { lineEnd: c.lineEnd }),
    });
  }
  return mentions;
}

async function resolveToRelative(
  cwd: string,
  cwdReal: string,
  path: string,
): Promise<string | null> {
  try {
    const real = await resolveScopedPath(cwd, path);
    const s = await stat(real);
    if (!s.isFile()) return null;
    const rel = relative(cwdReal, real);
    if (!rel || rel.startsWith("..")) return null;
    return rel;
  } catch {
    // PathScopeError (escapes cwd), ENOENT, EACCES — all just mean "not
    // linkable", and the caller never needs to tell them apart.
    return null;
  }
}
