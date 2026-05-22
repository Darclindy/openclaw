import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAuthProfileStoreKey } from "../agents/auth-profiles/paths.js";
import {
  readAuthProfileStorePayloadResult,
  writeAuthProfileStorePayload,
} from "../agents/auth-profiles/sqlite-storage.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { clearSecretsRuntimeSnapshot } from "./runtime-state.js";

function authStore(key: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key,
      },
    },
  };
}

describe("secrets runtime state", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("clears loaded auth-profile cache without importing the full secrets runtime", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-state-cache-"));
    process.env.OPENCLAW_STATE_DIR = root;
    const agentDir = path.join(root, "agents", "default", "agent");

    try {
      fs.mkdirSync(agentDir, { recursive: true });
      const env = { OPENCLAW_STATE_DIR: root };
      const storeKey = resolveAuthProfileStoreKey(agentDir, env);
      saveAuthProfileStore(authStore("sk-old"), agentDir, { env });
      const saved = readAuthProfileStorePayloadResult(storeKey, { env });
      if (!saved.exists) {
        throw new Error("expected seeded auth profile store");
      }

      loadAuthProfileStoreForRuntime(agentDir, { env, syncExternalCli: false });
      writeAuthProfileStorePayload(storeKey, authStore("sk-new"), {
        env,
        now: () => saved.updatedAt,
      });

      expect(
        loadAuthProfileStoreForRuntime(agentDir, { env, syncExternalCli: false }).profiles[
          "openai:default"
        ],
      ).toMatchObject({ key: "sk-old" });

      clearSecretsRuntimeSnapshot();

      expect(
        loadAuthProfileStoreForRuntime(agentDir, { env, syncExternalCli: false }).profiles[
          "openai:default"
        ],
      ).toMatchObject({ key: "sk-new" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
