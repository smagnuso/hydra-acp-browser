// Changes pane model: what the session edited, either as the daemon's
// whole-session reconstruction or as the edits of one turn read straight
// off the chat log. A UI renders `ChatState.diffPane`; opening a file
// goes through the Files viewer (files.ts).

import { api } from "./api.js";
import { editAnchor } from "./edit-diff.js";
import { closeFiles, openFileAtLine } from "./files.js";
import { state, notifyChange } from "./state.js";
import type { ChatState, EditDiff, EditDiffLogItem } from "./types.js";

export interface DiffHunk {
  oldText: string;
  newText: string;
}

export interface FileDiff {
  path: string;
  created: boolean;
  // Uncommitted scope only: gone from disk, or listed without hunks.
  deleted?: boolean;
  omitted?: "binary" | "large";
  hunks: DiffHunk[];
}

export interface TurnDiff {
  // 0-based position among the turns that edited something.
  index: number;
  prompt: string;
  files: FileDiff[];
}

export type DiffScope = "session" | "turn" | "uncommitted";

export interface DiffPaneState {
  scope: DiffScope;
  // Which entry of turnDiffs() the turn scope shows; null follows the latest.
  turn: number | null;
  files: FileDiff[] | null;
  // The uncommitted scope's data: git's view of the working tree under cwd.
  uncommitted: FileDiff[] | null;
  notRepo: boolean;
  truncated: boolean;
  loading: boolean;
  err: string | null;
  // Paths whose hunks are showing; files start collapsed so a big diff is
  // a cheap list on a phone.
  expanded: string[];
  // Where the list was scrolled to; a view restores it when the pane's
  // node is re-attached (back from the file viewer, a rebuild).
  scrollTop: number;
}

// Tool calls that never changed anything on disk.
const FAILED = new Set(["failed", "rejected", "denied", "cancelled"]);

function addEdit(files: Map<string, FileDiff>, item: EditDiffLogItem): void {
  const diff: EditDiff = item.diff;
  if (!diff.path || FAILED.has(item.status ?? "")) return;
  let file = files.get(diff.path);
  if (!file) {
    file = { path: diff.path, created: diff.oldText === "", hunks: [] };
    files.set(diff.path, file);
  }
  // The log item's own object, so views can share per-diff caches with the chat.
  file.hunks.push(diff);
}

// A turn starts at each user prompt, so a steer sent mid-turn splits that
// turn's edits across two entries. Only history the client holds is seen.
export function turnDiffs(c: ChatState): TurnDiff[] {
  const turns: TurnDiff[] = [];
  let prompt = "";
  let files = new Map<string, FileDiff>();
  const flush = (): void => {
    if (files.size > 0) {
      turns.push({ index: turns.length, prompt, files: [...files.values()] });
    }
    files = new Map();
  };
  for (const item of c.log) {
    if (item.kind === "stream" && item.role === "user") {
      flush();
      prompt = item.text;
    } else if (item.kind === "edit-diff") {
      addEdit(files, item);
    }
  }
  flush();
  return turns;
}

export function activeTurnIndex(pane: DiffPaneState, turns: TurnDiff[]): number {
  if (turns.length === 0) {
    return -1;
  }
  const want = pane.turn ?? turns.length - 1;
  return Math.min(Math.max(want, 0), turns.length - 1);
}

export function visibleDiffFiles(c: ChatState): FileDiff[] {
  const pane = c.diffPane;
  if (!pane) {
    return [];
  }
  if (pane.scope === "session") {
    return pane.files ?? [];
  }
  if (pane.scope === "uncommitted") {
    return pane.uncommitted ?? [];
  }
  const turns = turnDiffs(c);
  const i = activeTurnIndex(pane, turns);
  return i < 0 ? [] : turns[i]!.files;
}

let inFlight: Promise<void> | null = null;
let dirty = false;
let lastFetchAt = 0;
let editsAtFetch = -1;
let trailing: ReturnType<typeof setTimeout> | null = null;

// The daemon walks the whole history to build this, so turn-end refreshes
// are spaced out (same cadence as ahp's session changeset).
const MIN_REFETCH_MS = 10_000;

function sameFile(a: FileDiff, b: FileDiff): boolean {
  return (
    a.path === b.path &&
    a.created === b.created &&
    a.hunks.length === b.hunks.length &&
    a.hunks.every((h, i) => h.oldText === b.hunks[i]!.oldText && h.newText === b.hunks[i]!.newText)
  );
}

// Unchanged files keep their object identity, so views' per-diff caches and
// the pane's node cache survive a refetch.
function reuseFiles(prev: FileDiff[] | null, next: FileDiff[]): FileDiff[] {
  if (!prev) {
    return next;
  }
  const merged = next.map((f) => prev.find((p) => sameFile(p, f)) ?? f);
  return merged.length === prev.length && merged.every((f, i) => f === prev[i]) ? prev : merged;
}

function editCount(c: ChatState): number {
  return c.log.filter((i) => i.kind === "edit-diff").length;
}

export async function refreshDiff(): Promise<void> {
  const c = state.current;
  if (!c?.diffPane) {
    return;
  }
  if (inFlight) {
    dirty = true;
    return inFlight;
  }
  const scope = c.diffPane.scope;
  if (scope === "turn") {
    return;
  }
  c.diffPane.loading = true;
  lastFetchAt = Date.now();
  editsAtFetch = editCount(c);
  notifyChange();
  const base = `/api/sessions/${encodeURIComponent(c.sessionId)}`;
  inFlight = (async () => {
    try {
      if (scope === "session") {
        const files = await api<FileDiff[]>(`${base}/diff?fold=true`);
        if (state.current === c && c.diffPane) {
          c.diffPane.files = reuseFiles(c.diffPane.files, files);
          c.diffPane.err = null;
        }
      } else {
        const res = await api<{ repo: boolean; files: FileDiff[]; truncated?: boolean }>(`${base}/uncommitted`);
        if (state.current === c && c.diffPane) {
          c.diffPane.uncommitted = reuseFiles(c.diffPane.uncommitted, res.files);
          c.diffPane.notRepo = !res.repo;
          c.diffPane.truncated = res.truncated === true;
          c.diffPane.err = null;
        }
      }
    } catch (err) {
      if (state.current === c && c.diffPane) {
        c.diffPane.err = (err as Error).message;
      }
    } finally {
      if (state.current === c && c.diffPane) {
        c.diffPane.loading = false;
      }
      inFlight = null;
      notifyChange();
    }
    if (dirty) {
      dirty = false;
      void refreshDiff();
    }
  })();
  return inFlight;
}

// Called at turn end. The session scope refetches only if an edit tool ran
// since the last fetch; the uncommitted scope always does, since shell edits
// leave no trace in the log. No more often than MIN_REFETCH_MS (the last
// call in a burst is deferred, not dropped).
export function refreshDiffIfOpen(): void {
  const c = state.current;
  const scope = c?.diffPane?.scope;
  if (!c || (scope !== "uncommitted" && (scope !== "session" || editCount(c) === editsAtFetch))) {
    return;
  }
  const wait = lastFetchAt + MIN_REFETCH_MS - Date.now();
  if (wait <= 0) {
    void refreshDiff();
  } else if (trailing === null) {
    trailing = setTimeout(() => {
      trailing = null;
      refreshDiffIfOpen();
    }, wait);
  }
}

export function openDiff(): void {
  const c = state.current;
  if (!c) {
    return;
  }
  // Reopening shows the last-seen diff at once and revalidates behind it.
  c.diffPane = c.diffPane ?? c.savedDiffPane ?? { scope: "session", turn: null, files: null, uncommitted: null, notRepo: false, truncated: false, loading: false, err: null, expanded: [], scrollTop: 0 };
  notifyChange();
  void refreshDiff();
}

export function closeDiff(): void {
  const c = state.current;
  if (!c?.diffPane) {
    return;
  }
  c.savedDiffPane = { ...c.diffPane, loading: false };
  c.diffPane = null;
  notifyChange();
}

export function setDiffScroll(top: number): void {
  if (state.current?.diffPane) {
    state.current.diffPane.scrollTop = top;
  }
}

export function toggleDiffFile(path: string): void {
  const pane = state.current?.diffPane;
  if (!pane) {
    return;
  }
  pane.expanded = pane.expanded.includes(path)
    ? pane.expanded.filter((p) => p !== path)
    : [...pane.expanded, path];
  notifyChange();
}

export function setDiffScope(scope: DiffScope): void {
  const pane = state.current?.diffPane;
  if (!pane || pane.scope === scope) {
    return;
  }
  pane.scope = scope;
  pane.scrollTop = 0;
  notifyChange();
  void refreshDiff();
}

export function stepDiffTurn(delta: number): void {
  const c = state.current;
  const pane = c?.diffPane;
  if (!c || !pane) {
    return;
  }
  const turns = turnDiffs(c);
  const i = activeTurnIndex(pane, turns) + delta;
  if (i < 0 || i >= turns.length) {
    return;
  }
  pane.turn = i === turns.length - 1 ? null : i;
  notifyChange();
}

// Opens the file viewer on top of the diff, at the file's first change.
export function openDiffFile(file: FileDiff): void {
  const c = state.current;
  if (!c) {
    return;
  }
  const first = file.hunks[0];
  const locate = first && !file.deleted ? editAnchor({ path: file.path, ...first }) : null;
  openFileAtLine(c, file.path, undefined, undefined, locate ?? undefined);
}

export function hasOpenPane(c: ChatState | null): boolean {
  return c !== null && (c.fileOverlay !== null || c.diffPane !== null);
}

// Back: pops the topmost pane (the file viewer, then the diff), leaving
// the chat when none remain.
export function closeTopPane(): void {
  const c = state.current;
  if (!c) {
    return;
  }
  if (c.fileOverlay) {
    closeFiles();
  } else if (c.diffPane) {
    closeDiff();
  }
}
