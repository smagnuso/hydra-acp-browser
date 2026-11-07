#!/usr/bin/env node
// Takes the README screenshots against a throwaway daemon seeded with fake
// sessions (see seed.mjs). Nothing here touches ~/.hydra-acp.
//   npm run build && node scripts/readme-shots/capture.mjs [outDir]
import WebSocket from "ws";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const out = resolve(process.argv[2] ?? join(repo, "docs/img"));
const root = process.env.SHOTS_ROOT ?? "/tmp/dana";
const DAEMON_PORT = 56524;
const BROWSER_PORT = 5624;
const base = `http://127.0.0.1:${BROWSER_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(out, { recursive: true });
execFileSync(process.execPath, [join(here, "seed.mjs"), root], {
  stdio: "inherit",
  env: { ...process.env, SHOTS_DAEMON_PORT: String(DAEMON_PORT) },
});
const env = JSON.parse(readFileSync(join(root, "env.json"), "utf8"));

const children = [];
const childEnv = {
  ...process.env,
  HOME: env.home,
  HYDRA_ACP_HOME: join(env.home, ".hydra-acp"),
  HYDRA_ACP_TOKEN: env.token,
  HYDRA_ACP_DAEMON_URL: `http://127.0.0.1:${DAEMON_PORT}`,
};
function start(cmd, args, logName) {
  const log = join(root, logName);
  const c = spawn(cmd, args, { env: childEnv, stdio: ["ignore", "ignore", "ignore"], cwd: repo });
  children.push(c);
  return log;
}
async function until(fn, what, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await fn()) {
        return;
      }
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

let chromeProc;
let ws;
try {
  start("hydra-acp", ["daemon", "start", "--foreground"], "daemon.log");
  await until(async () => (await fetch(`http://127.0.0.1:${DAEMON_PORT}/v1/sessions`, { headers: { authorization: `Bearer ${env.token}` } })).ok, "daemon");
  writeFileSync(join(env.home, ".hydra-acp", "browser.conf"), `BROWSER_PORT=${BROWSER_PORT}\n`);
  start(process.execPath, [join(repo, "dist/index.js")], "browser.log");
  await until(async () => (await fetch(`${base}/api/sessions`, { headers: { cookie: `hb_session=${env.token}` } })).ok, "browser server");

  const port = 9500 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "readme-shots-"));
  chromeProc = spawn(
    "google-chrome",
    ["--headless=new", `--remote-debugging-port=${port}`, "--disable-gpu", "--no-sandbox", "--hide-scrollbars", `--user-data-dir=${profile}`],
    { stdio: "ignore" },
  );
  children.push(chromeProc);
  let version;
  await until(async () => {
    version = await (await fetch(`http://localhost:${port}/json/version`)).json();
    return true;
  }, "chrome");
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  let nextId = 1;
  const waiting = new Map();
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    const w = msg.id && waiting.get(msg.id);
    if (w) {
      waiting.delete(msg.id);
      msg.error ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result);
    }
  });
  const rpc = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  async function page(name, viewport, theme, steps) {
    const { browserContextId } = await rpc("Target.createBrowserContext");
    const { targetId } = await rpc("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await rpc("Target.attachToTarget", { targetId, flatten: true });
    const send = (m, p) => rpc(m, p, sessionId);
    const evalJs = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      }
      return r.result.value;
    };
    const wait = (expr, what, tries = 40) => until(() => evalJs(expr), what, tries);
    const tap = (selector) =>
      evalJs(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.dispatchEvent(new PointerEvent('pointerup', {bubbles:true})); return true; })()`);
    const shot = async (file) => {
      // Programmatic focus after synthetic taps draws a keyboard focus ring a real tap would not.
      await evalJs(`document.activeElement?.blur()`);
      await sleep(600);
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(out, `${name}-${file}-${theme}.png`), Buffer.from(data, "base64"));
      console.log(`wrote ${name}-${file}-${theme}.png`);
    };
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Network.enable");
    await send("Emulation.setDeviceMetricsOverride", viewport);
    if (viewport.mobile) {
      await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    }
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    for (const [n, v] of [["hb_session", env.token], ["hb_ui", "classic"]]) {
      await send("Network.setCookie", { name: n, value: v, domain: "127.0.0.1", path: "/" });
    }
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem("hydra-acp-browser:filters", JSON.stringify({ theme: ${JSON.stringify(theme)} }))`,
    });
    await send("Page.navigate", { url: base + "/" });
    await steps({ evalJs, wait, tap, shot, send });
    await rpc("Target.closeTarget", { targetId });
  }

  const hero = `.card[data-session-id="${env.hero}"]`;
  const flow = (mobile) => async ({ evalJs, wait, tap, shot }) => {
    await wait(`document.querySelectorAll('.card[data-session-id]').length >= 3`, "session list");
    await shot("1-sessions");

    // Cost is reachable only from the list on a phone, so shoot it first
    await tap('button[title="Usage"]');
    await wait(`!!document.querySelector('.modal-bg svg')`, "usage chart", 60);
    await sleep(800);
    await shot("3-cost");
    await evalJs(`(() => { const m = document.querySelector('.modal-bg'); m?.dispatchEvent(new PointerEvent('pointerup', {bubbles:true})); m?.click(); })()`);
    await sleep(500);

    await tap(hero);
    await wait(`document.querySelectorAll('.chat-body > *').length > 8`, "transcript");
    await sleep(1500);
    await evalJs(`(() => { const h = [...document.querySelectorAll('.toolcard > .head')].find((x) => x.textContent.includes('rateLimit.ts') && !x.textContent.includes('test') && x.textContent.includes('-1')); h?.dispatchEvent(new PointerEvent('pointerup', {bubbles:true})); })()`);
    await sleep(800);
    await evalJs(
      mobile
        ? `document.querySelector('.attachment-thumb')?.closest('.msg')?.scrollIntoView({ block: 'start' })`
        : `(() => { const b = document.querySelector('.chat-body'); b.scrollTop = b.scrollHeight; })()`,
    );
    await shot("2-session");

    await tap('button[title="Changes"]');
    await wait(`document.querySelectorAll('.diff-file').length > 0`, "diff pane");
    await evalJs(`document.querySelectorAll('.diff-file-head').forEach((h) => h.dispatchEvent(new PointerEvent('pointerup', {bubbles:true})))`);
    await sleep(1200);
    await shot("4-diff");

    await evalJs(`(() => { const h = [...document.querySelectorAll('.diff-file-head')].find((x) => x.textContent.includes('rateLimit.ts')); h.querySelector('button[title="Open file"]').dispatchEvent(new PointerEvent('pointerup', {bubbles:true})); })()`);
    await wait(`!!document.querySelector('.files, .file-view, .preview')`, "file viewer");
    await sleep(1200);
    await shot("5-file");
  };

  for (const theme of ["dark", "light"]) {
    await page("desktop", { width: 1360, height: 1080, deviceScaleFactor: 1.5, mobile: false }, theme, flow(false));
    await page("mobile", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true }, theme, flow(true));
  }
} finally {
  ws?.close();
  for (const c of children.reverse()) {
    c.kill("SIGTERM");
  }
  await sleep(500);
}
