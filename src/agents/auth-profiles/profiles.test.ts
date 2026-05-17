import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTH_STORE_VERSION } from "./constants.js";
import {
  clearLastGoodProfileWithLock,
  promoteAuthProfileInOrder,
} from "./profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  loadAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
} from "./store.js";
import type { AuthProfileStore } from "./types.js";

describe("promoteAuthProfileInOrder", () => {
  it("uses env-scoped default agent keys when agentDir is omitted", async () => {
    const processStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-process-state-"));
    const envStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-env-state-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = processStateDir;
    const env = { ...process.env, OPENCLAW_STATE_DIR: envStateDir };
    const profileId = "openai-codex:env-default";
    try {
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "token",
              provider: "openai-codex",
              token: "env-token",
            },
          },
        },
        undefined,
        { env },
      );
      clearRuntimeAuthProfileStoreSnapshots();

      const loaded = loadAuthProfileStoreWithoutExternalProfiles(undefined, { env });

      expect(loaded.profiles[profileId]).toMatchObject({
        type: "token",
        provider: "openai-codex",
        token: "env-token",
      });
      expect(fs.existsSync(path.join(envStateDir, "state", "openclaw.sqlite"))).toBe(true);
      expect(fs.existsSync(path.join(processStateDir, "state", "openclaw.sqlite"))).toBe(false);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(processStateDir, { recursive: true, force: true });
      fs.rmSync(envStateDir, { recursive: true, force: true });
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("reads env-scoped legacy default auth profiles before migration", async () => {
    const processStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-legacy-process-"));
    const envStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-legacy-env-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = processStateDir;
    const env = { ...process.env, OPENCLAW_STATE_DIR: envStateDir };
    const agentDir = path.join(envStateDir, "agents", "main", "agent");
    const profileId = "openai-codex:legacy-default";
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify({
          version: AUTH_STORE_VERSION,
          profiles: {
            [profileId]: {
              type: "token",
              provider: "openai-codex",
              token: "legacy-env-token",
            },
          },
        })}\n`,
      );

      const loaded = loadAuthProfileStoreWithoutExternalProfiles(undefined, { env });

      expect(loaded.profiles[profileId]).toMatchObject({
        type: "token",
        provider: "openai-codex",
        token: "legacy-env-token",
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(processStateDir, { recursive: true, force: true });
      fs.rmSync(envStateDir, { recursive: true, force: true });
      clearRuntimeAuthProfileStoreSnapshots();
    }
  });

  it("moves a relogin profile to the front of an existing per-agent provider order", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-order-promote-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const newProfileId = "openai-codex:bunsthedev@gmail.com";
      const staleProfileId = "openai-codex:val@viewdue.ai";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [newProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "new-access",
              refresh: "new-refresh",
              expires: Date.now() + 60 * 60 * 1000,
            },
            [staleProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "stale-access",
              refresh: "stale-refresh",
              expires: Date.now() + 30 * 60 * 1000,
            },
          },
          order: {
            "openai-codex": [staleProfileId],
          },
        },
        agentDir,
      );

      const updated = await promoteAuthProfileInOrder({
        agentDir,
        provider: "openai-codex",
        profileId: newProfileId,
      });

      expect(updated?.order?.["openai-codex"]).toEqual([newProfileId, staleProfileId]);
      expect(loadAuthProfileStoreForRuntime(agentDir).order?.["openai-codex"]).toEqual([
        newProfileId,
        staleProfileId,
      ]);
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("clears matching lastGood after a stale refresh_token_reused profile", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-clear-lastgood-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const staleProfileId = "openai-codex:default";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [staleProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "stale-access-token",
              refresh: "stale-refresh-token",
              expires: Date.now() - 60_000,
            },
          },
          lastGood: { "openai-codex": staleProfileId },
        },
        agentDir,
      );

      await clearLastGoodProfileWithLock({
        agentDir,
        provider: "openai-codex",
        profileId: staleProfileId,
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood).toBeUndefined();
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not clear lastGood when the failed profile is not the stored profile", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-clear-lastgood-keep-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const goodProfileId = "openai-codex:user@example.test";
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            [goodProfileId]: {
              type: "oauth",
              provider: "openai-codex",
              access: "good-access-token",
              refresh: "good-refresh-token",
              expires: Date.now() + 60_000,
            },
          },
          lastGood: { "openai-codex": goodProfileId },
        },
        agentDir,
      );

      await clearLastGoodProfileWithLock({
        agentDir,
        provider: "openai-codex",
        profileId: "openai-codex:default",
      });

      expect(loadAuthProfileStoreForRuntime(agentDir).lastGood?.["openai-codex"]).toBe(
        goodProfileId,
      );
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
