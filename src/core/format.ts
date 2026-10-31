// Display strings every UI shows the same way: durations, token counts,
// cost, model labels and short paths. Pure, no DOM.

import { shortenCwd } from "./session-list.js";
import type { ChatState } from "./types.js";

// Drop the provider prefix on a model id ("openai/gpt-4o-mini" →
// "gpt-4o-mini") so subtitle rows stay narrow.
export function shortenModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const idx = model.lastIndexOf("/");
  return idx === -1 ? model : model.slice(idx + 1);
}

// "agent•model" when both are known, just the agent (or "?") otherwise.
// Matches the CLI's TUI header (see cli/src/core/agent-display.ts).
export function agentWithModel(
  agent: string | undefined,
  model: string | undefined,
): string {
  const a = agent || "?";
  const m = shortenModel(model);
  return m ? `${a}•${m}` : a;
}

// Abbreviated duration. Matches the CLI/TUI style: "<1m", "12m", "3h",
// "2d", "5w", "11mo", "2y".
export function formatDuration(ms: number): string {
  const sec = Math.floor(Math.max(0, ms) / 1000);
  if (sec < 60) return "<1m";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d`;
  const week = Math.floor(day / 7);
  if (week < 9) return `${week}w`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}mo`;
  const year = Math.floor(day / 365);
  return `${year}y`;
}

// "Time since" hint for the subtitle row.
export function formatRelativeAge(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "?";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  return formatDuration(now - t);
}

// Compact-format a token count: <1k → "n", <1M → "n.nk", else "n.nM".
// Used in the chat header where horizontal space is scarce.
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = (n / 1000).toFixed(n < 10_000 ? 1 : 0);
    return v.replace(/\.0$/, "") + "k";
  }
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, "") + "M";
}

// Format an ACP cost field. The agent-side shape varies, sometimes
// a bare number (assumed USD), sometimes { amount, currency }, and
// some agents nest under { total: { amount, currency } }. We probe
// each layout, fall back to USD, and stretch decimals based on
// magnitude so sub-dollar costs stay readable.
export function fmtCost(cost: unknown): string | null {
  let amount: number | null = null;
  let currency = "USD";
  if (typeof cost === "number") {
    amount = cost;
  } else if (cost && typeof cost === "object") {
    const c = cost as { amount?: unknown; currency?: unknown; total?: unknown };
    if (typeof c.amount === "number") amount = c.amount;
    else if (typeof c.total === "number") amount = c.total;
    else if (c.total && typeof c.total === "object") {
      const t = c.total as { amount?: unknown; currency?: unknown };
      if (typeof t.amount === "number") amount = t.amount;
      if (typeof t.currency === "string") currency = t.currency;
    }
    if (typeof c.currency === "string") currency = c.currency;
  }
  if (amount === null) return null;
  const decimals = amount < 0.01 ? 4 : amount < 1 ? 3 : 2;
  if (currency === "USD") return `$${amount.toFixed(decimals)}`;
  return `${amount.toFixed(decimals)} ${currency}`;
}

// Collapse a leading home directory into "~" so the session list has
// room to actually show the rest of the path instead of truncating it.
export function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

// The directory to show beside the filename. Kept as short as it can be
// while still locating the file: in-project paths show their directory
// relative to the cwd ("src/server"), which is the part the reader
// doesn't already know, and anything outside falls back to the absolute
// directory with $HOME collapsed. A file at the cwd root has no
// directory of its own, so the cwd stands in rather than leaving it
// blank.
//
// Matters because this pill is the one thing in the header allowed to
// shrink (index.html's .file-modal .topbar .pill), and it ellipsizes at
// the end, so a long absolute path would show the useless head and cut
// the part that tells you where you are.
export function dirName(path: string, cwd: string): string {
  const slash = path.lastIndexOf("/");
  if (slash === -1) return shortenCwd(cwd);
  const dir = path.slice(0, slash);
  return dir.startsWith("/") ? shortenCwd(dir) : dir;
}

// Wall-clock stamp for a prompt or a finished turn (mirrors the TUI's
// formatWallClock, cli/src/tui/format.ts). Always carries both date and
// time, a session gets revisited long after the fact often enough that
// a bare time-of-day would be ambiguous, so unlike a typical chat app's
// "today" special-case, the date never drops out. The year itself is
// the one thing elided in the common case (this year), coming back
// once a stamp is actually old enough for that to matter.
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const dateStr = d.toLocaleDateString(
    undefined,
    sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
  const timeStr = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${dateStr}, ${timeStr}`;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Agent prose of the turn that `stamp` opens: every agent message up to
// the next prompt or turn boundary, in order.
export function turnAgentParts(c: ChatState, stamp: ChatState["log"][number]): string[] {
  const start = c.log.indexOf(stamp);
  if (start < 0) {
    return [];
  }
  const parts: string[] = [];
  for (let i = start + 1; i < c.log.length; i++) {
    const it = c.log[i]!;
    if (it.kind === "turn-stamp" || (it.kind === "stream" && it.role === "user")) {
      break;
    }
    if (it.kind === "stream" && it.role === "agent") {
      parts.push(it.text);
    }
  }
  return parts;
}
