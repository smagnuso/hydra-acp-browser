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
const evt = (x: number, y: number): Record<string, unknown> => ({
  target: button,
  pointerType: "touch",
  clientX: x,
  clientY: y,
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
