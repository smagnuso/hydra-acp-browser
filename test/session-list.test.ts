import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};

const {
  filterSessions,
  groupSessions,
  hostFilterSources,
  matchesSessionSearch,
  shortSessionId,
  shortenCwd,
  displayCwd,
  describeHostFilter,
  isDormantOnPeer,
} = await import("../src/core/session-list.js");
import type { SessionInfo } from "../src/core/types.js";

const s = (o: Partial<SessionInfo> & { sessionId: string }): SessionInfo =>
  ({ cwd: "/home/u/proj", ...o }) as SessionInfo;

const all = { showCold: true, hostFilter: "__all", sessionSearch: "" };

const local = s({ sessionId: "hydra_session_a", title: "Fix bug" });
const cold = s({ sessionId: "hydra_session_b", status: "cold" });
const peer = s({ sessionId: "p:hydra_session_c", remote: "peer" });
const dormantPeer = s({
  sessionId: "p:hydra_session_d",
  remote: "peer",
  importedFromMachine: "box",
});
const mirror = s({ sessionId: "hydra_session_e", importedFromMachine: "box" });
const boundImport = s({
  sessionId: "hydra_session_f",
  importedFromMachine: "box",
  upstreamSessionId: "up",
});
const every = [local, cold, peer, dormantPeer, mirror, boundImport];
const ids = (xs: SessionInfo[]) => xs.map((x) => x.sessionId);

test("short ids drop the peer prefix and hydra_session_", () => {
  assert.equal(shortSessionId("p:hydra_session_abc"), "abc");
  assert.equal(shortSessionId("hydra_session_abc"), "abc");
  assert.equal(shortSessionId("plain"), "plain");
});

test("cwd helpers collapse home and prefer the workspace source", () => {
  assert.equal(shortenCwd("/home/u/x"), "~/x");
  assert.equal(shortenCwd("/Users/u/x"), "~/x");
  assert.equal(shortenCwd("/srv/x"), "/srv/x");
  assert.equal(
    displayCwd(s({ sessionId: "w", workspace: { sourceCwd: "/src" } } as never)),
    "/src",
  );
});

test("showCold=false hides cold sessions", () => {
  assert.ok(!ids(filterSessions(every, { ...all, showCold: false })).includes(cold.sessionId));
  assert.ok(ids(filterSessions(every, all)).includes(cold.sessionId));
});

test("the local filter excludes remotes and unbound import mirrors", () => {
  const out = ids(filterSessions(every, { ...all, hostFilter: "__local" }));
  assert.deepEqual(out, [local.sessionId, cold.sessionId, boundImport.sessionId]);
});

test("a remote filter shows its live sessions, not its dormant mirrors", () => {
  const out = ids(filterSessions(every, { ...all, hostFilter: "remote:peer" }));
  assert.deepEqual(out, [peer.sessionId]);
});

test("a host filter shows unbound mirrors from that machine, bare or prefixed", () => {
  for (const hostFilter of ["host:box", "box"]) {
    assert.deepEqual(
      ids(filterSessions(every, { ...all, hostFilter })),
      [dormantPeer.sessionId, mirror.sessionId],
    );
  }
});

test("search matches title, id, agent and the home-shortened cwd", () => {
  assert.ok(matchesSessionSearch(local, "FIX"));
  assert.ok(matchesSessionSearch(s({ sessionId: "hydra_session_a1b2" }), "a1b2"));
  assert.ok(matchesSessionSearch(s({ sessionId: "x", agentId: "claude" }), "CLAU"));
  assert.ok(matchesSessionSearch(local, "~/proj"));
  assert.ok(!matchesSessionSearch(local, "nope"));
  assert.deepEqual(
    ids(filterSessions(every, { ...all, sessionSearch: "  fix  " })),
    [local.sessionId],
  );
});

test("host filter sources list live remotes and unbound import hosts", () => {
  assert.deepEqual(hostFilterSources(every), { remotes: ["peer"], hosts: ["box"] });
  assert.deepEqual(hostFilterSources([dormantPeer]), { remotes: [], hosts: [] });
});

test("dormant-on-peer and filter descriptions", () => {
  assert.equal(isDormantOnPeer(dormantPeer), true);
  assert.equal(isDormantOnPeer(peer), false);
  assert.equal(describeHostFilter("remote:peer"), 'remote "peer"');
  assert.equal(describeHostFilter("host:box"), 'host "box"');
  assert.equal(describeHostFilter("box"), 'host "box"');
});

test("grouping by project sorts groups by path and keeps order within", () => {
  const a1 = s({ sessionId: "1", cwd: "/home/u/b" });
  const a2 = s({ sessionId: "2", cwd: "/home/u/a" });
  const a3 = s({ sessionId: "3", cwd: "/home/u/b" });
  const groups = groupSessions([a1, a2, a3], "project");
  assert.deepEqual(groups.map((g) => g.label), ["~/a", "~/b"]);
  assert.deepEqual(ids(groups[1]!.sessions), ["1", "3"]);
  const recent = groupSessions([a1, a2, a3], "recent");
  assert.equal(recent.length, 1);
  assert.equal(recent[0]!.label, null);
});
