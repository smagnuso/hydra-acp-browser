// Composer attachments: pasted or picked images waiting to go out with the
// next prompt. A UI hands over Blobs/Files it collected; chips and
// thumbnails are its own business.

import { setState, notifyChange } from "./state.js";
import type { Attachment, ChatState } from "./types.js";

// Mirrors cli/src/tui/attachments.ts MAX_ATTACHMENT_BYTES, which keeps the
// two clients' caps in sync without a shared package.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Mirrors cli/src/tui/attachments.ts formatSize.
export function formatAttachmentSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)}KB`;
  }
  return `${bytes}B`;
}

export function attachmentSrc(a: Attachment): string {
  return a.url ?? `data:${a.mimeType};base64,${a.data}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Reads images into base64 Attachments and appends them to the chat's
// pending list. Oversized files are rejected with a banner rather than
// silently dropped, mirroring the TUI's clipboard-read errors.
export async function addImageAttachments(c: ChatState, files: Blob[]): Promise<void> {
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setState({
        banner: {
          kind: "warn",
          text: `pasted image is ${formatAttachmentSize(file.size)}, max ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)}`,
        },
      });
      continue;
    }
    const data = toBase64(new Uint8Array(await file.arrayBuffer()));
    c.attachments.push({
      mimeType: file.type || "image/png",
      data,
      sizeBytes: file.size,
    });
    notifyChange();
  }
}

export function removeAttachment(c: ChatState, index: number): void {
  c.attachments.splice(index, 1);
  notifyChange();
}
