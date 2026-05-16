import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMatrixInboundEventDeduper } from "./inbound-dedupe.js";

describe("Matrix inbound event dedupe", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetPluginStateStoreForTests();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createStateRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-inbound-dedupe-"));
    tempDirs.push(dir);
    return dir;
  }

  const auth = {
    accountId: "ops",
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "token",
    deviceId: "DEVICE",
  } as const;

  it("persists committed events across restarts", async () => {
    const stateRootDir = createStateRoot();
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      stateRootDir,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$event-1" })).toBe(true);
    await first.commitEvent({
      roomId: "!room:example.org",
      eventId: "$event-1",
    });
    await first.stop();

    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      stateRootDir,
    });
    expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$event-1" })).toBe(false);
  });

  it("isolates concurrent state root overrides without mutating process env", async () => {
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    const globalStateDir = createStateRoot();
    const firstStateRootDir = createStateRoot();
    const secondStateRootDir = createStateRoot();
    process.env.OPENCLAW_STATE_DIR = globalStateDir;
    try {
      const [first, second] = await Promise.all([
        createMatrixInboundEventDeduper({
          auth: auth as never,
          stateRootDir: firstStateRootDir,
        }),
        createMatrixInboundEventDeduper({
          auth: auth as never,
          stateRootDir: secondStateRootDir,
        }),
      ]);

      expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$shared" })).toBe(true);
      expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$shared" })).toBe(true);
      await Promise.all([
        first.commitEvent({ roomId: "!room:example.org", eventId: "$shared" }),
        second.commitEvent({ roomId: "!room:example.org", eventId: "$shared" }),
      ]);

      expect(process.env.OPENCLAW_STATE_DIR).toBe(globalStateDir);
      expect(fs.existsSync(path.join(globalStateDir, "state", "openclaw.sqlite"))).toBe(false);
      const firstReloaded = await createMatrixInboundEventDeduper({
        auth: auth as never,
        stateRootDir: firstStateRootDir,
      });
      const secondReloaded = await createMatrixInboundEventDeduper({
        auth: auth as never,
        stateRootDir: secondStateRootDir,
      });
      expect(firstReloaded.claimEvent({ roomId: "!room:example.org", eventId: "$shared" })).toBe(
        false,
      );
      expect(secondReloaded.claimEvent({ roomId: "!room:example.org", eventId: "$shared" })).toBe(
        false,
      );
    } finally {
      if (originalStateDir == null) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalStateDir;
      }
    }
  });

  it("does not persist released pending claims", async () => {
    const stateRootDir = createStateRoot();
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      stateRootDir,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$event-2" })).toBe(true);
    first.releaseEvent({ roomId: "!room:example.org", eventId: "$event-2" });
    await first.stop();

    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      stateRootDir,
    });
    expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$event-2" })).toBe(true);
  });

  it("prunes expired and overflowed entries on load", async () => {
    const stateRootDir = createStateRoot();
    let now = 10;
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      stateRootDir,
      ttlMs: 1_000,
      maxEntries: 10,
      nowMs: () => now,
    });
    for (const eventId of ["$old", "$keep-1", "$keep-2", "$keep-3"]) {
      expect(first.claimEvent({ roomId: "!room:example.org", eventId })).toBe(true);
      await first.commitEvent({ roomId: "!room:example.org", eventId });
      now += eventId === "$old" ? 80 : 5;
    }
    await first.stop();

    const deduper = await createMatrixInboundEventDeduper({
      auth: auth as never,
      stateRootDir,
      ttlMs: 20,
      maxEntries: 2,
      nowMs: () => 100,
    });

    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$old" })).toBe(true);
    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$keep-1" })).toBe(true);
    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$keep-2" })).toBe(false);
    expect(deduper.claimEvent({ roomId: "!room:example.org", eventId: "$keep-3" })).toBe(false);
  });

  it("retains replayed backlog events based on processing time", async () => {
    const stateRootDir = createStateRoot();
    let now = 100;
    const first = await createMatrixInboundEventDeduper({
      auth: auth as never,
      stateRootDir,
      ttlMs: 20,
      nowMs: () => now,
    });

    expect(first.claimEvent({ roomId: "!room:example.org", eventId: "$backlog" })).toBe(true);
    await first.commitEvent({
      roomId: "!room:example.org",
      eventId: "$backlog",
    });
    await first.stop();

    now = 110;
    const second = await createMatrixInboundEventDeduper({
      auth: auth as never,
      stateRootDir,
      ttlMs: 20,
      nowMs: () => now,
    });
    expect(second.claimEvent({ roomId: "!room:example.org", eventId: "$backlog" })).toBe(false);
  });
});
