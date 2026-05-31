import { updateSessionStoreEntry, type SessionEntry } from "../config/sessions.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";
import { readRecentSessionMessages } from "./session-utils.fs.js";
import { loadSessionEntry } from "./session-utils.js";
import type { GatewaySessionRow, SessionRunStatus } from "./session-utils.types.js";

type LifecyclePhase = "start" | "end" | "error";

type LifecycleEventLike = Pick<AgentEventPayload, "ts"> & {
  data?: {
    phase?: unknown;
    startedAt?: unknown;
    endedAt?: unknown;
    aborted?: unknown;
    stopReason?: unknown;
  };
};

type LifecycleSessionShape = Pick<
  GatewaySessionRow,
  "updatedAt" | "status" | "startedAt" | "endedAt" | "runtimeMs" | "abortedLastRun"
>;

type PersistedLifecycleSessionShape = Pick<
  SessionEntry,
  | "updatedAt"
  | "status"
  | "startedAt"
  | "endedAt"
  | "runtimeMs"
  | "abortedLastRun"
  | "sessionId"
  | "sessionFile"
  | "channel"
  | "route"
  | "deliveryContext"
  | "lastChannel"
  | "origin"
>;

type GatewaySessionLifecycleSnapshot = Partial<LifecycleSessionShape>;

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function resolveLifecyclePhase(event: LifecycleEventLike): LifecyclePhase | null {
  const phase = typeof event.data?.phase === "string" ? event.data.phase : "";
  return phase === "start" || phase === "end" || phase === "error" ? phase : null;
}

function resolveTerminalStatus(event: LifecycleEventLike): SessionRunStatus {
  const phase = resolveLifecyclePhase(event);
  if (phase === "error") {
    return "failed";
  }

  const stopReason = typeof event.data?.stopReason === "string" ? event.data.stopReason : "";
  if (stopReason === "aborted") {
    return "killed";
  }

  return event.data?.aborted === true ? "timeout" : "done";
}

function resolveLifecycleStartedAt(
  existingStartedAt: number | undefined,
  event: LifecycleEventLike,
): number | undefined {
  if (isFiniteTimestamp(event.data?.startedAt)) {
    return event.data.startedAt;
  }
  if (isFiniteTimestamp(existingStartedAt)) {
    return existingStartedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveLifecycleEndedAt(event: LifecycleEventLike): number | undefined {
  if (isFiniteTimestamp(event.data?.endedAt)) {
    return event.data.endedAt;
  }
  return isFiniteTimestamp(event.ts) ? event.ts : undefined;
}

function resolveRuntimeMs(params: {
  startedAt?: number;
  endedAt?: number;
  existingRuntimeMs?: number;
}): number | undefined {
  const { startedAt, endedAt, existingRuntimeMs } = params;
  if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt)) {
    return Math.max(0, endedAt - startedAt);
  }
  if (
    typeof existingRuntimeMs === "number" &&
    Number.isFinite(existingRuntimeMs) &&
    existingRuntimeMs >= 0
  ) {
    return existingRuntimeMs;
  }
  return undefined;
}

function readMessageRole(message: unknown): string | undefined {
  return message && typeof message === "object" && !Array.isArray(message)
    ? typeof (message as { role?: unknown }).role === "string"
      ? (message as { role: string }).role
      : undefined
    : undefined;
}

function readMessageTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (isFiniteTimestamp(timestamp)) {
    return timestamp;
  }
  return undefined;
}

function readMessageText(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "";
  }
  const record = message as { content?: unknown; text?: unknown };
  if (typeof record.text === "string") {
    return record.text;
  }
  if (!Array.isArray(record.content)) {
    return "";
  }
  return record.content
    .map((block) =>
      block && typeof block === "object" && !Array.isArray(block)
        ? typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : ""
        : "",
    )
    .join("");
}

function hasSuccessfulAssistantMessage(params: {
  entry: Partial<PersistedLifecycleSessionShape>;
  storePath: string;
  startedAt?: number;
  endedAt?: number;
}): boolean {
  if (!params.entry.sessionId) {
    return false;
  }
  const messages = readRecentSessionMessages(
    params.entry.sessionId,
    params.storePath,
    params.entry.sessionFile,
    {
      maxMessages: 12,
      maxBytes: 96 * 1024,
      maxLines: 160,
    },
  );
  const startedAt = params.startedAt;
  const endedAt = params.endedAt;
  return messages.some((message) => {
    if (readMessageRole(message) !== "assistant") {
      return false;
    }
    const text = readMessageText(message).trim();
    if (!text || text === "[assistant turn failed before producing content]") {
      return false;
    }
    const timestamp = readMessageTimestamp(message);
    if (isFiniteTimestamp(startedAt) && isFiniteTimestamp(timestamp) && timestamp < startedAt) {
      return false;
    }
    if (isFiniteTimestamp(endedAt) && isFiniteTimestamp(timestamp) && timestamp > endedAt + 5_000) {
      return false;
    }
    const stopReason =
      message && typeof message === "object" && !Array.isArray(message)
        ? (message as { stopReason?: unknown }).stopReason
        : undefined;
    if (typeof stopReason === "string" && stopReason !== "stop" && stopReason !== "end_turn") {
      return false;
    }
    return true;
  });
}

function isInternalSessionEntry(entry: Partial<PersistedLifecycleSessionShape> | undefined) {
  if (!entry) {
    return false;
  }
  const routeChannel =
    entry.route && typeof entry.route === "object" && !Array.isArray(entry.route)
      ? (entry.route as { channel?: unknown }).channel
      : undefined;
  const deliveryChannel =
    entry.deliveryContext &&
    typeof entry.deliveryContext === "object" &&
    !Array.isArray(entry.deliveryContext)
      ? (entry.deliveryContext as { channel?: unknown }).channel
      : undefined;
  const originProvider =
    entry.origin && typeof entry.origin === "object" && !Array.isArray(entry.origin)
      ? (entry.origin as { provider?: unknown }).provider
      : undefined;
  return [entry.channel, routeChannel, deliveryChannel, entry.lastChannel, originProvider].some(
    (channel) => typeof channel === "string" && isInternalMessageChannel(channel),
  );
}

export function deriveGatewaySessionLifecycleSnapshot(params: {
  session?: Partial<LifecycleSessionShape> | null;
  event: LifecycleEventLike;
}): GatewaySessionLifecycleSnapshot {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return {};
  }

  const existing = params.session ?? undefined;
  if (phase === "start") {
    const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
    const updatedAt = startedAt ?? existing?.updatedAt;
    return {
      updatedAt,
      status: "running",
      startedAt,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    };
  }

  const startedAt = resolveLifecycleStartedAt(existing?.startedAt, params.event);
  const endedAt = resolveLifecycleEndedAt(params.event);
  const updatedAt = endedAt ?? existing?.updatedAt;
  return {
    updatedAt,
    status: resolveTerminalStatus(params.event),
    startedAt,
    endedAt,
    runtimeMs: resolveRuntimeMs({
      startedAt,
      endedAt,
      existingRuntimeMs: existing?.runtimeMs,
    }),
    abortedLastRun: resolveTerminalStatus(params.event) === "killed",
  };
}

export function derivePersistedSessionLifecyclePatch(params: {
  entry?: Partial<PersistedLifecycleSessionShape> | null;
  event: LifecycleEventLike;
  storePath?: string;
}): Partial<PersistedLifecycleSessionShape> {
  const snapshot = deriveGatewaySessionLifecycleSnapshot({
    session: params.entry ?? undefined,
    event: params.event,
  });
  if (
    snapshot.status &&
    snapshot.status !== "done" &&
    params.entry &&
    params.storePath &&
    isInternalSessionEntry(params.entry) &&
    hasSuccessfulAssistantMessage({
      entry: params.entry,
      storePath: params.storePath,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
    })
  ) {
    return {
      ...snapshot,
      updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
      status: "done",
      abortedLastRun: false,
    };
  }
  return {
    ...snapshot,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : undefined,
  };
}

export async function persistGatewaySessionLifecycleEvent(params: {
  sessionKey: string;
  event: LifecycleEventLike;
}): Promise<void> {
  const phase = resolveLifecyclePhase(params.event);
  if (!phase) {
    return;
  }

  const sessionEntry = loadSessionEntry(params.sessionKey);
  if (!sessionEntry.entry) {
    return;
  }

  await updateSessionStoreEntry({
    storePath: sessionEntry.storePath,
    sessionKey: sessionEntry.canonicalKey,
    update: async (entry) =>
      derivePersistedSessionLifecyclePatch({
        entry,
        event: params.event,
        storePath: sessionEntry.storePath,
      }),
  });
}
