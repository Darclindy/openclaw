import { type MemorySourceFileStateRow } from "./manager-source-state.js";

export type MemorySessionSyncScope = {
  agentId: string;
  sessionId: string;
};

export type MemorySessionStartupTranscriptState = {
  scopeKey: string;
  sourceKey: string;
  updatedAt: number;
  size: number;
};

export function resolveMemorySessionStartupDirtyTranscripts(params: {
  transcripts: MemorySessionStartupTranscriptState[];
  existingRows?: MemorySourceFileStateRow[] | null;
}): string[] {
  const indexedRows = new Map((params.existingRows ?? []).map((row) => [row.sourceKey, row]));
  const dirtyTranscripts: string[] = [];
  for (const transcript of params.transcripts) {
    const existing = indexedRows.get(transcript.sourceKey);
    if (!existing) {
      dirtyTranscripts.push(transcript.scopeKey);
      continue;
    }
    const indexedMtimeMs = Number(existing.mtime);
    const indexedSize = Number(existing.size);
    if (!Number.isFinite(indexedMtimeMs) || !Number.isFinite(indexedSize)) {
      dirtyTranscripts.push(transcript.scopeKey);
      continue;
    }
    if (transcript.size !== indexedSize || transcript.updatedAt > indexedMtimeMs) {
      dirtyTranscripts.push(transcript.scopeKey);
    }
  }
  return dirtyTranscripts;
}

export function resolveMemorySessionSyncPlan(params: {
  needsFullReindex: boolean;
  transcripts: MemorySessionSyncScope[];
  targetSessionTranscriptKeys: Set<string> | null;
  dirtySessionTranscripts: Set<string>;
  existingRows?: MemorySourceFileStateRow[] | null;
  sessionTranscriptSourceKeyForScope: (scope: MemorySessionSyncScope) => string;
}): {
  activeSourceKeys: Set<string> | null;
  existingRows: MemorySourceFileStateRow[] | null;
  existingHashes: Map<string, string> | null;
  indexAll: boolean;
} {
  const activeSourceKeys = params.targetSessionTranscriptKeys
    ? null
    : new Set(params.transcripts.map((scope) => params.sessionTranscriptSourceKeyForScope(scope)));
  const existingRows = activeSourceKeys === null ? null : (params.existingRows ?? []);
  return {
    activeSourceKeys,
    existingRows,
    existingHashes: existingRows
      ? new Map(existingRows.map((row) => [row.sourceKey, row.hash]))
      : null,
    indexAll:
      params.needsFullReindex ||
      Boolean(params.targetSessionTranscriptKeys) ||
      params.dirtySessionTranscripts.size === 0,
  };
}
