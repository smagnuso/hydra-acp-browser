// Usage modal: daily cost stacked by model, fed by /api/usage. The chart
// is plain SVG; no chart library.

import { el, tapHandler } from "./dom.js";
import { api } from "./api.js";
import { render } from "./renderer.js";
import { setState } from "./state.js";

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
const PALETTE = ["#5b8def", "#e8a33d", "#4cb58a", "#c26bd1", "#e0645c", "#8a8f98"];
const SVG_NS = "http://www.w3.org/2000/svg";

const view = {
  range: "30d" as Range,
  metric: "cost" as Metric,
  split: "model" as SplitBy,
  cache: new Map<string, UsageResponse>(),
  hidden: new Set<string>(),
  status: "idle" as "idle" | "loading" | "ready" | "error",
  data: null as UsageResponse | null,
  error: "",
  selected: -1,
  seq: 0,
};

export function openUsageModal(): void {
  view.cache.clear();
  view.hidden.clear();
  setState({ modal: { kind: "usage" } });
  void load();
}

async function load(): Promise<void> {
  const seq = ++view.seq;
  view.selected = -1;
  const hourly = isHourly();
  const key = `${view.metric}|${view.split}|${hourly ? "h" : "d"}`;
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
      `/api/usage?since=${hourly ? "24h" : "90d"}&bucket=${hourly ? "hour" : "day"}&by=${view.split}&metric=${view.metric}`,
      { timeoutMs: 120_000 },
    );
    if (seq !== view.seq) {
      return;
    }
    view.cache.set(key, data);
    view.data = data;
    view.status = "ready";
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
  hourly: boolean;
  all: Series[];
  series: Series[];
  totals: number[];
}

function buildModel(data: UsageResponse, range: Range, hidden: Set<string>): Model {
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
  const index = new Map(days.map((d, i) => [hourly ? hourKey(d) : dayKey(d), i]));

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
  return { days, hourly, all: series, series: shown, totals };
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
      const rect = svg("rect", {
        x,
        y: top0,
        width: barW,
        height: Math.max(0, y(acc) - top0),
        fill: s.color,
        opacity: view.selected === -1 || view.selected === i ? 1 : 0.45,
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

  root.addEventListener("pointermove", (e: PointerEvent) => {
    if (e.pointerType !== "mouse") {
      return;
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
    if (tx + tip.offsetWidth > wb.width) {
      tx = e.clientX - wb.left - tip.offsetWidth - 14;
    }
    if (ty + tip.offsetHeight > wb.height) {
      ty = e.clientY - wb.top - tip.offsetHeight - 14;
    }
    tip.style.left = `${Math.max(0, tx)}px`;
    tip.style.top = `${Math.max(0, ty)}px`;
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

function renderLegend(m: Model, currency: string): HTMLElement {
  return el(
    "div",
    { class: "usage-legend" },
    m.all.map((s) => {
      const off = view.hidden.has(s.label);
      // CSP blocks inline style attributes; CSSOM assignment is allowed.
      const swatch = el("span", { class: "usage-swatch" });
      swatch.style.background = s.color;
      return el(
        "span",
        {
          class: off ? "usage-key off" : "usage-key",
          title: off ? "Show" : "Hide",
          ...tapHandler(() => {
            if (off) {
              view.hidden.delete(s.label);
            } else {
              view.hidden.add(s.label);
            }
            view.selected = -1;
            render();
          }),
        },
        swatch,
        `${s.label} ${fmt(s.values.reduce((a, b) => a + b, 0), currency)}`,
      );
    }),
  );
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
    null,
    renderDetail(model, currency),
    renderChart(model, currency),
    renderLegend(model, currency),
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
          void load();
        }),
        picker(SPLITS, view.split, (v) => {
          view.split = v;
          view.hidden.clear();
          void load();
        }),
        picker(RANGES, view.range, (v) => {
          view.range = v;
          void load();
        }),
      ),
      renderBody(),
      el(
        "div",
        { class: "actions" },
        el("button", { class: "primary", ...tapHandler(close) }, "Close"),
      ),
    ),
  );
}
