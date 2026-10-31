// Minimal second UI. Imports only the public core surface; everything
// here is rendering. Static chrome is built once so the composer keeps
// focus; only the list and the transcript are rebuilt on state changes.

import {
  state,
  subscribe,
  installUiHooks,
  seedSessionCache,
  startPolling,
  loadAgents,
  loadConfig,
  openChat,
  closeChat,
  sendPrompt,
  sendCancel,
  respondPermission,
  createSession,
  renderMarkdown,
  escapeHtml,
  type ChatState,
  type LogItem,
  type SessionInfo,
} from "../core/index.js";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  ...kids: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    node.setAttribute(k, v);
  }
  node.append(...kids);
  return node;
}

const app = document.getElementById("app")!;
const title = el("h1", {}, "Hydra");
const back = el("button", { hidden: "" }, "Back");
const newBtn = el("button", {}, "New");
const classic = el("a", { class: "btn", href: "/?ui=classic" }, "Classic UI");
const header = el("header", {}, back, title, newBtn, classic);
const listBody = el("div", { class: "scroll" });
const chatBody = el("div", { class: "scroll", hidden: "" });
const input = el("textarea", { rows: "1", placeholder: "Message" });
const send = el("button", { class: "primary" }, "Send");
const stop = el("button", {}, "Stop");
const footer = el("footer", { hidden: "" }, input, send, stop);
app.append(header, listBody, chatBody, footer);

installUiHooks({
  readComposerDom: () => input.value,
  clearComposerDom: () => {
    input.value = "";
  },
});

back.addEventListener("click", () => closeChat());
newBtn.addEventListener("click", async () => {
  const cwd = window.prompt("Working directory", state.defaultCwd ?? "");
  if (!cwd) {
    return;
  }
  try {
    const made = await createSession({ cwd });
    if (made.sessionId) {
      openChat(made.sessionId);
    }
  } catch (err) {
    window.alert((err as Error).message);
  }
});
input.addEventListener("input", () => {
  if (state.current) {
    state.current.composerValue = input.value;
  }
});
send.addEventListener("click", () => sendPrompt());
stop.addEventListener("click", () => sendCancel());

function sessionRow(s: SessionInfo): HTMLElement {
  const flags = [s.awaitingInput ? "needs you" : "", s.busy ? "working" : ""].filter(Boolean);
  const row = el(
    "div",
    { class: s.status === "cold" ? "row cold" : "row" },
    el("div", {}, s.title || s.sessionId.slice(0, 8), el("span", { class: "badge" }, flags.join(", "))),
    el("div", { class: "sub" }, `${s.agentId ?? ""} ${s.cwd}`),
  );
  row.addEventListener("click", () => openChat(s.sessionId));
  return row;
}

function renderList(): void {
  const sorted = [...state.sessions].sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  listBody.replaceChildren(...sorted.map(sessionRow));
}

function logNode(c: ChatState, item: LogItem): Node | null {
  switch (item.kind) {
    case "stream": {
      if (item.role === "thought") {
        return null;
      }
      const box = el("div", { class: item.role === "user" ? "msg user" : "msg" });
      box.innerHTML =
        item.role === "user" ? escapeHtml(item.text) : renderMarkdown(item.text, c.fileMentions);
      return box;
    }
    case "system":
      return el("div", { class: "note" }, item.text);
    case "error":
      return el("div", { class: "msg error" }, item.text);
    case "spinner":
      return el("div", { class: "note" }, `working (${item.spinner.toolCallIds.length} tools)`);
    case "turn-stamp":
      return el("div", { class: "note" }, `${item.toolCount} tools, ${Math.round(item.elapsedMs / 1000)}s`);
    case "perm": {
      const entry = c.pendingPermissions.get(item.toolCallId);
      if (!entry) {
        return null;
      }
      const box = el("div", { class: "perm" }, entry.toolCall.title ?? entry.toolCall.name ?? "Permission");
      box.append(el("br"));
      for (const o of entry.options) {
        const b = el("button", {}, o.name ?? o.optionId);
        b.addEventListener("click", () => respondPermission(item.toolCallId, o.optionId));
        box.append(b);
      }
      return box;
    }
    case "exit-plan-mode": {
      const box = el("div", { class: "msg" });
      box.innerHTML = renderMarkdown(item.plan);
      return box;
    }
    case "edit-diff":
      return el("div", { class: "note" }, `edit ${item.diff.path ?? ""}`);
    case "image":
      return el("div", { class: "note" }, "[image]");
    default:
      return null;
  }
}

function renderChat(c: ChatState): void {
  const nearBottom =
    chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < 120;
  const nodes: Node[] = [];
  if (!c.ready) {
    nodes.push(el("div", { class: "note" }, c.cold ? "cold" : c.sessionGone ? "session not found" : "connecting"));
  }
  for (const item of c.log) {
    const n = logNode(c, item);
    if (n) {
      nodes.push(n);
    }
  }
  chatBody.replaceChildren(...nodes);
  if (nearBottom) {
    chatBody.scrollTop = chatBody.scrollHeight;
  }
}

let scheduled = false;
function render(): void {
  const c = state.view === "chat" ? state.current : null;
  const inChat = c !== null;
  back.hidden = !inChat;
  newBtn.hidden = inChat;
  listBody.hidden = inChat;
  chatBody.hidden = !inChat;
  footer.hidden = !inChat;
  title.textContent = c ? c.title || c.sessionId.slice(0, 8) : "Hydra";
  if (c) {
    stop.hidden = !c.inTurn;
    renderChat(c);
  } else {
    renderList();
  }
}

subscribe(() => {
  if (scheduled) {
    return;
  }
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    render();
  });
});

window.addEventListener("DOMContentLoaded", async () => {
  await seedSessionCache();
  startPolling();
  void loadAgents();
  void loadConfig();
  render();
});
