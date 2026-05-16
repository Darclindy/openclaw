import { afterEach, expect, test, vi } from "vitest";
import { getSessionEntry } from "../config/sessions.js";
import { setupGatewaySessionsTestHarness, directSessionReq } from "./test/server-sessions.test-helpers.js";

const transcriptMocks = vi.hoisted(() => ({
  failAppend: false,
}));

vi.mock("../config/sessions/transcript-store.sqlite.js", async () => {
  const actual = await vi.importActual<typeof import("../config/sessions/transcript-store.sqlite.js")>(
    "../config/sessions/transcript-store.sqlite.js",
  );
  return {
    ...actual,
    appendSqliteSessionTranscriptEvent: (
      ...args: Parameters<typeof actual.appendSqliteSessionTranscriptEvent>
    ) => {
      if (transcriptMocks.failAppend) {
        throw new Error("transcript append failed");
      }
      return actual.appendSqliteSessionTranscriptEvent(...args);
    },
  };
});

setupGatewaySessionsTestHarness();

afterEach(() => {
  transcriptMocks.failAppend = false;
});

test("sessions.send removes implicit main session when transcript creation fails", async () => {
  transcriptMocks.failAppend = true;

  const sent = await directSessionReq("sessions.send", {
    key: "agent:main:main",
    message: "hello",
  });

  expect(sent.ok).toBe(false);
  expect(sent.error?.message).toContain("failed to create session transcript");
  expect(getSessionEntry({ agentId: "main", sessionKey: "agent:main:main" })).toBeUndefined();
});
