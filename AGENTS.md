# AGENTS.md

Brief for AI agents working in this repo.

## What this is

`hydra-acp-browser` — a browser-based UI **extension** for Hydra. Serves a
small single-page app on localhost that lists live sessions, mirrors them
in real time, and lets you prompt, approve permission requests, switch
modes/models, create/kill sessions, and browse the project files of any
session — from a phone or laptop browser.

The hydra master token never leaves the machine. The browser authenticates
with a separate per-host authkey stored under `~/.hydra-acp/browser/`.

## How it fits into Hydra

Hydra is a multi-client ACP session daemon. Full docs and wire protocol
live at [`smagnuso/hydra-acp`](https://github.com/smagnuso/hydra-acp) — see
`cli/PROTOCOL.md`.

This is a **client extension**: the server-side process connects to the
daemon over REST + WSS using `HYDRA_ACP_TOKEN` and re-exposes a scoped
subset to the browser SPA over its own HTTP + WS surface, gated by the
per-host authkey.

## Layout

- `src/index.ts` — entry point
- `src/server/` — HTTP + WS server the browser talks to
  (`/api/sessions`, `/api/agents`, `/api/kill`, `/api/files/*`,
  `/ws?session=<id>`, …)
- `src/hydra/` — client-side adapter to the daemon (REST + WSS)
- `src/core/` — UI-agnostic client logic (ACP reducer, bridge, queue,
  caches, state). Public surface is `src/core/index.ts`; see
  `docs/ui-core.md`.
- `src/ui-<name>/` — one SPA per directory (`ui-classic` is the real
  one, `ui-min` a small example). Each builds to `dist/ui/<name>/`.
- `src/config.ts`, `src/util/` — config resolution, shared plumbing

Two build steps: `build:server` (tsc → `dist/`) and `build:ui` (builds every
`src/ui-*`; `build:ui -- <name>` builds one). Top-level `build` runs both.
The server serves all built UIs; a browser picks one with `/?ui=<name>`
(cookie `hb_ui`), or the classic Options dialog dropdown. Wire contract:
`docs/api.md`.

## Model/view split: read this before touching client code

There is more than one UI (`ui-classic`, `ui-min`, and more to come), and
the user picks between them at runtime. All of them share `src/core/`, the
**model**: state, the ACP update reducer, WebSocket bridge, prompt queue,
caches, polling and session actions. Each `src/ui-<name>/` is a **view**:
it only renders and translates user gestures into core calls. Treat any
change as a model change or a view change, never both tangled together.

Rules:

1. **Behavior goes in `core/`, presentation goes in a view.** If a feature
   changes what happens (a request is sent, state changes, data is merged,
   a rule is decided), it belongs in `core/` and must work with no DOM. If
   it only changes how something looks or is tapped, it belongs in the
   view. A new `fetch`, a new state field, or a new decision inside
   `views.ts` is the sign that logic is leaking into a view.
2. **`core/` never imports a UI and never touches `document`/`window`**
   except through `platform.ts` (`test/core-boundary.test.ts` enforces
   both). No element lookups, no `innerHTML`, no focus, scroll, or layout
   reads.
3. **Core asks the view for things through `uiHooks`** (`core/hooks.ts`),
   for example "scroll to bottom" or "read the composer text". A UI
   installs the hooks it supports at startup; unset hooks are inert, so
   core must work when a hook does nothing. Add a hook only for a
   view-layer behavior core genuinely needs; prefer state the view can
   read.
4. **The view learns about changes through `subscribe()`**, and never the
   other way around. Core calls `notifyChange()`; it must not call a
   renderer. Views may coalesce or throttle however they like.
5. **A new capability that every UI could want is added to `core/` and
   exported from `core/index.ts`** (see `core/actions.ts` for the shape:
   a plain async function that throws on failure). Confirm dialogs, banners
   and modals stay in the view and wrap the core call.
6. **Do not fix a bug in one UI's copy of shared logic.** Find the shared
   function in `core/` and fix it there so every UI gets it.
7. **Server API changes are shared too.** A route or WebSocket method added
   for one UI is available to all of them, so update `docs/api.md` and keep
   the scoped-subset rule below.

When adding a feature, the usual order is: extend `core/` (with a test
that needs no DOM), export it from `core/index.ts`, document it in
`docs/ui-core.md` if it changes the contract, then wire it into the view
that asked for it. Other UIs can adopt it later without rework.

Known gap: some logic still lives in `ui-classic/views.ts` (file browsing,
attachments, model/mode pickers, rewind/export, priority). Extract it into
`core/` when you next need it from a second UI or when you are already
changing it; do not copy it.

## Build & test

```
npm install
npm run build     # server + UI
npm run build:server
npm run build:ui
npm test          # node:test via scripts/run-tests.mjs
npm run lint
npm run smoke      # headless Chrome loads each bundled UI against the running server
```

Ships as `hydra-acp-browser` on PATH. Registered via
`hydra-acp extension add hydra-acp-browser`.

## Conventions

- TypeScript, ESM, tsc for the server, esbuild for the UIs, node:test for tests.
- Default bind is localhost only. Anything binding to a non-loopback host
  must require TLS — mirror the daemon's stance.
- Never proxy the hydra master token to the browser. The authkey is the
  browser's credential; keep them separate.
- The browser API surface is a *scoped subset* of the daemon's — don't
  expose management endpoints (auth rotation, extension lifecycle) through
  it.

## Gotchas

- The daemon can restart underneath us; WS reconnect must be transparent
  to the browser (buffer or replay, don't drop state).
- Permission prompts are races (RFD #533). If the user in the browser is
  slow and the TUI answers first, the browser must gracefully accept the
  `permission_resolved` update instead of erroring.
- Files API reads from disk on the daemon's host — respect the session's
  `cwd` as the root and reject path traversal.
- **`fs/*` MCP requests are refused, not proxied** (`ws-bridge.ts`). The
  bridge advertises fs off in initialize; if an agent asks anyway, we
  error. Do NOT "helpfully" forward these — it exposes the daemon's disk
  to any agent.
- **Permission-request buffering by `permissionDelayMs`**
  (`ws-bridge.ts`): sibling controllers (auto-approver) usually resolve
  within milliseconds, so the browser holds the frame in
  `pendingPermissionFrames` keyed by `toolCallId` and drops it if a
  `permission_resolved` notification lands first. RFD #533 keys
  everything by `toolCallId`; don't change the map key.
- **CSRF/token gate runs at WS upgrade time** (`ws-bridge.ts`), before
  `handleUpgrade`. A bad request never allocates a socket. Move-that-code
  refactors will silently trade defense-in-depth for latency.
- **The auth rate limiter is defense-in-depth**, not primary — the
  daemon has its own on `/v1/auth/login`. Removing the local one isn't
  "simplification".
- **The classic SPA's `render()` is a full teardown** of `#app` (`ui-classic/renderer.ts`),
  and WS/poll events (`core/bridge.ts`, `core/acp.ts`, `core/queue.ts`) can trigger one
  at any point, including mid-tap. On mobile Chrome, `click` is a
  compatibility event synthesized after `pointerup` and can arrive a
  frame or more later — after `render()` has already replaced the
  element out from under it, silently dropping the tap. Every
  interactive element in `ui-classic/views.ts` is wired with `tapHandler()`
  (`ui-classic/dom.ts`), which acts on `pointerup` instead and stops propagation so
  a nested control can't double-fire its container's handler. Any new
  clickable element must use `tapHandler`, not a plain `onclick` — a
  plain `onclick` will "mostly work" in testing and then flake on real
  phones under load.
- **Any independently-scrolling container nested inside the fixed-position
  app shell needs `overscroll-behavior: contain`** (`index.html`:
  `.chat-body`, `.list`, `.files .body`/`.preview`). `body` is
  `position: fixed` and its ancestors (`#app`, `.chat`) are
  `overflow: hidden`, so none of them can actually scroll. Without
  `overscroll-behavior`, iOS Safari's rubber-band bounce at a scroll
  container's boundary tries to chain the remaining overscroll momentum
  to the next scrollable ancestor; the failed handoff can leave that
  container's own scrolling unresponsive (taps still fine) until an
  unrelated touch resets its internal state. Reproduces with zero app
  JS involved — a pure CSS/scroll-chaining bug, not a render or pin
  timing issue. Any new independently-scrolling panel needs the same
  property.

## Debugging a "the transcript is missing X" report

Split it into *data* vs *render* before theorising — the two live in
different halves of the system and the answer usually falls out in
minutes. Three levels, cheapest first:

1. **Does the daemon have it?**
   `~/.hydra-acp/sessions/<id>/history.jsonl` is the record of truth;
   `hydra session transcript <id>` is the readable view. If a
   `prompt_received` frame is there, nothing was lost server-side.
2. **Does a full attach replay it?** Connect to the daemon's `/acp`
   directly (`wss://<host>/acp`, subprotocols `acp.v1` and
   `hydra-acp-token.<token>` from `~/.hydra-acp/auth-token`), send
   `initialize` + `session/attach {historyPolicy: "full"}`, and capture
   the notifications. Feeding that capture through the real
   `handleNotification` in a `tsx` script (stub `globalThis.document`,
   hand-build a `ChatState` — see `test/acp-replay-cursor.test.ts`)
   tells you whether the *client logic* renders it, with no browser
   involved.
3. **Does the real SPA render it?** Drive it with headless Chrome over
   CDP: launch with `--remote-debugging-port` + `--ignore-certificate-errors`,
   `Network.setCookie` `hb_session` = the daemon token (the browser
   server only checks the cookie *exists*; the daemon validates it, so
   the master token works and no password is needed),
   `Emulation.setDeviceMetricsOverride` for phone metrics, seed
   `localStorage["hydra-acp-browser:filters"]` to match the reporter's
   `hideThoughts` etc., then dump `.chat-body > *` class names and
   `getBoundingClientRect()`. `Network.webSocketCreated` also shows the
   `afterMessageId`/`afterSeq`/`load` params the SPA actually sent,
   which is the fastest way to tell a full replay from a delta.

Correlate with the two logs, whose clocks match:
`~/.hydra-acp/extensions/hydra-acp-browser/current.log` (`bridge open` /
`browser closed`) and the daemon's `current.log`
(`session/attach OK … requestedPolicy=… appliedPolicy=… replayed=N`).
A `browser closed` landing *before* its own attach response means that
connection's whole replay went nowhere.

If all three levels come back clean, the transcript is intact and the
reporter is looking at a wedged long-lived `ChatState` — a reload fixes
it, and the bug is in whatever teardown dropped the items, not in the
data.

## Updating this file

If you discover a durable, non-obvious invariant while working here — the
kind of thing you wish had been in this file when you started — flag it
in your final turn summary so the human can decide whether to add it. Do
not silently edit AGENTS.md mid-task. Prefer additions to `## Gotchas`
over reworking existing sections; never delete a gotcha without checking
that the underlying invariant is actually gone.
