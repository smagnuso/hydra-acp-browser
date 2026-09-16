// tapHandler's release path, exercised without a DOM: the handlers it
// returns are plain functions over synthetic events.
import { strict as assert } from "node:assert";
import { test } from "node:test";

class FakeHTMLElement {
  tagName: string;
  isContentEditable = false;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
}
(globalThis as Record<string, unknown>).HTMLElement = FakeHTMLElement;
(globalThis as Record<string, unknown>).window = {
  getSelection: () => null,
};

const { tapHandler, TAP_MOVE_THRESHOLD } = await import("../src/ui/dom.js");

interface Handlers {
  onpointerdown: (e: unknown) => void;
  onpointerup: (e: unknown) => void;
  onclick: (e: unknown) => void;
}

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
