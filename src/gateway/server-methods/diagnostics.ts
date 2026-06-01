import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
} from "../../logging/diagnostic-stability.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { recordClientTraceEvents } from "./diagnostics-client-trace.js";
import type { GatewayRequestHandlers } from "./types.js";

export const diagnosticsHandlers: GatewayRequestHandlers = {
  "diagnostics.stability": async ({ params, respond }) => {
    try {
      const query = normalizeDiagnosticStabilityQuery(params);
      respond(true, getDiagnosticStabilitySnapshot(query), undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          err instanceof Error ? err.message : "invalid diagnostics.stability params",
        ),
      );
    }
  },
  // Fire-and-forget ingestion of frontend timeline spans (perf-trace). Always
  // acks; emits into the diagnostics timeline only when it is enabled.
  "diagnostics.clientTrace": async ({ params, respond }) => {
    const accepted = recordClientTraceEvents(params);
    respond(true, { accepted }, undefined);
  },
};
