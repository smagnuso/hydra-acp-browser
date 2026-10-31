// Which UIs this server offers and how to switch between them.

import { api } from "./api.js";

export interface UiChoices {
  uis: string[];
  current: string;
}

export function loadUiChoices(): Promise<UiChoices> {
  return api<UiChoices>("/api/uis");
}

// Visiting this selects the UI (the server stores the choice in a cookie)
// and lands on the app root.
export function uiSwitchUrl(name: string): string {
  return `/?ui=${encodeURIComponent(name)}`;
}
