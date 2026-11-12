import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { registerSessionRoutes } from "../src/server/routes-sessions.js";
import type { ServerContext } from "../src/server/http.js";

let daemon: Server;
let app: FastifyInstance;
let baseUrl: string;
const seen: IncomingMessage[] = [];
let upstreamClosed = 0;
let mode: "stream" | "missing" = "stream";

const frame = (body: unknown): string =>
  `event: sessions\ndata: ${JSON.stringify(body)}\n\n`;

before(async () => {
  daemon = createServer((req, res) => {
    seen.push(req);
    if (mode === "missing") {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame({ sessions: [{ sessionId: "a", cwd: "/w" }], removed: [], cursor: 4 }));
    res.on("close", () => {
      upstreamClosed++;
    });
  });
  await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
  const port = (daemon.address() as AddressInfo).port;
  const ctx = {
    config: { hydraDaemonUrl: `http://127.0.0.1:${port}`, hydraToken: "tok" },
  } as unknown as ServerContext;
  app = Fastify({ logger: false });
  registerSessionRoutes(app, ctx);
  await app.listen({ host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(async () => {
  await app.close();
  await new Promise<void>((r) => {
    daemon.closeAllConnections();
    daemon.close(() => r());
  });
});

async function firstChunk(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const chunk = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(chunk.value);
}

test("relays the daemon's frames and forwards the cursor and bearer token", async () => {
  mode = "stream";
  seen.length = 0;
  const res = await fetch(`${baseUrl}/api/sessions/stream?since=3`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await firstChunk(res);
  assert.match(text, /event: sessions/);
  assert.match(text, /"sessionId":"a"/);
  const upstream = seen[0]!;
  assert.equal(upstream.url, "/v1/sessions/stream?since=3");
  assert.equal(upstream.headers.authorization, "Bearer tok");
});

test("closes the upstream stream when the client goes away", async () => {
  mode = "stream";
  const before = upstreamClosed;
  const res = await fetch(`${baseUrl}/api/sessions/stream`);
  await firstChunk(res);
  for (let i = 0; i < 50 && upstreamClosed === before; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(upstreamClosed, before + 1);
});

test("passes an older daemon's 404 through so the SPA can fall back to polling", async () => {
  mode = "missing";
  const res = await fetch(`${baseUrl}/api/sessions/stream`);
  assert.equal(res.status, 404);
  mode = "stream";
});
