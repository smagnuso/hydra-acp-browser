// The user's theme choice resolved against the OS preference. Applying it
// (a data attribute, a class, a stylesheet) is the UI's job.

import { state } from "./state.js";
import { platform } from "./platform.js";

export type ResolvedTheme = "light" | "dark";

export function resolvedTheme(): ResolvedTheme {
  if (state.theme === "system") {
    return platform.prefersDark() ? "dark" : "light";
  }
  return state.theme;
}

// Calls apply now and whenever the result can change: the OS flipping
// while the choice is "system". The UI applies on its own when the choice
// itself changes.
export function watchTheme(apply: (theme: ResolvedTheme) => void): void {
  apply(resolvedTheme());
  platform.onPrefersDarkChange(() => {
    if (state.theme === "system") {
      apply(resolvedTheme());
    }
  });
}
