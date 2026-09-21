// Minimal element-builder. Accepts an attribute bag where:
//   - "class": className
//   - "html": innerHTML (caller must have already escaped untrusted text)
//   - "on<event>": event listener (lowercased after the "on")
//   - anything else: setAttribute
// false/null/undefined attribute values are skipped so we can write
// `el("button", { disabled: someFlag && true })` without polluting the
// element tree.

import { noteTapHandlerDown, noteTouchFallback, tapDebugEnabled, tapLog } from "./tap-debug.js";

type Attrs = Record<string, unknown> | null | undefined;
type Child = Node | string | number | false | null | undefined | Child[];

export function el(tag: string, attrs?: Attrs, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) {
        continue;
      }
      if (k === "class") {
        node.className = v as string;
      } else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === "html") {
        node.innerHTML = v as string;
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) {
      for (const cc of c) appendChild(node, cc);
    } else {
      appendChild(node, c);
    }
  }
  return node;
}

// Button activation via "click" is unreliable on mobile Chrome for this
// app: click is a compatibility event synthesized after pointerup, and
// on a slower device it can land a frame or more later — after our
// full-teardown render() has already replaced the button's DOM node out
// from under it, silently dropping the event. pointerup fires
// synchronously with the physical release, before any of that, so we
// act on it directly instead. preventDefault on pointerdown stops the
// button from taking focus (which would blur/dismiss an open mobile
// keyboard) and, for touch, suppresses the compatibility click entirely;
// the firedViaPointer guard covers the mouse case, where click still
// fires after pointerup despite the preventDefault. A plain "click" (no
// preceding pointerdown/pointerup — keyboard Enter/Space activation)
// still runs fn(e) normally. Every stage also stops propagation, so a
// tapHandler'd control nested inside another clickable container (a
// card, a modal backdrop, a spinner row) never double-fires the
// ancestor's own handler — for mouse, click still bubbles even after
// preventDefault, so without this a nested control's click could also
// trigger its parent's onclick.
//
// A native click is also suppressed by the browser when the pointer
// moves far enough between down and up to count as a drag/scroll
// (e.g. the pull-to-refresh gesture starting on a session card) — acting
// on pointerup directly bypasses that, so we track the down position and
// skip fn() on pointerup if the release has moved past TAP_MOVE_THRESHOLD.
// For touch this fully suppresses activation (the compatibility click is
// already gone via preventDefault); for mouse it falls through to the
// click handler below, matching a plain onclick's behavior.
//
// Same story for a long-press-to-select: it barely moves the pointer, so
// the movement check doesn't catch it, but a native click is still
// suppressed once the gesture resolves into a text selection instead of a
// tap (e.g. long-pressing a session card to copy its cwd). preventDefault
// on pointerdown doesn't stop that native selection gesture from starting,
// so we check for one directly and skip activation — in both onpointerup
// and onclick, since a mouse click-drag-select needs the same guard as a
// touch long-press-select.
//
// A tapHandler'd container (a modal backdrop, say) can have a real form
// control nested inside it — e.g. the new-session modal's cwd input sits
// inside .modal-bg. That input's own pointerdown bubbles up to the
// backdrop's handler same as anything else, and preventDefault on it
// blocks the input's native focus-on-pointerdown, so the input never
// focuses and the mobile keyboard never opens. Bypass entirely — no
// preventDefault, no stopPropagation, no fn() — whenever the tap actually
// landed on a form control, so it gets fully native behavior.
export const TAP_MOVE_THRESHOLD = 10;

// How long after a pointerdown a replacement click is still accepted as
// that press's own (see tapHandler's onclick). Comfortably longer than
// the gap between a real release and its compatibility click, short
// enough that an abandoned press can't authorize a later stray one.
const LOST_POINTERUP_GRACE_MS = 1500;

// How close a pointerdown must be to a touch's start to count as the
// same gesture, whichever of the two WebKit or Blink dispatches first.
const POINTER_TOUCH_SLACK_MS = 150;

// Short human label for a tap target, for the ?tapdebug=1 overlay only.
function label(target: EventTarget | null): string {
  if (!(target instanceof HTMLElement)) return "?";
  const text = (target.textContent ?? "").trim().slice(0, 12);
  return `${target.tagName.toLowerCase()}:${text || target.className.slice(0, 12) || "-"}`;
}

export function hasActiveSelection(): boolean {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().length > 0;
}

// Whether a live selection means this particular tap was really a
// select gesture rather than a press. The plain hasActiveSelection()
// above is too blunt to gate a tap on: ANY selection anywhere in the
// document made it veto EVERY tapHandler'd control at once.
//
// That is not hypothetical on iOS. Double-tapping a word in the composer
// to fix a typo (an ordinary thing to do while writing a prompt) leaves a
// live selection, and WebKit, unlike Blink, reports a selection inside a
// textarea through window.getSelection(). preventDefault on pointerdown
// then stops a tap from clearing it, so the selection outlives every
// following tap and Send/Enqueue stay dead until something collapses it.
// Dismissing the keyboard does, which is exactly the "toggle the keyboard
// and it works again" cure.
//
// The guard's real purpose is narrow: a long-press that resolves into
// selecting an element's own text (a session card's cwd) should not also
// activate that element. So it only applies when the selection and the
// tapped element are actually related, and never when the selection lives
// in a text field, whose contents have nothing to say about whether a
// button press was meant.
export function selectionSuppressesTap(target: EventTarget | null): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.toString().length === 0) {
    return false;
  }
  const anchor = sel.anchorNode;
  const node = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
  if (!node) {
    return false;
  }
  if (isFormControl(node) || node.closest("input, textarea, select") !== null) {
    return false;
  }
  const el = target instanceof Element ? target : null;
  if (!el) {
    return false;
  }
  return el.contains(node) || node.contains(el);
}

export function isFormControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

// Same signal index.html's desktop-only CSS already gates on (chat-back
// button, queue button sizing) — a mouse/trackpad with real hover, not
// just a wide viewport (a tablet in landscape can be just as wide as a
// laptop but still wants touch behavior). JS-side uses: deciding whether
// autofocusing the composer is free (no virtual keyboard to pop up) or
// costly (steals the screen on a touch device).
export function isDesktopPointer(): boolean {
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

// Width-based, not device-based — a narrow desktop Chrome window falls
// back to the single-pane layout same as phone, and a hypothetical wide
// touch tablet gets the split view. views.ts's renderApp reads this to
// decide whether to render the session-list rail alongside chat instead
// of as its own full-screen view.
const WIDE_LAYOUT_QUERY = "(min-width: 1000px)";

export function isWideLayout(): boolean {
  return window.matchMedia(WIDE_LAYOUT_QUERY).matches;
}

// Call once at boot. Re-renders on crossing the breakpoint so the
// split/single-pane layout tracks a live window resize, not just the
// value at last render.
export function initWideLayoutWatcher(onChange: () => void): void {
  window.matchMedia(WIDE_LAYOUT_QUERY).addEventListener("change", onChange);
}

// Movement is measured in SCREEN coordinates, not client ones. clientX/Y
// are relative to the viewport, so anything that moves the viewport
// between press and release (on iOS: the visual-viewport pan and resize
// that come with the on-screen keyboard) changes them for a finger that
// never moved, by up to the keyboard's height. That read as a drag and
// silently threw the tap away, which is why Send/Enqueue failed with the
// keyboard up and worked as soon as it was dismissed. screenX/Y are
// relative to the physical screen: a stationary finger holds them steady
// no matter what the viewport does, while a real drag still moves them,
// so the pull-to-refresh/scroll suppression above is unaffected.
export function tapHandler(fn: (e: Event) => void): Record<string, unknown> {
  let firedViaPointer = false;
  let startX = 0;
  let startY = 0;
  let downAt = -Infinity;
  // Whether this closure actually saw the matching pointerdown. Without
  // it the move check below compared the release point against (0, 0),
  // the initial values, which for any real button is hundreds of px and
  // so ALWAYS exceeded the threshold: a pointerup with no recorded start
  // was not merely unverified, it was guaranteed to be thrown away. The
  // fallback onclick cannot rescue it either (a pointer-generated click
  // has detail >= 1, and for touch the click is suppressed outright by
  // the preventDefault above), so the tap vanished with the press
  // highlight still flashing. A closure is created per render and the
  // composer's button row is rebuilt on every renderChat, so "released
  // on a node that was swapped in mid-press" is a normal occurrence
  // here, not a pathological one. No recorded start means no evidence of
  // a drag, so treat it as a tap rather than as a 500px swipe.
  let haveStart = false;
  // Touch-event fallback state. See ontouchend below.
  let touchStarted = false;
  let touchStartAt = -Infinity;
  let touchStartX = 0;
  let touchStartY = 0;
  return {
    // iOS can deliver a tap's touch events to a control while delivering
    // NO pointer events for it at all. Field captures show exactly that:
    // the touchstart's target is the Send button, and no tapHandler ever
    // receives a pointerdown. It sets in with the composer focused and
    // clears when the text is edited or the keyboard is toggled, i.e. it
    // tracks iOS's text-interaction state rather than anything in this
    // app. Every pointer-side fix is blind to it by construction, so watch
    // the touch stream too and act on it when the pointer stream is absent.
    ontouchstart: (e: Event) => {
      if (isFormControl(e.target)) return;
      const te = e as TouchEvent;
      const t = te.touches[0];
      if (!t || te.touches.length > 1) {
        touchStarted = false;
        return;
      }
      touchStarted = true;
      touchStartAt = performance.now();
      touchStartX = t.screenX;
      touchStartY = t.screenY;
    },
    ontouchcancel: () => {
      touchStarted = false;
    },
    ontouchend: (e: Event) => {
      if (!touchStarted) return;
      touchStarted = false;
      // A pointerdown around this touch means the pointer path owns the
      // gesture and has already handled (or deliberately declined) it.
      // Checked by time rather than order because WebKit and Blink
      // disagree on whether pointerdown precedes touchstart.
      if (downAt >= touchStartAt - POINTER_TOUCH_SLACK_MS) return;
      const t = (e as TouchEvent).changedTouches[0];
      if (!t) return;
      if (Math.hypot(t.screenX - touchStartX, t.screenY - touchStartY) > TAP_MOVE_THRESHOLD) return;
      if (selectionSuppressesTap(e.target)) return;
      // Suppresses the compatibility mouse events and click, so the
      // button neither steals focus (dismissing the keyboard) nor fires
      // a second time through onclick.
      e.preventDefault();
      e.stopPropagation();
      haveStart = false;
      noteTouchFallback();
      fn(e);
    },
    onpointerdown: (e: Event) => {
      if (isFormControl(e.target)) return;
      const pe = e as PointerEvent;
      if (pe.pointerType === "mouse" && pe.button !== 0) return;
      startX = pe.screenX;
      startY = pe.screenY;
      haveStart = true;
      downAt = performance.now();
      noteTapHandlerDown();
      if (tapDebugEnabled()) {
        tapLog(
          `down ${label(e.target)} scr=${Math.round(pe.screenX)},${Math.round(pe.screenY)} ` +
            `cli=${Math.round(pe.clientX)},${Math.round(pe.clientY)}`,
        );
      }
      e.preventDefault();
      e.stopPropagation();
    },
    onpointerup: (e: Event) => {
      if (isFormControl(e.target)) return;
      const pe = e as PointerEvent;
      if (pe.pointerType === "mouse" && pe.button !== 0) return;
      e.stopPropagation();
      const dist = haveStart
        ? Math.hypot(pe.screenX - startX, pe.screenY - startY)
        : 0;
      const moved = haveStart && dist > TAP_MOVE_THRESHOLD;
      const sawStart = haveStart;
      haveStart = false;
      if (tapDebugEnabled()) {
        tapLog(
          `up   ${label(e.target)} start=${sawStart ? "y" : "n"} dist=${dist.toFixed(1)} ` +
            `moved=${moved} sel=${selectionSuppressesTap(e.target)}` +
            (moved || selectionSuppressesTap(e.target) ? " <<< DROPPED" : " -> fire"),
        );
      }
      if (moved) return;
      if (selectionSuppressesTap(e.target)) return;
      firedViaPointer = true;
      fn(e);
    },
    onpointercancel: (e: Event) => {
      if (!tapDebugEnabled()) return;
      tapLog(`CANCEL ${label(e.target)} start=${haveStart ? "y" : "n"} <<< pointerup lost`);
    },
    onclick: (e: Event) => {
      if (isFormControl(e.target)) return;
      e.stopPropagation();
      if (tapDebugEnabled()) {
        tapLog(
          `click ${label(e.target)} detail=${(e as MouseEvent).detail} ` +
            `viaPointer=${firedViaPointer} start=${haveStart ? "y" : "n"}`,
        );
      }
      if (firedViaPointer) {
        firedViaPointer = false;
        return;
      }
      // haveStart still set means THIS instance saw the pointerdown but
      // never got a pointerup to clear it: the pointer sequence was lost
      // (a pointercancel, which is exactly what iOS delivers when it
      // reclassifies the touch as a scroll because the viewport moved
      // under the finger). The press was real and landed here, so honor
      // the click the browser sent in its place. Bounded by time, and
      // still subject to the same movement check, so a stale press can't
      // authorize an unrelated later click.
      const me = e as MouseEvent;
      if (haveStart) {
        const stale = performance.now() - downAt > LOST_POINTERUP_GRACE_MS;
        const moved =
          Math.hypot(me.screenX - startX, me.screenY - startY) > TAP_MOVE_THRESHOLD;
        haveStart = false;
        if (stale || moved) return;
        if (selectionSuppressesTap(e.target)) return;
        fn(e);
        return;
      }
      // No pointerdown ran on *this* element instance at all. That's the
      // normal case for keyboard Enter/Space activation (MouseEvent.detail
      // is 0 there) but it's also what a stray compatibility click looks
      // like on iOS Chrome: preventDefault on pointerdown doesn't reliably
      // suppress it, so it can arrive a frame late and land on whatever
      // element render()'s teardown put in the old target's place (e.g. a
      // just-opened modal backdrop), immediately closing it.
      // Pointer-generated clicks have detail >= 1, so only detail === 0 is
      // trusted here.
      if (me.detail !== 0) return;
      if (selectionSuppressesTap(e.target)) return;
      fn(e);
    },
  };
}

// tapHandler for elements this module didn't create. Markdown bodies are
// assigned as innerHTML, so a link inside one has no place to hang the
// per-element handlers above, and re-binding after every render() would
// mean leaking a listener per repaint. Registered once at boot instead.
//
// Capture phase, on document, is load-bearing: in the bubble phase a
// document-level listener runs LAST, so an ancestor's own click handler
// (a thought bubble's collapse toggle, say) would already have fired by
// the time we could stop it. Capturing at the top lets stopPropagation
// actually mean something.
//
// Acts on pointerup for the same reason tapHandler does, but without its
// preventDefault on pointerdown: these are inline words inside
// selectable prose, and suppressing the native gesture would break
// selecting a sentence that happens to start on a linked path. The
// compatibility click that touch then still delivers is absorbed by the
// firedViaPointer guard, which is per-handler rather than per-element,
// so a late click landing on a *different* matching element after a
// render() teardown is swallowed too.
export function delegatedTap(
  selector: string,
  fn: (target: HTMLElement, e: Event) => void,
): void {
  let firedViaPointer = false;
  let startX = 0;
  let startY = 0;
  const match = (e: Event): HTMLElement | null => {
    const t = e.target;
    if (!(t instanceof Element)) return null;
    return t.closest<HTMLElement>(selector);
  };
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!match(e)) return;
      const pe = e as PointerEvent;
      if (pe.pointerType === "mouse" && pe.button !== 0) return;
      firedViaPointer = false;
      startX = pe.screenX;
      startY = pe.screenY;
    },
    true,
  );
  document.addEventListener(
    "pointerup",
    (e) => {
      const target = match(e);
      if (!target) return;
      const pe = e as PointerEvent;
      if (pe.pointerType === "mouse" && pe.button !== 0) return;
      if (Math.hypot(pe.screenX - startX, pe.screenY - startY) > TAP_MOVE_THRESHOLD) return;
      if (selectionSuppressesTap(target)) return;
      e.preventDefault();
      e.stopPropagation();
      firedViaPointer = true;
      fn(target, e);
    },
    true,
  );
  document.addEventListener(
    "click",
    (e) => {
      const target = match(e);
      if (!target) return;
      // Kill the href default whichever path got here, so a file link
      // never writes "#" into the URL.
      e.preventDefault();
      e.stopPropagation();
      if (firedViaPointer) {
        firedViaPointer = false;
        return;
      }
      // Keyboard activation only, same detail === 0 reasoning as
      // tapHandler's onclick.
      if ((e as MouseEvent).detail !== 0) return;
      if (selectionSuppressesTap(target)) return;
      fn(target, e);
    },
    true,
  );
}

function appendChild(parent: Node, c: Child): void {
  if (c == null || c === false) return;
  if (c instanceof Node) {
    parent.appendChild(c);
  } else {
    parent.appendChild(document.createTextNode(String(c)));
  }
}
