import WebSocket from "ws";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const SESSION_TITLE = "Disk cleanup recommendations";

async function main() {
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--remote-debugging-port=9336",
      "--ignore-certificate-errors",
      "--disable-gpu",
      "--no-sandbox",
      "--user-data-dir=/tmp/chrome-swipe-test",
    ],
    { stdio: "ignore" },
  );
  await new Promise((r) => setTimeout(r, 1500));

  const version = await (await fetch("http://localhost:9336/json/version")).json();
  const browserWs = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => browserWs.once("open", r));
  const rpcTop = (method, params = {}) => {
    const id = Math.floor(Math.random() * 1e9);
    return new Promise((resolve, reject) => {
      const onMsg = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          browserWs.off("message", onMsg);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      };
      browserWs.on("message", onMsg);
      browserWs.send(JSON.stringify({ id, method, params }));
    });
  };
  const { targetId } = await rpcTop("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await rpcTop("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params = {}) => {
    const id = Math.floor(Math.random() * 1e9);
    return new Promise((resolve, reject) => {
      const onMsg = (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.sessionId === sessionId && msg.id === id) {
          browserWs.off("message", onMsg);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      };
      browserWs.on("message", onMsg);
      browserWs.send(JSON.stringify({ id, method, params, sessionId }));
    });
  };
  const evalJs = async (expr) => {
    const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
    return res.result.value;
  };

  await send("Network.enable");
  await send("Network.setCookie", {
    name: "hb_session",
    value: readFileSync(process.env.HOME + "/.hydra-acp/auth-token", "utf8").trim(),
    domain: "localhost",
    path: "/",
    secure: true,
  });
  // Narrow/mobile layout — swipe-nav.ts only arms below the wide-layout
  // breakpoint (1000px).
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await send("Page.navigate", { url: "https://localhost:5514/" });
  await new Promise((r) => setTimeout(r, 2500));

  const openCard = async () =>
    evalJs(`
      (function() {
        const cards = Array.from(document.querySelectorAll('.list *'));
        const target = cards.find(el => el.textContent && el.textContent.includes(${JSON.stringify(SESSION_TITLE)}) && el.className.includes('card'));
        if (!target) return 'not found';
        target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        return 'clicked';
      })()
    `);

  console.log("open via tap:", await openCard());
  await new Promise((r) => setTimeout(r, 1500));
  console.log("view:", await evalJs("document.querySelector('.chat-header') ? 'chat' : 'list'"));
  console.log("pill before swipe:", await evalJs("document.querySelector('.pill')?.textContent"));

  // Dispatch a real touch-drag sequence via CDP Input domain, mirroring
  // exactly what swipe-nav.ts listens for: touchstart -> several
  // touchmoves crossing DIRECTION_LOCK_PX then THRESHOLD_PX -> touchend.
  const touchSeq = async (points, type0, x0, y0) => {
    // points: array of {x,y} for touchmove after the initial touchstart
    await send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: x0, y: y0, id: 1 }],
    });
    for (const p of points) {
      await send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: p.x, y: p.y, id: 1 }],
      });
      await new Promise((r) => setTimeout(r, 16));
    }
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };

  // Swipe left-to-right in chat (mode "toList", dx > THRESHOLD_PX=80) —
  // starts on the chat body, not a form control or scrolled-left table.
  console.log("--- swiping chat -> list (left-to-right) ---");
  const startX = 60;
  const startY = 400;
  await touchSeq(
    [
      { x: startX + 20, y: startY },
      { x: startX + 60, y: startY },
      { x: startX + 100, y: startY },
      { x: startX + 140, y: startY },
    ],
    "touchStart",
    startX,
    startY,
  );
  await new Promise((r) => setTimeout(r, 350)); // SETTLE_MS + margin
  console.log("view after swipe-to-list:", await evalJs("document.querySelector('.chat-header') ? 'chat' : 'list'"));

  // Now swipe right-to-left on the list (mode "toChat", dx < -THRESHOLD_PX)
  // to reopen the SAME session — this exercises reopenClosedChat's fast
  // path specifically.
  console.log("--- swiping list -> chat (right-to-left) ---");
  const startX2 = 340;
  const startY2 = 400;
  await touchSeq(
    [
      { x: startX2 - 20, y: startY2 },
      { x: startX2 - 60, y: startY2 },
      { x: startX2 - 100, y: startY2 },
      { x: startX2 - 140, y: startY2 },
    ],
    "touchStart",
    startX2,
    startY2,
  );

  // Sample the pill rapidly right through the SETTLE_MS commit animation
  // and beyond, to catch any "connecting…" flash.
  const samples = [];
  const start = Date.now();
  while (Date.now() - start < 1200) {
    samples.push([Date.now() - start, await evalJs("document.querySelector('.chat-header') ? (document.querySelector('.pill')?.textContent ?? 'no-pill') : 'list-view'")]);
    await new Promise((r) => setTimeout(r, 20));
  }
  console.log("pill/view samples after swipe-reopen:");
  for (const [t, v] of samples) console.log(`  ${t}ms: ${v}`);

  browserWs.close();
  chrome.kill(9);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
