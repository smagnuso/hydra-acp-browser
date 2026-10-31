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
- Files: the browser is a state machine on `state.current.fileOverlay`
  (`path`, `entries`, windowed `preview`, `err`, `maximized`,
  `previewRaw`, one-shot `scrollToLine`/`keepLine`). Drive it with
  `openFiles()`, `listFiles(dir)`, `readFile(path)`, `navigateFile(entry)`,
  `openFileAtLine(chat, path, line)`, `extendFileWindow("up"|"down")` as
  the reader nears an edge, and `closeFiles()` (remembers the view in
  `savedFileView`). Image previews carry a `url` to use in an `<img>`.
  View-only parts go through hooks: `beforeFileOverlayOpen`,
  `afterFileOverlayOpen`, `fileOverlayClosing`, and `captureFileAnchor`
  (return the visible line and its offset so prepending keeps the reader
  in place; core then sets `keepLine` for you to apply).
- Attachments: collect images as `Blob`/`File` (paste, picker, drag) and
  call `addImageAttachments(chat, files)`; it enforces the size cap with a
  banner. Pending ones are `chat.attachments`; `removeAttachment`,
  `attachmentSrc` for thumbnails. `sendPrompt()` sends them.
- Hooks (`UiHooks`) cover view behavior core needs: scrolling, paint holds,
  navigation (URL), composer DOM sync. Unset hooks are inert no-ops.
- `platform.ts` is the only core file allowed to touch `document` or
  `window` (`test/core-boundary.test.ts` enforces this and that core never
  imports a UI).

## Not in core

Rendering, gestures, theming, URL routing, and modals. Core exports
`renderMarkdown` and `renderInlineMarkdown` for UIs that want the same
HTML output.
