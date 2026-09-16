// Diagnostics for "I tapped Send and nothing happened" on a phone.
//
// Two parts:
//   - tapLog(): an on-screen overlay, only with ?tapdebug=1. Useful when
//     you can reproduce on demand.
//   - the watchdog below: always on, silent, and reports to the server
//     log. This failure is rare and random (a handful a day), so there is
//     nothing to sit and watch for, and an overlay parked over the
//     composer is not something you can leave running while working.
//
// What the watchdog is actually testing. A touch that lands inside the
// Send button's painted rectangle should reach that button. A
// document-level listener sees the touch no matter which element the
// browser decides to target, so comparing "the touch was inside the
// button's rect" against "the button's own pointerdown ran" detects the
// case where painting and hit-testing disagree: the button is drawn where
// you tapped, but the browser routes the touch somewhere else, so no
// amount of handler-side fixing can ever see it. elementFromPoint records
// what the browser thought was there instead, which names the culprit.
//
// Nothing is reported on a healthy tap, so this is silent in normal use.

const OVERLAY = (() => {
  try {
    return new URLSearchParams(window.location.search).get("tapdebug") === "1";
  } catch {
    return false;
  }
})();

export function tapDebugEnabled(): boolean {
  return OVERLAY;
}

const MAX_LINES = 16;
const lines: string[] = [];
let overlay: HTMLElement | null = null;
let pending = false;

export function tapLog(line: string): void {
  if (!OVERLAY) return;
  const t = new Date();
  const stamp =
    `${String(t.getMinutes()).padStart(2, "0")}:` +
    `${String(t.getSeconds()).padStart(2, "0")}.` +
    `${String(t.getMilliseconds()).padStart(3, "0")}`;
  lines.push(`${stamp} ${line}`);
  while (lines.length > MAX_LINES) {
    lines.shift();
  }
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    paint();
  });
}

function paint(): void {
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "__tap_debug__";
    overlay.style.cssText =
      "position:absolute;top:0;left:0;right:0;z-index:99999;background:rgba(0,0,0,0.88);" +
      "color:#9f9;padding:0.35rem 0.5rem;font:10px/1.35 ui-monospace,monospace;" +
      "white-space:pre-wrap;pointer-events:none;border:1px solid #4a4";
    document.body.appendChild(overlay);
  }
  overlay.textContent = lines.join("\n");
}

// Set by tapHandler on every pointerdown it actually receives. The
// watchdog compares against it to tell "the button got the touch" from
// "the touch went somewhere else".
let lastTapHandlerDownAt = 0;

export function noteTapHandlerDown(): void {
  lastTapHandlerDownAt = performance.now();
}

let reportsThisSession = 0;
const MAX_REPORTS_PER_SESSION = 40;

function report(line: string): void {
  if (reportsThisSession >= MAX_REPORTS_PER_SESSION) return;
  reportsThisSession += 1;
  tapLog(line);
  try {
    void fetch("/api/client-log", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    void 0;
  }
}

function describe(el: Element | null): string {
  if (!el) return "null";
  const cls = typeof el.className === "string" ? el.className.slice(0, 24) : "";
  const text = (el.textContent ?? "").trim().slice(0, 10);
  return `${el.tagName.toLowerCase()}${cls ? "." + cls.replace(/\s+/g, ".") : ""}[${text}]`;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "-";
}

// How long to wait after the touch before deciding the button never got
// it. Comfortably past the synchronous pointerdown dispatch.
const VERDICT_DELAY_MS = 350;

export function initTapWatchdog(): void {
  document.addEventListener(
    "touchstart",
    (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      const btn = document.querySelector<HTMLElement>(".composer .composer-buttons button.primary");
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const x = touch.clientX;
      const y = touch.clientY;
      const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      if (!inside) return;

      const startedAt = performance.now();
      // What the browser believes is at the point we just touched. If
      // this is not the button (or a child of it), painting and
      // hit-testing have diverged and that is the whole bug.
      const at = document.elementFromPoint(x, y);
      const hitIsButton = at === btn || (at !== null && btn.contains(at));
      const vv = window.visualViewport;

      setTimeout(() => {
        const gotDown = lastTapHandlerDownAt >= startedAt;
        if (gotDown && hitIsButton) return;
        const ta = document.querySelector<HTMLTextAreaElement>('[data-focus-key="composer"]');
        report(
          "SEND TAP LOST " +
            `gotPointerDown=${gotDown} hitIsButton=${hitIsButton} hit=${describe(at)} ` +
            `touch=${Math.round(x)},${Math.round(y)} ` +
            `btnRect=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)} ` +
            `vv=${vv ? `${Math.round(vv.height)}h,${Math.round(vv.offsetTop)}top,${vv.scale}x` : "none"} ` +
            `innerH=${window.innerHeight} ` +
            `appH=${cssVar("--app-height")} appOff=${cssVar("--app-offset-top")} ` +
            `kbdClass=${document.documentElement.classList.contains("keyboard-open")} ` +
            `bodyTransform=${getComputedStyle(document.body).transform} ` +
            `active=${describe(document.activeElement)} ` +
            `taLen=${ta ? ta.value.trim().length : -1}`,
        );
      }, VERDICT_DELAY_MS);
    },
    { capture: true, passive: true },
  );
}
