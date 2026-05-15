import path from "node:path";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { safeAccountKey, safeChannelKey } from "../pairing/pairing-store-keys.js";
import type { PairingChannel } from "../pairing/pairing-store.types.js";

export function resolveChannelAllowFromPath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string {
  const stateDir = resolveStateDir(env);
  const base = safeChannelKey(channel);
  const accountKey = accountId?.trim() ? safeAccountKey(accountId) : null;
  return path.join(
    resolveOAuthDir(env, stateDir),
    accountKey ? `${base}-${accountKey}-allowFrom.json` : `${base}-allowFrom.json`,
  );
}
