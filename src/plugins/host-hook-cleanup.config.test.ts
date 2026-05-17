import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSessionEntry, upsertSessionEntry } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { runPluginHostCleanup } from "./host-hook-cleanup.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

describe("plugin host cleanup config fallback", () => {
  afterEach(() => {
    mocks.getRuntimeConfig.mockReset();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("records session store config failures while continuing runtime cleanup", async () => {
    const registry = createEmptyPluginRegistry();
    const cleanup = vi.fn();
    registry.runtimeLifecycles ??= [];
    registry.runtimeLifecycles.push({
      pluginId: "cleanup-plugin",
      pluginName: "Cleanup Plugin",
      source: "test",
      lifecycle: {
        id: "runtime-cleanup",
        cleanup,
      },
    });
    const configError = new Error("invalid config");
    mocks.getRuntimeConfig.mockImplementation(() => {
      throw configError;
    });

    const result = await runPluginHostCleanup({
      registry,
      pluginId: "cleanup-plugin",
      reason: "disable",
    });

    expect(cleanup.mock.calls).toEqual([
      [
        {
          runId: undefined,
          reason: "disable",
          sessionKey: undefined,
        },
      ],
    ]);
    expect(result.cleanupCount).toBe(1);
    expect(result.failures).toEqual([
      {
        error: configError,
        pluginId: "cleanup-plugin",
        hookId: "session-store",
      },
    ]);
  });

  it("clears plugin session state in registered agent databases", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-cleanup-registered-db-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    try {
      process.env.OPENCLAW_STATE_DIR = stateDir;
      const cfg = {
        session: {},
        agents: { list: [{ id: "main", default: true }] },
      } as OpenClawConfig;
      const sessionKey = "agent:main:archived";
      const databasePath = path.join(stateDir, "retired", "openclaw-agent.sqlite");
      upsertSessionEntry({
        agentId: "main",
        path: databasePath,
        sessionKey,
        entry: {
          sessionId: "archived-session",
          updatedAt: 1,
          pluginExtensions: {
            "cleanup-plugin": { workflow: { state: "waiting" } },
          },
        },
      });

      const result = await runPluginHostCleanup({
        cfg,
        registry: createEmptyPluginRegistry(),
        pluginId: "cleanup-plugin",
        reason: "disable",
      });

      expect(result.failures).toEqual([]);
      expect(result.cleanupCount).toBe(1);
      expect(
        getSessionEntry({ agentId: "main", path: databasePath, sessionKey })?.pluginExtensions,
      ).toBeUndefined();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
