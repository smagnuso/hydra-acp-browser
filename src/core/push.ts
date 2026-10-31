// Push notification orchestration shared by every UI: turning them on and
// off, re-arming the subscription after a reload, and keeping the server
// told whether this device is being looked at. The primitives live in
// notifications.ts; this is the sequence around them.

import { state, setState } from "./state.js";
import { platform } from "./platform.js";
import {
  requestNotificationPermission,
  subscribeForPush,
  unsubscribeFromPush,
} from "./notifications.js";
import { reportPushEndpoint, reportVisibility } from "./bridge.js";
import { refreshWatcherPresence } from "./watch.js";

export type NotificationsResult = "enabled" | "disabled" | "blocked";

async function resubscribe(): Promise<void> {
  await subscribeForPush();
  reportPushEndpoint();
  refreshWatcherPresence();
}

// Turns turn-end and "waiting on you" notifications on or off. "blocked"
// means the browser refused permission; nothing was changed in that case,
// so the UI should explain how to unblock it.
export async function setNotifications(enabled: boolean): Promise<NotificationsResult> {
  if (!enabled) {
    setState({ notifyOnTurnEnd: false });
    await unsubscribeFromPush();
    reportPushEndpoint();
    refreshWatcherPresence();
    return "disabled";
  }
  if (!(await requestNotificationPermission())) {
    return "blocked";
  }
  setState({ notifyOnTurnEnd: true });
  await resubscribe();
  return "enabled";
}

// Call at startup. A push subscription does not always survive a service
// worker update or reinstall, so a saved "on" preference re-establishes it
// rather than trusting last session's subscribe().
export async function resumeNotifications(): Promise<void> {
  if (
    state.notifyOnTurnEnd &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    await resubscribe();
  }
}

let tracking = false;

// Call once at startup. Reports visibility changes on the open chat's
// socket and on the board's watcher sockets, so the server can skip a push
// for what is already on screen.
export function trackPresence(): void {
  if (tracking) {
    return;
  }
  tracking = true;
  const report = (): void => {
    reportVisibility();
    refreshWatcherPresence();
  };
  platform.onVisibilityChange(report);
  platform.onWindowFocus(report);
  platform.onWindowBlur(report);
}
