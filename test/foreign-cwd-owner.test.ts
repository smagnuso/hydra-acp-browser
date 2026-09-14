import { test } from "node:test";
import assert from "node:assert/strict";
import { foreignCwdOwner } from "../src/hydra/client.js";

test("foreignCwdOwner returns undefined for a plain local session", () => {
  assert.equal(foreignCwdOwner({}), undefined);
});

test("foreignCwdOwner returns the peer name for a live federated session", () => {
  assert.equal(foreignCwdOwner({ remote: "workbox" }), "workbox");
});

test("foreignCwdOwner returns the origin machine for a dormant import (never forked locally)", () => {
  assert.equal(
    foreignCwdOwner({ importedFromMachine: "old-laptop" }),
    "old-laptop",
  );
});

test("foreignCwdOwner returns undefined once a dormant import has been forked locally", () => {
  // upstreamSessionId set means the user already went through the
  // fork-cwd prompt and picked a real local cwd — the record is
  // genuinely local from here.
  assert.equal(
    foreignCwdOwner({
      importedFromMachine: "old-laptop",
      upstreamSessionId: "up_1",
    }),
    undefined,
  );
});

test("foreignCwdOwner prefers remote over importedFromMachine when both are set", () => {
  assert.equal(
    foreignCwdOwner({ remote: "workbox", importedFromMachine: "old-laptop" }),
    "workbox",
  );
});
