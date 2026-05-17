import { describe, expect, it } from "vitest";
import {
  resolveMemorySessionStartupDirtyTranscripts,
  resolveMemorySessionSyncPlan,
} from "./manager-session-sync-state.js";

describe("memory session sync state", () => {
  it("tracks active source keys and bulk hashes for full scans", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      transcripts: [
        { agentId: "main", sessionId: "a" },
        { agentId: "main", sessionId: "b" },
      ],
      targetSessionTranscriptKeys: null,
      dirtySessionTranscripts: new Set(),
      existingRows: [
        { sourceKey: "session:a", path: "transcript:main:a", hash: "hash-a" },
        { sourceKey: "session:b", path: "transcript:main:b", hash: "hash-b" },
      ],
      sessionTranscriptSourceKeyForScope: (scope) => `session:${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activeSourceKeys).toEqual(new Set(["session:a", "session:b"]));
    expect(plan.existingRows).toEqual([
      { sourceKey: "session:a", path: "transcript:main:a", hash: "hash-a" },
      { sourceKey: "session:b", path: "transcript:main:b", hash: "hash-b" },
    ]);
    expect(plan.existingHashes).toEqual(
      new Map([
        ["session:a", "hash-a"],
        ["session:b", "hash-b"],
      ]),
    );
  });

  it("treats targeted session syncs as refresh-only and skips unrelated pruning", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      transcripts: [{ agentId: "main", sessionId: "targeted-first" }],
      targetSessionTranscriptKeys: new Set(["main\0targeted-first"]),
      dirtySessionTranscripts: new Set(["main\0targeted-first"]),
      existingRows: [
        {
          sourceKey: "session:targeted-first",
          path: "transcript:main:targeted-first",
          hash: "hash-first",
        },
        {
          sourceKey: "session:targeted-second",
          path: "transcript:main:targeted-second",
          hash: "hash-second",
        },
      ],
      sessionTranscriptSourceKeyForScope: (scope) => `session:${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activeSourceKeys).toBeNull();
    expect(plan.existingRows).toBeNull();
    expect(plan.existingHashes).toBeNull();
  });

  it("keeps dirty-only incremental mode when no targeted sync is requested", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      transcripts: [{ agentId: "main", sessionId: "incremental" }],
      targetSessionTranscriptKeys: null,
      dirtySessionTranscripts: new Set(["main\0incremental"]),
      existingRows: [],
      sessionTranscriptSourceKeyForScope: (scope) => `session:${scope.sessionId}`,
    });

    expect(plan.indexAll).toBe(false);
    expect(plan.activeSourceKeys).toEqual(new Set(["session:incremental"]));
  });

  it("marks missing and changed startup session transcripts dirty", () => {
    const dirtyTranscripts = resolveMemorySessionStartupDirtyTranscripts({
      transcripts: [
        {
          scopeKey: "main\0unchanged",
          sourceKey: "session:unchanged",
          updatedAt: 100,
          size: 10,
        },
        {
          scopeKey: "main\0newer",
          sourceKey: "session:newer",
          updatedAt: 250,
          size: 20,
        },
        {
          scopeKey: "main\0resized",
          sourceKey: "session:resized",
          updatedAt: 300,
          size: 31,
        },
        {
          scopeKey: "main\0missing",
          sourceKey: "session:missing",
          updatedAt: 400,
          size: 40,
        },
      ],
      existingRows: [
        {
          sourceKey: "session:unchanged",
          path: "transcript:main:unchanged",
          hash: "hash-unchanged",
          mtime: 100,
          size: 10,
        },
        {
          sourceKey: "session:newer",
          path: "transcript:main:newer",
          hash: "hash-newer",
          mtime: 200,
          size: 20,
        },
        {
          sourceKey: "session:resized",
          path: "transcript:main:resized",
          hash: "hash-resized",
          mtime: 300,
          size: 30,
        },
      ],
    });

    expect(dirtyTranscripts).toEqual(["main\0newer", "main\0resized", "main\0missing"]);
  });
});
