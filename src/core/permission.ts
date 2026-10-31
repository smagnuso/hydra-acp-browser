// Permission requests: parsing the agent's ask, deciding how to present
// each option, building the reply, and listing what it is asking to do as
// plain label/value rows a UI can lay out however it likes.

import type { PermissionEntry } from "./types.js";

export type OptionTone = "allow" | "reject" | "neutral";

// How an option should read: allow_* is the go-ahead, reject_* the refusal.
export function permissionOptionTone(kind: string | undefined): OptionTone {
  if (kind?.startsWith("allow")) {
    return "allow";
  }
  if (kind?.startsWith("reject")) {
    return "reject";
  }
  return "neutral";
}

// The JSON-RPC result for answering a request. "__cancel__" is the
// UI-side id for dismissing without choosing.
export function permissionOutcome(optionId: string): { outcome: Record<string, unknown> } {
  return {
    outcome:
      optionId === "__cancel__"
        ? { outcome: "cancelled" }
        : { outcome: "selected", optionId },
  };
}

// Parses a session/request_permission request. Null when it carries no
// toolCall.toolCallId, which every UI keys pending requests by (RFD #533).
export function parsePermissionRequest(
  requestId: string | number,
  params: Record<string, unknown> | undefined,
): PermissionEntry | null {
  const toolCall = ((params?.toolCall as Record<string, unknown> | undefined) ?? {});
  const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : "";
  if (!toolCallId) {
    return null;
  }
  return {
    requestId,
    toolCallId,
    toolCall: toolCall as PermissionEntry["toolCall"],
    options: (params?.options as PermissionEntry["options"]) ?? [],
  };
}

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
