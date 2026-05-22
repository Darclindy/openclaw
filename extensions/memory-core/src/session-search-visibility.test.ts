import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import * as sessionTranscriptHit from "openclaw/plugin-sdk/session-transcript-hit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

type TestSessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
};

const crossAgentStore: Record<string, TestSessionEntry> = {
  "agent:peer:only": {
    sessionId: "w1",
    updatedAt: 1,
  },
};
let combinedSessionEntries: Record<string, TestSessionEntry> = crossAgentStore;

vi.mock("openclaw/plugin-sdk/session-transcript-hit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-hit")>();
  return {
    ...actual,
    loadCombinedSessionEntriesForGateway: vi.fn(() => ({
      databasePath: "(test)",
      entries: combinedSessionEntries,
    })),
  };
});

describe("filterMemorySearchHitsBySessionVisibility", () => {
  afterEach(() => {
    vi.mocked(sessionTranscriptHit.loadCombinedSessionEntriesForGateway).mockClear();
    combinedSessionEntries = crossAgentStore;
  });

  it("drops sessions-sourced hits when requester key is missing (fail closed)", async () => {
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });
    const hits: MemorySearchResult[] = [
      {
        path: "transcript:main:u1",
        source: "sessions",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
    ];
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: undefined,
      sandboxed: false,
      hits,
    });
    expect(filtered).toEqual([]);
  });

  it("keeps non-session hits unchanged", async () => {
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });
    const hits: MemorySearchResult[] = [
      {
        path: "memory/foo.md",
        source: "memory",
        score: 1,
        snippet: "x",
        startLine: 1,
        endLine: 2,
      },
    ];
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits,
    });
    expect(filtered).toEqual(hits);
  });

  it("loads the combined session entries once per filter pass", async () => {
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });
    const hits: MemorySearchResult[] = [
      {
        path: "transcript:peer:w1",
        source: "sessions",
        score: 1,
        snippet: "a",
        startLine: 1,
        endLine: 2,
      },
      {
        path: "transcript:peer:w1",
        source: "sessions",
        score: 0.9,
        snippet: "b",
        startLine: 1,
        endLine: 2,
      },
    ];
    await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits,
    });
    expect(sessionTranscriptHit.loadCombinedSessionEntriesForGateway).toHaveBeenCalledTimes(1);
    expect(sessionTranscriptHit.loadCombinedSessionEntriesForGateway).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
  });

  it("keeps same-agent session hits when visibility=all and agent-to-agent is enabled", async () => {
    combinedSessionEntries = {
      "agent:main:only": {
        sessionId: "w1",
        updatedAt: 1,
      },
    };
    const hit: MemorySearchResult = {
      path: "transcript:main:w1",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toEqual([hit]);
  });

  it("keeps global-scope session hits for non-default agents", async () => {
    combinedSessionEntries = {
      global: {
        sessionId: "w1",
        updatedAt: 1,
      },
    };
    const hit: MemorySearchResult = {
      path: "transcript:secondary:w1",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      session: { scope: "global" },
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      agentId: "secondary",
      requesterSessionKey: "agent:secondary:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toEqual([hit]);
  });

  it("does not keep cross-agent session hits outside the scoped entries", async () => {
    combinedSessionEntries = crossAgentStore;
    const hit: MemorySearchResult = {
      path: "transcript:peer:w1",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: true, allow: ["*"] },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toEqual([]);
  });

  it("denies cross-agent session hits when agent-to-agent is disabled", async () => {
    const hit: MemorySearchResult = {
      path: "transcript:peer:w1",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
        agentToAgent: { enabled: false },
      },
    });
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toEqual([]);
  });

  it("keeps same-agent QMD-normalized archived reset .md hits when the store has a matching entry", async () => {
    combinedSessionEntries = {
      "agent:main:abc-uuid": {
        sessionId: "abc-uuid",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/abc-uuid.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "qmd/sessions-main/abc-uuid-jsonl-reset-2026-02-16t22-26-33-000z.md",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "agent" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });

  it("keeps QMD .md hits whose live session id looks like an archive name", async () => {
    const sessionId = "foo.jsonl.deleted.2026-02-16T22-27-33.000Z";
    combinedSessionEntries = {
      "agent:main:archive-looking": {
        sessionId,
        updatedAt: 1,
        sessionFile: `/tmp/sessions/${sessionId}.jsonl`,
      },
    };
    const hit: MemorySearchResult = {
      path: `qmd/sessions-main/${sessionId}.md`,
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "self" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:archive-looking",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });

  it("does not authorize QMD archived .md hits through lossy slug fallback", async () => {
    combinedSessionEntries = {
      "agent:main:foo_bar": {
        sessionId: "foo_bar",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/foo_bar.jsonl",
      },
    };
    const hit: MemorySearchResult = {
      path: "qmd/sessions-main/foo-bar-jsonl-deleted-2026-02-16t22-26-33-000z.md",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "self" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:foo_bar",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toStrictEqual([]);
  });

  it("keeps same-agent QMD archived deleted .md hits when no store entry remains", async () => {
    combinedSessionEntries = {};
    const hit: MemorySearchResult = {
      path: "qmd/sessions-main/abc-uuid-jsonl-deleted-2026-02-16t22-26-33-000z.md",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({
      tools: {
        sessions: { visibility: "all" },
      },
    });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });
});
