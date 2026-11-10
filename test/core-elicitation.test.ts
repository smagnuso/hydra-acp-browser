import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { document?: unknown }).document ??= {
  addEventListener() {},
  removeEventListener() {},
};
(globalThis as { window?: unknown }).window ??= { addEventListener() {} };

const e = await import("../src/core/elicitation.js");
const { state } = await import("../src/core/state.js");
const { handleAgentRequest, handleNotification } = await import("../src/core/acp.js");
const { respondElicitation } = await import("../src/core/bridge.js");
const { chatActivity } = await import("../src/core/activity.js");
import type { ChatState } from "../src/core/types.js";

const form = (extra: Record<string, unknown> = {}) => ({
  mode: "form",
  sessionId: "s1",
  message: "Pick one",
  requestedSchema: {
    type: "object",
    required: ["question_0"],
    properties: {
      question_0: {
        type: "string",
        title: "Color",
        description: "Which color?",
        oneOf: [
          { const: "red", title: "Red", description: "warm" },
          { const: "blue", title: "Blue" },
        ],
      },
      question_0_custom: { type: "string", title: "Other" },
      question_1: {
        type: "array",
        title: "Sizes",
        items: { anyOf: [{ const: "s", title: "Small" }, { const: "l", title: "Large" }] },
        minItems: 1,
      },
    },
  },
  _meta: { "hydra-acp": { elicitationId: "el1" } },
  ...extra,
});

test("a claude-acp form parses into choice, multi and custom text fields", () => {
  const parsed = e.parseElicitationRequest(3, form());
  assert.equal(parsed?.requestId, 3);
  assert.equal(parsed?.elicitationId, "el1");
  assert.equal(parsed?.message, "Pick one");
  const [q0, custom, q1] = parsed!.fields;
  assert.equal(q0!.kind, "choice");
  assert.equal(q0!.required, true);
  assert.deepEqual((q0 as { options: unknown[] }).options[0], { value: "red", title: "Red", description: "warm" });
  assert.equal(custom!.kind, "text");
  assert.equal(q1!.kind, "multi");
  const groups = e.groupElicitationFields(parsed!.fields);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.custom?.key, "question_0_custom");
  assert.equal(groups[1]!.custom, undefined);
});

test("scalar property kinds parse and non-form or empty requests are refused", () => {
  const p = e.parseElicitationRequest("x", {
    requestedSchema: {
      type: "object",
      properties: {
        n: { type: "number", minimum: 1 },
        i: { type: "integer" },
        b: { type: "boolean", default: true },
        s: { type: "string", enum: ["a", "b"] },
        weird: { type: "object" },
      },
    },
  });
  assert.deepEqual(p!.fields.map((f) => f.kind), ["number", "number", "boolean", "choice"]);
  assert.equal(p!.elicitationId, "x");
  assert.equal(e.parseElicitationRequest(1, form({ mode: "url" })), null);
  assert.equal(e.parseElicitationRequest(1, { requestedSchema: { type: "object", properties: {} } }), null);
  assert.equal(e.parseElicitationRequest(1, undefined), null);
});

test("required and bounds are validated", () => {
  const { fields } = e.parseElicitationRequest(1, form())!;
  assert.deepEqual(e.validateElicitation(fields, {}), { question_0: "Required" });
  assert.deepEqual(e.validateElicitation(fields, { question_0: "red" }), {});
  assert.equal(e.validateElicitation(fields, { question_0: "red", question_1: [] }).question_1, undefined);
  const nums = e.parseElicitationRequest(1, {
    requestedSchema: { type: "object", properties: { n: { type: "integer", minimum: 2 } } },
  })!.fields;
  assert.equal(e.validateElicitation(nums, { n: 1.5 }).n, "Enter a whole number");
  assert.equal(e.validateElicitation(nums, { n: 1 }).n, "At least 2");
  assert.deepEqual(e.validateElicitation(nums, {}), {});
});

test("results carry content for accept only and skip blank answers", () => {
  const { fields } = e.parseElicitationRequest(1, form())!;
  assert.deepEqual(e.elicitationResult("decline"), { action: "decline" });
  assert.deepEqual(e.elicitationResult("cancel", fields, { question_0: "red" }), { action: "cancel" });
  assert.deepEqual(
    e.elicitationResult("accept", fields, { question_0: "red", question_0_custom: "", question_1: ["s"] }),
    { action: "accept", content: { question_0: "red", question_1: ["s"] } },
  );
});

function chat(): { c: ChatState; sent: unknown[] } {
  const sent: unknown[] = [];
  const c = {
    sessionId: "s1",
    log: [],
    toolCalls: new Map(),
    pendingPermissions: new Map(),
    pendingElicitations: new Map(),
    ws: { readyState: 1, send: (d: string) => sent.push(JSON.parse(d)) },
    inTurn: false,
    spinner: null,
  } as unknown as ChatState;
  state.current = c;
  return { c, sent };
}

test("a form is held per elicitation, flips the chat to waiting and answers with the request id", () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = { OPEN: 1 };
  const { c, sent } = chat();
  handleAgentRequest({ jsonrpc: "2.0", id: 11, method: "elicitation/create", params: form() } as never);
  assert.equal(c.pendingElicitations.size, 1);
  assert.deepEqual(c.log, [{ kind: "elicit", elicitationId: "el1" }]);
  assert.equal(chatActivity(c).phase, "waiting");
  respondElicitation("el1", "accept", { question_0: "blue" });
  assert.deepEqual(sent, [
    { jsonrpc: "2.0", id: 11, result: { action: "accept", content: { question_0: "blue" } } },
  ]);
  assert.equal(c.pendingElicitations.size, 0);
  assert.equal(c.log.length, 0);
});

test("elicitation_resolved from another client drops the form", () => {
  const { c, sent } = chat();
  handleAgentRequest({ jsonrpc: "2.0", id: 12, method: "elicitation/create", params: form() } as never);
  handleNotification({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s1", update: { sessionUpdate: "elicitation_resolved", elicitationId: "el1" } },
  } as never);
  assert.equal(c.pendingElicitations.size, 0);
  assert.equal(c.log.length, 0);
  assert.deepEqual(sent, []);
});

test("a form this client cannot render is abstained from with MethodNotFound", () => {
  const { sent } = chat();
  handleAgentRequest({
    jsonrpc: "2.0",
    id: 13,
    method: "elicitation/create",
    params: form({ mode: "url" }),
  } as never);
  assert.equal((sent[0] as { error: { code: number } }).error.code, -32601);
});
