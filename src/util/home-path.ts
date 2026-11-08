// Expands "~", "~/x" and "~\x" only; "~foo" is a relative name, not a home.
export function expandTilde(p: string, home: string): string {
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return home + p.slice(1);
  }
  return p;
}
