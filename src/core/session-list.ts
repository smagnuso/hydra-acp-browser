// Session-list derivations shared by every UI: which sessions are
// visible under the current filters, how they group, and what the host
// filter offers. Pure functions over SessionInfo plus selectors over state.

import { state } from "./state.js";
import type { SessionInfo } from "./types.js";

// Short, copy-pasteable form of the session id for inline display in
// subtitle rows. A federated id ("name:localId") has its peer-name
// prefix stripped first (the remote is already shown via its own badge,
// so repeating "name:" in every id is redundant), then the redundant
// "hydra_session_" prefix is stripped from what's left.
export function shortSessionId(sessionId: string): string {
  const colon = sessionId.indexOf(":");
  const local = colon === -1 ? sessionId : sessionId.slice(colon + 1);
  return local.replace(/^hydra_session_/, "");
}

export function shortenCwd(cwd: string): string {
  return cwd.replace(/^\/(home|Users)\/[^/]+/, "~");
}

// "Which project is this session working on" rather than "what is its
// literal working directory". For an isolated session those differ: the
// literal cwd is a workspace path under ~/.hydra-acp that says nothing
// about the project, so anywhere the UI shows cwd to a human should show
// the source tree instead. Mirrors cli's formatCwdCell (session-row.ts).
export function displayCwd(s: SessionInfo): string {
  return s.workspace?.sourceCwd ?? s.cwd;
}

// Namespace prefixes for the host-filter value; see describeHostFilter
// and cli's picker.ts (same fix, same reason): a `hydra remote add`
// name is very commonly just the machine's own hostname (e.g. `hydra
// remote add mrclean mrclean.local`), which is the exact same string
// importedFromMachine already uses for old bundle imports from that
// box. Without a prefix, "mrclean" as a bare filter value can't tell a
// live federated remote from an unrelated years-old import mirror
// apart, and silently merges two unrelated session sets into one
// bucket. An actual bug, not a hypothetical.
export const REMOTE_FILTER_PREFIX = "remote:";
export const HOST_FILTER_PREFIX = "host:";

// True when a federated entry is, on the *peer's own* side, a dormant
// import mirror it has never attached to. importedFromMachine rides
// through the merge unchanged from the peer's own record (the daemon's
// ForeignSessionCache deliberately doesn't filter these out; that's a
// general-purpose data cache, and this is a presentation decision made
// here instead, mirroring cli's picker.ts). Not "what's happening on
// the peer" in any useful sense, so it's excluded from that remote's
// own bucket, the same way a local dormant mirror is excluded from
// "local". Still visible under "all".
export function isDormantOnPeer(s: {
  importedFromMachine?: string;
  upstreamSessionId?: string;
}): boolean {
  return !!s.importedFromMachine && !s.upstreamSessionId;
}

// True when the currently-selected host filter IS the given imported-from
// machine, i.e. every card on screen already carries that provenance, so
// a per-card "← machine" badge would be pure noise. Matches the bare
// pre-namespacing value too, same fallback describeHostFilter uses.
export function isCurrentHostFilter(machine: string): boolean {
  return (
    state.hostFilter === `${HOST_FILTER_PREFIX}${machine}` || state.hostFilter === machine
  );
}

export function describeHostFilter(value: string): string {
  if (value.startsWith(REMOTE_FILTER_PREFIX)) {
    return `remote "${value.slice(REMOTE_FILTER_PREFIX.length)}"`;
  }
  if (value.startsWith(HOST_FILTER_PREFIX)) {
    return `host "${value.slice(HOST_FILTER_PREFIX.length)}"`;
  }
  return `host "${value}"`; // pre-namespacing persisted value
}

// Origins the host filter can offer, computed live from the session
// list so newly-imported peer hosts (or newly federated remotes) appear
// without a reload. Sentinel/namespaced filter values:
//   "__local"    sessions created here OR imported and bound to a local
//                agent. Federated (remote-set) sessions never land here.
//   "__all"      every session.
//   "host:<m>"   passive mirrors imported from machine <m> that haven't
//                been attached locally yet.
//   "remote:<n>" live sessions federated under the `hydra remote` named
//                <n>, excluding any that are themselves a dormant,
//                never-attached import mirror on that peer's own side
//                (isDormantOnPeer); those still show under "all".
// A peer host with no passive mirrors drops out of the list (its filter
// would render empty); a federated remote does too if every one of its
// sessions is a dormant mirror on the peer's side.
export function hostFilterSources(sessions: SessionInfo[]): {
  remotes: string[];
  hosts: string[];
} {
  const remotes = new Set<string>();
  const hosts = new Set<string>();
  for (const s of sessions) {
    if (s.remote) {
      if (!isDormantOnPeer(s)) {
        remotes.add(s.remote);
      }
      continue;
    }
    if (s.importedFromMachine && !s.upstreamSessionId) {
      hosts.add(s.importedFromMachine);
    }
  }
  return { remotes: [...remotes].sort(), hosts: [...hosts].sort() };
}

// Substring match across the same fields the TUI picker's `/` search
// covers (cli/src/tui/picker.ts matchesSearch): id, upstream id, agent,
// title and cwd. Case-insensitive, no fuzzy matching; typing a literal
// fragment of a path or title is what people actually do, and fuzzy
// matching makes short terms match almost everything.
export function matchesSessionSearch(s: SessionInfo, term: string): boolean {
  if (term.length === 0) {
    return true;
  }
  const t = term.toLowerCase();
  const haystacks = [
    shortSessionId(s.sessionId),
    s.upstreamSessionId ?? "",
    s.agentId ?? "",
    s.title ?? "",
    s.cwd,
    // The cards display cwd home-shortened, so "~/dev/foo" has to match
    // what the user can actually see. The TUI gets this from a real
    // $HOME; we only have the path, so collapse the usual container.
    s.cwd.replace(/^\/(?:home|Users)\/[^/]+/, "~"),
  ];
  return haystacks.some((h) => h.toLowerCase().includes(t));
}

export interface SessionListFilters {
  showCold: boolean;
  hostFilter: string;
  sessionSearch: string;
}

// The daemon returns everything; "show cold", the host filter and the
// search box are client-side passes, applied in that order.
export function filterSessions(
  sessions: SessionInfo[],
  f: SessionListFilters,
): SessionInfo[] {
  let visible = f.showCold ? sessions : sessions.filter((s) => s.status !== "cold");
  if (f.hostFilter === "__local") {
    visible = visible.filter(
      (s) => !s.remote && (!s.importedFromMachine || !!s.upstreamSessionId),
    );
  } else if (f.hostFilter.startsWith(REMOTE_FILTER_PREFIX)) {
    const name = f.hostFilter.slice(REMOTE_FILTER_PREFIX.length);
    visible = visible.filter((s) => s.remote === name && !isDormantOnPeer(s));
  } else if (f.hostFilter !== "__all") {
    const machine = f.hostFilter.startsWith(HOST_FILTER_PREFIX)
      ? f.hostFilter.slice(HOST_FILTER_PREFIX.length)
      : f.hostFilter; // pre-namespacing persisted value
    visible = visible.filter(
      (s) => s.importedFromMachine === machine && !s.upstreamSessionId,
    );
  }
  const term = f.sessionSearch.trim();
  if (term.length > 0) {
    visible = visible.filter((v) => matchesSessionSearch(v, term));
  }
  return visible;
}

export function visibleFilteredSessions(): SessionInfo[] {
  return filterSessions(state.sessions, state);
}

export interface SessionGroup {
  label: string | null;
  sessions: SessionInfo[];
}

// Groups already-ordered sessions by project (source cwd), groups sorted
// by path; each group keeps the incoming order. "recent" is one unlabeled
// group. Ordering itself is the caller's job (compareSessions, or a view's
// own stabilizing pass over it).
export function groupSessions(
  ordered: SessionInfo[],
  mode: "project" | "recent",
): SessionGroup[] {
  if (mode === "recent") {
    return [{ label: null, sessions: ordered }];
  }
  const map = new Map<string, SessionInfo[]>();
  for (const s of ordered) {
    const key = displayCwd(s) || "(unknown)";
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key)!.push(s);
  }
  const out: SessionGroup[] = [];
  for (const [cwd, items] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push({ label: shortenCwd(cwd), sessions: items });
  }
  return out;
}
