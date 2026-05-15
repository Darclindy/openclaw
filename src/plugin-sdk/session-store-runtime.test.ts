import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadSessionStore,
  readSessionUpdatedAt,
  upsertSessionEntry,
} from "./session-store-runtime.js";

describe("session-store-runtime compatibility", () => {
  it("rejects custom store paths instead of falling back to the default agent", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-session-store-compat-",
        scenario: "minimal",
      },
      async (state) => {
        const customStorePath = path.join(state.path("custom"), "sessions.json");
        await fs.mkdir(path.dirname(customStorePath), { recursive: true });

        upsertSessionEntry({
          agentId: "default",
          env: { ...process.env, OPENCLAW_STATE_DIR: state.stateDir },
          sessionKey: "discord:default:user:1",
          entry: {
            sessionId: "default-session",
            updatedAt: 123,
            sessionStartedAt: 123,
          },
        });

        expect(() => loadSessionStore(customStorePath)).toThrow(/Custom sessions\.json paths/);
        expect(
          readSessionUpdatedAt({
            agentId: "default",
            sessionKey: "discord:default:user:1",
            storePath: customStorePath,
          }),
        ).toBe(123);
      },
    );
  });
});
