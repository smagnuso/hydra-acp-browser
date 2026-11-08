// Composer "@" file mentions. Typing "@fo" before the caret opens a picker
// of fuzzy-matched files under the session's cwd (server-ranked); picking
// one inserts "@path" and remembers it, and at send time each remembered
// mention still present in the text goes out as an ACP resource_link
// block alongside the text. Mirrors the TUI's Tab completion.

import { api } from "./api.js";
import { queueDraftWrite } from "./composer-draft.js";
import { displayCwd, matchesSessionSearch, shortSessionId } from "./session-list.js";
import { notifyChange, state } from "./state.js";
import type {
  ChatState,
  MentionItem,
  MentionTarget,
  SessionInfo,
  SessionMentionItem,
} from "./types.js";

const MAX_SESSION_ROWS = 5;
// With sessions in the list, the first few files stay on top and the
// sessions follow, so they are on screen rather than below the fold.
const FILE_ROWS_WITH_SESSIONS = 15;
const FILES_BEFORE_SESSIONS = 2;
const SLUG_MAX = 24;
const MIN_SLUG_WORD = 8;
const SHORT_ID_LEN = 4;

export interface ActiveMention {
  start: number;
  end: number;
  query: string;
}

// The "@token" ending at the caret, when the "@" starts the text or follows
// whitespace and the token has no unescaped whitespace.
export function activeMention(text: string, caret: number): ActiveMention | null {
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1] ?? "";
    if (/\s/.test(ch)) {
      if (ch === " " && text[i - 2] === "\\") {
        i -= 2;
        continue;
      }
      return null;
    }
    if (ch === "@") {
      const before = text[i - 2];
      if (before !== undefined && !/\s/.test(before)) {
        return null;
      }
      return { start: i - 1, end: caret, query: text.slice(i, caret).replace(/\\ /g, " ") };
    }
    i -= 1;
  }
  return null;
}

export function mentionToken(file: string): string {
  return `@${file.replace(/ /g, "\\ ")}`;
}

function present(text: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const idx = text.indexOf(token, from);
    if (idx === -1) {
      return false;
    }
    const next = text[idx + token.length];
    if (next === undefined || /\s/.test(next)) {
      return true;
    }
    from = idx + 1;
  }
}

// file:// URI for a cwd-relative path. The cwd may be Windows-shaped
// whatever host this runs on, so separators are normalized by hand and a
// UNC cwd (\\server\share) keeps its host in the authority.
export function fileUri(cwd: string, file: string): string {
  const full = `${cwd.replace(/\\/g, "/").replace(/\/+$/, "")}/${file}`;
  if (full.startsWith("//")) {
    const [host, ...rest] = full.slice(2).split("/");
    return `file://${host}/${rest.map(encodeURIComponent).join("/")}`;
  }
  const encoded = full
    .split("/")
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
}

export function slugify(title: string): string {
  const full = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= SLUG_MAX) {
    return full;
  }
  // Cut at a word boundary when there is one worth keeping.
  const head = full.slice(0, SLUG_MAX + 1);
  const boundary = head.lastIndexOf("-");
  const cut = boundary >= MIN_SLUG_WORD ? head.slice(0, boundary) : full.slice(0, SLUG_MAX);
  return cut.replace(/-+$/g, "");
}

// The short id is always in the token: a mention is recorded by its token
// text, and two sessions can share a title.
export function sessionMentionToken(id: string, title: string): string {
  const slug = slugify(title);
  return `@${slug.length > 0 ? slug : "session"}-${shortSessionId(id).slice(0, SHORT_ID_LEN)}`;
}

export function sessionUri(id: string): string {
  return `hydra://sessions/${encodeURIComponent(id)}`;
}

// Sessions matching an "@query", newest first. Federated sessions and the
// chat's own session are left out, and a path-shaped query is a file search.
export function sessionMentionItems(
  query: string,
  sessions: readonly SessionInfo[],
  opts: { excludeId?: string; limit?: number } = {},
): SessionMentionItem[] {
  if (query.includes("/") || query.includes("\\") || query.startsWith(".")) {
    return [];
  }
  // Titles have spaces where the typed token has hyphens; try both forms.
  const term = query.replace(/[-_]+/g, " ").trim();
  const recency = (s: SessionInfo): number => {
    const t = s.updatedAt === undefined ? NaN : Date.parse(s.updatedAt);
    return Number.isNaN(t) ? 0 : t;
  };
  const q = query.toLowerCase();
  const t = term.toLowerCase();
  // A title hit beats a hit on the cwd, id or agent, which are far looser.
  const inTitle = (s: SessionInfo): boolean => {
    const title = (s.title ?? "").toLowerCase();
    return title.includes(q) || title.includes(t);
  };
  return sessions
    .filter(
      (s) =>
        s.remote === undefined &&
        s.sessionId !== opts.excludeId &&
        (matchesSessionSearch(s, query) || matchesSessionSearch(s, term)),
    )
    .sort((a, b) => Number(inTitle(b)) - Number(inTitle(a)) || recency(b) - recency(a))
    .slice(0, opts.limit ?? MAX_SESSION_ROWS)
    .map((s) => ({
      kind: "session" as const,
      id: s.sessionId,
      title: s.title?.trim() ?? "",
      cwd: displayCwd(s),
    }));
}

// The rows to show: a couple of files, then the sessions, then more files.
export function mentionItems(
  p: Pick<NonNullable<ChatState["mentionPicker"]>, "files" | "sessions">,
): MentionItem[] {
  const files = p.sessions.length > 0 ? p.files.slice(0, FILE_ROWS_WITH_SESSIONS) : p.files;
  const rows = files.map((path) => ({ kind: "file" as const, path }));
  return [
    ...rows.slice(0, FILES_BEFORE_SESSIONS),
    ...p.sessions,
    ...rows.slice(FILES_BEFORE_SESSIONS),
  ];
}

export function mentionBlocks(
  c: Pick<ChatState, "mentions" | "cwd">,
  text: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [token, target] of c.mentions) {
    if (!present(text, token)) {
      continue;
    }
    if (target.kind === "file") {
      out.push({ type: "resource_link", uri: fileUri(c.cwd, target.path), name: target.path });
    } else {
      out.push({
        type: "resource_link",
        uri: sessionUri(target.id),
        name: target.title.length > 0 ? target.title : target.id,
        description: `Hydra session ${target.id}; read it with: hydra session transcript ${target.id}`,
        mimeType: "text/markdown",
      });
    }
  }
  return out;
}

// Close the picker and keep it closed for this "@" until it is retyped or
// backspaced down to a bare "@".
export function dismissMentionPicker(c: ChatState): void {
  if (c.mentionPicker !== null) {
    c.mentionDismissed = { start: c.mentionPicker.start };
  }
  closeMentionPicker(c);
}

export function closeMentionPicker(c: ChatState): void {
  if (c.mentionPicker !== null) {
    c.mentionPicker = null;
    notifyChange();
  }
}

let searchSeq = 0;

// Re-evaluate the picker for the current text and caret. Safe to call on
// every keystroke: stale search replies are dropped.
export function updateMentionPicker(c: ChatState, text: string, caret: number): void {
  const m = activeMention(text, caret);
  if (m === null) {
    c.mentionDismissed = null;
    closeMentionPicker(c);
    return;
  }
  if (c.mentionDismissed !== null) {
    // Still the dismissed "@": stay closed, unless the token has been
    // backspaced down to a bare "@", which is a fresh start.
    if (c.mentionDismissed.start === m.start && m.query !== "") {
      closeMentionPicker(c);
      return;
    }
    c.mentionDismissed = null;
  }
  const prev = c.mentionPicker;
  const same = prev !== null && prev.query === m.query;
  c.mentionPicker = {
    start: m.start,
    end: m.end,
    query: m.query,
    files: same ? prev.files : [],
    sessions: sessionMentionItems(m.query, state.sessions, { excludeId: c.sessionId }),
    selected: same ? prev.selected : 0,
    truncated: same ? prev.truncated : false,
  };
  notifyChange();
  const seq = ++searchSeq;
  void api<{ files?: string[]; truncated?: boolean }>("/api/files/search", {
    method: "POST",
    body: JSON.stringify({ sessionId: c.sessionId, query: m.query }),
  })
    .then((res) => {
      const cur = c.mentionPicker;
      if (seq !== searchSeq || cur === null || cur.query !== m.query) {
        return;
      }
      cur.files = res.files ?? [];
      cur.truncated = res.truncated === true;
      cur.selected = 0;
      notifyChange();
    })
    .catch(() => {
      if (seq !== searchSeq) {
        return;
      }
      // Files can be unavailable (a federated chat) while sessions still work.
      const cur = c.mentionPicker;
      if (cur !== null && cur.sessions.length > 0) {
        cur.files = [];
        notifyChange();
        return;
      }
      closeMentionPicker(c);
    });
}

export function moveMentionSelection(c: ChatState, delta: number): void {
  const p = c.mentionPicker;
  if (p === null) {
    return;
  }
  const count = mentionItems(p).length;
  if (count === 0) {
    return;
  }
  p.selected = (p.selected + delta + count) % count;
  notifyChange();
}

// Insert the chosen row in place of the typed "@query". Returns the new
// caret for the view to apply, or null when there is nothing to pick.
export function pickMention(c: ChatState, index?: number): number | null {
  const p = c.mentionPicker;
  if (p === null) {
    return null;
  }
  const item = mentionItems(p)[index ?? p.selected];
  if (item === undefined) {
    return null;
  }
  const isSession = item.kind === "session";
  const isDir = item.kind === "file" && item.path.endsWith("/");
  const token = isSession ? sessionMentionToken(item.id, item.title) : mentionToken(item.path);
  const text = c.composerValue;
  const tail = text.slice(p.end);
  const gap = !isDir && (tail.length === 0 || !/^\s/.test(tail)) ? " " : "";
  c.composerValue = `${text.slice(0, p.start)}${token}${gap}${tail}`;
  const caret = p.start + token.length + gap.length;
  queueDraftWrite(c.sessionId, c.composerValue);
  if (isDir) {
    // Directories are text only; keep the picker open to drill in.
    c.mentionPicker = null;
    updateMentionPicker(c, c.composerValue, caret);
    return caret;
  }
  c.mentions.set(
    token,
    item.kind === "session"
      ? { kind: "session", id: item.id, title: item.title }
      : { kind: "file", path: item.path },
  );
  c.mentionPicker = null;
  c.mentionDismissed = null;
  notifyChange();
  return caret;
}
