import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, buildContext } from "../src/server/http.js";
import { registerRootRoutes } from "../src/server/routes-root.js";
import type { Config } from "../src/config.js";

function fixtureConfig(uiDir: string): Config {
  return {
    browserHost: "127.0.0.1",
    browserHostExplicit: false,
    browserPort: 5514,
    tls: undefined,
    linkFile: "/tmp/link",
    preferredHost: undefined,
    allowedHosts: [],
    hydraDaemonUrl: "http://127.0.0.1:55514",
    hydraWsUrl: "ws://127.0.0.1:55514/acp",
    hydraToken: "test-token",
    permissionDisplayDelayMs: 500,
    permissionNotifyDelayMs: 15_000,
    readIdleSeconds: 180,
    uiDir,
    defaultUi: "classic",
    debug: false,
  };
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "custom-ui-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), '<script nonce="__CSP_NONCE__">x</script>');
  writeFileSync(join(dir, "sw.js"), "// sw");
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(dir, "secret.txt"), "nope");
  const ctx = buildContext(fixtureConfig(dir));
  const app = createServer(ctx);
  registerRootRoutes(app, ctx);
  await app.ready();
  return { app, dir };
}

const headers = { host: "127.0.0.1:5514", cookie: "hb_session=tok" };

test("serves index.html from the custom dir with the nonce injected", async () => {
  const { app } = await setup();
  const res = await app.inject({ method: "GET", url: "/", headers });
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /<script nonce="[A-Za-z0-9+/=]+">x<\/script>/);
  assert.doesNotMatch(res.body, /__CSP_NONCE__/);
});

test("serves assets with a content type", async () => {
  const { app } = await setup();
  const res = await app.inject({ method: "GET", url: "/assets/app.js", headers });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /javascript/);
  assert.equal(res.body, "console.log(1)");
});

test("assets 404 on traversal and missing files", async () => {
  const { app } = await setup();
  for (const url of ["/assets/..%2Fsecret.txt", "/assets/../secret.txt", "/assets/nope.js"]) {
    const res = await app.inject({ method: "GET", url, headers });
    assert.equal(res.statusCode, 404, url);
  }
});

test("assets require the session cookie", async () => {
  const { app } = await setup();
  const res = await app.inject({
    method: "GET",
    url: "/assets/app.js",
    headers: { host: headers.host },
  });
  assert.equal(res.statusCode, 401);
});

async function setupMulti() {
  const root = mkdtempSync(join(tmpdir(), "multi-ui-"));
  for (const name of ["alpha", "beta"]) {
    mkdirSync(join(root, name, "assets"), { recursive: true });
    writeFileSync(join(root, name, "index.html"), `<p>${name}</p>`);
    writeFileSync(join(root, name, "assets", "a.js"), name);
  }
  writeFileSync(join(root, "beta", "sw.js"), "// beta sw");
  const ctx = buildContext({ ...fixtureConfig(""), uiDir: undefined, defaultUi: "beta" });
  const app = createServer(ctx);
  registerRootRoutes(app, ctx, root);
  await app.ready();
  return app;
}

test("serves the default bundled UI, then the one picked by cookie", async () => {
  const app = await setupMulti();
  const def = await app.inject({ method: "GET", url: "/", headers });
  assert.match(def.body, /beta/);
  const picked = await app.inject({
    method: "GET",
    url: "/",
    headers: { ...headers, cookie: "hb_session=tok; hb_ui=alpha" },
  });
  assert.match(picked.body, /alpha/);
  const asset = await app.inject({
    method: "GET",
    url: "/assets/a.js",
    headers: { ...headers, cookie: "hb_session=tok; hb_ui=alpha" },
  });
  assert.equal(asset.body, "alpha");
});

test("?ui= sets the cookie and redirects, ignoring unknown names", async () => {
  const app = await setupMulti();
  const ok = await app.inject({ method: "GET", url: "/?ui=alpha", headers });
  assert.equal(ok.statusCode, 303);
  assert.match(String(ok.headers["set-cookie"]), /hb_ui=alpha/);
  const bad = await app.inject({ method: "GET", url: "/?ui=../etc", headers });
  assert.equal(bad.statusCode, 303);
  assert.equal(bad.headers["set-cookie"], undefined);
});

test("/api/uis lists the bundled UIs and the current pick", async () => {
  const app = await setupMulti();
  const res = await app.inject({
    method: "GET",
    url: "/api/uis",
    headers: { ...headers, cookie: "hb_session=tok; hb_ui=alpha" },
  });
  assert.deepEqual(JSON.parse(res.body), { uis: ["alpha", "beta"], current: "alpha" });
});

test("a UI without its own service worker borrows the default UI's", async () => {
  const app = await setupMulti();
  const res = await app.inject({
    method: "GET",
    url: "/sw.js",
    headers: { ...headers, cookie: "hb_session=tok; hb_ui=alpha" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, "// beta sw");
});
