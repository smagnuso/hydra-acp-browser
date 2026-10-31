import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as { window?: unknown }).window = { addEventListener() {} };
(globalThis as { document?: unknown }).document = {
  visibilityState: "visible",
  hasFocus: () => true,
  addEventListener() {},
};

const core = await import("../src/core/index.js");

const FUNCTIONS = [
  "setState",
  "subscribe",
  "notifyChange",
  "installUiHooks",
  "installPlatform",
  "startPolling",
  "pollSessions",
  "seedSessionCache",
  "loadAgents",
  "loadRemotes",
  "loadConfig",
  "importBundle",
  "api",
  "openChat",
  "closeChat",
  "forceReconnect",
  "maybeRestoreLastSession",
  "loadEarlierHistory",
  "requestFullHistory",
  "sendPrompt",
  "amendPrompt",
  "sendCancel",
  "sendSetMode",
  "sendSetModel",
  "sendSetConfigOption",
  "cancelQueuedPrompt",
  "amendQueuedPrompt",
  "updateQueuedPrompt",
  "respondPermission",
  "createSession",
  "killSession",
  "importBundleFromText",
  "shortenModel",
  "agentWithModel",
  "formatDuration",
  "formatRelativeAge",
  "fmtTokens",
  "fmtCost",
  "baseName",
  "dirName",
  "formatDateTime",
  "formatElapsed",
  "turnAgentParts",
  "permissionDetails",
  "loadCwdHistory",
  "loadLastCwd",
  "saveLastCwd",
  "isFederatedSession",
  "loadUsage",
  "loadUsageSessions",
  "resetUsage",
  "saveUsageSettings",
  "buildUsageModel",
  "formatUsage",
  "usageValue",
  "usageUnit",
  "addImageAttachments",
  "removeAttachment",
  "attachmentSrc",
  "formatAttachmentSize",
  "openFiles",
  "openFileAtLine",
  "openImagePreviewAt",
  "listFiles",
  "readFile",
  "navigateFile",
  "extendFileWindow",
  "closeFiles",
  "closeFilePreview",
  "togglePreviewRaw",
  "toggleMaximizeFiles",
  "editAnchorForToolCall",
  "isImagePath",
  "isMarkdownPath",
  "imageUrl",
  "relativeToCwd",
  "setSessionTitle",
  "setSessionPriority",
  "sessionExportUrl",
  "sendWorkspaceCommand",
  "sendCompactCommand",
  "filterSessions",
  "visibleFilteredSessions",
  "groupSessions",
  "hostFilterSources",
  "matchesSessionSearch",
  "describeHostFilter",
  "shortSessionId",
  "shortenCwd",
  "displayCwd",
  "markOpenChatRead",
  "initReadTracking",
  "ensureServiceWorker",
  "requestNotificationPermission",
  "subscribeForPush",
  "unsubscribeFromPush",
  "renderMarkdown",
  "renderInlineMarkdown",
  "escapeHtml",
] as const;

test("the public core surface exports every documented function", () => {
  for (const name of FUNCTIONS) {
    assert.equal(typeof (core as Record<string, unknown>)[name], "function", name);
  }
  assert.equal(typeof core.state, "object");
});

test("subscribe fires on a real change, not on a repeat", () => {
  let n = 0;
  const off = core.subscribe(() => {
    n += 1;
  });
  core.setState({ sessionSearch: "abc" });
  assert.equal(n, 1);
  core.setState({ sessionSearch: "abc" });
  assert.equal(n, 1);
  off();
  core.setState({ sessionSearch: "def" });
  assert.equal(n, 1);
});

test("an uninstalled hook is an inert default, an installed one is called", async () => {
  const { uiHooks } = await import("../src/core/hooks.js");
  assert.equal(uiHooks.readComposerDom(), null);
  assert.equal(uiHooks.isWideLayout(), false);
  core.installUiHooks({ readComposerDom: () => "typed" });
  assert.equal(uiHooks.readComposerDom(), "typed");
});
