// Paths a session has actually edited, so the Files API can show you a
// file the agent just changed even when it sits outside the session's
// cwd (a sibling repo, a parent directory, a /tmp scratch file). Agents
// do this constantly: one real session's cwd was .../hydra-acp/cli while
// every single edit it made landed in the parent directory or /tmp.
//
// This is deliberately an allowlist of individual files rather than a
// widening of the cwd root. /api/files/read is reachable from any
// browser holding the per-host authkey, so unscoping it outright would
// turn the same endpoint into "read any file the daemon can", which
// includes ~/.ssh and the daemon's own auth token. A file only lands
// here because this session was observed editing it.
//
// Its own module, mirroring session-visibility.ts, because ws-bridge.ts
// writes it while routes-files.ts reads it.

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

// Per session, so a long-lived process doesn't accumulate without bound.
// Sessions that edit more than this lose their oldest entries, which
// only costs those files the out-of-cwd affordance.
const MAX_PATHS_PER_SESSION = 500;

const editedPaths = new Map<string, Set<string>>();

export function recordEditedPath(sessionId: string, path: string): void {
  if (!path.startsWith("/")) return;
  let set = editedPaths.get(sessionId);
  if (!set) {
    set = new Set();
    editedPaths.set(sessionId, set);
  }
  // Re-inserting refreshes insertion order, so the cap evicts the
  // genuinely least-recently-touched path.
  set.delete(path);
  set.add(path);
  while (set.size > MAX_PATHS_PER_SESSION) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

// Compares resolved paths, never the requested string. A string compare
// would accept ".../scan.md/../../.ssh/id_rsa", which normalizes to
// something this session never edited.
export async function isEditedPath(sessionId: string, requested: string): Promise<boolean> {
  const set = editedPaths.get(sessionId);
  if (!set || set.size === 0) return false;
  const target = await realpathOrResolve(requested);
  for (const candidate of set) {
    if ((await realpathOrResolve(candidate)) === target) return true;
  }
  return false;
}

async function realpathOrResolve(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    // Missing file (deleted since the edit): fall back to the lexical
    // form so the comparison is still on normalized paths.
    return resolve(path);
  }
}

// Exported for tests.
export function _reset(): void {
  editedPaths.clear();
}
