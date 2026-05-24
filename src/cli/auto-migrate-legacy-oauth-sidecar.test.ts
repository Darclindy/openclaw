import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/store.js";
import { testing as oauthSidecarTesting } from "../commands/doctor-auth-oauth-sidecar.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli } from "./auto-migrate-legacy-oauth-sidecar.js";

const DECLINE_MARKER_FILENAME = "legacy-oauth-sidecar-migration-declined";

const states: OpenClawTestState[] = [];

const INTERACTIVE_SHELL_ENV: Record<string, string | undefined> = {
  CI: undefined,
  OPENCLAW_NON_INTERACTIVE: undefined,
  OPENCLAW_AUTH_STORE_READONLY: undefined,
  OPENCLAW_AUTO_MIGRATE_LEGACY_OAUTH_SIDECAR: undefined,
};

function setPlatform(value: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  return () => {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  };
}

function declineMarkerPath(state: OpenClawTestState): string {
  return state.statePath(DECLINE_MARKER_FILENAME);
}

async function makeStateWithLegacyOauthRef(seed: string): Promise<{
  state: OpenClawTestState;
  authPath: string;
  sidecarPath: string;
  profileId: string;
}> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-auto-migrate-sidecar-",
    env: {
      ...INTERACTIVE_SHELL_ENV,
      OPENCLAW_AGENT_DIR: undefined,
      OPENCLAW_AUTH_PROFILE_SECRET_KEY: seed,
    },
  });
  states.push(state);
  const profileId = "openai-codex:default";
  const ref = {
    source: "openclaw-credentials" as const,
    provider: "openai-codex" as const,
    id: "0123456789abcdef0123456789abcdef",
  };
  const authPath = await state.writeAuthProfiles({
    version: 1,
    profiles: {
      [profileId]: {
        type: "oauth",
        provider: "openai-codex",
        expires: 1777777777000,
        oauthRef: ref,
      },
    },
    order: { "openai-codex": [profileId] },
    lastGood: { "openai-codex": profileId },
  });
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv(
    "aes-256-gcm",
    oauthSidecarTesting.buildLegacyOAuthSecretKey(seed),
    iv,
  );
  cipher.setAAD(
    oauthSidecarTesting.buildLegacyOAuthSecretAad({
      ref,
      profileId,
      provider: "openai-codex",
    }),
  );
  const ciphertext = Buffer.concat([
    cipher.update(
      JSON.stringify({ access: "access-token", refresh: "refresh-token", idToken: "id-token" }),
      "utf8",
    ),
    cipher.final(),
  ]);
  const sidecarPath = await state.writeJson(
    path.join("credentials", "auth-profiles", `${ref.id}.json`),
    {
      version: 1,
      profileId,
      provider: "openai-codex",
      encrypted: {
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      },
    },
  );
  return { state, authPath, sidecarPath, profileId };
}

async function makeStateWithUnreferencedSidecar(seed: string): Promise<{
  state: OpenClawTestState;
  sidecarPath: string;
}> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-auto-migrate-unreferenced-sidecar-",
    env: {
      ...INTERACTIVE_SHELL_ENV,
      OPENCLAW_AGENT_DIR: undefined,
      OPENCLAW_AUTH_PROFILE_SECRET_KEY: seed,
    },
  });
  states.push(state);
  const refId = "abcdef0123456789abcdef0123456789";
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv(
    "aes-256-gcm",
    oauthSidecarTesting.buildLegacyOAuthSecretKey(seed),
    iv,
  );
  cipher.setAAD(
    oauthSidecarTesting.buildLegacyOAuthSecretAad({
      ref: { source: "openclaw-credentials", provider: "openai-codex", id: refId },
      profileId: "openai-codex:orphan",
      provider: "openai-codex",
    }),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify({ access: "orphan-token" }), "utf8"),
    cipher.final(),
  ]);
  const sidecarPath = await state.writeJson(
    path.join("credentials", "auth-profiles", `${refId}.json`),
    {
      version: 1,
      profileId: "openai-codex:orphan",
      provider: "openai-codex",
      encrypted: {
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      },
    },
  );
  return { state, sidecarPath };
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli", () => {
  let restorePlatform: () => void;

  beforeEach(() => {
    restorePlatform = setPlatform("darwin");
  });

  afterEach(() => {
    restorePlatform();
  });

  it.each<{ name: string; setup: () => Promise<{ env: NodeJS.ProcessEnv; isTty?: boolean }> }>([
    {
      name: "non-darwin platform",
      setup: async () => {
        restorePlatform();
        restorePlatform = setPlatform("linux");
        return { env: { HOME: "/tmp" } };
      },
    },
    {
      name: "non-TTY",
      setup: async () => {
        const { state } = await makeStateWithLegacyOauthRef("seed");
        return { env: state.env, isTty: false };
      },
    },
    {
      name: "OPENCLAW_AUTO_MIGRATE_LEGACY_OAUTH_SIDECAR=0 opt-out",
      setup: async () => {
        const { state } = await makeStateWithLegacyOauthRef("seed");
        return { env: { ...state.env, OPENCLAW_AUTO_MIGRATE_LEGACY_OAUTH_SIDECAR: "0" } };
      },
    },
    {
      name: "CI=true",
      setup: async () => {
        const { state } = await makeStateWithLegacyOauthRef("seed");
        return { env: { ...state.env, CI: "true" } };
      },
    },
    {
      name: "OPENCLAW_AUTH_STORE_READONLY=1 (embedded path)",
      setup: async () => {
        const { state } = await makeStateWithLegacyOauthRef("seed");
        return { env: { ...state.env, OPENCLAW_AUTH_STORE_READONLY: "1" } };
      },
    },
    {
      name: "no sidecar files",
      setup: async () => {
        const state = await createOpenClawTestState({
          layout: "state-only",
          prefix: "openclaw-auto-migrate-empty-",
        });
        states.push(state);
        return { env: state.env };
      },
    },
  ])("does not prompt or migrate when skipped: $name", async ({ setup }) => {
    const { env, isTty = true } = await setup();
    const confirm = vi.fn();
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env,
      isInteractiveTty: () => isTty,
      prompter: { confirm },
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(["doctor", "update", "completion"])(
    "does not prompt for the %s primary command",
    async (primary) => {
      const { state } = await makeStateWithLegacyOauthRef("seed");
      const confirm = vi.fn();
      await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
        argv: ["node", "openclaw", primary],
        env: state.env,
        isInteractiveTty: () => true,
        prompter: { confirm },
      });
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "--json on a routed primary", argv: ["node", "openclaw", "status", "--json"] },
    { name: "--json=pretty", argv: ["node", "openclaw", "agent", "--json=pretty"] },
    { name: "--json before subcommand", argv: ["node", "openclaw", "--json", "status"] },
  ])("does not prompt for JSON-output invocations: $name", async ({ argv }) => {
    const { state, sidecarPath } = await makeStateWithLegacyOauthRef("seed");
    const confirm = vi.fn();
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv,
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(fs.existsSync(declineMarkerPath(state))).toBe(false);
  });

  it.each([
    {
      name: "--non-interactive on agents add",
      argv: ["node", "openclaw", "agents", "add", "--workspace", "/tmp/wp", "--non-interactive"],
    },
    {
      name: "--non-interactive on reset",
      argv: ["node", "openclaw", "reset", "--scope", "config", "--yes", "--non-interactive"],
    },
    {
      name: "--non-interactive on setup",
      argv: ["node", "openclaw", "setup", "--non-interactive"],
    },
  ])("does not prompt for argv-level --non-interactive invocations: $name", async ({ argv }) => {
    const { state, sidecarPath } = await makeStateWithLegacyOauthRef("seed");
    const confirm = vi.fn();
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv,
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(fs.existsSync(declineMarkerPath(state))).toBe(false);
  });

  it.each([
    { name: "bare-root TUI launch", argv: ["node", "openclaw"] },
    { name: "openclaw gateway foreground start", argv: ["node", "openclaw", "gateway"] },
    { name: "openclaw gateway run foreground start", argv: ["node", "openclaw", "gateway", "run"] },
  ])("prompts before the $name fast path", async ({ argv }) => {
    const { state } = await makeStateWithLegacyOauthRef("seed");
    const confirm = vi.fn(async () => false);
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv,
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "reset --yes",
      argv: ["node", "openclaw", "reset", "--scope", "config", "--yes"],
    },
    {
      name: "uninstall --yes",
      argv: ["node", "openclaw", "uninstall", "--yes"],
    },
    {
      name: "migrate apply --yes",
      argv: ["node", "openclaw", "migrate", "apply", "codex", "--yes"],
    },
  ])("does not prompt for --yes no-confirmation invocations: $name", async ({ argv }) => {
    const { state, sidecarPath } = await makeStateWithLegacyOauthRef("seed");
    const confirm = vi.fn();
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv,
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(fs.existsSync(declineMarkerPath(state))).toBe(false);
  });

  it.each([
    {
      name: "plugins uninstall --force",
      argv: ["node", "openclaw", "plugins", "uninstall", "pkg", "--force"],
    },
    { name: "agent prune --force", argv: ["node", "openclaw", "agent", "prune", "old", "--force"] },
    { name: "models scan --no-input", argv: ["node", "openclaw", "models", "scan", "--no-input"] },
  ])("does not prompt for additional no-prompt flags: $name", async ({ argv }) => {
    const { state, sidecarPath } = await makeStateWithLegacyOauthRef("seed");
    const confirm = vi.fn();
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv,
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(fs.existsSync(declineMarkerPath(state))).toBe(false);
  });

  it("still prompts when --force or --no-input appears after a `--` argv terminator", async () => {
    const { state } = await makeStateWithLegacyOauthRef("seed");
    for (const argv of [
      ["node", "openclaw", "status", "--", "--force"],
      ["node", "openclaw", "status", "--", "--no-input"],
    ]) {
      const confirm = vi.fn(async () => false);
      await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
        argv,
        env: state.env,
        isInteractiveTty: () => true,
        prompter: { confirm },
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      // Reset the decline marker so the next iteration also prompts.
      fs.rmSync(declineMarkerPath(state), { force: true });
    }
  });

  it("still prompts when --yes appears after a `--` argv terminator", async () => {
    const { state } = await makeStateWithLegacyOauthRef("seed");
    const confirm = vi.fn(async () => false);
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status", "--", "--yes"],
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("still prompts when --non-interactive appears after a `--` argv terminator", async () => {
    const { state } = await makeStateWithLegacyOauthRef("seed");
    const confirm = vi.fn(async () => false);
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status", "--", "--non-interactive"],
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("still prompts when --json appears after a `--` argv terminator", async () => {
    const { state } = await makeStateWithLegacyOauthRef("seed");
    const confirm = vi.fn(async () => false);
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status", "--", "--json"],
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("migrates legacy oauthRef profiles when the user accepts", async () => {
    const { state, authPath, sidecarPath, profileId } =
      await makeStateWithLegacyOauthRef("legacy-oauth-seed");
    const confirm = vi.fn(async () => true);
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sidecarPath)).toBe(false);
    const written = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
    const profiles = written.profiles as Record<string, Record<string, unknown>>;
    expect(profiles[profileId]?.access).toBe("access-token");
    expect(profiles[profileId]?.refresh).toBe("refresh-token");
    expect(profiles[profileId]?.idToken).toBe("id-token");
    expect(profiles[profileId]?.oauthRef).toBeUndefined();
    expect(fs.existsSync(declineMarkerPath(state))).toBe(false);
  });

  it("does not prompt when only unreferenced sidecar files exist (no migratable oauthRef profile)", async () => {
    const { state, sidecarPath } = await makeStateWithUnreferencedSidecar("legacy-oauth-seed");
    const confirm = vi.fn();
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(fs.existsSync(declineMarkerPath(state))).toBe(false);

    const confirmAgain = vi.fn();
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm: confirmAgain },
    });
    expect(confirmAgain).not.toHaveBeenCalled();
    expect(fs.existsSync(sidecarPath)).toBe(true);
  });

  it("writes the decline marker when the user accepts but decryption fails (e.g. Keychain denied)", async () => {
    const { state, sidecarPath } = await makeStateWithLegacyOauthRef("legacy-oauth-seed");
    // Corrupt the sidecar ciphertext so decryption fails regardless of which
    // seed source the loader tries — same observable outcome as the user
    // hitting "Deny" on the macOS Keychain prompt after accepting the
    // migration confirm.
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8")) as {
      encrypted: { ciphertext: string };
    };
    sidecar.encrypted.ciphertext = Buffer.from("not-the-real-ciphertext").toString("base64url");
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar), "utf8");

    const confirm = vi.fn(async () => true);
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(declineMarkerPath(state))).toBe(true);

    const confirmAgain = vi.fn();
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm: confirmAgain },
    });
    expect(confirmAgain).not.toHaveBeenCalled();
  });

  it("writes a permanent decline marker on decline and honors it on later runs", async () => {
    const { state } = await makeStateWithLegacyOauthRef("legacy-oauth-seed");
    const confirm = vi.fn(async () => false);
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm },
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(declineMarkerPath(state))).toBe(true);

    const confirmAgain = vi.fn(async () => true);
    await maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli({
      argv: ["node", "openclaw", "status"],
      env: state.env,
      isInteractiveTty: () => true,
      prompter: { confirm: confirmAgain },
    });
    expect(confirmAgain).not.toHaveBeenCalled();
  });
});
