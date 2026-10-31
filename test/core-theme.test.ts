import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};
globalThis.fetch = (async () => Response.json({ uis: ["classic", "board"], current: "board" })) as typeof fetch;

const { resolvedTheme, watchTheme } = await import("../src/core/theme.js");
const { loadUiChoices, uiSwitchUrl } = await import("../src/core/ui-switch.js");
const { installPlatform } = await import("../src/core/platform.js");
const { state } = await import("../src/core/state.js");

let dark = false;
let osChange: (() => void) | undefined;
installPlatform({
  prefersDark: () => dark,
  onPrefersDarkChange: (cb) => {
    osChange = cb;
  },
});

test("an explicit theme wins, and system follows the OS", () => {
  state.theme = "light";
  dark = true;
  assert.equal(resolvedTheme(), "light");
  state.theme = "dark";
  dark = false;
  assert.equal(resolvedTheme(), "dark");
  state.theme = "system";
  assert.equal(resolvedTheme(), "light");
  dark = true;
  assert.equal(resolvedTheme(), "dark");
});

test("watchTheme applies now and on an OS change only while on system", () => {
  const seen: string[] = [];
  state.theme = "system";
  dark = false;
  watchTheme((t) => seen.push(t));
  assert.deepEqual(seen, ["light"]);
  dark = true;
  osChange?.();
  assert.deepEqual(seen, ["light", "dark"]);
  state.theme = "light";
  osChange?.();
  assert.deepEqual(seen, ["light", "dark"]);
});

test("UI choices come from the server and switching builds the URL", async () => {
  assert.deepEqual(await loadUiChoices(), { uis: ["classic", "board"], current: "board" });
  assert.equal(uiSwitchUrl("board"), "/?ui=board");
  assert.equal(uiSwitchUrl("a b"), "/?ui=a%20b");
});
