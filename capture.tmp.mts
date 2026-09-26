import fs from "node:fs";
import WebSocket from "ws";

const token = fs.readFileSync("/home/smagnuson/.hydra-acp/auth-token", "utf8").trim();
const sessionId = "hydra_session_kOyaw60HrZlG841X";
const url = "wss://127.0.0.1:55514/acp";

const ws = new WebSocket(url, ["acp.v1", `hydra-acp-token.${token}`], {
  rejectUnauthorized: false,
});

const out: unknown[] = [];
let nextId = 1;
const pending = new Map<number, (r: any) => void>();

function req(method: string, params: unknown): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  return new Promise((res) => pending.set(id, res));
}

ws.on("message", (data) => {
  const m = JSON.parse(String(data));
  if (m.id !== undefined && m.method === undefined) {
    pending.get(m.id)?.(m);
    return;
  }
  if (m.method) {
    out.push(m);
  }
});

ws.on("open", async () => {
  await req("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: { name: "repro-capture", version: "0.0.1" },
  });
  const attach = await req("session/attach", {
    sessionId,
    historyPolicy: "full",
    clientInfo: { name: "repro-capture", version: "0.0.1" },
  });
  setTimeout(() => {
    fs.writeFileSync("/tmp/capture.json", JSON.stringify({ attach: attach.result, frames: out }, null, 0));
    console.log("attach policy:", attach.result?.historyPolicy, "frames:", out.length);
    ws.close();
    process.exit(0);
  }, 3000);
});
ws.on("error", (e) => { console.error("err", e.message); process.exit(1); });
