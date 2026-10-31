// Working directories recently used for new sessions, most recent first.

const LAST_CWD_KEY = "hydra-acp-browser:lastCwd";
const CWD_HISTORY_KEY = "hydra-acp-browser:cwdHistory";
const CWD_HISTORY_LIMIT = 20;

// Most-recent-first, deduplicated. Seeded from the older single-value
// lastCwd key on first read so upgrading doesn't lose the one cwd
// someone already had remembered.
export function loadCwdHistory(): string[] {
  try {
    const raw = localStorage.getItem(CWD_HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === "string");
    }
    const legacy = localStorage.getItem(LAST_CWD_KEY);
    return legacy ? [legacy] : [];
  } catch {
    return [];
  }
}

export function loadLastCwd(): string | null {
  return loadCwdHistory()[0] ?? null;
}

export function saveLastCwd(cwd: string): void {
  try {
    const history = loadCwdHistory().filter((v) => v !== cwd);
    history.unshift(cwd);
    localStorage.setItem(
      CWD_HISTORY_KEY,
      JSON.stringify(history.slice(0, CWD_HISTORY_LIMIT)),
    );
    localStorage.removeItem(LAST_CWD_KEY);
  } catch {
    // Private browsing / quota, the field just won't persist.
  }
}
