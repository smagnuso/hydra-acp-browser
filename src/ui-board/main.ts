// Board UI: sessions sorted by what needs you. Permission requests are
// answered right on the card (core/watch.ts keeps a light socket open per
// awaiting session); anything else opens a plain chat view. Imports only
// the public core surface.

import {
  state,
  setState,
  subscribe,
  installUiHooks,
  seedSessionCache,
  startPolling,
  loadAgents,
  loadConfig,
  initReadTracking,
  startPermissionWatching,
  watchedPermissionsFor,
  answerWatchedPermission,
  visibleFilteredSessions,
  hostFilterSources,
  openChat,
  closeChat,
  sendPrompt,
  sendCancel,
  respondPermission,
  permissionDetails,
  renderMarkdown,
  escapeHtml,
  formatRelativeAge,
  formatElapsed,
  agentWithModel,
  shortenCwd,
  displayCwd,
  api,
  type ChatState,
  type LogItem,
  type SessionInfo,
  type WatchedPermission,
} from "../core/index.js";

type Child = Node | string | null | false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    node.setAttribute(k, v);
  }
  for (const kid of kids) {
    if (kid) {
      node.append(kid);
    }
  }
  return node;
}

const IDLE_PAGE = 30;
let idleShown = IDLE_PAGE;

const app = document.getElementById("app")!;
const title = el("h1", {}, "Hydra board");
const back = el("button", { hidden: "" }, "Back");
const uiSelect = el("select", { hidden: "", title: "Switch UI" });
const header = el("header", {}, back, title, uiSelect);
const filters = el("div", { class: "filters" });
const search = el("input", { type: "search", placeholder: "Search sessions", "aria-label": "Search sessions" });
const chips = el("span", {});
chips.style.display = "contents";
filters.append(chips, search);
const boardBody = el("div", { class: "scroll" });
const board = el("div", {}, filters, boardBody);
board.style.display = "flex";
board.style.flexDirection = "column";
board.style.flex = "1";
board.style.minHeight = "0";
const chatBody = el("div", { class: "scroll", hidden: "" });
const input = el("textarea", { rows: "1", placeholder: "Message" });
const send = el("button", { class: "primary" }, "Send");
const stop = el("button", {}, "Stop");
const footer = el("footer", { hidden: "" }, input, send, stop);
app.append(header, board, chatBody, footer);

installUiHooks({
  readComposerDom: () => input.value,
  clearComposerDom: () => {
    input.value = "";
  },
});

back.addEventListener("click", () => closeChat());
input.addEventListener("input", () => {
  if (state.current) {
    state.current.composerValue = input.value;
  }
});
send.addEventListener("click", () => sendPrompt());
stop.addEventListener("click", () => sendCancel());
search.addEventListener("input", () => {
  idleShown = IDLE_PAGE;
  setState({ sessionSearch: search.value });
});
search.value = state.sessionSearch;

async function loadUiChoices(): Promise<void> {
  try {
    const res = await api<{ uis: string[]; current: string }>("/api/uis");
    if (res.uis.length < 2) {
      return;
    }
    uiSelect.replaceChildren(...res.uis.map((n) => el("option", { value: n }, n)));
    uiSelect.value = res.current;
    uiSelect.hidden = false;
    uiSelect.addEventListener("change", () => {
      window.location.assign(`/?ui=${encodeURIComponent(uiSelect.value)}`);
    });
  } catch {
    // no switcher without the list
  }
}

function hostTag(s: SessionInfo): string {
  return s.remote ?? s.importedFromMachine ?? "";
}

function subtitle(s: SessionInfo): HTMLElement {
  const tag = hostTag(s);
  return el(
    "div",
    { class: "sub" },
    `${shortenCwd(displayCwd(s))} · ${agentWithModel(s.agentId, s.currentModel)}`,
    tag ? el("span", { class: "host" }, tag) : null,
  );
}

function optionClass(kind: string | undefined): string {
  if (kind?.startsWith("allow")) {
    return "ok";
  }
  if (kind?.startsWith("reject")) {
    return "no";
  }
  return "alt";
}

function requestBlock(p: WatchedPermission): HTMLElement {
  const rows = permissionDetails(p.toolCall as Record<string, unknown>);
  const text = rows.map((r) => (r.label ? `${r.label}: ${r.value}` : r.value)).join("\n");
  const box = el("div", {});
  box.append(el("div", { class: "req" }, el("b", {}, String(p.toolCall.title ?? p.toolCall.name ?? "Permission request")), text ? `\n${text}` : ""));
  const btns = el("div", { class: "btns" });
  for (const o of p.options) {
    const b = el("button", { class: optionClass(o.kind) }, o.name ?? o.optionId);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      answerWatchedPermission(p.sessionId, p.toolCallId, o.optionId);
    });
    btns.append(b);
  }
  const open = el("button", { class: "alt" }, "Open");
  open.addEventListener("click", (e) => {
    e.stopPropagation();
    openChat(p.sessionId);
  });
  btns.append(open);
  box.append(btns);
  return box;
}

function needCard(s: SessionInfo): HTMLElement {
  const requests = watchedPermissionsFor(s.sessionId);
  const card = el(
    "div",
    { class: "card need", "data-session-id": s.sessionId },
    el(
      "div",
      { class: "top" },
      el("div", {}, el("div", { class: "t" }, s.title || "untitled"), subtitle(s)),
      el("div", { class: "sub" }, formatRelativeAge(s.updatedAt)),
    ),
  );
  if (requests.length === 0) {
    card.append(el("div", { class: "note" }, "Waiting on you. Open to see what it needs."));
  }
  for (const r of requests) {
    card.append(requestBlock(r));
  }
  card.addEventListener("click", () => openChat(s.sessionId));
  return card;
}

function workingCard(s: SessionInfo): HTMLElement {
  const elapsed = s.turnStartedAt ? formatElapsed(Date.now() - s.turnStartedAt) : "";
  const card = el(
    "div",
    { class: "card", "data-session-id": s.sessionId },
    el(
      "div",
      { class: "top" },
      el("div", { class: "t" }, el("span", { class: "dot" }), s.title || "untitled"),
      el("div", { class: "sub" }, elapsed),
    ),
    subtitle(s),
  );
  card.addEventListener("click", () => openChat(s.sessionId));
  return card;
}

function idleRow(s: SessionInfo): HTMLElement {
  const row = el(
    "div",
    { class: "idle", "data-session-id": s.sessionId },
    el("span", {}, s.title || "untitled"),
    el("span", {}, formatRelativeAge(s.updatedAt)),
  );
  row.addEventListener("click", () => openChat(s.sessionId));
  return row;
}

function byRecent(a: SessionInfo, b: SessionInfo): number {
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

function renderChips(): void {
  const { remotes, hosts } = hostFilterSources(state.sessions);
  const options: Array<[string, string]> = [
    ["__all", "all"],
    ["__local", "local"],
    ...remotes.map((r): [string, string] => [`remote:${r}`, r]),
    ...hosts.map((h): [string, string] => [`host:${h}`, h]),
  ];
  chips.replaceChildren(
    ...options.map(([value, label]) => {
      const c = el("button", { class: state.hostFilter === value ? "chip on" : "chip" }, label);
      c.addEventListener("click", () => {
        idleShown = IDLE_PAGE;
        setState({ hostFilter: value });
      });
      return c;
    }),
  );
}

function section(label: string, count: number, tone: "n" | "w" | "i"): HTMLElement {
  const cls = count === 0 && tone !== "i" ? "n z" : tone === "n" ? "n" : `n ${tone}`;
  return el("h2", {}, label, el("span", { class: cls }, String(count)));
}

function renderBoard(): void {
  renderChips();
  const visible = visibleFilteredSessions();
  const needs = visible.filter((s) => s.awaitingInput).sort(byRecent);
  const working = visible.filter((s) => s.busy && !s.awaitingInput).sort(byRecent);
  const idle = visible.filter((s) => !s.awaitingInput && !s.busy).sort(byRecent);

  const colNeeds = el("div", {}, section("Needs you", needs.length, "n"));
  if (needs.length === 0) {
    colNeeds.append(el("div", { class: "empty" }, "Nothing is waiting on you."));
  }
  colNeeds.append(...needs.map(needCard));

  const colWorking = el("div", {}, section("Working", working.length, "w"));
  if (working.length === 0) {
    colWorking.append(el("div", { class: "empty" }, "No agents are running."));
  }
  colWorking.append(...working.map(workingCard));

  const colIdle = el("div", {}, section("Idle", idle.length, "i"));
  colIdle.append(...idle.slice(0, idleShown).map(idleRow));
  if (idle.length > idleShown) {
    const more = el("button", { class: "more" }, `Show more (${idle.length - idleShown})`);
    more.addEventListener("click", () => {
      idleShown += IDLE_PAGE;
      render();
    });
    colIdle.append(more);
  }

  boardBody.replaceChildren(el("div", { class: "cols" }, colNeeds, colWorking, colIdle));
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
      return el("div", { class: "empty" }, item.text);
    case "error":
      return el("div", { class: "msg error" }, item.text);
    case "spinner":
      return el("div", { class: "empty" }, `working (${item.spinner.toolCallIds.length} tools)`);
    case "turn-stamp":
      return el("div", { class: "empty" }, `${item.toolCount} tools, ${Math.round(item.elapsedMs / 1000)}s`);
    case "perm": {
      const entry = c.pendingPermissions.get(item.toolCallId);
      if (!entry) {
        return null;
      }
      const box = el("div", { class: "perm" }, el("b", {}, String(entry.toolCall.title ?? entry.toolCall.name ?? "Permission request")));
      const btns = el("div", { class: "btns" });
      for (const o of entry.options) {
        const b = el("button", { class: optionClass(o.kind) }, o.name ?? o.optionId);
        b.addEventListener("click", () => respondPermission(item.toolCallId, o.optionId));
        btns.append(b);
      }
      box.append(btns);
      return box;
    }
    case "exit-plan-mode": {
      const box = el("div", { class: "msg" });
      box.innerHTML = renderMarkdown(item.plan);
      return box;
    }
    case "edit-diff":
      return el("div", { class: "empty" }, `edit ${item.diff.path ?? ""}`);
    case "image":
      return el("div", { class: "empty" }, "[image]");
    default:
      return null;
  }
}

function renderChat(c: ChatState): void {
  const nearBottom = chatBody.scrollHeight - chatBody.scrollTop - chatBody.clientHeight < 120;
  const nodes: Node[] = [];
  if (!c.ready) {
    nodes.push(el("div", { class: "empty" }, c.cold ? "cold" : c.sessionGone ? "session not found" : "connecting"));
  }
  for (const item of c.log) {
    const n = logNode(c, item);
    if (n) {
      nodes.push(n);
    }
  }
  chatBody.replaceChildren(el("div", { class: "chatwrap" }, ...nodes));
  if (nearBottom) {
    chatBody.scrollTop = chatBody.scrollHeight;
  }
}

function render(): void {
  const c = state.view === "chat" ? state.current : null;
  const inChat = c !== null;
  back.hidden = !inChat;
  board.hidden = inChat;
  chatBody.hidden = !inChat;
  footer.hidden = !inChat;
  title.textContent = c ? c.title || c.sessionId.slice(0, 8) : "Hydra board";
  if (c) {
    stop.hidden = !c.inTurn;
    renderChat(c);
  } else {
    renderBoard();
  }
}

// A rebuild mid-tap can drop the click, so hold renders while a pointer is
// down and flush on release.
let scheduled = false;
let pointerDown = false;
function schedule(): void {
  if (scheduled || pointerDown) {
    return;
  }
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    render();
  });
}
document.addEventListener("pointerdown", () => {
  pointerDown = true;
}, true);
const release = (): void => {
  pointerDown = false;
  setTimeout(schedule, 50);
};
document.addEventListener("pointerup", release, true);
document.addEventListener("pointercancel", release, true);

subscribe(schedule);

window.addEventListener("DOMContentLoaded", async () => {
  await seedSessionCache();
  startPolling();
  void loadAgents();
  void loadConfig();
  initReadTracking();
  startPermissionWatching();
  void loadUiChoices();
  render();
});
