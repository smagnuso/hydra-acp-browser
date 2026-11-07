#!/usr/bin/env node
// Minimal ACP agent for the README screenshot daemon: speaks just enough
// JSON-RPC over stdio for the daemon to create, load and prompt sessions.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
let n = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) {
    return;
  }
  switch (m.method) {
    case "initialize":
      send({
        id: m.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: {} },
          authMethods: [],
        },
      });
      break;
    case "session/new":
      send({ id: m.id, result: { sessionId: `fake_${Date.now()}_${n++}` } });
      break;
    case "session/prompt":
      send({
        method: "session/update",
        params: {
          sessionId: m.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "This is a demo agent." },
          },
        },
      });
      send({ id: m.id, result: { stopReason: "end_turn" } });
      break;
    default:
      send({ id: m.id, result: {} });
  }
});
