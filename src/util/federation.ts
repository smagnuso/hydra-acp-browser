// A session living on a federated peer (hydra's `remote add`) rather
// than on this daemon. Its id carries the remote's name as a prefix —
// "mrclean:hydra_session_A5tB…" versus a local "hydra_session_kHtA…" —
// which is the only signal available everywhere: GET /v1/sessions
// reports a `remote` field, but GET /v1/sessions/<id> does not, so the
// WS bridge has nothing else to go on. Verified against a live daemon
// holding 3394 sessions: 0 of 1426 local ids contained a colon, all
// 1968 federated ones did, and the prefix matched the remote's name
// every time.
//
// This matters because everything file-related in this server reads its
// OWN disk. A federated session's cwd is a path on the peer, and with
// the same username on both machines that path usually exists here too
// — so resolving it locally doesn't fail, it quietly serves a different
// machine's file under the remote session's name.
export function isFederatedSessionId(sessionId: string): boolean {
  return federatedRemoteName(sessionId) !== null;
}

// The peer's name, for messages explaining why a file isn't available.
// Same rule as the daemon's own parseForeignSessionId
// (cli/src/core/foreign-session-id.ts): split on the first colon, and
// both halves must be non-empty. The split is unambiguous because peer
// names cannot contain a colon (PEER_NAME_PATTERN) and local ids are
// alphanumeric (HYDRA_ID_ALPHABET), so the prefix is always exactly the
// remote's name — formatForeignSessionId builds the id as
// `${name}:${localId}` and nothing else produces one.
export function federatedRemoteName(sessionId: string): string | null {
  const colon = sessionId.indexOf(":");
  if (colon === -1) return null;
  const name = sessionId.slice(0, colon);
  const localId = sessionId.slice(colon + 1);
  return name.length > 0 && localId.length > 0 ? name : null;
}
