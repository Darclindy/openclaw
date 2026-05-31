import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveUsableCustomProviderApiKey } from "../../agents/model-auth.js";
import {
  loadModelCatalogForBrowse,
  type ModelCatalogBrowseView,
} from "../../agents/model-catalog-browse.js";
import { resolveVisibleModelCatalog } from "../../agents/model-catalog-visibility.js";
import { normalizeProviderId } from "../../agents/provider-id.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateModelsListParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

type ModelsListView = ModelCatalogBrowseView;
type ProbeApi = "openai-completions" | "openai-responses";

export type ModelsProbeResult = {
  provider: string;
  model: string;
  api?: string;
  baseUrl?: string;
  ok: boolean;
  status?: number;
  elapsedMs: number;
  message: string;
};

let loggedSlowModelsListCatalog = false;

function resolveModelsListView(params: Record<string, unknown>): ModelsListView {
  return typeof params.view === "string" ? (params.view as ModelsListView) : "default";
}

function readStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

function readTimeoutMs(params: Record<string, unknown>): number {
  const raw = params.timeoutMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 20_000;
  }
  return Math.min(60_000, Math.max(1_000, Math.floor(raw)));
}

function resolveProviderConfig(
  providers: Record<string, ModelProviderConfig> | undefined,
  providerId: string,
): ModelProviderConfig | undefined {
  if (!providers) {
    return undefined;
  }
  const direct = providers[providerId];
  if (direct) {
    return direct;
  }
  const normalized = normalizeProviderId(providerId);
  return Object.entries(providers).find(([key]) => normalizeProviderId(key) === normalized)?.[1];
}

function resolveModelConfig(
  providerConfig: ModelProviderConfig,
  modelId: string,
): ModelDefinitionConfig | undefined {
  return providerConfig.models?.find((entry) => entry?.id === modelId);
}

function resolveProbeUrl(baseUrl: string, api: ProbeApi): string {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  const suffix = api === "openai-responses" ? "/responses" : "/chat/completions";
  return trimmed.endsWith(suffix) ? trimmed : `${trimmed}${suffix}`;
}

function buildProbePayload(api: ProbeApi, model: string): Record<string, unknown> {
  if (api === "openai-responses") {
    return {
      model,
      input: "Reply with OK.",
      max_output_tokens: 8,
      store: false,
    };
  }
  return {
    model,
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 8,
    stream: false,
  };
}

function sanitizeProbeMessage(value: unknown): string {
  if (value instanceof Error && value.name === "AbortError") {
    return "request timed out";
  }
  if (typeof value === "string") {
    return value.slice(0, 500);
  }
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") {
      return message.slice(0, 500);
    }
  }
  return formatForLog(value).slice(0, 500);
}

export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!validateModelsListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid models.list params: ${formatValidationErrors(validateModelsListParams.errors)}`,
        ),
      );
      return;
    }
    try {
      const cfg = context.getRuntimeConfig();
      const workspaceDir =
        resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)) ??
        resolveDefaultAgentWorkspaceDir();
      const view = resolveModelsListView(params);
      const catalog = await loadModelCatalogForBrowse({
        cfg,
        view,
        loadCatalog: context.loadGatewayModelCatalog,
        onTimeout: (timeoutMs) => {
          if (loggedSlowModelsListCatalog) {
            return;
          }
          loggedSlowModelsListCatalog = true;
          context.logGateway.debug(
            `models.list continuing without model catalog after ${timeoutMs}ms`,
          );
        },
      });
      if (view === "all") {
        respond(true, { models: catalog }, undefined);
        return;
      }
      const models = await resolveVisibleModelCatalog({
        cfg,
        catalog,
        defaultProvider: DEFAULT_PROVIDER,
        workspaceDir,
        view,
        runtimeAuthDiscovery: false,
      });
      respond(true, { models }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
  "models.probe": async ({ params, respond, context }) => {
    const p = params as Record<string, unknown>;
    const provider = readStringParam(p, "provider");
    const model = readStringParam(p, "model");
    if (!provider || !model) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "provider and model are required"),
      );
      return;
    }
    const startedAt = Date.now();
    try {
      const cfg = context.getRuntimeConfig();
      const providerConfig = resolveProviderConfig(cfg.models?.providers, provider);
      if (!providerConfig) {
        respond(
          true,
          {
            provider,
            model,
            ok: false,
            elapsedMs: Date.now() - startedAt,
            message: `provider "${provider}" is not configured`,
          } satisfies ModelsProbeResult,
          undefined,
        );
        return;
      }
      const modelConfig = resolveModelConfig(providerConfig, model);
      const api = modelConfig?.api ?? providerConfig.api;
      const baseUrl = modelConfig?.baseUrl ?? providerConfig.baseUrl;
      if (api !== "openai-completions" && api !== "openai-responses") {
        respond(
          true,
          {
            provider,
            model,
            api,
            baseUrl,
            ok: false,
            elapsedMs: Date.now() - startedAt,
            message: `live probe is not supported for api "${api ?? "unknown"}"`,
          } satisfies ModelsProbeResult,
          undefined,
        );
        return;
      }
      if (!baseUrl?.trim()) {
        respond(
          true,
          {
            provider,
            model,
            api,
            ok: false,
            elapsedMs: Date.now() - startedAt,
            message: "provider baseUrl is not configured",
          } satisfies ModelsProbeResult,
          undefined,
        );
        return;
      }
      const auth = resolveUsableCustomProviderApiKey({ cfg, provider });
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (auth?.apiKey) {
        headers.authorization = `Bearer ${auth.apiKey}`;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), readTimeoutMs(p));
      let response: Response;
      try {
        response = await fetch(resolveProbeUrl(baseUrl, api), {
          method: "POST",
          headers,
          body: JSON.stringify(buildProbePayload(api, model)),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const elapsedMs = Date.now() - startedAt;
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        respond(
          true,
          {
            provider,
            model,
            api,
            baseUrl,
            ok: false,
            status: response.status,
            elapsedMs,
            message: body.slice(0, 500) || response.statusText || `HTTP ${response.status}`,
          } satisfies ModelsProbeResult,
          undefined,
        );
        return;
      }
      await response.arrayBuffer().catch(() => undefined);
      respond(
        true,
        {
          provider,
          model,
          api,
          baseUrl,
          ok: true,
          status: response.status,
          elapsedMs,
          message: "model call succeeded",
        } satisfies ModelsProbeResult,
        undefined,
      );
    } catch (err) {
      respond(
        true,
        {
          provider,
          model,
          ok: false,
          elapsedMs: Date.now() - startedAt,
          message: sanitizeProbeMessage(err),
        } satisfies ModelsProbeResult,
        undefined,
      );
    }
  },
};
