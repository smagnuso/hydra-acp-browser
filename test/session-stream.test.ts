import { test } from "node:test";
import assert from "node:assert/strict";
import {
  drainSseData,
  mergeSessionStreamFrame,
  runSessionStream,
} from "../src/core/session-stream.js";
import type { SessionListPage } from "../src/core/session-merge.js";
import type { SessionInfo } from "../src/core/types.js";

const row = (sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId,
  cwd: "/w",
  status: "warm",
  ...extra,
});

const sse = (body: unknown): string =>
  `event: sessions\ndata: ${JSON.stringify(body)}\n\n`;

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(c));
      }
      controller.close();
    },
  });
  return new Response(status === 200 ? body : null, { status });
}

test("drainSseData returns whole payloads and keeps a partial frame", () => {
  const out = drainSseData('event: sessions\ndata: {"a":1}\n\ndata: {"b"');
  assert.deepEqual(out.payloads, ['{"a":1}']);
  assert.equal(out.rest, 'data: {"b"');
});

test("drainSseData skips comment-only blocks", () => {
  assert.deepEqual(drainSseData(": ping\n\n").payloads, []);
});

test("a frame keeps the warm rows it does not mention", () => {
  const frame: SessionListPage = {
    sessions: [row("b", { busy: true })],
    removed: [],
    cursor: 2,
  };
  const merged = mergeSessionStreamFrame([row("a"), row("b")], frame);
  assert.deepEqual(merged.map((s) => s.sessionId).sort(), ["a", "b"]);
  assert.equal(merged.find((s) => s.sessionId === "b")?.busy, true);
});

test("a frame drops removed ids and upserts a cooled session as cold", () => {
  const merged = mergeSessionStreamFrame([row("a"), row("b")], {
    sessions: [row("a", { status: "cold" })],
    removed: ["b"],
    cursor: 3,
  });
  assert.deepEqual(merged, [row("a", { status: "cold" })]);
});

test("runSessionStream resumes from initialCursor and then from the last frame", async () => {
  const abort = new AbortController();
  const urls: string[] = [];
  let call = 0;
  const fetchImpl = async (url: string): Promise<Response> => {
    urls.push(url);
    call++;
    return streamResponse([
      sse({ sessions: [], removed: [], cursor: call === 1 ? 7 : 9 }),
    ]);
  };
  const disconnects: number[] = [];
  let seen = 0;
  await runSessionStream({
    signal: abort.signal,
    initialCursor: 5,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async () => undefined,
    onDisconnect: () => disconnects.push(1),
    onFrame: () => {
      seen++;
      if (seen === 2) {
        abort.abort();
      }
    },
  });
  assert.equal(urls[0], "/api/sessions/stream?since=5");
  assert.equal(urls[1], "/api/sessions/stream?since=7");
  assert.equal(disconnects.length, 1);
});

test("runSessionStream starts without a cursor when none is given", async () => {
  const abort = new AbortController();
  const urls: string[] = [];
  await runSessionStream({
    signal: abort.signal,
    fetchImpl: (async (url: string) => {
      urls.push(url);
      return streamResponse([sse({ sessions: [], removed: [], cursor: 1 })]);
    }) as unknown as typeof fetch,
    onFrame: () => abort.abort(),
  });
  assert.equal(urls[0], "/api/sessions/stream");
});

test("runSessionStream backs off after failures", async () => {
  const abort = new AbortController();
  const waits: number[] = [];
  let call = 0;
  await runSessionStream({
    signal: abort.signal,
    fetchImpl: (async () => {
      call++;
      if (call < 3) {
        throw new Error("down");
      }
      return streamResponse([sse({ sessions: [], removed: [], cursor: 1 })]);
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
    onFrame: () => abort.abort(),
  });
  assert.deepEqual(waits, [1000, 2000]);
});

test("runSessionStream reports an older daemon (404) as unsupported", async () => {
  let calls = 0;
  const outcome = await runSessionStream({
    signal: new AbortController().signal,
    fetchImpl: (async () => {
      calls++;
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch,
    sleep: async () => undefined,
    onFrame: () => undefined,
  });
  assert.equal(outcome, "unsupported");
  assert.equal(calls, 1);
});

test("runSessionStream ignores a malformed payload and keeps reading", async () => {
  const abort = new AbortController();
  const frames: SessionListPage[] = [];
  await runSessionStream({
    signal: abort.signal,
    fetchImpl: (async () =>
      streamResponse([
        "data: {not json\n\n",
        sse({ sessions: [row("a")], removed: [], cursor: 2 }),
      ])) as unknown as typeof fetch,
    onFrame: (f) => {
      frames.push(f);
      abort.abort();
    },
  });
  assert.equal(frames.length, 1);
});
