import { randomUUID } from "node:crypto";
import { normalizeTalkSection } from "../../config/talk.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  buildRealtimeVoiceAgentConsultChatMessage,
} from "../../talk/agent-consult-tool.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../talk/provider-resolver.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type ErrorShape,
  validateTalkClientCreateParams,
  validateTalkClientToolCallParams,
} from "../protocol/index.js";
import { registerTalkRealtimeRelayAgentRun } from "../talk-realtime-relay.js";
import { formatForLog } from "../ws-log.js";
import { chatHandlers } from "./chat.js";
import { asRecord } from "./record-shared.js";
import {
  buildRealtimeInstructions,
  buildRealtimeVoiceLaunchOptions,
  buildTalkRealtimeConfig,
  isUnsupportedBrowserWebRtcSession,
} from "./talk-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_TALK_CONSULT_THINKING_LEVEL = "low";
const DEFAULT_TALK_CONSULT_FAST_MODE = true;

function logTalkTimeline(
  request: Pick<Parameters<GatewayRequestHandlers[string]>[0], "context">,
  level: "info" | "warn",
  message: string,
) {
  request.context.logGateway?.[level]?.(`[talk.timeline] ${message}`);
}

async function startRealtimeToolCallAgentConsult(params: {
  sessionKey: string;
  callId: string;
  args: unknown;
  relaySessionId?: string;
  connId?: string;
  request: Parameters<GatewayRequestHandlers[string]>[0];
}): Promise<
  { ok: true; runId: string; idempotencyKey: string } | { ok: false; error: ErrorShape }
> {
  const startedAt = Date.now();
  logTalkTimeline(
    params.request,
    "info",
    `toolCall start sessionKey=${params.sessionKey} callId=${params.callId}`,
  );
  let message: string;
  try {
    message = buildRealtimeVoiceAgentConsultChatMessage(params.args);
  } catch (err) {
    logTalkTimeline(
      params.request,
      "warn",
      `toolCall invalid args callId=${params.callId} elapsedMs=${Date.now() - startedAt}: ${formatForLog(err)}`,
    );
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)) };
  }
  const idempotencyKey = `talk-${params.callId}-${randomUUID()}`;
  const normalizedTalk = normalizeTalkSection(params.request.context.getRuntimeConfig().talk);
  const thinking = normalizedTalk?.consultThinkingLevel ?? DEFAULT_TALK_CONSULT_THINKING_LEVEL;
  const fastMode = normalizedTalk?.consultFastMode ?? DEFAULT_TALK_CONSULT_FAST_MODE;
  logTalkTimeline(
    params.request,
    "info",
    `toolCall chat.send start callId=${params.callId} messageChars=${message.length} thinking=${thinking} fastMode=${fastMode}`,
  );
  const chatStartedAt = Date.now();
  let chatResponse: { ok: true; result: unknown } | { ok: false; error: ErrorShape } | undefined;
  await chatHandlers["chat.send"]({
    ...params.request,
    req: {
      type: "req",
      id: `${params.request.req.id}:talk-tool-call`,
      method: "chat.send",
    },
    params: {
      sessionKey: params.sessionKey,
      message,
      idempotencyKey,
      thinking,
      fastMode,
    },
    respond: (ok: boolean, result?: unknown, error?: ErrorShape) => {
      chatResponse = ok
        ? { ok: true, result }
        : {
            ok: false,
            error: error ?? errorShape(ErrorCodes.UNAVAILABLE, "chat.send failed without error"),
          };
    },
  } as never);

  if (!chatResponse) {
    logTalkTimeline(
      params.request,
      "warn",
      `toolCall chat.send missing response callId=${params.callId} elapsedMs=${Date.now() - chatStartedAt}`,
    );
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "chat.send did not return a realtime tool result"),
    };
  }
  if (!chatResponse.ok) {
    logTalkTimeline(
      params.request,
      "warn",
      `toolCall chat.send failed callId=${params.callId} elapsedMs=${Date.now() - chatStartedAt}: ${chatResponse.error.message}`,
    );
    return { ok: false, error: chatResponse.error };
  }
  const runId = normalizeOptionalString(asRecord(chatResponse.result)?.runId) ?? idempotencyKey;
  logTalkTimeline(
    params.request,
    "info",
    `toolCall chat.send accepted callId=${params.callId} runId=${runId} elapsedMs=${Date.now() - chatStartedAt} totalMs=${Date.now() - startedAt}`,
  );
  if (params.relaySessionId && params.connId) {
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: params.relaySessionId,
      connId: params.connId,
      sessionKey: params.sessionKey,
      runId,
    });
  }
  logTalkTimeline(
    params.request,
    "info",
    `toolCall done callId=${params.callId} runId=${runId} totalMs=${Date.now() - startedAt}`,
  );
  return { ok: true, runId, idempotencyKey };
}

export const talkClientHandlers: GatewayRequestHandlers = {
  "talk.client.create": async ({ params, respond, context }) => {
    const startedAt = Date.now();
    if (!validateTalkClientCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.create params: ${formatValidationErrors(validateTalkClientCreateParams.errors)}`,
        ),
      );
      return;
    }
    const typedParams = params as {
      provider?: string;
      model?: string;
      voice?: string;
      vadThreshold?: number;
      silenceDurationMs?: number;
      prefixPaddingMs?: number;
      reasoningEffort?: string;
      mode?: string;
      transport?: string;
      brain?: string;
    };
    try {
      logTalkTimeline(
        { context },
        "info",
        `client.create start provider=${typedParams.provider ?? "default"} model=${typedParams.model ?? "default"} voice=${typedParams.voice ?? "default"} transport=${typedParams.transport ?? "default"}`,
      );
      const runtimeConfig = context.getRuntimeConfig();
      const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, typedParams.provider);
      const mode =
        normalizeOptionalLowercaseString(typedParams.mode) ?? realtimeConfig.mode ?? "realtime";
      if (mode !== "realtime") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create only supports mode="realtime"; use talk.catalog for ${mode} provider discovery`,
          ),
        );
        return;
      }
      const brain =
        normalizeOptionalLowercaseString(typedParams.brain) ??
        realtimeConfig.brain ??
        "agent-consult";
      if (brain !== "agent-consult") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create only supports brain="agent-consult"`,
          ),
        );
        return;
      }
      const transport =
        normalizeOptionalLowercaseString(typedParams.transport) ?? realtimeConfig.transport;
      if (transport === "managed-room") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "managed-room realtime Talk sessions are not available in the browser UI yet",
          ),
        );
        return;
      }
      if (transport === "gateway-relay") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.client.create is client-owned; use talk.session.create for gateway-relay`,
          ),
        );
        return;
      }
      const resolution = resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: realtimeConfig.provider,
        providerConfigs: realtimeConfig.providers,
        cfg: runtimeConfig,
        cfgForResolve: runtimeConfig,
        noRegisteredProviderMessage: "No realtime voice provider registered",
      });
      const launchOptions = buildRealtimeVoiceLaunchOptions({
        requested: typedParams,
        defaults: realtimeConfig,
      });
      logTalkTimeline(
        { context },
        "info",
        `client.create resolved provider=${resolution.provider.id} transport=${transport ?? "default"} elapsedMs=${Date.now() - startedAt}`,
      );
      if (resolution.provider.createBrowserSession && transport !== "gateway-relay") {
        const providerStartedAt = Date.now();
        const session = await resolution.provider.createBrowserSession({
          cfg: runtimeConfig,
          providerConfig: resolution.providerConfig,
          instructions: buildRealtimeInstructions(realtimeConfig.instructions),
          tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL],
          ...launchOptions,
        });
        if (
          !isUnsupportedBrowserWebRtcSession(session) &&
          (!transport || session.transport === transport)
        ) {
          logTalkTimeline(
            { context },
            "info",
            `client.create provider session ok provider=${session.provider} transport=${session.transport} model=${session.model ?? "unknown"} elapsedMs=${Date.now() - providerStartedAt} totalMs=${Date.now() - startedAt}`,
          );
          respond(true, session, undefined);
          return;
        }
        logTalkTimeline(
          { context },
          "warn",
          `client.create provider unsupported provider=${resolution.provider.id} returnedTransport=${session.transport} requestedTransport=${transport ?? "default"} elapsedMs=${Date.now() - providerStartedAt}`,
        );
        if (transport) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              `Realtime provider "${resolution.provider.id}" does not support requested browser transport "${transport}"`,
            ),
          );
          return;
        }
      }
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `Realtime provider "${resolution.provider.id}" does not support client-owned realtime sessions`,
        ),
      );
    } catch (err) {
      logTalkTimeline(
        { context },
        "warn",
        `client.create failed elapsedMs=${Date.now() - startedAt}: ${formatForLog(err)}`,
      );
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.client.toolCall": async (request) => {
    const startedAt = Date.now();
    const { params, respond } = request;
    if (!validateTalkClientToolCallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.client.toolCall params: ${formatValidationErrors(validateTalkClientToolCallParams.errors)}`,
        ),
      );
      return;
    }
    if (params.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported realtime Talk tool: ${params.name}`),
      );
      return;
    }

    logTalkTimeline(
      request,
      "info",
      `client.toolCall start sessionKey=${params.sessionKey} callId=${params.callId} name=${params.name}`,
    );
    const result = await startRealtimeToolCallAgentConsult({
      sessionKey: params.sessionKey,
      callId: params.callId,
      args: params.args ?? {},
      relaySessionId: normalizeOptionalString(params.relaySessionId),
      connId: normalizeOptionalString(request.client?.connId),
      request,
    });
    if (!result.ok) {
      logTalkTimeline(
        request,
        "warn",
        `client.toolCall failed callId=${params.callId} elapsedMs=${Date.now() - startedAt}: ${result.error.message}`,
      );
      respond(false, undefined, result.error);
      return;
    }
    logTalkTimeline(
      request,
      "info",
      `client.toolCall accepted callId=${params.callId} runId=${result.runId} elapsedMs=${Date.now() - startedAt}`,
    );
    respond(
      true,
      {
        runId: result.runId,
        idempotencyKey: result.idempotencyKey,
      },
      undefined,
    );
  },
};
