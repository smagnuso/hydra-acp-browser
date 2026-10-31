import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

const urls: string[] = [];
let respond: (url: string) => Response = () => Response.json({ kind: "x", currency: "USD", groups: [] });
globalThis.fetch = (async (input: string | URL | Request) => {
  urls.push(String(input));
  return respond(String(input));
}) as typeof fetch;

const u = await import("../src/core/usage.js");

const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return u.dayKey(d);
};

test("money and compact formatting", () => {
  assert.equal(u.money(1.234, "USD"), "$1.23");
  assert.equal(u.money(250.6, "USD"), "$251");
  assert.equal(u.money(3, "EUR"), "EUR 3.00");
  assert.equal(u.compact(950), "950");
  assert.equal(u.compact(1500), "1.5k");
  assert.equal(u.compact(12_000), "12k");
  assert.equal(u.compact(2_500_000), "2.5M");
  assert.equal(u.formatUsage(1.5, "USD", "cost"), "$1.50");
  assert.equal(u.formatUsage(1500, "USD", "tokens"), "1.5k");
});

test("usageValue picks the metric, with loc falling back to added minus removed", () => {
  const item = { bucket: "b", deltaCost: 2, inputTokens: 300, linesAdded: 10, linesRemoved: 4 };
  assert.equal(u.usageValue(item, "cost"), 2);
  assert.equal(u.usageValue(item, "tokens"), 300);
  assert.equal(u.usageValue(item, "loc"), 6);
  assert.equal(u.usageValue({ ...item, linesNet: -5 }, "loc"), 0);
  assert.equal(u.usageUnit("tokens"), " tokens");
  assert.equal(u.usageUnit("cost"), "");
});

test("rangeSlots counts days, or 24 hours for the 24h range", () => {
  assert.equal(u.rangeSlots("7d").days.length, 7);
  assert.equal(u.rangeSlots("90d").days.length, 90);
  const h = u.rangeSlots("24h");
  assert.equal(h.hourly, true);
  assert.equal(h.days.length, 24);
  assert.match(h.keys[0]!, /^\d\d\/\d\d \d\d:00$/);
  assert.match(u.rangeSlots("7d").keys[0]!, /^\d\d\/\d\d\/\d{4}$/);
  assert.equal(u.isHourly("24h"), true);
  assert.equal(u.isHourly("7d"), false);
});

test("buildUsageModel keeps the top series, folds the rest into other, and honours hidden", () => {
  const groups = Array.from({ length: 7 }, (_, i) => ({
    label: `m${i}`,
    items: [{ bucket: day(0), deltaCost: 10 - i }],
  }));
  const m = u.buildUsageModel({ kind: "x", currency: "USD", groups }, "7d", "cost", new Set());
  assert.deepEqual(m.all.map((s) => s.label), ["m0", "m1", "m2", "m3", "m4", "other"]);
  assert.equal(m.all[5]!.values[6], 5 + 4);
  assert.equal(m.totals[6], 10 + 9 + 8 + 7 + 6 + 9);
  const hidden = u.buildUsageModel({ kind: "x", currency: "USD", groups }, "7d", "cost", new Set(["m0", "other"]));
  assert.equal(hidden.series.length, 4);
  assert.equal(hidden.totals[6], 9 + 8 + 7 + 6);
  assert.equal(hidden.all.length, 6);
});

test("buckets outside the range are ignored", () => {
  const m = u.buildUsageModel(
    { kind: "x", currency: "USD", groups: [{ label: "a", items: [{ bucket: "01/01/1999", deltaCost: 5 }] }] },
    "7d",
    "cost",
    new Set(),
  );
  assert.equal(m.totals.reduce((a, b) => a + b, 0), 0);
});

test("loadUsage builds the query, caches by view, and refresh bypasses the cache", async () => {
  Object.assign(u.usage, { range: "24h", metric: "tokens", split: "agent" });
  u.resetUsage();
  urls.length = 0;
  await u.loadUsage();
  const main = urls.find((x) => x.includes("by=agent"))!;
  assert.equal(main, "/api/usage?since=24h&bucket=hour&by=agent&metric=tokens");
  assert.equal(u.usage.status, "ready");
  await new Promise((r) => setTimeout(r, 0));
  const before = urls.length;
  await u.loadUsage();
  assert.equal(urls.length, before);
  await u.loadUsage(true);
  assert.ok(urls.slice(before).some((x) => x.endsWith("&refresh=1")));
  Object.assign(u.usage, { range: "30d", metric: "cost", split: "model" });
  u.resetUsage();
  urls.length = 0;
  await u.loadUsage();
  assert.ok(urls.includes("/api/usage?since=90d&bucket=day&by=model&metric=cost"));
});

test("a failed load lands in the error state", async () => {
  u.resetUsage();
  Object.assign(u.usage, { range: "7d", metric: "loc", split: "dir" });
  respond = () => Response.json({ error: "budgeter down" }, { status: 502 });
  await u.loadUsage();
  assert.equal(u.usage.status, "error");
  assert.equal(u.usage.error, "budgeter down");
});

test("the chosen range, metric and split persist", () => {
  Object.assign(u.usage, { range: "90d", metric: "tokens", split: "dir" });
  u.saveUsageSettings();
  assert.deepEqual(JSON.parse(store.get("hydra-acp-browser:usage")!), {
    range: "90d",
    metric: "tokens",
    split: "dir",
  });
});
