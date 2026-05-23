import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatUiProtocolFreshnessIssue,
  repairUiProtocolFreshnessIssue,
  uiProtocolFreshnessIssueTitle,
} from "./doctor-ui.js";

const mocks = vi.hoisted(() => ({
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

describe("doctor UI freshness repair helpers", () => {
  beforeEach(() => {
    mocks.runCommandWithTimeout.mockReset();
  });

  it("formats missing UI assets like the legacy doctor note", () => {
    const issue = {
      kind: "missing-assets" as const,
      root: "/repo",
      uiIndexPath: "/repo/dist/index.html",
      canBuild: true,
    };

    expect(uiProtocolFreshnessIssueTitle(issue)).toBe("UI");
    expect(formatUiProtocolFreshnessIssue(issue)).toBe(
      ["- Control UI assets are missing.", "- Run: pnpm ui:build"].join("\n"),
    );
  });

  it("builds missing UI assets after confirmation", async () => {
    mocks.runCommandWithTimeout.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const confirmAutoFix = vi.fn(async () => true);
    const confirmAggressiveAutoFix = vi.fn(async () => false);

    const result = await repairUiProtocolFreshnessIssue(
      {
        kind: "missing-assets",
        root: "/repo",
        uiIndexPath: "/repo/dist/index.html",
        canBuild: true,
      },
      { confirmAutoFix, confirmAggressiveAutoFix },
    );

    expect(result).toEqual({ status: "repaired", notes: ["UI build complete."] });
    expect(confirmAutoFix).toHaveBeenCalledWith({
      message: "Build Control UI assets now?",
      initialValue: true,
    });
    expect(confirmAggressiveAutoFix).not.toHaveBeenCalled();
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(
      [process.execPath, "/repo/scripts/ui.js", "build"],
      expect.objectContaining({ cwd: "/repo", timeoutMs: 120_000 }),
    );
  });

  it("keeps slim installs quiet when UI sources are absent", async () => {
    const result = await repairUiProtocolFreshnessIssue(
      {
        kind: "stale-assets",
        root: "/repo",
        uiIndexPath: "/repo/dist/index.html",
        schemaPath: "/repo/src/gateway/protocol/schema.ts",
        canBuild: false,
        changesSinceBuild: ["abc schema change"],
      },
      {
        confirmAutoFix: vi.fn(async () => true),
        confirmAggressiveAutoFix: vi.fn(async () => true),
      },
    );

    expect(result).toEqual({
      status: "skipped",
      notes: ["Skipping UI rebuild: ui/ sources not present."],
    });
    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
  });
});
