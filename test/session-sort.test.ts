import { test } from "node:test";
import assert from "node:assert/strict";
import { compareSessions } from "../src/ui/session-sort.js";
import type { SessionInfo } from "../src/ui/types.js";

function sortIds(sessions: SessionInfo[]): string[] {
  return sessions
    .slice()
    .sort(compareSessions)
    .map((s) => s.sessionId);
}

test("compareSessions tiers busy+awaiting above plain busy above idle warm above cold", () => {
  const sessions: SessionInfo[] = [
    { sessionId: "cold", cwd: "/w", status: "cold" },
    { sessionId: "idle-warm", cwd: "/w", status: "warm" },
    { sessionId: "busy", cwd: "/w", status: "warm", busy: true },
    { sessionId: "busy-awaiting", cwd: "/w", status: "warm", busy: true, awaitingInput: true },
  ];
  assert.deepEqual(sortIds(sessions), ["busy-awaiting", "busy", "idle-warm", "cold"]);
});

test("compareSessions never lets a cold priority pin outrank real activity", () => {
  const sessions: SessionInfo[] = [
    { sessionId: "cold-pinned", cwd: "/w", status: "cold", priority: 5 },
    { sessionId: "warm-busy", cwd: "/w", status: "warm", busy: true },
  ];
  assert.deepEqual(sortIds(sessions), ["warm-busy", "cold-pinned"]);
});

test("compareSessions ties within a tier break on updatedAt, minute precision", () => {
  const sessions: SessionInfo[] = [
    { sessionId: "older", cwd: "/w", status: "cold", updatedAt: "2025-01-01T00:00:00Z" },
    { sessionId: "newer", cwd: "/w", status: "cold", updatedAt: "2025-01-02T00:00:00Z" },
  ];
  assert.deepEqual(sortIds(sessions), ["newer", "older"]);
});

test("compareSessions breaks ties between two busy sessions on turnStartedAt, not updatedAt", () => {
  const sessions: SessionInfo[] = [
    // Turn started earlier, but the most recent streamed delta (updatedAt)
    // landed after the other session's — without turnStartedAt this would
    // flip to the top on every poll despite its turn being the older one.
    { sessionId: "older-turn", cwd: "/w", status: "warm", busy: true, turnStartedAt: 1000, updatedAt: "2025-01-02T00:00:00Z" },
    { sessionId: "newer-turn", cwd: "/w", status: "warm", busy: true, turnStartedAt: 2000, updatedAt: "2025-01-01T00:00:00Z" },
  ];
  assert.deepEqual(sortIds(sessions), ["newer-turn", "older-turn"]);
});

test("compareSessions falls back to updatedAt when either busy session lacks turnStartedAt", () => {
  const sessions: SessionInfo[] = [
    { sessionId: "no-turn-start", cwd: "/w", status: "warm", busy: true, updatedAt: "2025-01-01T00:00:00Z" },
    { sessionId: "has-turn-start", cwd: "/w", status: "warm", busy: true, turnStartedAt: 1000, updatedAt: "2025-01-02T00:00:00Z" },
  ];
  assert.deepEqual(sortIds(sessions), ["has-turn-start", "no-turn-start"]);
});
