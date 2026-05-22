import { cloneAuthProfileStore } from "./clone.js";
import { EXTERNAL_CLI_SYNC_TTL_MS } from "./constants.js";
import type { AuthProfileStore } from "./types.js";

const loadedAuthStoreCache = new Map<
  string,
  {
    authMtimeMs: number | null;
    syncedAtMs: number;
    store: AuthProfileStore;
  }
>();

export function readCachedAuthProfileStore(params: {
  storeKey: string;
  authMtimeMs: number | null;
}): AuthProfileStore | null {
  const cached = loadedAuthStoreCache.get(params.storeKey);
  if (!cached || cached.authMtimeMs !== params.authMtimeMs) {
    return null;
  }
  if (Date.now() - cached.syncedAtMs >= EXTERNAL_CLI_SYNC_TTL_MS) {
    return null;
  }
  return cloneAuthProfileStore(cached.store);
}

export function writeCachedAuthProfileStore(params: {
  storeKey: string;
  authMtimeMs: number | null;
  store: AuthProfileStore;
}): void {
  loadedAuthStoreCache.set(params.storeKey, {
    authMtimeMs: params.authMtimeMs,
    syncedAtMs: Date.now(),
    store: cloneAuthProfileStore(params.store),
  });
}

export function clearLoadedAuthStoreCache(): void {
  loadedAuthStoreCache.clear();
}
