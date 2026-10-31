// Public surface for building a UI on the shared client logic. A UI
// supplies rendering: subscribe() to state changes, read `state`, call
// the actions below, and installUiHooks() for any view-layer behavior it
// wants to provide. Nothing here touches the DOM.

export { state, setState, subscribe, notifyChange } from "./state.js";
export { installUiHooks, type UiHooks } from "./hooks.js";
export { installPlatform, type Platform } from "./platform.js";

export {
  startPolling,
  pollSessions,
  seedSessionCache,
  loadAgents,
  loadRemotes,
  loadConfig,
  importBundle,
  api,
} from "./api.js";

export {
  openChat,
  closeChat,
  forceReconnect,
  maybeRestoreLastSession,
  loadEarlierHistory,
  requestFullHistory,
} from "./routing.js";

export {
  sendPrompt,
  amendPrompt,
  sendCancel,
  sendWorkspaceCommand,
  sendCompactCommand,
  sendSetMode,
  sendSetModel,
  sendSetConfigOption,
  cancelQueuedPrompt,
  amendQueuedPrompt,
  updateQueuedPrompt,
} from "./queue.js";

export { respondPermission } from "./bridge.js";
export {
  createSession,
  killSession,
  setSessionTitle,
  setSessionPriority,
  sessionExportUrl,
  type CreateSessionParams,
} from "./actions.js";
export {
  filterSessions,
  visibleFilteredSessions,
  groupSessions,
  hostFilterSources,
  matchesSessionSearch,
  describeHostFilter,
  shortSessionId,
  shortenCwd,
  displayCwd,
  type SessionGroup,
  type SessionListFilters,
} from "./session-list.js";
export {
  openFiles,
  openFileAtLine,
  openImagePreviewAt,
  listFiles,
  readFile,
  navigateFile,
  extendFileWindow,
  closeFiles,
  closeFilePreview,
  togglePreviewRaw,
  toggleMaximizeFiles,
  editAnchorForToolCall,
  isImagePath,
  isMarkdownPath,
  imageUrl,
  relativeToCwd,
} from "./files.js";
export { markOpenChatRead, initReadTracking } from "./read-state.js";
export {
  ensureServiceWorker,
  requestNotificationPermission,
  subscribeForPush,
  unsubscribeFromPush,
} from "./notifications.js";

export { renderMarkdown, renderInlineMarkdown, escapeHtml } from "./markdown.js";

export type * from "./types.js";
