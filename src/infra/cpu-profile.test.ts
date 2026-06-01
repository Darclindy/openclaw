import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isCpuProfileEnabled,
  resolveCpuProfileDir,
  startCpuProfile,
  stopCpuProfile,
  withCpuProfile,
} from "./cpu-profile.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-cpuprof-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("cpu-profile gating", () => {
  it("is disabled without OPENCLAW_CPU_PROFILE_DIR", () => {
    expect(isCpuProfileEnabled({})).toBe(false);
    expect(resolveCpuProfileDir({})).toBeUndefined();
  });

  it("is enabled when a directory is configured", () => {
    const env = { OPENCLAW_CPU_PROFILE_DIR: "/tmp/x" } as NodeJS.ProcessEnv;
    expect(isCpuProfileEnabled(env)).toBe(true);
    expect(resolveCpuProfileDir(env)).toBe("/tmp/x");
  });

  it("honors the OPENCLAW_CPU_PROFILE_OFF kill switch", () => {
    const env = {
      OPENCLAW_CPU_PROFILE_DIR: "/tmp/x",
      OPENCLAW_CPU_PROFILE_OFF: "1",
    } as NodeJS.ProcessEnv;
    expect(isCpuProfileEnabled(env)).toBe(false);
  });

  it("start is a no-op when disabled", async () => {
    await expect(startCpuProfile({})).resolves.toBe(false);
    await expect(stopCpuProfile("x", {})).resolves.toBeNull();
  });
});

describe("withCpuProfile capture", () => {
  it("writes a non-empty .cpuprofile around the wrapped work", async () => {
    const dir = makeTempDir();
    const env = { OPENCLAW_CPU_PROFILE_DIR: dir } as NodeJS.ProcessEnv;
    const result = await withCpuProfile(
      "unit",
      () => {
        let acc = 0;
        for (let i = 0; i < 1_000_000; i++) {
          acc += Math.sqrt(i);
        }
        return acc;
      },
      env,
    );
    expect(typeof result).toBe("number");
    const profiles = readdirSync(dir).filter((f) => f.endsWith(".cpuprofile"));
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toContain("unit-");
    expect(statSync(join(dir, profiles[0])).size).toBeGreaterThan(0);
  });

  it("runs the work even when profiling is disabled", async () => {
    const ran = await withCpuProfile("noop", () => "done", {});
    expect(ran).toBe("done");
  });
});
