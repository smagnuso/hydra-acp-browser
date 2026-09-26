import type { JsonRpcFrame } from "./acp.js";

export interface HistoryPageEntry {
  method: string;
  params: Record<string, unknown>;
  recordedAt?: number;
  seq?: number;
}

// The daemon stamps seq/recordedAt into params._meta["hydra-acp"] on the
// wire; raw history entries carry them at the top level, so fold them back
// in to make a page look like the frames an attach replay delivers.
export function historyEntryToFrame(entry: HistoryPageEntry): JsonRpcFrame {
  const params = entry.params ?? {};
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const hydra = (meta["hydra-acp"] ?? {}) as Record<string, unknown>;
  return {
    method: entry.method,
    params: {
      ...params,
      _meta: {
        ...meta,
        "hydra-acp": {
          ...hydra,
          ...(entry.seq !== undefined ? { seq: entry.seq } : {}),
          ...(entry.recordedAt !== undefined ? { recordedAt: entry.recordedAt } : {}),
        },
      },
    },
  };
}

export function oldestSeqOf(entries: HistoryPageEntry[]): number | undefined {
  let oldest: number | undefined;
  for (const e of entries) {
    if (e.seq !== undefined && (oldest === undefined || e.seq < oldest)) {
      oldest = e.seq;
    }
  }
  return oldest;
}
