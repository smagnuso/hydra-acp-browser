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

test("a leading colon names no remote", () => {
  // Still treated as federated, since the safe answer when an id is not
  // a plain local one is to refuse to touch local disk for it.
  assert.equal(isFederatedSessionId(":hydra_session_x"), true);
  assert.equal(federatedRemoteName(":hydra_session_x"), null);
});
