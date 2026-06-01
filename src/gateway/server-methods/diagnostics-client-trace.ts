import {
  emitDiagnosticsTimelineEvent,
  isDiagnosticsTimelineEnabled,
} from "../../infra/diagnostics-timeline.js";

/**
 * Ingests frontend (desktop UI) timeline spans reported over the gateway and
 * emits them into the same diagnostics-timeline JSONL as gateway/agent/provider
 * spans, tagged `layer: "frontend"` so the perf-trace export
 * (docs/diagnostics/perf-trace) renders them as a fourth swimlane correlated by
 * runId. No-op when the timeline is disabled; bounded + defensive because the
 * payload is client-supplied.
 */

const MAX_CLIENT_TRACE_EVENTS = 500;
const MAX_ATTRIBUTE_COUNT = 32;
const MAX_STRING_LENGTH = 512;
const MAX_NAME_LENGTH = 256;
const MAX_SPAN_ID_LENGTH = 128;

const CLIENT_TRACE_EVENT_TYPES = new Set(["span.start", "span.end", "mark"]);

type TimelineAttributeValue = string | number | boolean | null;

function clampString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function normalizeAttributes(value: unknown): Record<string, TimelineAttributeValue> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const normalized: Record<string, TimelineAttributeValue> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= MAX_ATTRIBUTE_COUNT || key === "layer") {
      continue;
    }
    if (typeof raw === "string") {
      normalized[key] = raw.slice(0, MAX_STRING_LENGTH);
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      normalized[key] = raw;
    } else if (typeof raw === "boolean" || raw === null) {
      normalized[key] = raw;
    } else {
      continue;
    }
    count++;
  }
  return normalized;
}

/**
 * Validate and emit a batch of client trace events. Returns the count accepted.
 * The `layer` attribute is always forced to "frontend" so clients cannot
 * masquerade as another swimlane.
 */
export function recordClientTraceEvents(params: unknown): number {
  if (!isDiagnosticsTimelineEnabled()) {
    return 0;
  }
  const events = (params as { events?: unknown } | null | undefined)?.events;
  if (!Array.isArray(events)) {
    return 0;
  }

  let accepted = 0;
  for (const raw of events.slice(0, MAX_CLIENT_TRACE_EVENTS)) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const event = raw as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : undefined;
    if (!type || !CLIENT_TRACE_EVENT_TYPES.has(type)) {
      continue;
    }
    const name = clampString(event.name, MAX_NAME_LENGTH);
    if (!name) {
      continue;
    }
    const timestamp = clampString(event.timestamp, MAX_STRING_LENGTH);
    const runId = clampString(event.runId, MAX_STRING_LENGTH);
    const spanId = clampString(event.spanId, MAX_SPAN_ID_LENGTH);
    const parentSpanId = clampString(event.parentSpanId, MAX_SPAN_ID_LENGTH);
    const durationMs =
      typeof event.durationMs === "number" && Number.isFinite(event.durationMs)
        ? event.durationMs
        : undefined;

    emitDiagnosticsTimelineEvent({
      type: type as "span.start" | "span.end" | "mark",
      name,
      ...(timestamp ? { timestamp } : {}),
      ...(runId ? { runId } : {}),
      ...(spanId ? { spanId } : {}),
      ...(parentSpanId ? { parentSpanId } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      attributes: { ...normalizeAttributes(event.attributes), layer: "frontend" },
    });
    accepted++;
  }
  return accepted;
}
