import fs from "node:fs";
import {
  resolveAuthProfileStoreKey,
  resolveAuthStatePath,
  resolveAuthStorePath,
  resolveLegacyAuthStorePath,
} from "./path-resolve.js";
import { hasPersistedAuthProfileSecretsStore } from "./persisted.js";
import { hasAnyRuntimeAuthProfileStoreSource } from "./runtime-snapshots.js";

function hasLegacyAuthProfileFiles(agentDir?: string): boolean {
  return (
    fs.existsSync(resolveAuthStorePath(agentDir)) ||
    fs.existsSync(resolveAuthStatePath(agentDir)) ||
    fs.existsSync(resolveLegacyAuthStorePath(agentDir))
  );
}

export function hasAnyAuthProfileStoreSource(agentDir?: string): boolean {
  if (hasAnyRuntimeAuthProfileStoreSource(agentDir)) {
    return true;
  }
  if (hasPersistedAuthProfileSecretsStore(agentDir) || hasLegacyAuthProfileFiles(agentDir)) {
    return true;
  }

  const storeKey = resolveAuthProfileStoreKey(agentDir);
  const mainStoreKey = resolveAuthProfileStoreKey();
  if (
    agentDir &&
    storeKey !== mainStoreKey &&
    (hasPersistedAuthProfileSecretsStore(undefined) || hasLegacyAuthProfileFiles(undefined))
  ) {
    return true;
  }
  return false;
}
