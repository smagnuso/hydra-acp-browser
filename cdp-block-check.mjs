import WebSocket from "ws";
async function main() {
  const version = await (await fetch("http://localhost:9338/json/version")).json();
  const browserWs = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => browserWs.once("open", r));
  const rpcTop = (method, params = {}) => {
    const id = Math.floor(Math.random() * 1e9);
    return new Promise((resolve, reject) => {
      const onMsg = (data) => { const msg = JSON.parse(data.toString()); if (msg.id === id) { browserWs.off("message", onMsg); if (msg.error) reject(msg.error); else resolve(msg.result); } };
      browserWs.on("message", onMsg);
      browserWs.send(JSON.stringify({ id, method, params }));
    });
  };
  const { targetId } = await rpcTop("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await rpcTop("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params = {}) => {
    const id = Math.floor(Math.random() * 1e9);
    return new Promise((resolve, reject) => {
      const onMsg = (data) => { const msg = JSON.parse(data.toString()); if (msg.sessionId === sessionId && msg.id === id) { browserWs.off("message", onMsg); if (msg.error) reject(msg.error); else resolve(msg.result); } };
      browserWs.on("message", onMsg);
      browserWs.send(JSON.stringify({ id, method, params, sessionId }));
    });
  };
  await send("Network.enable");
  await send("Network.setBlockedURLs", { urls: ["*/ws?*"] });
  let events = [];
  const onMsg = (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.sessionId === sessionId && (msg.method === "Network.webSocketCreated" || msg.method === "Network.webSocketFrameError")) {
      events.push(msg.method + " " + JSON.stringify(msg.params).slice(0,200));
    }
  };
  browserWs.on("message", onMsg);
  await send("Page.navigate", { url: "wss://localhost:5514/ws?session=test123" }); // this won't work directly, use evaluate instead
  await new Promise(r => setTimeout(r, 500));
  const evalJs = async (expr) => { const res = await send("Runtime.evaluate", {expression: expr, returnByValue:true, awaitPromise:true}); return res; };
  await send("Page.navigate", { url: "about:blank" });
  await evalJs(`
    (function(){
      window.__wsResult = 'pending';
      const ws = new WebSocket('wss://localhost:5514/ws?session=test123');
      ws.onopen = () => { window.__wsResult = 'open'; };
      ws.onerror = () => { window.__wsResult = 'error'; };
      ws.onclose = (e) => { window.__wsResult = 'closed:' + e.code; };
    })()
  `);
  await new Promise(r => setTimeout(r, 1000));
  console.log("wsResult:", (await evalJs("window.__wsResult")).result.value);
  console.log("events:", events);
  browserWs.close();
}
main().catch(e=>{console.error(e);process.exit(1);});
