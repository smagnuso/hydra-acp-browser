// File browser model: the per-chat overlay state (directory listing,
// windowed preview, remembered view) and the fetches that feed it. A UI
// renders `ChatState.fileOverlay` and calls these; view-only behavior
// (focus, scroll anchoring) goes through uiHooks.

import { api } from "./api.js";
import { uiHooks } from "./hooks.js";
import { state, notifyChange } from "./state.js";
import { editAnchor, type EditAnchor } from "./edit-diff.js";
import type { ChatState, FileEntry } from "./types.js";

// How far a paging pill moves. Smaller than the server's window so the
// new slice overlaps the old one and you don't lose your place.
export const WINDOW_PAGE_LINES = 400;

// Total lines allowed in the DOM at once. Extending past this trims the
// far end, so a long scroll through a 300k-line file costs a bounded
// number of gutter rows rather than all of them.
const MAX_RENDERED_LINES = 1500;

// Start a window a little above the line being aimed at, so the target
// has context above it rather than sitting on the top edge. Mirrors the
// server's own locate behaviour.
const WINDOW_LEAD_LINES = 200;

export function windowStartFor(line: number): number {
  return Math.max(1, line - WINDOW_LEAD_LINES);
}

export function relativeToCwd(cwd: string, path: string): string {
  if (!cwd || !path.startsWith("/")) return path;
  const base = cwd.endsWith("/") ? cwd : cwd + "/";
  return path.startsWith(base) ? path.slice(base.length) : path;
}

// Unmaximized is 80vw x 80vh inside a padded backdrop (index.html's
// .file-modal), which on a phone leaves about 300px of usable width to
// read code in. Width-based rather than pointer-based on purpose: what
// makes the windowed size unusable is the room available, so a narrow
// desktop window wants the same treatment a phone does. Only the
// starting state, an explicit toggle is remembered in savedFileView
// and takes precedence on reopen.
export function defaultMaximized(): boolean {
  return !uiHooks.isWideLayout();
}

export type ReadWindow = {
  content: string;
  fromLine?: number;
  hasMore?: boolean;
  matchedLine?: number;
};

export function isMarkdownPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ext === "md" || ext === "markdown";
}

// Mirrors routes-files.ts's IMAGE_MIME_BY_EXT (the server's word on what
// /api/files/image will actually serve), kept separate since the UI
// bundle can't import server route internals.
export function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext);
}

export function imageUrl(sessionId: string, path: string): string {
  return `/api/files/image?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`;
}

export function openFiles(): void {
  const c = state.current;
  if (!c) return;
  uiHooks.beforeFileOverlayOpen();
  const saved = c.savedFileView;
  c.fileOverlay = {
    path: "",
    entries: [],
    preview: null,
    err: null,
    maximized: saved?.maximized ?? defaultMaximized(),
    previewRaw: saved?.previewRaw ?? false,
  };
  notifyChange();
  uiHooks.afterFileOverlayOpen();
  if (saved?.previewPath) {
    // Fetch the directory listing and the remembered file's content
    // together and settle into a single render, rather than listFiles
    // then readFile in sequence, each renders on its own, and the
    // listing's and a file preview's very different shapes (a row list
    // vs. code/markdown) made that sequence visibly flicker/resize on
    // reopen.
    void restoreFileView(c, saved.dirPath, saved.previewPath, saved.previewRaw);
  } else {
    void listFiles(saved?.dirPath ?? "");
  }
}

// Opens the Files overlay straight into a full-size view of one image -
// what tapping a chat image bubble does, so "the agent looked at this"
// and "let me look at it too" land on the exact same view. No directory
// listing fetch: the image's path is routinely outside cwd (a /tmp
// scratch dir), where /api/files/list would 400, and there's nothing
// useful "back to listing" needs beyond closing the preview. path is
// omitted for a pasted/sent prompt image, there's no file on the
// daemon's host to name, only the data: URI already in url.
export function openImagePreviewAt(c: ChatState, url: string, path?: string): void {
  uiHooks.beforeFileOverlayOpen();
  const saved = c.savedFileView;
  c.fileOverlay = {
    path: "",
    entries: [],
    preview: { path, isImage: true, url },
    err: null,
    maximized: saved?.maximized ?? defaultMaximized(),
    previewRaw: false,
  };
  notifyChange();
  uiHooks.afterFileOverlayOpen();
}

export async function restoreFileView(
  c: ChatState,
  dirPath: string,
  previewPath: string,
  previewRaw: boolean,
  scrollToLine?: number,
  scrollToLineEnd?: number,
  // Set instead of an explicit line when the target has to be recovered
  // from the file's own content (an edit block whose tool call carried no
  // locations[0].line). Resolved here, once, against the content we were
  // already fetching to display, so it costs no extra read, and nothing
  // is computed for edits nobody clicks.
  locate?: EditAnchor,
): Promise<void> {
  const isImage = isImagePath(previewPath);
  const [listResult, readResult] = await Promise.allSettled([
    api<{ path: string; entries?: FileEntry[] }>("/api/files/list", {
      method: "POST",
      body: JSON.stringify({ sessionId: c.sessionId, path: dirPath }),
    }),
    // /api/files/read 415s on binary, so there's nothing worth asking for
    // an image path, the <img> tag fetches /api/files/image itself.
    isImage
      ? Promise.resolve({ content: "" } as ReadWindow)
      : api<ReadWindow>("/api/files/read", {
          method: "POST",
          body: JSON.stringify({
            sessionId: c.sessionId,
            path: previewPath,
            // Centre the window on whatever we're aiming at, so a link into
            // a large file lands on its lines rather than its first page.
            ...(locate ? { locate: locate.anchor } : {}),
            ...(locate || scrollToLine === undefined ? {} : { fromLine: windowStartFor(scrollToLine) }),
          }),
        }),
  ]);
  if (state.current !== c || !c.fileOverlay) return;
  const maximized = c.fileOverlay.maximized;
  let from = scrollToLine;
  let to = scrollToLineEnd;
  // The server resolves the anchor now and reports which line it hit,
  // because the client only holds a window of the file and can no longer
  // search it.
  if (!isImage && from === undefined && locate && readResult.status === "fulfilled") {
    const matched = readResult.value.matchedLine;
    if (typeof matched === "number") {
      from = matched;
      to = matched + locate.span - 1;
    }
  }
  const listErr = listResult.status === "rejected" ? (listResult.reason as Error).message : null;
  const readErr = !isImage && readResult.status === "rejected" ? (readResult.reason as Error).message : null;
  c.fileOverlay = {
    path: listResult.status === "fulfilled" ? listResult.value.path : dirPath,
    entries: listResult.status === "fulfilled" ? listResult.value.entries ?? [] : [],
    preview: isImage
      ? { path: previewPath, isImage: true, url: imageUrl(c.sessionId, previewPath) }
      : readResult.status === "fulfilled"
        ? {
            path: previewPath,
            content: readResult.value.content,
            fromLine: readResult.value.fromLine ?? 1,
            hasMore: readResult.value.hasMore ?? false,
          }
        : null,
    err: readErr ?? listErr,
    maximized,
    previewRaw,
    // highlightLine is set here rather than where the scroll is consumed
    // below: the gutter is built earlier in that same render pass, so
    // setting it there would only tint on some later, incidental render.
    ...(from === undefined ? {} : { scrollToLine: from, highlightLine: from }),
    ...(to === undefined ? {} : { highlightLineEnd: to }),
  };
  notifyChange();
}

// Entry point for a file-mention link in the transcript. Goes straight
// to the file rather than making the user walk the directory tree, and
// carries the target line through to renderFileOverlay.
export function openFileAtLine(
  c: ChatState,
  rawPath: string,
  line?: number,
  lineEnd?: number,
  locate?: EditAnchor,
): void {
  // An edit block's path is always absolute in practice. Inside the cwd
  // it's folded to a relative one, because the breadcrumb and
  // savedFileView elsewhere in the overlay are cwd-relative and an
  // absolute path eats the whole width of a phone.
  uiHooks.beforeFileOverlayOpen();
  const path = relativeToCwd(c.cwd, rawPath);
  const outsideCwd = path.startsWith("/");
  // A file outside the cwd is readable only because this session edited
  // it (the server's per-file allowlist); its *directory* is not
  // listable, and asking would fail the listing half of the fetch below
  // and surface an error over a preview that loaded fine. Root the
  // listing at the cwd instead, so "back to listing" still goes
  // somewhere sensible.
  const slash = path.lastIndexOf("/");
  const dirPath = outsideCwd || slash === -1 ? "" : path.slice(0, slash);
  // A markdown file renders as prose by default, and that view has no
  // line gutter at all, so a line request has to force source view or
  // it would silently fail to scroll.
  const previewRaw = (line !== undefined || locate !== undefined) && isMarkdownPath(path);
  c.fileOverlay = {
    path: dirPath,
    entries: [],
    preview: null,
    err: null,
    maximized: c.fileOverlay?.maximized ?? c.savedFileView?.maximized ?? defaultMaximized(),
    previewRaw,
  };
  notifyChange();
  uiHooks.afterFileOverlayOpen();
  void restoreFileView(c, dirPath, path, previewRaw, line, lineEnd, locate);

}

export function toggleMaximizeFiles(): void {
  const fo = state.current?.fileOverlay;
  if (!fo) return;
  fo.maximized = !fo.maximized;
  notifyChange();
}

// Anchor for an edit block's header link, looked up at click time so the
// diff text never has to ride along in the DOM.
export function editAnchorForToolCall(c: ChatState, toolCallId: string): EditAnchor | undefined {
  for (const entry of c.log) {
    if (entry.kind === "edit-diff" && entry.toolCallId === toolCallId) {
      return editAnchor(entry.diff) ?? undefined;
    }
  }
  return undefined;
}

export function togglePreviewRaw(): void {
  const fo = state.current?.fileOverlay;
  if (!fo) return;
  fo.previewRaw = !fo.previewRaw;
  notifyChange();
}

export async function listFiles(p: string): Promise<void> {
  if (!state.current) return;
  const maximized = state.current.fileOverlay?.maximized ?? false;
  try {
    const data = await api<{ path: string; entries?: FileEntry[] }>(
      "/api/files/list",
      {
        method: "POST",
        body: JSON.stringify({ sessionId: state.current.sessionId, path: p }),
      },
    );
    state.current.fileOverlay = {
      path: data.path,
      entries: data.entries ?? [],
      preview: null,
      err: null,
      maximized,
      previewRaw: false,
    };
    notifyChange();
  } catch (err) {
    state.current.fileOverlay = {
      path: p,
      entries: [],
      preview: null,
      err: (err as Error).message,
      maximized,
      previewRaw: false,
    };
    notifyChange();
  }
}

// Grows the on-screen window in one direction. Appending downward needs
// no correction, content below the reader doesn't move them, but
// prepending does, which is what keepLine is for.
let windowLoadInFlight = false;

export async function extendFileWindow(direction: "up" | "down"): Promise<void> {
  const c = state.current;
  const fo = c?.fileOverlay;
  const preview = fo?.preview;
  if (!c || !fo || !preview || !("content" in preview) || windowLoadInFlight) return;
  const lines = preview.content.split("\n");
  const firstLine = preview.fromLine;
  const lastLine = firstLine + lines.length - 1;
  if (direction === "up" && firstLine <= 1) return;
  if (direction === "down" && !preview.hasMore) return;

  const anchor = uiHooks.captureFileAnchor(firstLine);

  const fromLine =
    direction === "up" ? Math.max(1, firstLine - WINDOW_PAGE_LINES) : lastLine + 1;
  // Upward asks for exactly the gap, so the slices abut without overlap.
  const lineCount = direction === "up" ? firstLine - fromLine : WINDOW_PAGE_LINES;
  windowLoadInFlight = true;
  try {
    const data = await api<ReadWindow>("/api/files/read", {
      method: "POST",
      body: JSON.stringify({ sessionId: c.sessionId, path: preview.path, fromLine, lineCount }),
    });
    if (state.current !== c || c.fileOverlay !== fo || fo.preview !== preview) return;
    // "".split("\n") is [""], not [], so an empty slice would append a
    // phantom numbered line. Reachable when the file shrank between the
    // two reads: hasMore was true when sampled, and the follow-up
    // request now lands past the new EOF.
    if (data.content.length === 0) {
      fo.preview = { ...preview, hasMore: false };
      notifyChange();
      return;
    }
    const added = data.content.split("\n");
    let merged = direction === "up" ? [...added, ...lines] : [...lines, ...added];
    let newFrom = direction === "up" ? (data.fromLine ?? fromLine) : firstLine;
    // Trimming the bottom puts lines back beyond the window, so it has
    // to re-arm hasMore. Getting this wrong stranded the tail of the
    // file: scroll up from the end, the bottom is trimmed, hasMore
    // stays false from when we really were at EOF, and scrolling back
    // down does nothing forever. The two directions are asymmetric
    // because "more above" is derived from fromLine and so is always
    // right, while "more below" is a carried flag a trim invalidates.
    let trimmedBottom = false;
    if (merged.length > MAX_RENDERED_LINES) {
      // Trim the end the reader is moving away from.
      if (direction === "down") {
        const drop = merged.length - MAX_RENDERED_LINES;
        merged = merged.slice(drop);
        newFrom += drop;
      } else {
        merged = merged.slice(0, MAX_RENDERED_LINES);
        trimmedBottom = true;
      }
    }
    fo.preview = {
      path: preview.path,
      content: merged.join("\n"),
      fromLine: newFrom,
      hasMore:
        direction === "down"
          ? (data.hasMore ?? false)
          : preview.hasMore || trimmedBottom,
    };
    fo.err = null;
    // Only meaningful if the anchor survived the trim; otherwise the
    // reader was nowhere near the part that moved.
    if (anchor && anchor.line >= newFrom && anchor.line < newFrom + merged.length) {
      fo.keepLine = anchor;
    }
  } catch (err) {
    if (state.current !== c || c.fileOverlay !== fo) return;
    fo.err = (err as Error).message;
  } finally {
    windowLoadInFlight = false;
  }
  notifyChange();
}

export async function readFile(p: string): Promise<void> {
  if (!state.current) return;
  if (isImagePath(p)) {
    // /api/files/read 415s on binary, so there's nothing to await here -
    // the <img> tag fetches /api/files/image itself, same as a chat image
    // bubble.
    const fo = state.current.fileOverlay!;
    state.current.fileOverlay = {
      ...fo,
      preview: { path: p, isImage: true, url: imageUrl(state.current.sessionId, p) },
      err: null,
    };
    notifyChange();
    return;
  }
  try {
    const data = await api<ReadWindow>("/api/files/read", {
      method: "POST",
      body: JSON.stringify({ sessionId: state.current.sessionId, path: p }),
    });
    const fo = state.current.fileOverlay!;
    state.current.fileOverlay = {
      path: fo.path,
      entries: fo.entries,
      preview: {
        path: p,
        content: data.content,
        fromLine: data.fromLine ?? 1,
        hasMore: data.hasMore ?? false,
      },
      err: null,
      maximized: fo.maximized,
      previewRaw: false,
    };
    notifyChange();
  } catch (err) {
    if (state.current.fileOverlay) {
      state.current.fileOverlay = {
        ...state.current.fileOverlay,
        err: (err as Error).message,
      };
    }
    notifyChange();
  }
}

export function closeFiles(): void {
  const c = state.current;
  if (!c) return;
  const fo = c.fileOverlay;
  if (fo) {
    c.savedFileView = {
      dirPath: fo.path,
      previewPath: fo.preview?.path ?? null,
      previewRaw: fo.previewRaw,
      maximized: fo.maximized,
    };
  }
  c.fileOverlay = null;
  uiHooks.fileOverlayClosing();
  notifyChange();
}

export function navigateFile(entry: FileEntry): void {
  if (!state.current?.fileOverlay) return;
  const fo = state.current.fileOverlay;
  const childPath = fo.path ? `${fo.path}/${entry.name}` : entry.name;
  if (entry.kind === "dir") {
    void listFiles(childPath);
  } else if (entry.kind === "file") {
    void readFile(childPath);
  }
}

export function closeFilePreview(): void {
  if (!state.current?.fileOverlay) return;
  state.current.fileOverlay.preview = null;
  notifyChange();
}

