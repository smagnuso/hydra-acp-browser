import { test } from "node:test";
import assert from "node:assert/strict";
import { federatedRemoteName, isFederatedSessionId } from "../src/util/federation.js";

// Shapes taken from a live daemon holding 3394 sessions: every one of
// the 1968 federated ids carried a "<remote>:" prefix and none of the
// 1426 local ids contained a colon at all.
test("a federated id is recognised by its remote prefix", () => {
  assert.equal(isFederatedSessionId("mrclean:hydra_session_A5tBCYwRR1mUkIB3"), true);
  assert.equal(federatedRemoteName("mrclean:hydra_session_A5tBCYwRR1mUkIB3"), "mrclean");
});

test("a local id is not federated", () => {
  assert.equal(isFederatedSessionId("hydra_session_kHtAPiUCVEzfOte1"), false);
  assert.equal(federatedRemoteName("hydra_session_kHtAPiUCVEzfOte1"), null);
});

test("a malformed id is not foreign, matching the daemon's parser", () => {
  // parseForeignSessionId requires both halves to be non-empty and falls
  // through to local handling otherwise, so this agrees with it rather
  // than inventing a third answer. Not reachable from a real id:
  // formatForeignSessionId always builds `${name}:${localId}`, and
  // neither half can contain a colon.
  assert.equal(isFederatedSessionId(":hydra_session_x"), false);
  assert.equal(isFederatedSessionId("mrclean:"), false);
  assert.equal(federatedRemoteName(":hydra_session_x"), null);
});
