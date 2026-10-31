# Building a UI on `src/core`

`src/core/` is the client logic shared by every UI: session list polling,
the ACP update reducer, WebSocket bridge, prompt queue, caches and read
state. It renders nothing. A UI lives in its own `src/ui-<name>/` with
`index.html` (containing `/*BUNDLE*/` and `__CSP_NONCE__`), `main.ts`, and
optionally `sw.js`. `src/ui-classic/` is the reference.

Build and serve: `npm run build:ui` builds every `src/ui-*` into
`dist/ui/<name>/`; open `/?ui=<name>` to select one (stored in a cookie).
For a UI outside the repo, `npm run build:ui -- ui-<name> --out /path`
and set `BROWSER_UI_DIR=/path`. `src/ui-min/` is a ~200 line example.

## Contract

- Import from `src/core/index.ts` only.
- `state` is the single mutable app state. Change it with `setState()`;
  `subscribe(fn)` fires on every change (coalesce in your own renderer;
  streaming fires many times a second).
- Actions: `openChat`, `closeChat`, `sendPrompt`, `sendCancel`,
  `respondPermission`, `createSession`, `killSession`, `sendSetMode`,
  `sendSetModel`, and the rest of the index. Set `state.current.composerValue`
  before `sendPrompt()`.
- Boot order: `installUiHooks()` before anything else, then `subscribe()`,
  then `await seedSessionCache()`, `startPolling()`, `loadAgents()`,
  `loadConfig()`, `loadRemotes()`, `maybeRestoreLastSession()`, and
  `initReadTracking()` if you want read-marking.
- Session list: `visibleFilteredSessions()` applies the show-cold, host
  and search filters in `state`; `groupSessions(ordered, mode)` groups by
  project; `hostFilterSources()` lists the host-filter choices. Ordering
  (`compareSessions` in `session-sort.ts`) is the view's call.
- Session metadata: `setSessionTitle`, `setSessionPriority`,
  `sessionExportUrl`, `createSession`, `killSession`.
- Hooks (`UiHooks`) cover view behavior core needs: scrolling, paint holds,
  navigation (URL), composer DOM sync. Unset hooks are inert no-ops.
- `platform.ts` is the only core file allowed to touch `document` or
  `window` (`test/core-boundary.test.ts` enforces this and that core never
  imports a UI).

## Not in core

Rendering, gestures, theming, URL routing, and modals. Core exports
`renderMarkdown` and `renderInlineMarkdown` for UIs that want the same
HTML output.
