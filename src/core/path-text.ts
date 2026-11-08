// Path text helpers shared by the front end. Paths here are display strings
// that can come from any platform the daemon runs on, so a Windows cwd
// (`C:\x`, `C:/x`, a mix, or UNC) must work as well as a POSIX one. No node
// imports: this bundle runs in the browser.

const DRIVE = /^[A-Za-z]:[\\/]/;
const UNC = /^\\\\/;

export function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || DRIVE.test(p) || UNC.test(p);
}

function isWindowsAbsolute(p: string): boolean {
  return DRIVE.test(p) || UNC.test(p);
}

export function lastSeparator(p: string): number {
  return Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
}

export function splitSegments(p: string): string[] {
  return p.split(/[\\/]/);
}

// The last `n` non-empty segments joined with "/".
export function tailSegments(p: string, n: number): string {
  return splitSegments(p)
    .filter((s) => s.length > 0)
    .slice(-n)
    .join("/");
}

function foldWindows(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

// The part of `path` below `cwd`, with the path's own separators kept, or
// null when `path` is not inside it.
export function pathBelow(cwd: string, path: string): string | null {
  if (isWindowsAbsolute(cwd) && isWindowsAbsolute(path)) {
    const trimmed = cwd.replace(/[\\/]+$/, "");
    const base = foldWindows(trimmed) + "/";
    if (foldWindows(path).startsWith(base)) {
      return path.slice(trimmed.length + 1);
    }
    return null;
  }
  const base = cwd.endsWith("/") ? cwd : cwd + "/";
  return path.startsWith(base) ? path.slice(base.length) : null;
}
