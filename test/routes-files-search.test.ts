import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { registerFileRoutes } from "../src/server/routes-files.js";
import type { ServerContext } from "../src/server/http.js";

let daemon: Server;
let app: FastifyInstance;
let cwd: string;

before(async () => {
  cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "hb-route-")));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "app.ts"), "");
  writeFileSync(join(cwd, "README.md"), "");

  // Stand-in for the hydra daemon: only GET /v1/sessions is needed.
  const sessions = [
    { sessionId: "local", cwd },
    { sessionId: "peer", cwd, remote: "workbox" },
  ];
  daemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ sessions, removed: [], cursor: 1 }));
  });
  await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
  const port = (daemon.address() as AddressInfo).port;

  const ctx = {
    config: { hydraDaemonUrl: `http://127.0.0.1:${port}`, hydraToken: "t" },
  } as unknown as ServerContext;
  app = Fastify({ logger: false });
  registerFileRoutes(app, ctx);
  await app.ready();
});

after(async () => {
  await app.close();
  await new Promise<void>((r) => daemon.close(() => r()));
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const search = (body: unknown) =>
  app.inject({ method: "POST", url: "/api/files/search", payload: body as object });

test("search requires a sessionId", async () => {
  const res = await search({ query: "app" });
  assert.equal(res.statusCode, 400);
});

test("search 404s for an unknown session", async () => {
  const res = await search({ sessionId: "nope", query: "app" });
  assert.equal(res.statusCode, 404);
});

test("search refuses a session whose files live on another machine", async () => {
  const res = await search({ sessionId: "peer", query: "app" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /workbox/);
});

test("search returns fuzzy-ranked files and directories under the cwd", async () => {
  const res = await search({ sessionId: "local", query: "app" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { files: ["src/app.ts"], truncated: false });
  const dirs = await search({ sessionId: "local", query: "src" });
  assert.equal(dirs.json().files[0], "src/");
});

test("search with a missing query lists everything", async () => {
  const res = await search({ sessionId: "local" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().files.sort(), ["README.md", "src/", "src/app.ts"]);
});
