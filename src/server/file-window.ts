import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// Default lines per request. Generous enough that most reads are one
// round trip, bounded enough that the client isn't asked to build a
// gutter row per line of a 300k-line file.
export const DEFAULT_WINDOW_LINES = 1200;
export const MAX_WINDOW_LINES = 4000;
// Context kept either side of an anchor match, so the reader lands in
// the middle of the change rather than at the top of it.
const LOCATE_CONTEXT_LINES = 200;

export interface FileWindow {
  // 1-based line of the first line in `content`.
  fromLine: number;
  content: string;
  // Whether lines exist beyond the end of this window. Deliberately not
  // a total line count: knowing the total means scanning the whole file,
  // which is exactly the cost windowing exists to avoid. "Is there
  // more" is all the paging affordances need.
  hasMore: boolean;
  // Set when the request asked to locate an anchor and it was found.
  matchedLine?: number;
}

export interface WindowRequest {
  fromLine?: number;
  lineCount?: number;
  // Full-line text to find, as the edit-diff anchor does. When given,
  // the window is centred on the first line equal to it and fromLine is
  // ignored. Searching here rather than in the client is the whole
  // point: the client no longer has the file to search.
  locate?: string;
}

// Reads one window of a text file without holding the whole thing in
// memory: lines stream past and only those inside the window are kept.
// A locate request still walks from the top — unavoidable, since the
// anchor's position is what's being asked — but it stops at the match
// and never buffers more than the window either way.
export async function readFileWindow(
  path: string,
  req: WindowRequest = {},
): Promise<FileWindow> {
  const lineCount = Math.min(
    Math.max(1, Math.floor(req.lineCount ?? DEFAULT_WINDOW_LINES)),
    MAX_WINDOW_LINES,
  );
  if (req.locate !== undefined && req.locate.length > 0) {
    return readAroundAnchor(path, req.locate, lineCount);
  }
  const fromLine = Math.max(1, Math.floor(req.fromLine ?? 1));
  return readRange(path, fromLine, lineCount);
}

async function readRange(
  path: string,
  fromLine: number,
  lineCount: number,
): Promise<FileWindow> {
  const until = fromLine + lineCount - 1;
  const kept: string[] = [];
  let lineNo = 0;
  let hasMore = false;
  const rl = lines(path);
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (lineNo < fromLine) continue;
      if (lineNo > until) {
        // One line past the window is all it takes to know there's more,
        // so stop here rather than reading to EOF.
        hasMore = true;
        break;
      }
      kept.push(line);
    }
  } finally {
    rl.close();
  }
  return { fromLine, content: kept.join("\n"), hasMore };
}

async function readAroundAnchor(
  path: string,
  anchor: string,
  lineCount: number,
): Promise<FileWindow> {
  const before = Math.min(LOCATE_CONTEXT_LINES, Math.floor(lineCount / 2));
  // Ring buffer of the trailing `before` lines, so the window can start
  // above the match without a second pass over the file.
  const lead: string[] = [];
  let lineNo = 0;
  let matchedLine: number | null = null;
  const kept: string[] = [];
  let hasMore = false;
  const rl = lines(path);
  try {
    for await (const line of rl) {
      lineNo += 1;
      if (matchedLine === null) {
        if (line === anchor) {
          matchedLine = lineNo;
          kept.push(...lead, line);
          continue;
        }
        lead.push(line);
        if (lead.length > before) lead.shift();
        continue;
      }
      if (kept.length >= lineCount) {
        hasMore = true;
        break;
      }
      kept.push(line);
    }
  } finally {
    rl.close();
  }
  if (matchedLine === null) {
    // Anchor isn't in the file (edited since, or whitespace drift).
    // Fall back to the top rather than failing: the reader still gets
    // the file, just not the jump.
    return readRange(path, 1, lineCount);
  }
  const fromLine = Math.max(1, matchedLine - Math.min(before, lead.length));
  return { fromLine, content: kept.join("\n"), hasMore, matchedLine };
}

function lines(path: string): ReturnType<typeof createInterface> {
  // crlfDelay so a CRLF file doesn't yield a stray empty line between
  // every pair, which would throw the gutter's numbering out.
  return createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
}
