import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";
import { withOpenClawStateLock } from "./openclaw-state-lock.js";

const FAST_RETRY = {
  retries: 100,
  factor: 1,
  minTimeout: 1,
  maxTimeout: 1,
  randomize: false,
} as const;

describe("withOpenClawStateLock", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("renews active leases so long critical sections are not stolen", async () => {
    await withTempDir({ prefix: "openclaw-core-state-lock-renew-" }, async (dir) => {
      const dbPath = path.join(dir, "state.sqlite");
      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstCanFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let first!: Promise<void>;
      const firstEntered = new Promise<void>((resolve) => {
        first = withOpenClawStateLock(
          "shared",
          { path: dbPath, stale: 30, retries: FAST_RETRY },
          async () => {
            order.push("first-enter");
            resolve();
            await firstCanFinish;
            order.push("first-exit");
          },
        );
      });

      await firstEntered;
      await new Promise((resolve) => setTimeout(resolve, 75));
      const second = withOpenClawStateLock(
        "shared",
        { path: dbPath, stale: 30, retries: FAST_RETRY },
        async () => {
          order.push("second-enter");
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(order).toEqual(["first-enter"]);

      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
    });
  });
});
