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
  sendSetMode,
  sendSetModel,
  sendSetConfigOption,
  cancelQueuedPrompt,
  amendQueuedPrompt,
  updateQueuedPrompt,
} from "./queue.js";

export { respondPermission } from "./bridge.js";
export { createSession, killSession, type CreateSessionParams } from "./actions.js";
export { markOpenChatRead, initReadTracking } from "./read-state.js";
export {
  ensureServiceWorker,
  requestNotificationPermission,
  subscribeForPush,
  unsubscribeFromPush,
} from "./notifications.js";

export type * from "./types.js";
