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
  importBundleFromText,
  type ImportOutcome,
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
  isFederatedSession,
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
export {
  addImageAttachments,
  removeAttachment,
  attachmentSrc,
  formatAttachmentSize,
  MAX_ATTACHMENT_BYTES,
} from "./attachments.js";
export {
  usage,
  loadUsage,
  loadUsageSessions,
  resetUsage,
  saveUsageSettings,
  buildUsageModel,
  formatUsage,
  usageValue,
  usageUnit,
  METRICS as USAGE_METRICS,
  SPLITS as USAGE_SPLITS,
  RANGES as USAGE_RANGES,
  PALETTE as USAGE_PALETTE,
  type UsageItem,
  type UsageGroup,
  type UsageResponse,
  type Series as UsageSeries,
  type Model as UsageModel,
  type Range as UsageRange,
  type Metric as UsageMetric,
  type SplitBy as UsageSplit,
} from "./usage.js";
export {
  shortenModel,
  agentWithModel,
  formatDuration,
  formatRelativeAge,
  fmtTokens,
  fmtCost,
  baseName,
  dirName,
  formatDateTime,
  formatElapsed,
  turnAgentParts,
} from "./format.js";
export { permissionDetails, type PermissionDetail } from "./permission.js";
export { loadCwdHistory, loadLastCwd, saveLastCwd } from "./cwd-history.js";
export { markOpenChatRead, initReadTracking } from "./read-state.js";
export {
  ensureServiceWorker,
  requestNotificationPermission,
  subscribeForPush,
  unsubscribeFromPush,
} from "./notifications.js";

export { renderMarkdown, renderInlineMarkdown, escapeHtml } from "./markdown.js";

export type * from "./types.js";
