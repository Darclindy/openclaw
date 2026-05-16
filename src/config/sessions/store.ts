import type { MsgContext } from "../../auto-reply/templating.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { ConversationIdentity } from "./conversation-identity.js";
import { conversationIdentityFromMsgContext } from "./conversation-identity.js";
import { deriveSessionMetaPatch } from "./metadata.js";
import {
  applySqliteSessionEntriesPatch,
  deleteSqliteSessionEntry,
  listSqliteSessionEntries,
  moveSqliteSessionEntryKey,
  readSqliteSessionEntry,
  replaceSqliteSessionEntry,
} from "./session-entries.sqlite.js";
import { normalizeSessionRowKey } from "./store-entry.js";
import {
  mergeSessionEntry,
  mergeSessionEntryPreserveActivity,
  type SessionEntry,
} from "./types.js";

export { normalizeSessionRowKey, resolveSessionRowEntry } from "./store-entry.js";

const SESSION_ROW_PATCH_RETRY_LIMIT = 16;

type SessionEntryRowOptions = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
};

function resolveSessionRowOptionsFromSessionKey(params: {
  agentId?: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
}): SessionEntryRowOptions {
  const agentId =
    params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey) ?? DEFAULT_AGENT_ID;
  return {
    agentId: normalizeAgentId(agentId),
    ...(params.env ? { env: params.env } : {}),
  };
}

export function getSessionEntry(
  options: SessionEntryRowOptions & { sessionKey: string },
): SessionEntry | undefined {
  const direct = readSqliteSessionEntry(options);
  if (direct) {
    return direct;
  }
  const normalizedKey = normalizeSessionRowKey(options.sessionKey);
  return normalizedKey === options.sessionKey
    ? undefined
    : readSqliteSessionEntry({
        ...options,
        sessionKey: normalizedKey,
      });
}

export function listSessionEntries(
  options: SessionEntryRowOptions,
): Array<{ sessionKey: string; entry: SessionEntry }> {
  return listSqliteSessionEntries(options);
}

export function upsertSessionEntry(
  options: SessionEntryRowOptions & {
    sessionKey: string;
    entry: SessionEntry;
    conversationIdentities?: readonly ConversationIdentity[];
  },
): void {
  replaceSqliteSessionEntry(options);
}

export function deleteSessionEntry(
  options: SessionEntryRowOptions & { sessionKey: string },
): boolean {
  return deleteSqliteSessionEntry(options);
}

export function moveSessionEntryKey(
  options: SessionEntryRowOptions & {
    fromSessionKey: string;
    toSessionKey: string;
    entry?: SessionEntry;
  },
): boolean {
  return moveSqliteSessionEntryKey(options);
}

function resolvePatchSessionEntry(options: SessionEntryRowOptions & { sessionKey: string }): {
  entry?: SessionEntry;
  entryKey: string;
  normalizedKey: string;
} {
  const trimmedKey = options.sessionKey.trim();
  const normalizedKey = normalizeSessionRowKey(trimmedKey);
  const canonical = readSqliteSessionEntry({ ...options, sessionKey: normalizedKey });
  if (canonical) {
    return { entry: canonical, entryKey: normalizedKey, normalizedKey };
  }
  const direct =
    trimmedKey === normalizedKey
      ? undefined
      : readSqliteSessionEntry({ ...options, sessionKey: trimmedKey });
  return { entry: direct, entryKey: direct ? trimmedKey : normalizedKey, normalizedKey };
}

export async function patchSessionEntry(
  options: SessionEntryRowOptions & {
    sessionKey: string;
    fallbackEntry?: SessionEntry;
    update: (
      entry: SessionEntry,
    ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;
  },
): Promise<SessionEntry | null> {
  for (let attempt = 0; attempt < SESSION_ROW_PATCH_RETRY_LIMIT; attempt += 1) {
    const resolved = resolvePatchSessionEntry(options);
    const expected = resolved.entry ? structuredClone(resolved.entry) : null;
    const existing = resolved.entry
      ? structuredClone(resolved.entry)
      : options.fallbackEntry
        ? structuredClone(options.fallbackEntry)
        : undefined;
    if (!existing) {
      return null;
    }
    const patch = await options.update(existing);
    if (!patch) {
      return existing;
    }
    const next = mergeSessionEntry(existing, patch);
    const expectedEntries = new Map([[resolved.entryKey, expected]]);
    if (resolved.entryKey !== resolved.normalizedKey) {
      expectedEntries.set(resolved.normalizedKey, null);
    }
    const applied = applySqliteSessionEntriesPatch({
      agentId: options.agentId,
      env: options.env,
      path: options.path,
      upsertEntries: { [resolved.normalizedKey]: next },
      expectedEntries,
      deleteEntries: resolved.entryKey === resolved.normalizedKey ? undefined : [resolved.entryKey],
    });
    if (applied) {
      return next;
    }
  }
  throw new Error(
    `Session row update conflicted after ${SESSION_ROW_PATCH_RETRY_LIMIT} SQLite retries: ${options.sessionKey}`,
  );
}

export function readSessionUpdatedAt(params: {
  agentId?: string;
  sessionKey: string;
}): number | undefined {
  try {
    const options = resolveSessionRowOptionsFromSessionKey(params);
    const normalizedKey = normalizeSessionRowKey(params.sessionKey);
    const entry =
      readSqliteSessionEntry({
        ...options,
        sessionKey: normalizedKey,
      }) ??
      (normalizedKey === params.sessionKey
        ? undefined
        : readSqliteSessionEntry({
            ...options,
            sessionKey: params.sessionKey,
          }));
    return entry?.updatedAt;
  } catch {
    return undefined;
  }
}

function removeThreadFromDeliveryContext(context?: DeliveryContext): DeliveryContext | undefined {
  if (!context || context.threadId == null) {
    return context;
  }
  const next: DeliveryContext = { ...context };
  delete next.threadId;
  return next;
}

export async function recordSessionMetaFromInbound(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { sessionKey, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  const rowOptions = resolveSessionRowOptionsFromSessionKey({
    agentId: params.agentId,
    env: params.env,
    sessionKey,
  });
  const normalizedKey = normalizeSessionRowKey(sessionKey);
  const existing = getSessionEntry({ ...rowOptions, sessionKey });
  const patch = deriveSessionMetaPatch({
    ctx,
    sessionKey: normalizedKey,
    existing,
    groupResolution: params.groupResolution,
  });
  if (!patch) {
    if (existing && normalizedKey !== sessionKey.trim()) {
      upsertSessionEntry({ ...rowOptions, sessionKey: normalizedKey, entry: existing });
    }
    return existing ?? null;
  }
  if (!existing && !createIfMissing) {
    return null;
  }
  const next = existing
    ? mergeSessionEntryPreserveActivity(existing, patch)
    : mergeSessionEntry(existing, patch);
  upsertSessionEntry({
    ...rowOptions,
    sessionKey: normalizedKey,
    entry: next,
    conversationIdentities: [
      conversationIdentityFromMsgContext({
        ctx,
        groupResolution: params.groupResolution,
      }),
    ].filter((entry) => entry !== null),
  });
  return next;
}

export async function updateLastRoute(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  sessionKey: string;
  channel?: SessionEntry["channel"];
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryContext?: DeliveryContext;
  ctx?: MsgContext;
  groupResolution?: import("./types.js").GroupKeyResolution | null;
  createIfMissing?: boolean;
}): Promise<SessionEntry | null> {
  const { sessionKey, channel, to, accountId, threadId, ctx } = params;
  const createIfMissing = params.createIfMissing ?? true;
  const rowOptions = resolveSessionRowOptionsFromSessionKey({
    agentId: params.agentId,
    sessionKey,
    env: params.env,
  });
  const normalizedKey = normalizeSessionRowKey(sessionKey);
  const existing = getSessionEntry({ ...rowOptions, sessionKey });
  if (!existing && !createIfMissing) {
    return null;
  }
  const explicitContext = normalizeDeliveryContext(params.deliveryContext);
  const inlineContext = normalizeDeliveryContext({
    channel,
    to,
    accountId,
    threadId,
  });
  const mergedInput = mergeDeliveryContext(explicitContext, inlineContext);
  const explicitDeliveryContext = params.deliveryContext;
  const explicitThreadFromDeliveryContext =
    explicitDeliveryContext != null &&
    Object.prototype.hasOwnProperty.call(explicitDeliveryContext, "threadId")
      ? explicitDeliveryContext.threadId
      : undefined;
  const explicitThreadValue =
    explicitThreadFromDeliveryContext ??
    (threadId != null && threadId !== "" ? threadId : undefined);
  const explicitRouteProvided = Boolean(
    explicitContext?.channel || explicitContext?.to || inlineContext?.channel || inlineContext?.to,
  );
  const clearThreadFromFallback = explicitRouteProvided && explicitThreadValue == null;
  const fallbackContext = clearThreadFromFallback
    ? removeThreadFromDeliveryContext(deliveryContextFromSession(existing))
    : deliveryContextFromSession(existing);
  const merged = mergeDeliveryContext(mergedInput, fallbackContext);
  const normalized = normalizeSessionDeliveryFields({
    deliveryContext: {
      channel: merged?.channel,
      to: merged?.to,
      accountId: merged?.accountId,
      threadId: merged?.threadId,
    },
  });
  const metaPatch = ctx
    ? deriveSessionMetaPatch({
        ctx,
        sessionKey: normalizedKey,
        existing,
        groupResolution: params.groupResolution,
      })
    : null;
  const basePatch: Partial<SessionEntry> = {
    channel: normalized.deliveryContext?.channel,
    deliveryContext: normalized.deliveryContext,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
  const next = mergeSessionEntryPreserveActivity(
    existing,
    metaPatch ? { ...basePatch, ...metaPatch } : basePatch,
  );
  upsertSessionEntry({
    ...rowOptions,
    sessionKey: normalizedKey,
    entry: next,
    conversationIdentities: ctx
      ? [
          conversationIdentityFromMsgContext({
            ctx,
            deliveryContext: normalized.deliveryContext,
            groupResolution: params.groupResolution,
          }),
        ].filter((entry) => entry !== null)
      : undefined,
  });
  return next;
}
