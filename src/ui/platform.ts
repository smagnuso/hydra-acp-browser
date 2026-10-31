// The one place logic modules reach the page environment (visibility,
// focus, unload, raw input). Defaults target a browser and degrade to
// no-ops under Node; a UI with a different host can installPlatform().

export interface Platform {
  onPageHidden(cb: () => void): void;
  pageVisibility(): string;
  pageHasFocus(): boolean;
  onUserInput(cb: () => void): void;
  onWindowFocus(cb: () => void): void;
  onVisibilityChange(cb: () => void): void;
}

const hasDom = (): boolean =>
  typeof window !== "undefined" && typeof document !== "undefined";

const USER_INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"];

export const platform: Platform = {
  // pagehide covers iOS Safari (no reliable beforeunload); visibilitychange
  // covers a tab being backgrounded without a full unload.
  onPageHidden(cb) {
    if (!hasDom()) {
      return;
    }
    window.addEventListener("pagehide", cb);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        cb();
      }
    });
  },
  pageVisibility: () => (hasDom() ? document.visibilityState : "hidden"),
  pageHasFocus: () => hasDom() && document.hasFocus(),
  onUserInput(cb) {
    if (!hasDom()) {
      return;
    }
    for (const type of USER_INPUT_EVENTS) {
      document.addEventListener(type, cb, { capture: true, passive: true });
    }
  },
  onWindowFocus(cb) {
    if (hasDom()) {
      window.addEventListener("focus", cb);
    }
  },
  onVisibilityChange(cb) {
    if (hasDom()) {
      document.addEventListener("visibilitychange", cb);
    }
  },
};

export function installPlatform(overrides: Partial<Platform>): void {
  Object.assign(platform, overrides);
}
