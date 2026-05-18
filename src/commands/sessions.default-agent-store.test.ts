import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const loadConfigMock = vi.hoisted(() => vi.fn());

type MockSessionEntryRow = {
  sessionKey: string;
  entry: { sessionId: string; updatedAt: number; model: string };
};
const listSessionEntriesMock = vi.hoisted(() =>
  vi.fn((_params: { agentId: string }): MockSessionEntryRow[] => []),
);

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: loadConfigMock,
    loadConfig: loadConfigMock,
  };
});

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    listSessionEntries: listSessionEntriesMock,
  };
});

import { sessionsCommand } from "./sessions.js";

function createSessionsConfig() {
  return {
    agents: {
      defaults: {
        model: { primary: "pi:opus" },
        models: { "pi:opus": {} },
        contextTokens: 32000,
      },
      list: [
        { id: "main", default: false },
        { id: "voice", default: true },
      ],
    },
  };
}

function createRuntime(): { runtime: RuntimeEnv; logs: string[] } {
  const logs: string[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: vi.fn(),
      exit: vi.fn(),
    },
    logs,
  };
}

describe("sessionsCommand default store agent selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockImplementation(() => createSessionsConfig());
    listSessionEntriesMock.mockImplementation(() => []);
  });

  it("includes agentId on sessions rows for --all-agents JSON output", async () => {
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock.mockImplementation(({ agentId }: { agentId: string }) =>
      agentId === "voice"
        ? [
            {
              sessionKey: "voice_row",
              entry: { sessionId: "s2", updatedAt: Date.now() - 120_000, model: "pi:opus" },
            },
          ]
        : [
            {
              sessionKey: "main_row",
              entry: { sessionId: "s1", updatedAt: Date.now() - 60_000, model: "pi:opus" },
            },
          ],
    );
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true, json: true }, runtime);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      path?: string | null;
      databasePath?: string | null;
      allAgents?: boolean;
      stores?: Array<{ agentId: string; path: string }>;
      databases?: Array<{ agentId: string; path: string }>;
      sessions?: Array<{ key: string; agentId?: string }>;
    };
    expect(payload.path).toBeNull();
    expect(payload.databasePath).toBeNull();
    expect(payload.allAgents).toBe(true);
    expect(payload.stores).toEqual(payload.databases);
    expect(payload.sessions?.map((session) => session.agentId)).toContain("main");
    expect(payload.sessions?.map((session) => session.agentId)).toContain("voice");
  });

  it("keeps per-agent rows in --all-agents database output", async () => {
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock.mockImplementation(({ agentId }: { agentId: string }) => [
      {
        sessionKey: `agent:${agentId}:room`,
        entry: {
          sessionId: agentId === "voice" ? "s2" : "s1",
          updatedAt: Date.now() - (agentId === "voice" ? 30_000 : 60_000),
          model: "pi:opus",
        },
      },
    ]);
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true, json: true }, runtime);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      count?: number;
      databases?: Array<{ agentId: string; path: string }>;
      allAgents?: boolean;
      sessions?: Array<{ key: string; agentId?: string }>;
    };
    expect(payload.count).toBe(2);
    expect(payload.allAgents).toBe(true);
    expect(payload.databases?.map((database) => database.agentId)).toEqual(["main", "voice"]);
    expect(
      payload.databases?.every((database) => database.path.endsWith("openclaw-agent.sqlite")),
    ).toBe(true);
    expect(payload.sessions?.map((session) => session.agentId).toSorted()).toEqual([
      "main",
      "voice",
    ]);
    expect(listSessionEntriesMock).toHaveBeenCalledTimes(2);
  });

  it("uses configured default agent id when resolving implicit session database", async () => {
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock.mockReturnValue([]);
    const { runtime, logs } = createRuntime();

    await sessionsCommand({}, runtime);

    expect(listSessionEntriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "voice",
        path: expect.stringContaining("agents/voice/agent/openclaw-agent.sqlite"),
      }),
    );
    expect(logs[0]).toContain("Session database:");
    expect(logs[0]).toContain("agents/voice/agent/openclaw-agent.sqlite");
  });

  it("uses all configured agent stores with --all-agents", async () => {
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock.mockImplementation(({ agentId }: { agentId: string }) =>
      agentId === "main"
        ? [
            {
              sessionKey: "main_row",
              entry: { sessionId: "s1", updatedAt: Date.now() - 60_000, model: "pi:opus" },
            },
          ]
        : [],
    );
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true }, runtime);

    expect(listSessionEntriesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        agentId: "main",
        path: expect.stringContaining("agents/main/agent/openclaw-agent.sqlite"),
      }),
    );
    expect(listSessionEntriesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        agentId: "voice",
        path: expect.stringContaining("agents/voice/agent/openclaw-agent.sqlite"),
      }),
    );
    expect(logs[0]).toContain("Session databases: 2 (main, voice)");
    expect(logs[2]).toContain("Agent");
  });
});
