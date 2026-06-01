import { measureDiagnosticsTimelineSpan } from "../infra/diagnostics-timeline.js";

/**
 * Narrow timeline helpers for the agent runtime, so embedded-runner and
 * provider-transport code emit perf-trace spans through one typed entry point
 * instead of scattering raw `measureDiagnosticsTimelineSpan` calls (see
 * `docs/reference/perf-trace.md`). Every span is no-op when the diagnostics
 * timeline is disabled, so the hot path keeps zero overhead in production.
 *
 * Spans are tagged with a `layer` attribute ("agent" / "provider") that the
 * trace exporter turns into Perfetto swimlanes. The agent root span sets `runId`
 * explicitly (the embedded run id, which equals the gateway `clientRunId` for a
 * chat request); nested provider spans inherit that `runId` automatically via
 * AsyncLocalStorage, so gateway + agent + provider spans land in one flame graph.
 */

type TimelineAttributeValue = string | number | boolean | null;
type TimelineAttributes = Record<string, TimelineAttributeValue>;

type AgentSpanOptions = {
  runId?: string;
  attributes?: TimelineAttributes;
};

const AGENT_PHASE = "agent-turn";

function traceLayerSpan<T>(
  layer: "agent" | "provider",
  name: string,
  run: () => Promise<T> | T,
  options: AgentSpanOptions = {},
): Promise<T> {
  return measureDiagnosticsTimelineSpan(name, run, {
    phase: AGENT_PHASE,
    ...(options.runId ? { runId: options.runId } : {}),
    attributes: { layer, ...options.attributes },
  });
}

/** Wrap an agent-runtime phase as a timeline span on the "agent" swimlane. */
export function traceAgentSpan<T>(
  name: string,
  run: () => Promise<T> | T,
  options?: AgentSpanOptions,
): Promise<T> {
  return traceLayerSpan("agent", name, run, options);
}

/** Wrap a provider model request as a timeline span on the "provider" swimlane. */
export function traceProviderSpan<T>(
  name: string,
  run: () => Promise<T> | T,
  options?: AgentSpanOptions,
): Promise<T> {
  return traceLayerSpan("provider", name, run, options);
}
