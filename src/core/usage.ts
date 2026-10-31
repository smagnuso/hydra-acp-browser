// Usage page model: the /api/usage queries, the persisted range/metric/split
// choice, and the shaping of a response into chart series. A UI renders
// `usage` and `buildUsageModel`; fetching and caching live here.

import { api } from "./api.js";
import { notifyChange } from "./state.js";

export interface UsageItem {
  bucket: string;
  deltaCost: number;
  inputTokens?: number;
  linesNet?: number;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface UsageGroup {
  label: string;
  items: UsageItem[];
  // Only on by=session groups; lets the list follow the legend's filter.
  attrs?: { model: string; agent: string; dir: string };
}

export interface UsageResponse {
  kind: string;
  currency: string;
  groups?: UsageGroup[];
}

export type Range = "24h" | "7d" | "30d" | "90d";
export type Metric = "cost" | "tokens" | "loc";
export type SplitBy = "model" | "agent" | "dir";

export const METRICS: Array<{ value: Metric; label: string }> = [
  { value: "cost", label: "cost" },
  { value: "tokens", label: "tokens" },
  { value: "loc", label: "lines of code" },
];
export const SPLITS: Array<{ value: SplitBy; label: string }> = [
  { value: "model", label: "by model" },
  { value: "agent", label: "by agent" },
  { value: "dir", label: "by directory" },
];

export const RANGES: Array<{ value: Range; label: string }> = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];
export const RANGE_DAYS: Record<Range, number> = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
export const MAX_SERIES = 5;

export const PALETTE = ["#5b8def", "#e8a33d", "#4cb58a", "#c26bd1", "#e0645c", "#8a8f98"];

export interface Series {
  label: string;
  color: string;
  values: number[];
}

export interface Model {
  days: Date[];
  keys: string[];
  hourly: boolean;
  all: Series[];
  series: Series[];
  totals: number[];
}


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

export function saveUsageSettings(): void {
  try {
    const saved: Saved = { range: usage.range, metric: usage.metric, split: usage.split };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Private browsing or quota: the choices just won't persist.
  }
}

export const usage = {
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

export async function loadUsageSessions(refresh: boolean): Promise<void> {
  const seq = ++usage.sseq;
  const hourly = isHourly(usage.range);
  const key = `sessions|${usage.metric}|${hourly ? "h" : "d"}`;
  const hit = refresh ? undefined : usage.cache.get(key);
  if (hit !== undefined) {
    usage.sessions = { status: "ready", data: hit, error: "" };
    return;
  }
  usage.sessions = { status: "loading", data: null, error: "" };
  try {
    const data = await api<UsageResponse>(
      `/api/usage?since=${hourly ? "24h" : "90d"}&bucket=${hourly ? "hour" : "day"}&by=session&metric=${usage.metric}`,
      { timeoutMs: 120_000 },
    );
    if (seq !== usage.sseq) {
      return;
    }
    usage.cache.set(key, data);
    usage.sessions = { status: "ready", data, error: "" };
  } catch (err) {
    if (seq !== usage.sseq) {
      return;
    }
    usage.sessions = { status: "error", data: null, error: (err as Error).message };
  }
  notifyChange();
}

export function resetUsage(): void {
  usage.cache.clear();
  usage.hidden.clear();
}

export async function loadUsage(refresh = false): Promise<void> {
  const seq = ++usage.seq;
  usage.selected = -1;
  const hourly = isHourly(usage.range);
  const key = `${usage.metric}|${usage.split}|${hourly ? "h" : "d"}`;
  if (refresh) {
    usage.cache.clear();
  }
  usage.listScroll = 0;
  if (!refresh) {
    void loadUsageSessions(false);
  }
  const hit = usage.cache.get(key);
  if (hit !== undefined) {
    usage.data = hit;
    usage.status = "ready";
    notifyChange();
    return;
  }
  usage.status = "loading";
  notifyChange();
  try {
    const data = await api<UsageResponse>(
      `/api/usage?since=${hourly ? "24h" : "90d"}&bucket=${hourly ? "hour" : "day"}&by=${usage.split}&metric=${usage.metric}${refresh ? "&refresh=1" : ""}`,
      { timeoutMs: 120_000 },
    );
    if (seq !== usage.seq) {
      return;
    }
    usage.cache.set(key, data);
    usage.data = data;
    usage.status = "ready";
    if (refresh) {
      void loadUsageSessions(false);
    }
  } catch (err) {
    if (seq !== usage.seq) {
      return;
    }
    usage.error = (err as Error).message;
    usage.status = "error";
  }
  notifyChange();
}


export function money(n: number, currency: string): string {
  const sym = currency === "USD" ? "$" : `${currency} `;
  return n >= 100 ? `${sym}${Math.round(n)}` : `${sym}${n.toFixed(2)}`;
}

export function compact(n: number): string {
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  }
  return String(Math.round(n));
}

export function formatUsage(n: number, currency: string, metric: Metric): string {
  return metric === "cost" ? money(n, currency) : compact(n);
}

export function usageValue(item: UsageItem, metric: Metric): number {
  if (metric === "tokens") {
    return item.inputTokens ?? 0;
  }
  if (metric === "loc") {
    const net = item.linesNet ?? (item.linesAdded ?? 0) - (item.linesRemoved ?? 0);
    return Math.max(0, net);
  }
  return item.deltaCost;
}

export function usageUnit(metric: Metric): string {
  return metric === "tokens" ? " tokens" : metric === "loc" ? " lines" : "";
}

// The aggregator labels day buckets MM/DD/YYYY, zero-padded.
export function isHourly(range: Range): boolean {
  return range === "24h";
}

// Hour buckets are labelled "MM/DD HH:00" in local time.
export function hourKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:00`;
}

export function dayKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

export function rangeSlots(range: Range): { days: Date[]; hourly: boolean; keys: string[] } {
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

export function buildUsageModel(
  data: UsageResponse,
  range: Range,
  metric: Metric,
  hidden: Set<string>,
): Model {
  const { days, hourly, keys } = rangeSlots(range);
  const index = new Map(keys.map((k, i) => [k, i]));

  const byModel = (data.groups ?? []).map((g) => {
    const values = days.map(() => 0);
    for (const item of g.items) {
      const i = index.get(item.bucket);
      if (i !== undefined) {
        values[i] = (values[i] ?? 0) + usageValue(item, metric);
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
