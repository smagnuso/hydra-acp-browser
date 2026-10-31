// View-layer behaviors the logic modules need but must not import. A UI
// registers real implementations at startup via installUiHooks(); until
// then each hook is an inert default, so logic runs without any DOM.

import type { ChatState } from "./types.js";

export interface UiHooks {
  isActivelyTyping(): boolean;
  seedInitialSessionOrder(ids: string[]): void;
  beginReplayPaintHold(): void;
  endReplayPaintHold(): void;
  jumpToBottom(c: ChatState): void;
  peekChatScrollTop(c: ChatState): number;
  renderNow(): void;
  isWideLayout(): boolean;
  tapDebugEnabled(): boolean;
  tapLog(line: string): void;
  noteSendOutcome(outcome: string): void;
}

export const uiHooks: UiHooks = {
  isActivelyTyping: () => false,
  seedInitialSessionOrder: () => {},
  beginReplayPaintHold: () => {},
  endReplayPaintHold: () => {},
  jumpToBottom: () => {},
  peekChatScrollTop: () => 0,
  renderNow: () => {},
  isWideLayout: () => false,
  tapDebugEnabled: () => false,
  tapLog: () => {},
  noteSendOutcome: () => {},
};

export function installUiHooks(hooks: Partial<UiHooks>): void {
  Object.assign(uiHooks, hooks);
}
