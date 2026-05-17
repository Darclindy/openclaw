import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "grammy/types";
import {
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectTelegramLegacyStateMigrations } from "./doctor-legacy-state.js";
import {
  createTelegramMessageCache,
  resolveTelegramMessageCacheScopeKey,
} from "./message-cache.js";
import {
  clearSentMessageCache,
  resetSentMessageCacheForTest,
  wasSentByBot,
} from "./sent-message-cache.js";
import {
  getCachedSticker,
  resetTelegramStickerCacheForTests,
  type CachedSticker,
} from "./sticker-cache-store.js";
import {
  createTelegramThreadBindingManager,
  __testing,
  type TelegramThreadBindingRecord,
} from "./thread-bindings.js";
import {
  getTopicName,
  resolveTopicNameCacheScope,
  resetTopicNameCacheForTest,
  resetTopicNameCacheStoreForTest,
} from "./topic-name-cache.js";
import {
  readTelegramUpdateOffset,
  resetTelegramUpdateOffsetsForTests,
} from "./update-offset-store.js";
import { fingerprintTelegramBotToken } from "./token-fingerprint.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  clearSentMessageCache();
  resetSentMessageCacheForTest();
  resetTopicNameCacheStoreForTest();
  await __testing.resetTelegramThreadBindingsForTests({ clearStore: true });
  resetTelegramStickerCacheForTests();
  await resetTelegramUpdateOffsetsForTests();
  resetPluginStateStoreForTests();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStateDir(): string {
  const stateDir = makeTempStateDir();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return stateDir;
}

function makeTempStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-migrate-"));
  tempDirs.push(stateDir);
  return stateDir;
}

function applyContext(stateDir: string) {
  return {
    cfg: {},
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    oauthDir: path.join(stateDir, "oauth"),
  };
}

function telegramStore<T>(params: {
  namespace: string;
  maxEntries: number;
  env: NodeJS.ProcessEnv;
  defaultTtlMs?: number;
}) {
  return createPluginStateSyncKeyedStore<T>("telegram", {
    namespace: params.namespace,
    maxEntries: params.maxEntries,
    ...(params.defaultTtlMs ? { defaultTtlMs: params.defaultTtlMs } : {}),
    env: params.env,
  });
}

describe("Telegram legacy state migrations", () => {
  it("imports update offsets into plugin state and removes the JSON files", async () => {
    const stateDir = makeStateDir();
    const telegramDir = path.join(stateDir, "telegram");
    fs.mkdirSync(telegramDir, { recursive: true });
    const sourcePath = path.join(telegramDir, "update-offset-default.json");
    const botToken = "111111:token";
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        version: 3,
        lastUpdateId: 42,
        botId: "111111",
        tokenFingerprint: fingerprintTelegramBotToken(botToken),
      })}\n`,
    );

    const plan = detectTelegramLegacyStateMigrations({ stateDir }).find(
      (entry) => entry.label === "Telegram update offset",
    );
    expect(plan).toBeTruthy();
    const result = await plan!.apply(applyContext(stateDir));

    expect(result.changes.join("\n")).toContain("Imported 1 Telegram update offset");
    await expect(readTelegramUpdateOffset({ accountId: "default", botToken })).resolves.toBe(42);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("imports sticker cache rows into plugin state and removes the JSON file", async () => {
    const stateDir = makeStateDir();
    const telegramDir = path.join(stateDir, "telegram");
    fs.mkdirSync(telegramDir, { recursive: true });
    const sourcePath = path.join(telegramDir, "sticker-cache.json");
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        version: 1,
        stickers: {
          sticker1: {
            fileId: "file-1",
            fileUniqueId: "unique-1",
            description: "A useful sticker",
            cachedAt: "2026-03-01T10:00:00.000Z",
            emoji: ":)",
          },
        },
      })}\n`,
    );

    const plan = detectTelegramLegacyStateMigrations({ stateDir }).find(
      (entry) => entry.label === "Telegram sticker cache",
    );
    expect(plan).toBeTruthy();
    const result = await plan!.apply(applyContext(stateDir));

    expect(result.changes.join("\n")).toContain("Imported 1 Telegram sticker cache");
    expect(getCachedSticker("unique-1")?.description).toBe("A useful sticker");
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("imports thread bindings into plugin state and removes the JSON files", async () => {
    const stateDir = makeStateDir();
    const telegramDir = path.join(stateDir, "telegram");
    fs.mkdirSync(telegramDir, { recursive: true });
    const sourcePath = path.join(telegramDir, "thread-bindings-work.json");
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        version: 1,
        bindings: [
          {
            accountId: "ignored",
            conversationId: "-100200300:topic:77",
            targetKind: "subagent",
            targetSessionKey: "agent:main:subagent:child-1",
            boundAt: 1_700_000_000_000,
            lastActivityAt: 1_700_000_000_100,
          },
        ],
      })}\n`,
    );

    const plan = detectTelegramLegacyStateMigrations({ stateDir }).find(
      (entry) => entry.label === "Telegram thread bindings",
    );
    expect(plan).toBeTruthy();
    const result = await plan!.apply(applyContext(stateDir));

    expect(result.changes.join("\n")).toContain("Imported 1 Telegram thread bindings");
    const manager = createTelegramThreadBindingManager({
      cfg: { channels: { telegram: { token: "test-token" } } } as never,
      accountId: "work",
      persist: true,
      enableSweeper: false,
    });
    expect(manager.getByConversationId("-100200300:topic:77")?.targetSessionKey).toBe(
      "agent:main:subagent:child-1",
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("imports sent-message cache sidecars into plugin state and removes the JSON files", async () => {
    const stateDir = makeStateDir();
    const legacyStorePath = path.join(stateDir, "sessions", "work.json");
    const sourcePath = `${legacyStorePath}.telegram-sent-messages.json`;
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        "-100123": {
          "77": Date.now(),
        },
      })}\n`,
    );

    const plan = detectTelegramLegacyStateMigrations({ stateDir }).find(
      (entry) => entry.label === "Telegram sent-message cache",
    );
    expect(plan).toBeTruthy();
    const result = await plan!.apply(applyContext(stateDir));

    expect(result.changes.join("\n")).toContain("Imported 1 Telegram sent-message cache");
    resetSentMessageCacheForTest();
    expect(wasSentByBot("-100123", 77, { accountId: "default" })).toBe(true);
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("imports message cache sidecars into plugin state and removes the JSON files", async () => {
    const stateDir = makeStateDir();
    const legacyStorePath = path.join(stateDir, "sessions", "work.json");
    const sourcePath = `${legacyStorePath}.telegram-messages.json`;
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify([
        {
          key: "work:-100123:77",
          node: {
            messageId: "77",
            sourceMessage: {
              chat: { id: -100123, type: "supergroup", title: "Deployments" },
              message_id: 77,
              date: 1_700_000_000,
              text: "Ship the cache migration",
              from: { id: 1234, is_bot: false, first_name: "Ada" },
            } satisfies Partial<Message>,
            threadId: "42",
          },
        },
      ])}\n`,
    );

    const plan = detectTelegramLegacyStateMigrations({ stateDir }).find(
      (entry) => entry.label === "Telegram message cache",
    );
    expect(plan).toBeTruthy();
    const result = await plan!.apply(applyContext(stateDir));

    expect(result.changes.join("\n")).toContain("Imported 1 Telegram message cache");
    const cache = createTelegramMessageCache({
      persistedScopeKey: resolveTelegramMessageCacheScopeKey(legacyStorePath),
    });
    expect(cache.get({ accountId: "work", chatId: "-100123", messageId: "77" })).toMatchObject({
      body: "Ship the cache migration",
      messageId: "77",
      threadId: "42",
    });
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("imports topic-name cache sidecars into plugin state and removes the JSON files", async () => {
    const stateDir = makeStateDir();
    const legacyStorePath = path.join(stateDir, "sessions", "work.json");
    const sourcePath = `${legacyStorePath}.telegram-topic-names.json`;
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(
      sourcePath,
      `${JSON.stringify({
        "-100123:42": {
          name: "Deployments",
          iconColor: 0x6fb9f0,
          updatedAt: 1_700_000_000_000,
        },
      })}\n`,
    );

    const plan = detectTelegramLegacyStateMigrations({ stateDir }).find(
      (entry) => entry.label === "Telegram topic-name cache",
    );
    expect(plan).toBeTruthy();
    const result = await plan!.apply(applyContext(stateDir));

    expect(result.changes.join("\n")).toContain("Imported 1 Telegram topic-name cache");
    resetTopicNameCacheForTest();
    expect(getTopicName("-100123", "42", resolveTopicNameCacheScope(legacyStorePath))).toBe(
      "Deployments",
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("imports plugin state rows into the doctor context env", async () => {
    const processStateDir = makeStateDir();
    const stateDir = makeTempStateDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const processEnv = { ...process.env, OPENCLAW_STATE_DIR: processStateDir };
    const telegramDir = path.join(stateDir, "telegram");
    const sessionsDir = path.join(stateDir, "sessions");
    fs.mkdirSync(telegramDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    const botToken = "111111:token";
    fs.writeFileSync(
      path.join(telegramDir, "update-offset-default.json"),
      `${JSON.stringify({
        version: 3,
        lastUpdateId: 42,
        botId: "111111",
        tokenFingerprint: fingerprintTelegramBotToken(botToken),
      })}\n`,
    );
    fs.writeFileSync(
      path.join(telegramDir, "sticker-cache.json"),
      `${JSON.stringify({
        stickers: {
          one: {
            fileId: "file-env",
            fileUniqueId: "unique-env",
            description: "Env scoped sticker",
            cachedAt: "2026-03-01T10:00:00.000Z",
          },
        },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(telegramDir, "thread-bindings-work.json"),
      `${JSON.stringify({
        bindings: [
          {
            conversationId: "-100200300:topic:77",
            targetKind: "subagent",
            targetSessionKey: "agent:main:subagent:child-1",
          },
        ],
      })}\n`,
    );
    const legacyStorePath = path.join(sessionsDir, "work.json");
    fs.writeFileSync(
      `${legacyStorePath}.telegram-sent-messages.json`,
      `${JSON.stringify({ "-100123": { "77": Date.now() } })}\n`,
    );
    fs.writeFileSync(
      `${legacyStorePath}.telegram-messages.json`,
      `${JSON.stringify([
        {
          key: "work:-100123:77",
          node: {
            messageId: "77",
            sourceMessage: {
              chat: { id: -100123, type: "supergroup", title: "Deployments" },
              message_id: 77,
              date: 1_700_000_000,
              text: "Ship the cache migration",
            } satisfies Partial<Message>,
            threadId: "42",
          },
        },
      ])}\n`,
    );
    fs.writeFileSync(
      `${legacyStorePath}.telegram-topic-names.json`,
      `${JSON.stringify({
        "-100123:42": {
          name: "Deployments",
          iconColor: 0x6fb9f0,
          updatedAt: 1_700_000_000_000,
        },
      })}\n`,
    );

    for (const plan of detectTelegramLegacyStateMigrations({ stateDir })) {
      await plan.apply({
        cfg: {},
        env,
        stateDir,
        oauthDir: path.join(stateDir, "oauth"),
      });
    }

    await expect(readTelegramUpdateOffset({ botToken, env })).resolves.toBe(42);
    await expect(readTelegramUpdateOffset({ botToken, env: processEnv })).resolves.toBeNull();
    expect(
      telegramStore<CachedSticker>({
        namespace: "sticker-cache",
        maxEntries: 10_000,
        env,
      }).lookup("unique-env")?.description,
    ).toBe("Env scoped sticker");
    expect(
      telegramStore<CachedSticker>({
        namespace: "sticker-cache",
        maxEntries: 10_000,
        env: processEnv,
      }).lookup("unique-env"),
    ).toBeUndefined();
    expect(
      telegramStore<TelegramThreadBindingRecord>({
        namespace: "thread-bindings",
        maxEntries: 50_000,
        env,
      })
        .entries()
        .map((entry) => entry.value.targetSessionKey),
    ).toEqual(["agent:main:subagent:child-1"]);
    expect(
      telegramStore<{ scopeKey: string; chatId: string; messageId: string }>({
        namespace: "sent-messages",
        maxEntries: 100_000,
        defaultTtlMs: 24 * 60 * 60 * 1000,
        env,
      })
        .entries()
        .map((entry) => `${entry.value.scopeKey}:${entry.value.chatId}:${entry.value.messageId}`),
    ).toEqual(["default:-100123:77"]);
    const messageScope = resolveTelegramMessageCacheScopeKey(legacyStorePath);
    expect(
      telegramStore<{ scopeKey: string; cacheKey: string }>({
        namespace: "message-cache",
        maxEntries: 100_000,
        defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
        env,
      })
        .entries()
        .map((entry) => `${entry.value.scopeKey}:${entry.value.cacheKey}`),
    ).toEqual([`${messageScope}:work:-100123:77`]);
    expect(
      telegramStore<{ scopeKey: string; name: string }>({
        namespace: "topic-names",
        maxEntries: 900,
        env,
      })
        .entries()
        .map((entry) => `${entry.value.scopeKey}:${entry.value.name}`),
    ).toEqual([`${resolveTopicNameCacheScope(legacyStorePath)}:Deployments`]);
  });
});
