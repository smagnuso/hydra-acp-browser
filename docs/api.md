# Browser API contract

What a UI served by `hydra-acp-browser` can rely on. The bundled SPA in
`src/ui-classic/` (on the shared `src/core/`) is one client of this; a replacement UI is another.

## Serving a UI

Set `BROWSER_UI_DIR` (in `~/.hydra-acp/browser.conf`) to a directory
containing:

- `index.html`: served at `/` once the `hb_session` cookie exists.
  Every `__CSP_NONCE__` in it is replaced per request with the CSP nonce.
- `sw.js` (optional): served at `/sw.js`.
- `assets/**`: served at `/assets/**` with a content type by extension.
  Requires the session cookie.

Files are re-read on every request, so rebuilding is enough; no restart.
Unset, the bundled `dist/ui` is served (cached).

CSP: `default-src 'self'`, scripts and styles from `'self'` or the
nonce, `connect-src 'self'`, `img-src 'self' data:`. Inline `<script>` and
`<style>` need `nonce="__CSP_NONCE__"`. External hosts are blocked.

Unauthenticated visits to `/` get the server-rendered login page, not
your `index.html`. `/login` (form POST, `password`, optional `next`) and
`/logout` (POST) set and clear the cookie.

## Auth and CSRF

- Credential is the `hb_session` cookie (daemon session token, 30 days).
  The server only checks it exists; the daemon validates it, so a stale
  cookie surfaces as 401 on the next call. Treat 401 as "show login".
- State-changing requests (non-GET) must be same-origin: the `Origin` /
  `Host` checks in `src/util/csrf.ts` apply. A same-origin `fetch` passes.
- The daemon master token is never exposed to the browser.

## REST (all under the session cookie)

| Route | Notes |
| --- | --- |
| `GET /api/config` | Daemon config plus `readIdleSeconds`. |
| `GET /api/agents` | Agents available for new sessions. |
| `GET /api/remotes` | Federation peers, fetched live. |
| `GET /api/sessions?cwd=&all=true&since=<cursor>` | Session list; `since` is a delta cursor. |
| `GET /api/sessions/:id` | One session's metadata. |
| `GET /api/sessions/:id/history?beforeSeq=&turns=` | Older history page ("load earlier"). |
| `POST /api/sessions` | Create. `{cwd, agent?, remote?, ...}`; 201 with the session. `cwd` required unless `remote`. |
| `POST /api/kill` | `{sessionId}`; 204. |
| `PATCH /api/sessions/:id/priority` | `{priority: positive int or null}`; 204. |
| `GET /api/sessions/:id/export` | Bundle download. |
| `POST /api/sessions/import` | `{bundle}`. |
| `POST /api/files/list` `/read`, `GET /api/files/download` `/image` | Rooted at the session's `cwd`; traversal rejected. |
| `GET /api/usage` | Budgeter aggregates (`since`, `bucket`, `by`, `metric`, `depth`, `refresh`). |
| `GET /api/push/vapid-public-key`, `POST /api/push/subscribe` `/unsubscribe` | Web Push. |
| `GET /api/health` | Unauthenticated; `{status, upstream}`. |

Errors are `{error: string}` with the daemon's status (502 if the daemon
is unreachable). Exact request and response shapes: `src/server/routes-*.ts`
and the matching types in `src/core/types.ts`.

## WebSocket: `/ws?session=<id>`

One socket per open session; JSON-RPC 2.0 text frames, proxied to the
daemon's ACP socket. Upgrade is rejected before the handshake on a bad
cookie (401), missing `session` (400), or failed origin/host checks.

Query parameters:

| Param | Meaning |
| --- | --- |
| `session` | Required. |
| `afterSeq` | Resume after this `_meta["hydra-acp"].seq`; delta replay. Preferred cursor. |
| `afterMessageId` | Older cursor form; send one of the two, never both. |
| `fullHistory=true` | Opt out of the daemon's replay cap (explicit user action only). |
| `passive=true` | Reconnect the user did not initiate; a cold session attaches read-only instead of resurrecting. |

### Server to browser

Standard ACP `session/update` notifications (replay first, then live),
plus agent-initiated requests such as `session/request_permission`
(buffered `permissionDisplayDelayMs`, dropped if a `permission_resolved`
update lands first, keyed by `toolCallId`). `fs/*` requests are answered
with an error by the bridge, never forwarded. Hydra extensions also
arrive, e.g. `hydra-acp/prompt_queue/added` and `removed`.

Local frames, never forwarded upstream:

| Method | Meaning |
| --- | --- |
| `bridge/replay_policy` `{policy: "full" \| "after_message"}` | Sent once before the replay frames; says whether the replay is a delta. |
| `bridge/ready` `{sessionId, clientId?, cold?, configOptions?, _meta?}` | Sent after the entire replay. Render the transcript here, not before. `cold: true` means read-only viewer. `_meta["hydra-acp"]` carries daemon capability flags and the queue snapshot. |
| `bridge/pong` | Answer to `bridge/ping`. |
| `bridge/error` `{code, message, terminal?}` | `terminal: true` means do not auto-reconnect. |

### Browser to server

Requests allowed (anything else gets a JSON-RPC error): `session/prompt`,
`session/cancel`, `session/set_mode`, `session/set_model`,
`session/set_config_option`, `hydra-acp/prompt/cancel`,
`hydra-acp/prompt/update`, `hydra-acp/prompt/amend`, `_session/steering`.
Notifications allowed: `session/cancel`. The source of truth is
`ALLOWED_BROWSER_REQUEST_METHODS` and `ALLOWED_BROWSER_NOTIFICATION_METHODS`
in `src/server/ws-bridge.ts`. The session id in params is coerced to the
connection's own.

Local notifications handled by the bridge:

| Method | Params | Purpose |
| --- | --- | --- |
| `bridge/ping` | `{}` | Heartbeat; the bridge replies `bridge/pong` immediately. Detects a dead browser-to-extension leg. |
| `bridge/visibility` | `{visible: boolean}` | Lets turn-end pushes be skipped when the answer is on screen. |
| `bridge/push-endpoint` | `{endpoint: string \| null}` | Targets turn-end pushes at this device. |

### Reconnect

The daemon can restart underneath the extension and sockets drop on
flaky networks. Reconnect with the last seen `afterSeq` and process
`bridge/replay_policy` before the replay; a `full` policy means discard
what you had and rebuild.
