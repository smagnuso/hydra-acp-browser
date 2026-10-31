// What a permission request is asking to do, as plain label/value rows a
// UI can lay out however it likes.

export interface PermissionDetail {
  label?: string;
  value: string;
  // Free-text explanation shown without a label.
  note?: boolean;
}

export function permissionDetails(tc: Record<string, unknown>): PermissionDetail[] {
  const asStr = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const rows: PermissionDetail[] = [];

  const kind = asStr(tc.kind);
  if (kind) {
    rows.push({ label: "kind", value: kind });
  }

  const seen = new Set<string>();
  const paths: string[] = [];
  const addPath = (v: unknown): void => {
    const s = asStr(v);
    if (s && !seen.has(s)) {
      seen.add(s);
      paths.push(s);
    }
  };
  const locations = tc.locations;
  if (Array.isArray(locations)) {
    for (const loc of locations) {
      if (loc && typeof loc === "object") {
        addPath((loc as Record<string, unknown>).path);
      }
    }
  }
  const rawInput =
    tc.rawInput && typeof tc.rawInput === "object"
      ? (tc.rawInput as Record<string, unknown>)
      : undefined;
  if (rawInput) {
    addPath(rawInput.file_path);
    addPath(rawInput.filePath);
    addPath(rawInput.path);
  }
  for (const p of paths) {
    rows.push({ label: "path", value: p });
  }

  if (rawInput) {
    const command = asStr(rawInput.command);
    if (command) {
      rows.push({ label: "command", value: command });
    }
    const url = asStr(rawInput.url);
    if (url) {
      rows.push({ label: "url", value: url });
    }
    const description = asStr(rawInput.description);
    if (description) {
      rows.push({ value: description, note: true });
    }
  }

  return rows;
}
