// Pure client for the daemon's session list stream, relayed by the host
// server at /api/sessions/stream. No DOM, so it is testable under node:test.
// See PROTOCOL.md's GET /v1/sessions/stream.
import type { SessionInfo } from "./types.js";
import type { SessionListPage } from "./session-merge.js";

// A frame is a delta: only changed rows, plus ids that left. Unlike
// mergeSessionListPage's incremental mode this must not purge the warm rows
// it does not mention, since those are unchanged.
export function mergeSessionStreamFrame(
  current: SessionInfo[],
  frame: SessionListPage,
): SessionInfo[] {
  const merged = new Map(current.map((s) => [s.sessionId, s]));
  for (const id of frame.removed) {
    merged.delete(id);
  }
  for (const s of frame.sessions) {
    merged.set(s.sessionId, s);
  }
  return [...merged.values()];
}

// Pulls SSE `data:` payloads out of a growing text buffer; what is left may
// be the front of a frame still arriving.
export function drainSseData(buffer: string): {
  payloads: string[];
  rest: string;
} {
  const payloads: string[] = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf("\n\n");
    if (end === -1) {
      return { payloads, rest };
    }
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.length > 0) {
      payloads.push(data);
    }
  }
}

function toPage(raw: unknown): SessionListPage {
  const body = raw as {
    sessions?: SessionInfo[];
    removed?: string[];
    cursor?: number;
  };
  return {
    sessions: Array.isArray(body.sessions) ? body.sessions : [],
    removed: Array.isArray(body.removed) ? body.removed : [],
    cursor: typeof body.cursor === "number" ? body.cursor : 0,
  };
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000];

export interface SessionStreamOptions {
  signal: AbortSignal;
  // Cursor of a list already in hand. Without it the first frame is the
  // whole list, which would duplicate what the caller just fetched.
  initialCursor?: number;
  onFrame: (frame: SessionListPage) => void;
  // Called when the connection drops, before the reconnect wait, so the
  // caller can go back to polling for the gap.
  onDisconnect?: () => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    // Under node (tests, tooling) a pending reconnect wait must not hold
    // the process open; browsers return a number, which has no unref.
    (timer as { unref?: () => void }).unref?.();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

// Holds the stream open, resuming from the last cursor after a drop.
// Resolves "unsupported" when the daemon has no such route, so the caller
// keeps polling, and "aborted" once the signal fires. Never rejects.
export async function runSessionStream(
  opts: SessionStreamOptions,
): Promise<"unsupported" | "aborted"> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? sleepUnlessAborted;
  let cursor: number | undefined = opts.initialCursor;
  let failures = 0;
  while (!opts.signal.aborted) {
    try {
      const path =
        cursor === undefined
          ? "/api/sessions/stream"
          : `/api/sessions/stream?since=${cursor}`;
      const response = await fetchImpl(path, {
        credentials: "same-origin",
        headers: { Accept: "text/event-stream" },
        signal: opts.signal,
      });
      if (response.status === 404 || response.status === 405) {
        return "unsupported";
      }
      if (!response.ok || !response.body) {
        throw new Error(`stream returned ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        const drained = drainSseData(buffer);
        buffer = drained.rest;
        for (const payload of drained.payloads) {
          let frame: SessionListPage;
          try {
            frame = toPage(JSON.parse(payload));
          } catch {
            continue;
          }
          cursor = frame.cursor;
          failures = 0;
          opts.onFrame(frame);
        }
      }
    } catch {
      // Fall through to the reconnect wait; an abort is caught by the loop.
    }
    if (opts.signal.aborted) {
      break;
    }
    opts.onDisconnect?.();
    const wait = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!;
    failures++;
    await sleep(wait, opts.signal);
  }
  return "aborted";
}
