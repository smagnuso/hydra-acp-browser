// Light/dark theme. The actual palette lives entirely in CSS custom
// properties on :root plus a matching html[data-theme="light"] override
// block in index.html (including the highlight.js syntax colors, which
// aren't variable-driven, so they get their own light-mode .hljs rules
// there too) — this module's only job is deciding which one applies and
// keeping it in sync with state.theme / the OS preference.

import { state } from "../core/state.js";
import { resolvedTheme, watchTheme } from "../core/theme.js";

// Everything in this UI is sized in rem, so scaling the root element
// scales the entire app — text, padding, control hit targets — in one
// move, and keeps the proportions the layout was designed around. 16 is
// the browser default this stylesheet assumes.
export function applyFontScale(): void {
  document.documentElement.style.fontSize = `${16 * state.fontScale}px`;
}

export function applyTheme(): void {
  const resolved = resolvedTheme();
  document.documentElement.setAttribute("data-theme", resolved);
  // Keeps the PWA status bar / app-switcher chrome matching instead of
  // staying hardcoded dark under a light theme.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "light" ? "#ffffff" : "#0e1116");
}

export function initTheme(): void {
  watchTheme(applyTheme);
}
