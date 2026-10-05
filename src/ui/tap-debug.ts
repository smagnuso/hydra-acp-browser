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

// Set when tapHandler's touch fallback acted because no pointer events
// arrived for a touch. Lets the watchdog report a rescue instead of a loss,
// which is how we learn from the field whether the fallback is working.
let lastTouchFallbackAt = 0;

export function noteTouchFallback(): void {
  lastTouchFallbackAt = performance.now();
}

// Set whenever any tapHandler'd control actually fires. The watchdog judges
// a tap by this outcome rather than by which events arrived: a press can
// deliver its pointerdown and still be cancelled before it fires.
let lastActivatedAt = -Infinity;

// What sendPrompt last did, and when. The watchdog's real question is not
// whether the button fired but whether a prompt went out: a button can
// fire and sendPrompt still return early with nothing sent.
let lastSendAt = -Infinity;
let lastSendOutcome = "";

export function noteSendOutcome(outcome: string): void {
  lastSendAt = performance.now();
  lastSendOutcome = outcome;
  if (outcome === "dispatched") {
    reportTrail();
  }
}

// Rolling record of recent input events, uploaded with every successful
// send. A failure where iOS swallows the whole touch (no touchstart either)
// is invisible to the watchdog, but it still shows here: the send that
// finally works carries the stretch before it, so failed taps that never
// arrived read as a gap followed by the backspacing or keyboard toggle that
// cleared it.
const TRAIL_WINDOW_MS = 20_000;
const TRAIL_MAX_CHARS = 1900;
const MAX_TRAILS_PER_SESSION = 300;
let trailsThisSession = 0;
const trail: { at: number; text: string }[] = [];

function trailPush(text: string): void {
  const now = performance.now();
  const last = trail[trail.length - 1];
  // Typing is one entry per run rather than one per keystroke.
  const run = /^(in|del)(\d+)$/.exec(last?.text ?? "");
  const kind = text === "in" || text === "del" ? text : null;
  if (kind && last && run && run[1] === kind && now - last.at < 2000) {
    last.text = `${kind}${Number(run[2]) + 1}`;
    last.at = now;
    return;
  }
  trail.push({ at: now, text: kind ? `${kind}1` : text });
  while (trail.length > 0 && now - trail[0]!.at > TRAIL_WINDOW_MS) {
    trail.shift();
  }
}

function short(el: EventTarget | null): string {
  if (!(el instanceof Element)) {
    return "-";
  }
  if (el.closest(".composer-buttons button")) {
    return `btn:${(el.closest("button")?.textContent ?? "").trim().slice(0, 7)}`;
  }
  if (el.matches('[data-focus-key="composer"]')) {
    return "ta";
  }
  const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
  return el.tagName.toLowerCase() + (cls ? `.${cls.slice(0, 14)}` : "");
}

function reportTrail(): void {
  if (trailsThisSession >= MAX_TRAILS_PER_SESSION || trail.length === 0) {
    return;
  }
  trailsThisSession += 1;
  const now = performance.now();
  const parts = trail
    .filter((e) => now - e.at <= TRAIL_WINDOW_MS)
    .map((e) => `${((e.at - now) / 1000).toFixed(1)} ${e.text}`);
  let line = parts.join(" | ");
  while (line.length > TRAIL_MAX_CHARS && parts.length > 1) {
    parts.shift();
    line = parts.join(" | ");
  }
  trail.length = 0;
  try {
    void fetch("/api/client-log", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line: `SEND OK trail: ${line}` }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    void 0;
  }
}

function installTrail(): void {
  const xy = (e: Event): string => {
    if (e instanceof TouchEvent) {
      const t = e.changedTouches[0];
      return t ? ` ${Math.round(t.clientX)},${Math.round(t.clientY)}` : "";
    }
    if (e instanceof MouseEvent) {
      return ` ${Math.round(e.clientX)},${Math.round(e.clientY)}`;
    }
    return "";
  };
  const abbrev: Record<string, string> = {
    touchstart: "ts", touchend: "te", touchcancel: "tc!",
    pointerdown: "pd", pointerup: "pu", pointercancel: "pc!", click: "clk",
    focusin: "fin", focusout: "fout",
  };
  for (const type of Object.keys(abbrev)) {
    document.addEventListener(
      type,
      (e) => trailPush(`${abbrev[type]} ${short(e.target)}${type.startsWith("focus") ? "" : xy(e)}`),
      { capture: true, passive: true },
    );
  }
  document.addEventListener(
    "input",
    (e) => {
      if (!(e.target instanceof Element) || !e.target.matches('[data-focus-key="composer"]')) {
        return;
      }
      const it = (e as InputEvent).inputType ?? "";
      if (it === "insertText" || it === "deleteContentBackward") {
        trailPush(it === "insertText" ? "in" : "del");
        return;
      }
      trailPush(`input:${it || "?"}`);
    },
    true,
  );
  document.addEventListener("compositionstart", () => trailPush("comp+"), true);
  document.addEventListener("compositionend", () => trailPush("comp-"), true);
  window.visualViewport?.addEventListener("resize", () => {
    trailPush(`vv ${Math.round(window.visualViewport?.height ?? 0)}h`);
  });
}

export function noteTapActivated(): void {
  lastActivatedAt = performance.now();
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

// Where a node sits in the tree, root last, with any inline transform or
// positioning, which is how a leftover or displaced copy would show.
function ancestry(el: Element | null): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && parts.length < 12) {
    const cls = typeof node.className === "string" ? node.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    let part = node.tagName.toLowerCase() + (node.id ? `#${node.id}` : "") + (cls ? `.${cls}` : "");
    if (node instanceof HTMLElement) {
      const st = node.style;
      const extra = [st.transform && `tf:${st.transform}`, st.position && `pos:${st.position}`, st.zIndex && `z:${st.zIndex}`]
        .filter(Boolean)
        .join(",");
      if (extra) {
        part += `{${extra}}`;
      }
    }
    parts.push(part);
    node = node.parentElement;
  }
  return parts.join("<");
}

// Every composer on the page: its top edge and its container chain.
function composerCensus(): string {
  const all = [...document.querySelectorAll(".composer")];
  return `${all.length}[` +
    all.map((c) => `${Math.round(c.getBoundingClientRect().top)}@${ancestry(c.parentElement).split("<").slice(0, 4).join("<")}`).join(" | ") +
    "]";
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "-";
}

// How long to wait after the touch before deciding the button never got
// it. Comfortably past the synchronous pointerdown dispatch.
const VERDICT_DELAY_MS = 1500;

// Touch-sequence and composition facts for the report: whether iOS ever
// finished the touch, and whether dictation/marked text was open.
let lastTouchEndAt = -Infinity;
let lastTouchCancelAt = -Infinity;
let composing = false;
let lastPointerCancelAt = -Infinity;

export function initTapWatchdog(): void {
  report(`CLIENT LOADED build=${typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev"} ua=${navigator.userAgent.slice(0, 120)}`);
  installTrail();
  document.addEventListener("touchend", () => { lastTouchEndAt = performance.now(); }, { capture: true, passive: true });
  document.addEventListener("touchcancel", () => { lastTouchCancelAt = performance.now(); }, { capture: true, passive: true });
  document.addEventListener("pointercancel", () => { lastPointerCancelAt = performance.now(); }, true);
  document.addEventListener("compositionstart", () => { composing = true; }, true);
  document.addEventListener("compositionend", () => { composing = false; }, true);
  document.addEventListener(
    "touchstart",
    (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      const touched = e.target instanceof Element ? e.target.closest<HTMLElement>(".composer-buttons button.primary") : null;
      const btn = touched ?? document.querySelector<HTMLElement>(".composer .composer-buttons button.primary");
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const x = touch.clientX;
      const y = touch.clientY;
      const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      if (!touched && !inside) return;

      const startedAt = performance.now();
      const composingAtStart = composing;
      const taAtStart = document.querySelector<HTMLTextAreaElement>('[data-focus-key="composer"]');
      const taLenAtStart = taAtStart ? taAtStart.value.trim().length : -1;
      const touchTarget = e.target instanceof Element ? e.target : null;
      // What the browser believes is at the point we just touched. If
      // this is not the button (or a child of it), painting and
      // hit-testing have diverged and that is the whole bug.
      const at = document.elementFromPoint(x, y);
      const hitIsButton = at === btn || (at !== null && btn.contains(at));
      const vv = window.visualViewport;

      setTimeout(() => {
        // iOS dispatches pointerdown just before touchstart, so a press on
        // this button can predate startedAt slightly.
        const gotDown = lastTapHandlerDownAt >= startedAt - 150;
        const activated = lastActivatedAt >= startedAt - 150;
        const rescued = lastTouchFallbackAt >= startedAt - 150;
        const sendRan = lastSendAt >= startedAt - 150;
        const sent = sendRan && lastSendOutcome === "dispatched";
        // Nothing typed means nothing should go out; not a failure.
        if (sent || taLenAtStart === 0) return;
        const ta = document.querySelector<HTMLTextAreaElement>('[data-focus-key="composer"]');
        const tr = ta?.getBoundingClientRect();
        report(
          "SEND TAP NO PROMPT " +
            `activated=${activated} rescued=${rescued} sendRan=${sendRan} ` +
            `sendOutcome=${sendRan ? lastSendOutcome : "-"} ` +
            `gotPointerDown=${gotDown} hitIsButton=${hitIsButton} hit=${describe(at)} ` +
            // The decisive one: who the browser actually dispatched to.
            // elementFromPoint and getBoundingClientRect agree with each
            // other and still do not match this, which is the whole
            // puzzle, so name the real target.
            `target=${describe(touchTarget)} ` +
            `btnPath=${ancestry(touchTarget)} ` +
            `composers=${composerCensus()} ` +
            `build=${typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev"} ` +
            `touchEnd=${lastTouchEndAt >= startedAt} touchCancel=${lastTouchCancelAt >= startedAt} ` +
            `pointerCancel=${lastPointerCancelAt >= startedAt - 150} ` +
            `composing=${composingAtStart} ` +
            `taRect=${tr ? `${Math.round(tr.left)},${Math.round(tr.top)},${Math.round(tr.right)},${Math.round(tr.bottom)}` : "none"} ` +
            `docClientH=${document.documentElement.clientHeight} ` +
            `vvPageTop=${vv ? Math.round(vv.pageTop) : -1} scrollY=${Math.round(window.scrollY)} ` +
            `touch=${Math.round(x)},${Math.round(y)} ` +
            `btnRect=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)} ` +
            `vv=${vv ? `${Math.round(vv.height)}h,${Math.round(vv.offsetTop)}top,${vv.scale}x` : "none"} ` +
            `innerH=${window.innerHeight} ` +
            `appH=${cssVar("--app-height")} appOff=${cssVar("--app-offset-top")} ` +
            `kbdClass=${document.documentElement.classList.contains("keyboard-open")} ` +
            `bodyTransform=${getComputedStyle(document.body).transform} ` +
            `active=${describe(document.activeElement)} ` +
            `taLen=${taLenAtStart}`,
        );
      }, VERDICT_DELAY_MS);
    },
    { capture: true, passive: true },
  );
}
