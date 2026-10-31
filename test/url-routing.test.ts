import { test } from "node:test";
import assert from "node:assert/strict";

const pushed: string[] = [];
const replaced: string[] = [];
const loc = { hash: "", search: "", pathname: "/" };
const hist = {
  pushState: (_s: unknown, _t: string, url: string) => {
    pushed.push(url);
    loc.hash = url;
  },
  replaceState: (_s: unknown, _t: string, url: string) => {
    replaced.push(url);
    if (url.startsWith("#")) {
      loc.hash = url;
    }
  },
};
(globalThis as { window?: unknown }).window = {
  addEventListener() {},
  location: loc,
  matchMedia: () => ({ matches: false }),
};
(globalThis as { history?: unknown }).history = hist;
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};

const routing = await import("../src/ui-classic/url-routing.js");

test("buildSessionHash encodes the id", () => {
  assert.equal(routing.buildSessionHash("a/b c"), "#/session/a%2Fb%20c");
});

test("navigateToSession pushes, and replaceNextNavigation replaces once", async () => {
  pushed.length = 0;
  replaced.length = 0;
  routing.navigateToSession("s1");
  assert.deepEqual(pushed, ["#/session/s1"]);
  await Promise.resolve();
  routing.replaceNextNavigation();
  routing.navigateToSession("s2");
  assert.deepEqual(replaced, ["#/session/s2"]);
  await Promise.resolve();
  routing.navigateToSession("s3");
  assert.deepEqual(pushed, ["#/session/s1", "#/session/s3"]);
});

test("navigating to the hash already showing is a no-op", () => {
  pushed.length = 0;
  loc.hash = "#/session/same";
  routing.navigateToSession("same");
  assert.deepEqual(pushed, []);
});

test("a web+hydra protocol launch becomes a session hash", () => {
  replaced.length = 0;
  loc.search = `?protocol_launch=${encodeURIComponent("web+hydra://sessions/abc123")}`;
  loc.hash = "";
  routing.applyProtocolLaunch();
  assert.equal(loc.hash, "#/session/abc123");
  assert.equal(replaced.length, 1);
});

test("a protocol launch for another scheme or host is ignored", () => {
  loc.hash = "";
  loc.search = `?protocol_launch=${encodeURIComponent("web+hydra://other/abc")}`;
  routing.applyProtocolLaunch();
  assert.equal(loc.hash, "");
  loc.search = `?protocol_launch=${encodeURIComponent("https://sessions/abc")}`;
  routing.applyProtocolLaunch();
  assert.equal(loc.hash, "");
});
