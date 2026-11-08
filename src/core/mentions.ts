// Composer "@" file mentions. Typing "@fo" before the caret opens a picker
// of fuzzy-matched files under the session's cwd (server-ranked); picking
// one inserts "@path" and remembers it, and at send time each remembered
// mention still present in the text goes out as an ACP resource_link
// block alongside the text. Mirrors the TUI's Tab completion.

import { api } from "./api.js";
import { queueDraftWrite } from "./composer-draft.js";
import { notifyChange } from "./state.js";
import type { ChatState } from "./types.js";

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

export function mentionBlocks(
  c: Pick<ChatState, "mentions" | "cwd">,
  text: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [token, file] of c.mentions) {
    if (present(text, token)) {
      out.push({ type: "resource_link", uri: fileUri(c.cwd, file), name: file });
    }
  }
  return out;
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
    closeMentionPicker(c);
    return;
  }
  const prev = c.mentionPicker;
  c.mentionPicker = {
    start: m.start,
    end: m.end,
    query: m.query,
    files: prev !== null && prev.query === m.query ? prev.files : [],
    selected: prev !== null && prev.query === m.query ? prev.selected : 0,
  };
  notifyChange();
  const seq = ++searchSeq;
  void api<{ files?: string[] }>("/api/files/search", {
    method: "POST",
    body: JSON.stringify({ sessionId: c.sessionId, query: m.query }),
  })
    .then((res) => {
      const cur = c.mentionPicker;
      if (seq !== searchSeq || cur === null || cur.query !== m.query) {
        return;
      }
      cur.files = res.files ?? [];
      cur.selected = 0;
      notifyChange();
    })
    .catch(() => {
      if (seq === searchSeq) {
        closeMentionPicker(c);
      }
    });
}

export function moveMentionSelection(c: ChatState, delta: number): void {
  const p = c.mentionPicker;
  if (p === null || p.files.length === 0) {
    return;
  }
  p.selected = (p.selected + delta + p.files.length) % p.files.length;
  notifyChange();
}

// Insert the chosen file in place of the typed "@query". Returns the new
// caret for the view to apply, or null when there is nothing to pick.
export function pickMention(c: ChatState, index?: number): number | null {
  const p = c.mentionPicker;
  if (p === null) {
    return null;
  }
  const file = p.files[index ?? p.selected];
  if (file === undefined) {
    return null;
  }
  const token = mentionToken(file);
  const isDir = file.endsWith("/");
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
  c.mentions.set(token, file);
  c.mentionPicker = null;
  notifyChange();
  return caret;
}
