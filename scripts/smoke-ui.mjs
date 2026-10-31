#!/usr/bin/env node
// Drives each bundled UI in headless Chrome against a running server and
// fails on uncaught exceptions, console errors, or an empty page.
//   node scripts/smoke-ui.mjs [baseUrl]    (default https://localhost:5514)
// Auth: the daemon token from ~/.hydra-acp/auth-token is used as the
// hb_session cookie (the browser server only checks the cookie exists).
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "https://localhost:5514";
const token = readFileSync(join(homedir(), ".hydra-acp", "auth-token"), "utf8").trim();
const port = 9400 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), "smoke-ui-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--ignore-certificate-errors",
    "--disable-gpu",
    "--no-sandbox",
    `--user-data-dir=${profile}`,
  ],
  { stdio: "ignore" },
);

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const v = await (await fetch(`http://localhost:${port}/json/version`)).json();
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.once("open", res);
        ws.once("error", rej);
      });
      return ws;
    } catch {
      await sleep(250);
    }
  }
  throw new Error("could not reach headless Chrome");
}

const ws = await connect();
let nextId = 1;
const waiting = new Map();
const events = [];
ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && waiting.has(msg.id)) {
    const { resolve, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    if (msg.error) {
      reject(new Error(JSON.stringify(msg.error)));
    } else {
      resolve(msg.result);
    }
    return;
  }
  events.push(msg);
});
const rpc = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const failures = [];

async function smoke(ui) {
  const { targetId } = await rpc("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await rpc("Target.attachToTarget", { targetId, flatten: true });
  const send = (m, p) => rpc(m, p, sessionId);
  const evalJs = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 800, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  const host = new URL(base).hostname;
  for (const [name, value] of [["hb_session", token], ["hb_ui", ui]]) {
    await send("Network.setCookie", { name, value, domain: host, path: "/" });
  }
  const mark = events.length;
  await send("Page.navigate", { url: base + "/" });
  await sleep(4000);

  let scanned = mark;
  const scan = () => {
    const mine = events.slice(scanned).filter((e) => e.sessionId === sessionId);
    scanned = events.length;
    for (const e of mine) {
      if (e.method === "Runtime.exceptionThrown") {
        failures.push(`${ui}: exception ${e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text}`);
      }
      if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") {
        failures.push(`${ui}: console.error ${e.params.args.map((a) => a.value ?? a.description).join(" ")}`);
      }
    }
  };
  scan();
  const rendered = await evalJs("document.getElementById('app')?.childElementCount ?? 0");
  if (!rendered) {
    failures.push(`${ui}: #app is empty`);
  }

  if (ui === "classic") {
    const opened = await evalJs(
      `(() => { const b = document.querySelector('button[title="Usage"]'); if (!b) return false; b.dispatchEvent(new PointerEvent('pointerup', {bubbles:true})); b.click(); return true; })()`,
    );
    if (!opened) {
      failures.push("classic: usage button not found");
    } else {
      await sleep(5000);
      const drawn = await evalJs("!!document.querySelector('.modal-bg svg')");
      if (!drawn) {
        failures.push("classic: usage modal did not draw a chart");
      }
      scan();
      await send("Page.reload");
      await sleep(3000);
    }
  }

  // Open the first session via each UI's own mechanism, then check the
  // socket attached and the transcript area exists.
  const sel = ".card, .session-card, [data-session-id]";
  const clicked = await evalJs(
    `(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) return false; n.dispatchEvent(new PointerEvent('pointerup', {bubbles:true})); n.click(); return true; })()`,
  );
  if (clicked) {
    await sleep(4000);
    const wsOpened = events.slice(mark).some(
      (e) => e.sessionId === sessionId && e.method === "Network.webSocketCreated" && e.params.url.includes("/ws?session="),
    );
    if (!wsOpened) {
      failures.push(`${ui}: opening a session did not create a /ws connection`);
    }
    const chatShown = await evalJs(
      ui === "board"
        ? "!document.querySelector('footer')?.hidden"
        : "!!document.querySelector('.chat-body')",
    );
    if (!chatShown) {
      failures.push(`${ui}: chat view not shown after opening a session`);
    }
  } else {
    console.log(`${ui}: no sessions to open, skipped chat check`);
  }
  if (ui === "classic" && clicked) {
    const touch = (type, x, y) =>
      send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    await touch("touchStart", 6, 400);
    for (const x of [30, 70, 120, 180, 240, 300]) {
      await touch("touchMove", x, 404);
      await sleep(30);
    }
    await touch("touchEnd", 300, 404);
    await sleep(1500);
    const stillInChat = await evalJs("!!document.querySelector('.chat-body')");
    if (stillInChat) {
      failures.push("classic: swipe right from the left edge did not leave the chat");
    }
  }
  if (ui === "board") {
    const hasSw = await evalJs(
      "navigator.serviceWorker.getRegistration().then((r) => !!r).catch(() => false)",
    );
    if (!hasSw) {
      failures.push("board: no service worker registered");
    }
    if (clicked) {
      const touch = (type, x, y) =>
        send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      await touch("touchStart", 20, 300);
      await touch("touchMove", 120, 305);
      await touch("touchMove", 220, 308);
      await touch("touchEnd", 220, 308);
      await sleep(800);
      const backOnBoard = await evalJs("!document.querySelector('footer')?.hidden === false");
      if (!backOnBoard) {
        failures.push("board: swipe right did not return to the board");
      }
      // A sloppier swipe: starts mid-screen, drifts down, and the browser
      // cancels the touch instead of ending it.
      await evalJs("document.querySelector('.card')?.click()");
      await sleep(2500);
      await touch("touchStart", 150, 300);
      for (const [x, y] of [[170, 310], [200, 325], [240, 335]]) {
        await touch("touchMove", x, y);
        await sleep(30);
      }
      await send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      await sleep(800);
      const backAgain = await evalJs("!document.querySelector('footer')?.hidden === false");
      if (!backAgain) {
        failures.push("board: a drifting swipe that ends in touchcancel did not return to the board");
      }
    }
  }
  scan();
  console.log(`${ui}: loaded${clicked ? ", opened a session" : ""}`);
  await rpc("Target.closeTarget", { targetId });
}

try {
  for (const ui of ["classic", "board"]) {
    await smoke(ui);
  }
} finally {
  ws.close();
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  chrome.kill();
  await Promise.race([exited, sleep(5000)]);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (failures.length > 0) {
  console.error("FAIL\n" + failures.map((f) => "  " + f).join("\n"));
  process.exit(1);
}
console.log("ok");
