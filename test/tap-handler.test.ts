// tapHandler's release path, exercised without a DOM: the handlers it
// returns are plain functions over synthetic events.
import { strict as assert } from "node:assert";
import { test } from "node:test";

class FakeHTMLElement {
  tagName: string;
  isContentEditable = false;
  parentElement: FakeHTMLElement | null = null;
  children: FakeHTMLElement[] = [];
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  contains(other: unknown): boolean {
    if (other === this) return true;
    return this.children.some((c) => c.contains(other));
  }
  closest(selector: string): FakeHTMLElement | null {
    const wanted = selector.split(",").map((s) => s.trim().toUpperCase());
    let node: FakeHTMLElement | null = this;
    while (node) {
      if (wanted.includes(node.tagName)) return node;
      node = node.parentElement;
    }
    return null;
  }
}
// dom.ts's selection check narrows with `instanceof Element` before
// `instanceof HTMLElement`, so the fake has to satisfy both.
(globalThis as Record<string, unknown>).HTMLElement = FakeHTMLElement;
(globalThis as Record<string, unknown>).Element = FakeHTMLElement;

let selection: { isCollapsed: boolean; anchorNode: unknown; text: string } | null = null;
(globalThis as Record<string, unknown>).window = {
  getSelection: () =>
    selection === null
      ? null
      : {
          isCollapsed: selection.isCollapsed,
          anchorNode: selection.anchorNode,
          toString: () => selection!.text,
        },
};

const { tapHandler, TAP_MOVE_THRESHOLD } = await import("../src/ui/dom.js");

interface Handlers {
  onpointerdown: (e: unknown) => void;
  onpointerup: (e: unknown) => void;
  onclick: (e: unknown) => void;
  ontouchstart: (e: unknown) => void;
  ontouchend: (e: unknown) => void;
  ontouchcancel: (e: unknown) => void;
}

const touch = (
  x: number,
  y: number,
  target: unknown = button,
): Record<string, unknown> & { defaultPrevented: () => boolean } => {
  let prevented = false;
  const pt = { screenX: x, screenY: y, clientX: x, clientY: y };
  return {
    target,
    touches: [pt],
    changedTouches: [pt],
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {},
    defaultPrevented: () => prevented,
  };
};

const button = new FakeHTMLElement("BUTTON");

// x/y are where the finger physically is (screen coords). viewportShift
// models the viewport moving under it: it changes the client coords the
// browser reports without the finger having moved at all, which is what
// the on-screen keyboard's pan/resize does on iOS.
const evt = (x: number, y: number, viewportShift = 0): Record<string, unknown> => ({
  target: button,
  pointerType: "touch",
  screenX: x,
  screenY: y,
  clientX: x,
  clientY: y - viewportShift,
  preventDefault: () => {},
  stopPropagation: () => {},
});

test("a tap fires the handler", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  h.onpointerdown(evt(340, 700));
  h.onpointerup(evt(340, 700));
  assert.equal(fired, 1);
});

test("a drag past the threshold does not fire", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  h.onpointerdown(evt(340, 700));
  h.onpointerup(evt(340, 700 + TAP_MOVE_THRESHOLD + 5));
  assert.equal(fired, 0);
});

// The regression: the composer's button row is rebuilt on every
// renderChat, so a release can land on a node whose closure never saw
// the press. The move check used to measure that release against (0, 0),
// which for any real button always exceeds the threshold, so the tap was
// dropped in silence and the onclick fallback refused it too (a
// pointer-generated click has detail >= 1). Send/Enqueue/Amend simply
// stopped responding.
test("a release with no recorded press still fires", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  h.onpointerup(evt(340, 700));
  assert.equal(fired, 1, "pointerup without its own pointerdown must not be discarded");
});

test("a release with no recorded press is not treated as a drag at any position", () => {
  for (const [x, y] of [
    [0, 0],
    [340, 700],
    [1200, 40],
  ]) {
    let fired = 0;
    const h = tapHandler(() => fired++) as unknown as Handlers;
    h.onpointerup(evt(x, y));
    assert.equal(fired, 1, `dropped at ${x},${y}`);
  }
});

test("the press is consumed, so a second stray release is still gated", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  h.onpointerdown(evt(340, 700));
  h.onpointerup(evt(340, 760));
  assert.equal(fired, 0, "the real drag is rejected");
});

// The regression this file is named for, second form: Send/Enqueue did
// nothing while the on-screen keyboard was up, and worked the moment it
// was dismissed. The move check measured clientX/Y, which the visual
// viewport's keyboard pan shifts by up to the keyboard's height, so a
// finger that never moved read as a drag of hundreds of px.
test("a viewport shift under a stationary finger is not a drag", () => {
  for (const shift of [40, 300, -300]) {
    let fired = 0;
    const h = tapHandler(() => fired++) as unknown as Handlers;
    h.onpointerdown(evt(340, 700));
    h.onpointerup(evt(340, 700, shift));
    assert.equal(fired, 1, `dropped on a ${shift}px viewport shift`);
  }
});

test("a real drag is still rejected even if the viewport shifts back", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  h.onpointerdown(evt(340, 700));
  // Finger moved 60px; a viewport shift happens to cancel it out in
  // client coords, which is exactly what must NOT be trusted.
  h.onpointerup(evt(340, 760, 60));
  assert.equal(fired, 0);
});

// iOS reclassifies a touch as a scroll when the viewport moves under the
// finger, delivering pointercancel instead of pointerup. fn() never ran,
// and the click the browser sent in its place was refused for having
// detail >= 1, so the press vanished.
test("a click rescues a press whose pointerup was lost", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  h.onpointerdown(evt(340, 700));
  h.onclick({ ...evt(340, 700), detail: 1 });
  assert.equal(fired, 1, "the press landed here, so its click must be honored");
});

test("a stray click on an instance that saw no press is still refused", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  h.onclick({ ...evt(340, 700), detail: 1 });
  assert.equal(fired, 0, "a compatibility click landing on a freshly rendered node must not fire");
});

test("a lost pointerup does not let a dragged-away release fire via click", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  h.onpointerdown(evt(340, 700));
  h.onclick({ ...evt(340, 760), detail: 1 });
  assert.equal(fired, 0);
});

// The composer case. Double-tapping a word in the textarea to fix a typo
// leaves a live selection, and WebKit reports selections inside a
// textarea through window.getSelection() where Blink does not. The old
// blanket check let that veto every tapHandler'd control on the page, so
// Send/Enqueue stayed dead for as long as the selection survived, which
// preventDefault on pointerdown guaranteed it would.
test("a selection inside the composer textarea does not veto a Send tap", () => {
  const textarea = new FakeHTMLElement("TEXTAREA");
  selection = { isCollapsed: false, anchorNode: textarea, text: "typo" };
  try {
    let fired = 0;
    const h = tapHandler(() => fired++) as unknown as Handlers;
    h.onpointerdown(evt(340, 700));
    h.onpointerup(evt(340, 700));
    assert.equal(fired, 1, "a selection in a text field must not block a button");
  } finally {
    selection = null;
  }
});

test("a selection elsewhere on the page does not veto an unrelated tap", () => {
  const otherCard = new FakeHTMLElement("DIV");
  selection = { isCollapsed: false, anchorNode: otherCard, text: "some cwd" };
  try {
    let fired = 0;
    const h = tapHandler(() => fired++) as unknown as Handlers;
    h.onpointerdown(evt(340, 700));
    h.onpointerup(evt(340, 700));
    assert.equal(fired, 1, "an unrelated selection must not block this control");
  } finally {
    selection = null;
  }
});

// The behaviour the guard actually exists for: long-pressing a session
// card to select its cwd must not also open the session.
test("a selection inside the tapped element still vetoes it", () => {
  const card = new FakeHTMLElement("DIV");
  const text = new FakeHTMLElement("SPAN");
  text.parentElement = card;
  card.children.push(text);
  selection = { isCollapsed: false, anchorNode: text, text: "~/dev/hydra-acp" };
  try {
    let fired = 0;
    const h = tapHandler(() => fired++) as unknown as Handlers;
    const press = { ...evt(340, 700), target: card };
    h.onpointerdown(press);
    h.onpointerup(press);
    assert.equal(fired, 0, "long-press-to-select must not activate the element");
  } finally {
    selection = null;
  }
});

// The field failure, captured repeatedly by the watchdog: the touchstart
// targets the Send button, yet no pointer event ever arrives for it. Every
// pointer-side fix is blind to that, so the touch stream has to carry it.
test("a tap with touch events but no pointer events still fires", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  h.ontouchstart(touch(340, 700));
  const end = touch(340, 700);
  h.ontouchend(end);
  assert.equal(fired, 1, "the touch-only tap must activate the control");
  assert.equal(end.defaultPrevented(), true, "and suppress the compat click so it cannot fire twice");
});

test("a healthy tap delivering both streams fires exactly once", () => {
  for (const order of ["pointer-first", "touch-first"] as const) {
    let fired = 0;
    const h = tapHandler(() => fired++) as unknown as Handlers;
    if (order === "pointer-first") {
      h.onpointerdown(evt(340, 700));
      h.ontouchstart(touch(340, 700));
    } else {
      h.ontouchstart(touch(340, 700));
      h.onpointerdown(evt(340, 700));
    }
    h.onpointerup(evt(340, 700));
    h.ontouchend(touch(340, 700));
    assert.equal(fired, 1, `${order}: a normal tap must not double-send`);
  }
});

test("a touch-only drag does not fire", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  h.ontouchstart(touch(340, 700));
  h.ontouchend(touch(340, 700 + TAP_MOVE_THRESHOLD + 5));
  assert.equal(fired, 0);
});

test("a cancelled touch does not fire", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  h.ontouchstart(touch(340, 700));
  h.ontouchcancel(touch(340, 700));
  h.ontouchend(touch(340, 700));
  assert.equal(fired, 0);
});

test("the touch fallback leaves form controls alone", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  const textarea = new FakeHTMLElement("TEXTAREA");
  h.ontouchstart(touch(340, 700, textarea));
  const end = touch(340, 700, textarea);
  h.ontouchend(end);
  assert.equal(fired, 0);
  assert.equal(end.defaultPrevented(), false, "a text field must keep native touch behavior");
});

test("a touch-rescued tap is not fired again by the click that follows", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  h.ontouchstart(touch(340, 700));
  h.ontouchend(touch(340, 700));
  h.onclick({ ...evt(340, 700), detail: 1 });
  assert.equal(fired, 1);
});

test("keyboard activation (detail 0) still fires, pointer clicks do not double-fire", () => {
  let fired = 0;
  const h = tapHandler(() => fired++) as unknown as Handlers;
  h.onpointerdown(evt(340, 700));
  h.onpointerup(evt(340, 700));
  h.onclick({ ...evt(340, 700), detail: 1 });
  assert.equal(fired, 1, "the compatibility click must be swallowed");
  const h2 = tapHandler(() => fired++) as unknown as Handlers;
  h2.onclick({ ...evt(0, 0), detail: 0 });
  assert.equal(fired, 2, "Enter/Space activation still works");
});
