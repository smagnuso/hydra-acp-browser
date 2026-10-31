// What an open chat is doing right now, in one place, so every UI says the
// same thing about it.

import type { ChatState } from "./types.js";

export type ChatPhase =
  | "idle"
  // The prompt has not been confirmed by the daemon yet (in flight, or held
  // offline).
  | "sending"
  | "working"
  // The agent is blocked on a permission request.
  | "waiting";

export interface ChatActivity {
  phase: ChatPhase;
  // Epoch ms the live turn began, when known.
  startedAt: number | undefined;
  toolCount: number;
  // Title of the tool the agent is on now, falling back to the last one.
  currentTool: string | undefined;
}

const FINISHED = new Set(["completed", "failed", "cancelled", "canceled"]);

export function chatActivity(c: ChatState): ChatActivity {
  const spinner = c.spinner;
  const ids = spinner?.toolCallIds ?? [];
  let currentTool: string | undefined;
  for (let i = ids.length - 1; i >= 0; i--) {
    const tc = c.toolCalls.get(ids[i]!);
    if (tc && !FINISHED.has(tc.status)) {
      currentTool = tc.title;
      break;
    }
  }
  if (currentTool === undefined && ids.length > 0) {
    currentTool = c.toolCalls.get(ids[ids.length - 1]!)?.title;
  }
  let phase: ChatPhase = "idle";
  if (c.pendingPermissions.size > 0) {
    phase = "waiting";
  } else if (c.inTurn) {
    phase = spinner?.sending ? "sending" : "working";
  }
  return {
    phase,
    startedAt: spinner?.startedAt,
    toolCount: ids.length,
    currentTool: currentTool || undefined,
  };
}

export const PHASE_LABEL: Record<ChatPhase, string> = {
  idle: "Idle",
  sending: "Sending",
  working: "Working",
  waiting: "Waiting for you",
};
