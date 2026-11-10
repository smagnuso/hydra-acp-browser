import { test } from "node:test";
import assert from "node:assert/strict";
import { runInitialize } from "../src/hydra/ws.js";

async function capabilities(opts?: Parameters<typeof runInitialize>[1]): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {};
  const conn = {
    request: async (_m: string, params: Record<string, unknown>) => {
      sent = params.clientCapabilities as Record<string, unknown>;
      return {};
    },
  };
  await runInitialize(conn as never, opts);
  return sent;
}

test("initialize omits elicitation unless the caller can render forms", async () => {
  const plain = await capabilities();
  assert.equal("elicitation" in plain, false);
  assert.equal(plain.terminal, false);
});

test("initialize advertises form elicitation for a form-capable connection", async () => {
  const caps = await capabilities({ elicitationForm: true });
  assert.deepEqual(caps.elicitation, { form: {} });
  assert.equal(caps.terminal, false);
});
