// Usage modal: daily cost stacked by model, fed by /api/usage. The chart
// is plain SVG; no chart library.

import { el, tapHandler, TAP_MOVE_THRESHOLD } from "./dom.js";
import { api } from "./api.js";
import { render } from "./renderer.js";
import { setState, state } from "./state.js";
import { openChat } from "./routing.js";
import type { SessionInfo } from "./types.js";

interface UsageItem {
  bucket: string;
  deltaCost: number;
  inputTokens?: number;
  linesNet?: number;
  linesAdded?: number;
  linesRemoved?: number;
}

interface UsageGroup {
  label: string;
  items: UsageItem[];
  // Only on by=session groups; lets the list follow the legend's filter.
  attrs?: { model: string; agent: string; dir: string };
}

interface UsageResponse {
  kind: string;
  currency: string;
  groups?: UsageGroup[];
}

type Range = "24h" | "7d" | "30d" | "90d";
type Metric = "cost" | "tokens" | "loc";
type SplitBy = "model" | "agent" | "dir";

const METRICS: Array<{ value: Metric; label: string }> = [
  { value: "cost", label: "cost" },
  { value: "tokens", label: "tokens" },
  { value: "loc", label: "lines of code" },
];
const SPLITS: Array<{ value: SplitBy; label: string }> = [
  { value: "model", label: "by model" },
  { value: "agent", label: "by agent" },
  { value: "dir", label: "by directory" },
];

const RANGES: Array<{ value: Range; label: string }> = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];
const RANGE_DAYS: Record<Range, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
const MAX_SERIES = 5;
const LONG_PRESS_MS = 350;
const PALETTE = ["#5b8def", "#e8a33d", "#4cb58a", "#c26bd1", "#e0645c", "#8a8f98"];
const SVG_NS = "http://www.w3.org/2000/svg";

const STORAGE_KEY = "hydra-acp-browser:usage";

interface Saved {
  range: Range;
  metric: Metric;
  split: SplitBy;
}

function loadSaved(): Partial<Saved> {
  const out: Partial<Saved> = {};
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    if (RANGES.some((r) => r.value === raw.range)) {
      out.range = raw.range as Range;
    }
    if (METRICS.some((m) => m.value === raw.metric)) {
      out.metric = raw.metric as Metric;
    }
    if (SPLITS.some((s) => s.value === raw.split)) {
      out.split = raw.split as SplitBy;
    }
  } catch {
    // Unreadable or unavailable storage: fall back to the defaults.
  }
  return out;
}

function saveSettings(): void {
  try {
    const saved: Saved = { range: view.range, metric: view.metric, split: view.split };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Private browsing or quota: the choices just won't persist.
  }
}

const view = {
  range: "30d" as Range,
  metric: "cost" as Metric,
  split: "model" as SplitBy,
  ...loadSaved(),
  cache: new Map<string, UsageResponse>(),
  hidden: new Set<string>(),
  status: "idle" as "idle" | "loading" | "ready" | "error",
  data: null as UsageResponse | null,
  error: "",
  selected: -1,
  seq: 0,
  sessions: { status: "idle" as "idle" | "loading" | "ready" | "error", data: null as UsageResponse | null, error: "" },
  sseq: 0,
  listScroll: 0,
};

async function loadSessions(refresh: boolean): Promise<void> {
  const seq = ++view.sseq;
  const hourly = isHourly();
  const key = `sessions|${view.metric}|${hourly ? "h" : "d"}`;
  const hit = refresh ? undefined : view.cache.get(key);
  if (hit !== undefined) {
    view.sessions = { status: "ready", data: hit, error: "" };
    return;
  }
  view.sessions = { status: "loading", data: null, error: "" };
  try {
    const data = await api<UsageResponse>(
      `/api/usage?since=${hourly ? "24h" : "90d"}&bucket=${hourly ? "hour" : "day"}&by=session&metric=${view.metric}`,
      { timeoutMs: 120_000 },
    );
    if (seq !== view.sseq) {
      return;
    }
    view.cache.set(key, data);
    view.sessions = { status: "ready", data, error: "" };
  } catch (err) {
    if (seq !== view.sseq) {
      return;
    }
    view.sessions = { status: "error", data: null, error: (err as Error).message };
  }
  render();
}

export function openUsageModal(): void {
  view.cache.clear();
  view.hidden.clear();
  setState({ modal: { kind: "usage" } });
  void load();
}

async function load(refresh = false): Promise<void> {
  const seq = ++view.seq;
  view.selected = -1;
  const hourly = isHourly();
  const key = `${view.metric}|${view.split}|${hourly ? "h" : "d"}`;
  if (refresh) {
    view.cache.clear();
  }
  view.listScroll = 0;
  if (!refresh) {
    void loadSessions(false);
  }
  const hit = view.cache.get(key);
  if (hit !== undefined) {
    view.data = hit;
    view.status = "ready";
    render();
    return;
  }
  view.status = "loading";
  render();
  try {
    const data = await api<UsageResponse>(
      `/api/usage?since=${hourly ? "24h" : "90d"}&bucket=${hourly ? "hour" : "day"}&by=${view.split}&metric=${view.metric}${refresh ? "&refresh=1" : ""}`,
      { timeoutMs: 120_000 },
    );
    if (seq !== view.seq) {
      return;
    }
    view.cache.set(key, data);
    view.data = data;
    view.status = "ready";
    if (refresh) {
      void loadSessions(false);
    }
  } catch (err) {
    if (seq !== view.seq) {
      return;
    }
    view.error = (err as Error).message;
    view.status = "error";
  }
  render();
}

function svg(tag: string, attrs: Record<string, string | number>, ...children: Node[]): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  for (const c of children) {
    node.appendChild(c);
  }
  return node;
}

function money(n: number, currency: string): string {
  const sym = currency === "USD" ? "$" : `${currency} `;
  return n >= 100 ? `${sym}${Math.round(n)}` : `${sym}${n.toFixed(2)}`;
}

function compact(n: number): string {
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  }
  return String(Math.round(n));
}

function fmt(n: number, currency: string): string {
  return view.metric === "cost" ? money(n, currency) : compact(n);
}

function valueOf(item: UsageItem): number {
  if (view.metric === "tokens") {
    return item.inputTokens ?? 0;
  }
  if (view.metric === "loc") {
    const net = item.linesNet ?? (item.linesAdded ?? 0) - (item.linesRemoved ?? 0);
    return Math.max(0, net);
  }
  return item.deltaCost;
}

function unit(): string {
  return view.metric === "tokens" ? " tokens" : view.metric === "loc" ? " lines" : "";
}

// The aggregator labels day buckets MM/DD/YYYY, zero-padded.
function isHourly(): boolean {
  return view.range === "24h";
}

// Hour buckets are labelled "MM/DD HH:00" in local time.
function hourKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:00`;
}

function slotLabel(d: Date, hourly: boolean): string {
  return hourly ? `${d.getHours()}:00` : `${d.getMonth() + 1}/${d.getDate()}`;
}

function dayKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function niceCeil(n: number): number {
  if (n <= 0) {
    return 1;
  }
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const f = n / pow;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 4 ? 4 : f <= 8 ? 8 : 10;
  return step * pow;
}

interface Series {
  label: string;
  color: string;
  values: number[];
}

interface Model {
  days: Date[];
  keys: string[];
  hourly: boolean;
  all: Series[];
  series: Series[];
  totals: number[];
}

function rangeSlots(range: Range): { days: Date[]; hourly: boolean; keys: string[] } {
  const hourly = range === "24h";
  const n = hourly ? 24 : RANGE_DAYS[range];
  const days: Date[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    days.push(
      hourly
        ? new Date(today.getFullYear(), today.getMonth(), today.getDate(), today.getHours() - i)
        : new Date(today.getFullYear(), today.getMonth(), today.getDate() - i),
    );
  }
  return { days, hourly, keys: days.map((d) => (hourly ? hourKey(d) : dayKey(d))) };
}

function buildModel(data: UsageResponse, range: Range, hidden: Set<string>): Model {
  const { days, hourly, keys } = rangeSlots(range);
  const index = new Map(keys.map((k, i) => [k, i]));

  const byModel = (data.groups ?? []).map((g) => {
    const values = days.map(() => 0);
    for (const item of g.items) {
      const i = index.get(item.bucket);
      if (i !== undefined) {
        values[i] = (values[i] ?? 0) + valueOf(item);
      }
    }
    return { label: g.label || "unknown", values, sum: values.reduce((a, b) => a + b, 0) };
  });
  byModel.sort((a, b) => b.sum - a.sum);

  const top = byModel.slice(0, MAX_SERIES);
  const rest = byModel.slice(MAX_SERIES);
  const series: Series[] = top.map((m, i) => ({
    label: m.label,
    color: PALETTE[i] ?? "#8a8f98",
    values: m.values,
  }));
  if (rest.length > 0) {
    series.push({
      label: "other",
      color: PALETTE[MAX_SERIES] ?? "#8a8f98",
      values: days.map((_, i) => rest.reduce((a, m) => a + (m.values[i] ?? 0), 0)),
    });
  }
  const shown = series.filter((s) => !hidden.has(s.label));
  const totals = days.map((_, i) => shown.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  return { days, keys, hourly, all: series, series: shown, totals };
}

interface Seg {
  lo: number;
  hi: number;
  series: number;
  rect: SVGElement;
}

function fullSlotLabel(d: Date, hourly: boolean): string {
  if (hourly) {
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${d.getHours()}:00`;
  }
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function renderChart(m: Model, currency: string): HTMLElement {
  const W = 600;
  const H = 220;
  const left = 44;
  const right = 8;
  const top = 8;
  const bottom = 22;
  const innerW = W - left - right;
  const innerH = H - top - bottom;
  const max = niceCeil(Math.max(...m.totals));
  const n = m.days.length;
  const step = innerW / n;
  const barW = Math.max(1, step * 0.72);
  const y = (v: number): number => top + innerH - (v / max) * innerH;

  const root = svg("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "usage-chart",
    role: "img",
    "aria-label": "Daily cost by model",
  });

  for (let g = 0; g <= 4; g++) {
    const v = (max * g) / 4;
    root.appendChild(
      svg("line", {
        x1: left,
        x2: W - right,
        y1: y(v),
        y2: y(v),
        class: "usage-grid",
      }),
    );
    const label = svg("text", { x: left - 6, y: y(v) + 4, class: "usage-axis", "text-anchor": "end" });
    label.textContent = fmt(v, currency);
    root.appendChild(label);
  }

  const segs: Seg[][] = m.days.map(() => []);
  const labelEvery = m.hourly ? 4 : n > 30 ? 14 : n > 7 ? 5 : 1;
  m.days.forEach((d, i) => {
    const x = left + i * step + (step - barW) / 2;
    let acc = 0;
    m.series.forEach((s, si) => {
      const v = s.values[i] ?? 0;
      if (v <= 0) {
        return;
      }
      const top0 = y(acc + v);
      const base = view.selected === -1 || view.selected === i ? 1 : 0.45;
      const rect = svg("rect", {
        x,
        y: top0,
        width: barW,
        height: Math.max(0, y(acc) - top0),
        fill: s.color,
        opacity: base,
        "data-s": s.label,
        "data-o": base,
      });
      root.appendChild(rect);
      segs[i]?.push({ lo: acc, hi: acc + v, series: si, rect });
      acc += v;
    });
    const hit = svg("rect", {
      x: left + i * step,
      y: top,
      width: step,
      height: innerH,
      fill: "transparent",
      class: "usage-hit",
    });
    const t = tapHandler(() => {
      view.selected = view.selected === i ? -1 : i;
      view.listScroll = 0;
      render();
    });
    for (const [k, v] of Object.entries(t)) {
      if (k.startsWith("on") && typeof v === "function") {
        hit.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      }
    }
    root.appendChild(hit);
    if (i % labelEvery === 0 || (!m.hourly && i === n - 1)) {
      const lbl = svg("text", {
        x: left + i * step + step / 2,
        y: H - 6,
        class: "usage-axis",
        "text-anchor": "middle",
      });
      lbl.textContent = slotLabel(d, m.hourly);
      root.appendChild(lbl);
    }
  });

  const wrap = el("div", { class: "usage-chart-wrap" }, root);
  const tip = el("div", { class: "usage-tip" });
  wrap.appendChild(tip);

  let shownSlot = -1;
  let shownSeg = -1;
  let lit: SVGElement | null = null;

  const hideTip = (): void => {
    tip.classList.remove("on");
    if (lit) {
      lit.removeAttribute("stroke");
      lit = null;
    }
    shownSlot = -1;
    shownSeg = -1;
  };

  const fillTip = (i: number, hot: number): void => {
    tip.textContent = "";
    const d = m.days[i];
    const total = m.totals[i] ?? 0;
    tip.appendChild(
      el(
        "div",
        { class: "hd" },
        `${d ? fullSlotLabel(d, m.hourly) : ""}: ${fmt(total, currency)}${unit()}`,
      ),
    );
    m.series.forEach((s, si) => {
      const v = s.values[i] ?? 0;
      if (v <= 0) {
        return;
      }
      const swatch = el("span", { class: "usage-swatch" });
      swatch.style.background = s.color;
      tip.appendChild(
        el(
          "div",
          { class: si === hot ? "row hot" : "row" },
          swatch,
          s.label,
          el("span", { class: "v" }, `${fmt(v, currency)} (${Math.round((v / total) * 100)}%)`),
        ),
      );
    });
  };

  // Touch: a horizontal drag scrubs the card across the bars. tapHandler stops
  // pointerdown/up from bubbling, so these listen in the capture phase.
  let touchStart: { x: number } | null = null;
  let scrubbing = false;
  const endTouch = (): void => {
    touchStart = null;
    scrubbing = false;
    hideTip();
  };
  root.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      if (e.pointerType !== "mouse") {
        touchStart = { x: e.clientX };
        scrubbing = false;
      }
    },
    true,
  );
  root.addEventListener(
    "pointerup",
    (e: PointerEvent) => {
      if (e.pointerType !== "mouse") {
        endTouch();
      }
    },
    true,
  );
  root.addEventListener("pointercancel", endTouch, true);

  root.addEventListener("pointermove", (e: PointerEvent) => {
    const touch = e.pointerType !== "mouse";
    if (touch) {
      if (touchStart === null) {
        return;
      }
      if (!scrubbing) {
        if (Math.abs(e.clientX - touchStart.x) <= TAP_MOVE_THRESHOLD) {
          return;
        }
        scrubbing = true;
      }
    }
    const box = root.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    const sy = ((e.clientY - box.top) / box.height) * H;
    const i = Math.floor((sx - left) / step);
    if (i < 0 || i >= n || (m.totals[i] ?? 0) <= 0) {
      hideTip();
      return;
    }
    const v = ((top + innerH - sy) / innerH) * max;
    const seg = (segs[i] ?? []).find((g) => v >= g.lo && v < g.hi);
    const si = seg ? seg.series : -1;
    if (i !== shownSlot || si !== shownSeg) {
      fillTip(i, si);
      if (lit) {
        lit.removeAttribute("stroke");
      }
      lit = seg ? seg.rect : null;
      if (lit) {
        lit.setAttribute("stroke", "#fff");
        lit.setAttribute("stroke-width", "1.5");
      }
      shownSlot = i;
      shownSeg = si;
    }
    tip.classList.add("on");
    const wb = wrap.getBoundingClientRect();
    let tx = e.clientX - wb.left + 14;
    let ty = e.clientY - wb.top + 14;
    if (touch) {
      // Above the finger so it isn't covered, clamped to the chart's width.
      tx = Math.min(Math.max(0, e.clientX - wb.left - tip.offsetWidth / 2), wb.width - tip.offsetWidth);
      ty = e.clientY - wb.top - tip.offsetHeight - 28;
      // May rise above the chart, but not out of the modal.
      const mb = root.closest(".modal")?.getBoundingClientRect();
      if (mb) {
        ty = Math.max(ty, mb.top - wb.top + 4);
      }
    } else {
      if (tx + tip.offsetWidth > wb.width) {
        tx = e.clientX - wb.left - tip.offsetWidth - 14;
      }
      if (ty + tip.offsetHeight > wb.height) {
        ty = e.clientY - wb.top - tip.offsetHeight - 14;
      }
    }
    tip.style.left = `${Math.max(0, tx)}px`;
    tip.style.top = `${touch ? ty : Math.max(0, ty)}px`;
  });
  root.addEventListener("pointerleave", hideTip);
  return wrap;
}

function renderDetail(m: Model, currency: string): HTMLElement {
  const i = view.selected;
  if (i < 0) {
    const total = m.totals.reduce((a, b) => a + b, 0);
    return el(
      "div",
      { class: "usage-detail" },
      `${fmt(total, currency)}${unit()} over ${m.hourly ? "24 hours" : `${m.days.length} days`}, ${fmt(total / m.days.length, currency)}/${m.hourly ? "hour" : "day"}`,
    );
  }
  const d = m.days[i];
  const parts = m.series
    .filter((s) => (s.values[i] ?? 0) > 0)
    .map((s) => `${s.label} ${fmt(s.values[i] ?? 0, currency)}`);
  return el(
    "div",
    { class: "usage-detail" },
    `${d ? `${d.getMonth() + 1}/${d.getDate()}${m.hourly ? ` ${d.getHours()}:00` : ""}` : ""}: ${fmt(m.totals[i] ?? 0, currency)}${unit()}`,
    parts.length > 0 ? ` (${parts.join(", ")})` : "",
  );
}

function seriesStats(m: Model, s: Series, currency: string): HTMLElement[] {
  const total = s.values.reduce((a, b) => a + b, 0);
  const grand = m.all.reduce((a, x) => a + x.values.reduce((p, q) => p + q, 0), 0);
  const per = m.hourly ? "hour" : "day";
  const n = m.days.length;
  let peak = 0;
  for (let i = 1; i < s.values.length; i++) {
    if ((s.values[i] ?? 0) > (s.values[peak] ?? 0)) {
      peak = i;
    }
  }
  const peakDay = m.days[peak];
  const active = s.values.filter((v) => v > 0).length;

  const swatch = el("span", { class: "usage-swatch" });
  swatch.style.background = s.color;
  const row = (k: string, v: string): HTMLElement =>
    el("div", { class: "row" }, k, el("span", { class: "v" }, v));

  return [
    el("div", { class: "hd" }, swatch, ` ${s.label}`),
    row("Total", `${fmt(total, currency)}${unit()}${grand > 0 ? ` (${Math.round((total / grand) * 100)}%)` : ""}`),
    row("Average", `${fmt(total / n, currency)}/${per}`),
    row(
      "Peak",
      total > 0 && peakDay
        ? `${fmt(s.values[peak] ?? 0, currency)} on ${fullSlotLabel(peakDay, m.hourly)}`
        : "none",
    ),
    row("Active", `${active} of ${n} ${per}s`),
  ];
}

// Dim every other series in the chart in place; render() is a full teardown.
function emphasizeSeries(label: string | null): void {
  document.querySelectorAll(".usage-chart rect[data-s]").forEach((r) => {
    if (label === null) {
      r.setAttribute("opacity", r.getAttribute("data-o") ?? "1");
    } else {
      r.setAttribute("opacity", r.getAttribute("data-s") === label ? "1" : "0.18");
    }
  });
}

function renderLegend(m: Model, currency: string): HTMLElement {
  const tip = el("div", { class: "usage-tip" });
  const hideTip = (): void => {
    tip.classList.remove("on");
    emphasizeSeries(null);
  };
  const showStats = (key: HTMLElement, s: Series, off: boolean): void => {
    tip.textContent = "";
    for (const node of seriesStats(m, s, currency)) {
      tip.appendChild(node);
    }
    tip.classList.add("on");
    const wrapW = tip.parentElement?.clientWidth ?? 0;
    tip.style.left = `${Math.max(0, Math.min(key.offsetLeft, wrapW - tip.offsetWidth))}px`;
    tip.style.top = `${key.offsetTop - tip.offsetHeight - 6}px`;
    emphasizeSeries(off ? null : s.label);
  };
  const keys = m.all.map((s) => {
    const off = view.hidden.has(s.label);
    let longPressed = false;
    // tapHandler consumes longPressed on release, so the card needs its own flag.
    let cardUp = false;
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    let pressX = 0;
    let pressY = 0;
    // CSP blocks inline style attributes; CSSOM assignment is allowed.
    const swatch = el("span", { class: "usage-swatch" });
    swatch.style.background = s.color;
    const key = el(
      "span",
      {
        class: off ? "usage-key off" : "usage-key",
        title: off ? "Show" : "Hide",
        ...tapHandler(() => {
          if (longPressed) {
            longPressed = false;
            return;
          }
          hideTip();
          if (off) {
            view.hidden.delete(s.label);
          } else {
            view.hidden.add(s.label);
          }
          view.selected = -1;
          view.listScroll = 0;
          render();
        }),
      },
      swatch,
      `${s.label} ${fmt(s.values.reduce((a, b) => a + b, 0), currency)}`,
    );
    key.addEventListener("pointerenter", (e: PointerEvent) => {
      if (e.pointerType === "mouse") {
        showStats(key, s, off);
      }
    });
    key.addEventListener("pointerleave", (e: PointerEvent) => {
      if (e.pointerType === "mouse") {
        hideTip();
      }
    });

    // Touch: a tap still toggles; holding shows the stats card until release.
    const cancelPress = (): void => {
      if (pressTimer !== undefined) {
        clearTimeout(pressTimer);
        pressTimer = undefined;
      }
    };
    key.addEventListener("pointerdown", (e: PointerEvent) => {
      if (e.pointerType === "mouse") {
        return;
      }
      longPressed = false;
      cardUp = false;
      pressX = e.clientX;
      pressY = e.clientY;
      cancelPress();
      pressTimer = setTimeout(() => {
        pressTimer = undefined;
        longPressed = true;
        cardUp = true;
        showStats(key, s, off);
      }, LONG_PRESS_MS);
    });
    key.addEventListener("pointermove", (e: PointerEvent) => {
      if (pressTimer !== undefined && Math.hypot(e.clientX - pressX, e.clientY - pressY) > TAP_MOVE_THRESHOLD) {
        cancelPress();
      }
    });
    key.addEventListener("pointerup", (e: PointerEvent) => {
      if (e.pointerType !== "mouse") {
        cancelPress();
        if (cardUp) {
          cardUp = false;
          hideTip();
        }
      }
    });
    key.addEventListener("pointercancel", () => {
      cancelPress();
      longPressed = false;
      cardUp = false;
      hideTip();
    });
    key.addEventListener("contextmenu", (e: Event) => {
      if (longPressed) {
        e.preventDefault();
      }
    });
    return key;
  });
  return el("div", { class: "usage-legend-wrap" }, el("div", { class: "usage-legend" }, keys), tip);
}

const SESSIONS_MAX = 200;

function tailPath(cwd: string): string {
  return cwd.split("/").filter((p) => p.length > 0).slice(-2).join("/");
}

function sessionKey(id: string): string {
  return id.replace(/^.*hydra_session_/, "");
}

function openSessionFromUsage(sessionId: string): void {
  setState({ modal: null });
  if (state.current?.sessionId !== sessionId) {
    openChat(sessionId);
  }
}

function renderSessions(m: Model, currency: string): HTMLElement {
  const box = el("div", { class: "usage-sessions" });
  const sel = view.selected;
  const day = sel >= 0 ? m.days[sel] : undefined;
  const scopeLabel = day
    ? fullSlotLabel(day, m.hourly)
    : (RANGES.find((r) => r.value === view.range)?.label ?? view.range);
  const metricNote =
    (view.metric === "tokens" ? ", tokens" : view.metric === "loc" ? ", lines" : "") +
    (view.hidden.size > 0 ? ", filtered" : "");
  const sv = view.sessions;
  if (sv.status === "error") {
    box.appendChild(el("div", { class: "usage-sessions-h" }, "Top sessions"));
    box.appendChild(el("div", { class: "err" }, sv.error || "Failed to load sessions"));
    return box;
  }
  if (sv.status !== "ready" || sv.data === null) {
    box.appendChild(el("div", { class: "usage-sessions-h" }, "Top sessions"));
    box.appendChild(el("div", { class: "usage-detail" }, "Loading…"));
    return box;
  }

  const scope = new Set(day && sel >= 0 ? [m.keys[sel] ?? ""] : m.keys);
  // A session counts toward the series its split attribute falls under.
  const shownLabels = new Set(m.all.map((s) => s.label));
  const rows = (sv.data.groups ?? [])
    .map((g) => {
      const attr = g.attrs?.[view.split];
      if (attr !== undefined && view.hidden.has(shownLabels.has(attr) ? attr : "other")) {
        return { id: g.label, v: 0 };
      }
      let v = 0;
      for (const item of g.items) {
        if (scope.has(item.bucket)) {
          v += valueOf(item);
        }
      }
      return { id: g.label, v };
    })
    .filter((r) => r.v > 0)
    .sort((a, b) => b.v - a.v);
  const total = rows.reduce((a, r) => a + r.v, 0);

  box.appendChild(
    el("div", { class: "usage-sessions-h" }, `Top sessions, ${scopeLabel}${metricNote} (${rows.length})`),
  );
  if (rows.length === 0) {
    box.appendChild(
      el(
        "div",
        { class: "usage-detail" },
        view.hidden.size > 0 ? "No sessions match the visible series." : "No sessions in this slice.",
      ),
    );
    return box;
  }

  const info = new Map<string, SessionInfo>();
  for (const s of state.sessions) {
    info.set(sessionKey(s.sessionId), s);
  }
  const top = rows[0]?.v ?? 1;
  const list = el("div", { class: "usage-sessions-list" });
  for (const r of rows.slice(0, SESSIONS_MAX)) {
    const s = info.get(r.id);
    const sub = s
      ? [s.agentId, s.cwd ? tailPath(s.cwd) : ""].filter((p) => p).join(" \u00b7 ")
      : r.id;
    const bar = el("i");
    bar.style.width = `${Math.max(2, (r.v / top) * 100)}%`;
    list.appendChild(
      el(
        "div",
        {
          class: s ? "usage-srow link" : "usage-srow",
          ...(s ? tapHandler(() => openSessionFromUsage(s.sessionId)) : {}),
        },
        el("div", { class: "t" }, s?.title || r.id),
        el("div", { class: "v" }, fmt(r.v, currency)),
        el("div", { class: "s" }, sub),
        el("div", { class: "p" }, `${Math.round((r.v / total) * 100)}%`),
        el("div", { class: "bar" }, bar),
      ),
    );
  }
  if (rows.length > SESSIONS_MAX) {
    list.appendChild(el("div", { class: "usage-more" }, `${rows.length - SESSIONS_MAX} more not shown`));
  }
  // render() rebuilds the modal on any poll or socket event, so remember where
  // the list was scrolled and put it back once the new element is attached.
  list.addEventListener("scroll", () => {
    view.listScroll = list.scrollTop;
  });
  queueMicrotask(() => {
    list.scrollTop = view.listScroll;
  });
  box.appendChild(list);
  return box;
}

function renderBody(): HTMLElement | string {
  if (view.status === "loading" || view.status === "idle") {
    return el("div", { class: "usage-detail" }, "Loading…");
  }
  if (view.status === "error" || view.data === null) {
    return el("div", { class: "err" }, view.error || "Failed to load usage");
  }
  const model = buildModel(view.data, view.range, view.hidden);
  const currency = view.data.currency || "USD";
  if (model.totals.every((t) => t <= 0)) {
    if (view.hidden.size === 0) {
      return el("div", { class: "usage-detail" }, "No data in this range.");
    }
    return el(
      "div",
      null,
      el("div", { class: "usage-detail" }, "Everything is hidden. Tap a legend entry to show it."),
      renderLegend(model, currency),
    );
  }
  return el(
    "div",
    { class: "usage-body" },
    renderDetail(model, currency),
    renderChart(model, currency),
    renderLegend(model, currency),
    renderSessions(model, currency),
  );
}

function picker<T extends string>(
  options: Array<{ value: T; label: string }>,
  current: T,
  onPick: (v: T) => void,
): HTMLElement {
  const select = el(
    "select",
    {
      onchange: (e: Event) => {
        const target = e.target as HTMLSelectElement;
        // renderer.ts holds renders while a select has focus; release it so
        // the loading state and the result actually paint.
        target.blur();
        onPick(target.value as T);
      },
    },
    ...options.map((o) => el("option", { value: o.value }, o.label)),
  ) as HTMLSelectElement;
  select.value = current;
  return select;
}

export function renderUsageModal(): HTMLElement {
  const close = (): void => setState({ modal: null });
  return el(
    "div",
    {
      class: "modal-bg",
      ...tapHandler((e) => {
        if ((e.target as HTMLElement).classList.contains("modal-bg")) {
          close();
        }
      }),
    },
    el(
      "div",
      { class: "modal usage-modal" },
      el("h2", null, "Usage"),
      el(
        "div",
        { class: "usage-pickers" },
        picker(METRICS, view.metric, (v) => {
          view.metric = v;
          saveSettings();
          void load();
        }),
        picker(SPLITS, view.split, (v) => {
          view.split = v;
          saveSettings();
          view.hidden.clear();
          void load();
        }),
        picker(RANGES, view.range, (v) => {
          view.range = v;
          saveSettings();
          void load();
        }),
      ),
      renderBody(),
      el(
        "div",
        { class: "actions" },
        el(
          "button",
          {
            title: "Re-download all usage events instead of only the new ones",
            ...tapHandler(() => void load(true)),
          },
          "Refresh",
        ),
        el("button", { class: "primary", ...tapHandler(close) }, "Close"),
      ),
    ),
  );
}
