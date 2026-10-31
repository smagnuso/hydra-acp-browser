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
  ensureServiceWorker,
  setNotifications,
  resumeNotifications,
  trackPresence,
  watchedPermissionsFor,
  answerWatchedPermission,
  visibleFilteredSessions,
  hostFilterChoices,
  sessionActivity,
  compareSessions,
  permissionOptionTone,
  loadUiChoices,
  uiSwitchUrl,
  watchTheme,
  resolvedTheme,
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
const themeSelect = el(
  "select",
  { title: "Theme" },
  el("option", { value: "system" }, "system"),
  el("option", { value: "dark" }, "dark"),
  el("option", { value: "light" }, "light"),
);
const notifyBtn = el("button", { title: "Notify me when an agent is waiting on you" });
const header = el("header", {}, back, title, notifyBtn, themeSelect, uiSelect);
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

function applyTheme(): void {
  document.documentElement.setAttribute("data-theme", resolvedTheme());
}
themeSelect.value = state.theme;
themeSelect.addEventListener("change", () => {
  setState({ theme: themeSelect.value as typeof state.theme });
  applyTheme();
});
watchTheme((theme) => document.documentElement.setAttribute("data-theme", theme));

function paintNotify(): void {
  notifyBtn.textContent = state.notifyOnTurnEnd ? "Notify: on" : "Notify: off";
}
notifyBtn.addEventListener("click", async () => {
  const result = await setNotifications(!state.notifyOnTurnEnd);
  if (result === "blocked") {
    window.alert("Notifications are blocked. Enable them for this site in your browser settings.");
  }
  paintNotify();
});
paintNotify();

// Swipe right to go back to the board. Decided while the finger moves, not
// on release: phones often cancel a touch (the scroller or the system claims
// it) and a release-only handler then never fires. Direction is locked after
// a few pixels so vertical scrolling is never mistaken for a swipe, and code
// blocks, which scroll sideways themselves, are left alone.
const SWIPE_ZONE = 0.6;
const SWIPE_LOCK_PX = 12;
const SWIPE_TRIGGER_PX = 70;
let swipe: { x: number; y: number; lock: "h" | "v" | null } | null = null;
chatBody.addEventListener("touchstart", (e) => {
  const t = e.touches[0];
  const target = e.target as Element | null;
  const inScrollable = !!target?.closest?.("pre, table, textarea, input");
  swipe =
    t && !inScrollable && e.touches.length === 1 && t.clientX < window.innerWidth * SWIPE_ZONE
      ? { x: t.clientX, y: t.clientY, lock: null }
      : null;
}, { passive: true });
chatBody.addEventListener("touchmove", (e) => {
  const t = e.touches[0];
  if (!swipe || !t) {
    return;
  }
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  if (swipe.lock === null && Math.max(Math.abs(dx), Math.abs(dy)) > SWIPE_LOCK_PX) {
    swipe.lock = Math.abs(dx) > Math.abs(dy) * 1.2 && dx > 0 ? "h" : "v";
  }
  if (swipe.lock === "h" && dx > SWIPE_TRIGGER_PX) {
    swipe = null;
    closeChat();
  }
}, { passive: true });
const endSwipe = (): void => {
  swipe = null;
};
chatBody.addEventListener("touchend", endSwipe, { passive: true });
chatBody.addEventListener("touchcancel", endSwipe, { passive: true });

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

async function showUiChoices(): Promise<void> {
  try {
    const res = await loadUiChoices();
    if (res.uis.length < 2) {
      return;
    }
    uiSelect.replaceChildren(...res.uis.map((n) => el("option", { value: n }, n)));
    uiSelect.value = res.current;
    uiSelect.hidden = false;
    uiSelect.addEventListener("change", () => {
      window.location.assign(uiSwitchUrl(uiSelect.value));
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
  return { allow: "ok", reject: "no", neutral: "alt" }[permissionOptionTone(kind)];
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

function renderChips(): void {
  const options: Array<[string, string]> = [
    ["__all", "all"],
    ...hostFilterChoices(state.sessions)
      .filter((c) => c.value !== "__all")
      .map((c): [string, string] => [c.value, c.label]),
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
  const needs = visible.filter((s) => sessionActivity(s) === "needs-you").sort(compareSessions);
  const working = visible.filter((s) => sessionActivity(s) === "working").sort(compareSessions);
  const idle = visible.filter((s) => sessionActivity(s) === "idle").sort(compareSessions);

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

// Size #app to what is actually visible. 100% is the layout viewport, which
// on phones is taller than the visible area (address bar) and does not
// shrink for the keyboard, leaving the composer below the fold.
function fitViewport(): void {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-h", `${Math.round(height)}px`);
  app.style.transform = vv && vv.offsetTop > 0 ? `translateY(${Math.round(vv.offsetTop)}px)` : "";
}
fitViewport();
window.visualViewport?.addEventListener("resize", fitViewport);
window.visualViewport?.addEventListener("scroll", fitViewport);
window.addEventListener("resize", fitViewport);
window.addEventListener("orientationchange", fitViewport);

// Keep the newest message in view when the keyboard opens.
input.addEventListener("focus", () => {
  setTimeout(() => {
    chatBody.scrollTop = chatBody.scrollHeight;
  }, 300);
});

function render(): void {
  const c = state.view === "chat" ? state.current : null;
  const inChat = c !== null;
  // The chat header only has room for Back and the title on a phone.
  notifyBtn.hidden = inChat;
  themeSelect.hidden = inChat;
  uiSelect.hidden = inChat || uiSelect.options.length < 2;
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
  void ensureServiceWorker();
  trackPresence();
  void resumeNotifications();
  void showUiChoices();
  render();
});
