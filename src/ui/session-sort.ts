// Pure sort comparator for the session list, split out of views.ts so
// session-cache.ts can sort a page before persisting it (see that
// module's doc comment) without pulling in views.ts's DOM-heavy imports
// — same "no document/localStorage at import time" discipline as
// session-merge.ts.
import type { SessionInfo } from "./types.js";

// Same tiering as the TUI picker's sortSessions (picker.ts): a mid-turn
// agent blocked on a question (busy + awaiting-input) is the most urgent
// row there is, plain busy comes next, then a stale awaiting-input flag
// on a turn that's already over (often just an uncleared flag rather
// than an agent actually standing by), then priority-pinned idle-warm,
// then plain idle-warm, then priority-pinned cold, then plain cold —
// priority only breaks ties within "both idle-warm" or "both cold", never
// outranking actual activity. Tiebreak within a tier is the priority
// integer itself, then updatedAt at minute precision so per-chunk mtime
// churn doesn't reshuffle the list between polls.
//
// Within the busy tiers specifically, prefer turnStartedAt over updatedAt
// when both sides have it: updatedAt is the daemon's history mtime, which
// advances on every streamed delta of a turn already in flight, so two
// concurrently-busy sessions would otherwise swap places on every poll.
// turnStartedAt is stamped once when the turn begins and holds steady for
// its whole duration. Falls back to updatedAt when either side lacks it
// (older daemon, or a busy tier pairing with an idle one — tier() already
// keeps those apart, but the field is optional on the wire).
export function compareSessions(a: SessionInfo, b: SessionInfo): number {
  const priorityOf = (s: SessionInfo): number => (s.priority && s.priority > 0 ? s.priority : 0);
  const tier = (s: SessionInfo): number => {
    const isWarm = s.status === "warm";
    const isPriority = priorityOf(s) > 0;
    if (isWarm && s.busy && s.awaitingInput) return 6;
    if (isWarm && s.busy) return 5;
    if (isWarm && s.awaitingInput) return 4;
    if (isWarm && isPriority) return 3;
    if (isWarm) return 2;
    if (isPriority) return 1;
    return 0;
  };
  const dt = tier(b) - tier(a);
  if (dt !== 0) {
    return dt;
  }
  const dp = priorityOf(b) - priorityOf(a);
  if (dp !== 0) {
    return dp;
  }
  if (a.busy && b.busy && typeof a.turnStartedAt === "number" && typeof b.turnStartedAt === "number") {
    return b.turnStartedAt - a.turnStartedAt;
  }
  return String(b.updatedAt || "").slice(0, 16).localeCompare(String(a.updatedAt || "").slice(0, 16));
}
