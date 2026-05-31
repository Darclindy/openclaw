/**
 * Converts an OpenClaw diagnostics-timeline JSONL stream (see
 * `diagnostics-timeline.ts`) into the Chrome Trace Event Format consumed by
 * https://ui.perfetto.dev and chrome://tracing, so a single chat request can be
 * inspected as a flame graph with one swimlane per layer (gateway / agent /
 * provider / frontend).
 *
 * Pure data transform — no filesystem access — so it is cheap to unit test.
 * Span start/end pairs become complete (`X`) events; `mark` events become
 * instants (`i`); `provider.request` becomes a duration on the provider track.
 * Timing uses each event's wall-clock `timestamp` for placement and the precise
 * `durationMs` for width; the whole trace is shifted so it starts at t=0.
 */

const CHROME_TRACE_DISPLAY_TIME_UNIT = "ms";

/** Stable swimlane ordering. Lower tid renders higher in Perfetto. */
const LAYER_TRACK_IDS: Record<string, number> = {
  frontend: 1,
  gateway: 2,
  agent: 3,
  provider: 4,
};
const OTHER_LAYER_TRACK_ID = 9;

type TimelineAttributeValue = string | number | boolean | null;

/** A single parsed timeline event. Mirrors the serialized shape, all optional. */
export type DiagnosticsTimelineRecord = {
  type?: string;
  name?: string;
  timestamp?: string;
  runId?: string;
  envName?: string;
  pid?: number;
  phase?: string;
  spanId?: string;
  parentSpanId?: string;
  durationMs?: number;
  attributes?: Record<string, TimelineAttributeValue>;
  errorName?: string;
  errorMessage?: string;
  provider?: string;
  operation?: string;
  ok?: boolean;
  command?: string;
  exitCode?: number | null;
  signal?: string | null;
  maxMs?: number;
  p99Ms?: number;
};

export type ChromeTraceEvent = {
  name: string;
  ph: string;
  ts: number;
  pid: number;
  tid: number;
  dur?: number;
  cat?: string;
  s?: string;
  args?: Record<string, unknown>;
};

export type ChromeTrace = {
  traceEvents: ChromeTraceEvent[];
  displayTimeUnit: string;
};

export type TimelineExportOptions = {
  /** When set, keep only events tagged with this runId. */
  runId?: string;
};

/** Parse a JSONL timeline file body into records, skipping blank/garbage lines. */
export function parseTimelineJsonl(text: string): DiagnosticsTimelineRecord[] {
  const records: DiagnosticsTimelineRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as DiagnosticsTimelineRecord;
      if (parsed && typeof parsed === "object") {
        records.push(parsed);
      }
    } catch {
      // Tolerate partial trailing writes / interleaved noise.
    }
  }
  return records;
}

function epochMs(timestamp: string | undefined): number | undefined {
  if (!timestamp) {
    return undefined;
  }
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function layerOf(record: DiagnosticsTimelineRecord): string {
  const layer = record.attributes?.layer;
  if (typeof layer === "string" && layer.length > 0) {
    return layer;
  }
  if (record.type === "provider.request") {
    return "provider";
  }
  return "other";
}

function trackIdForLayer(layer: string): number {
  return LAYER_TRACK_IDS[layer] ?? OTHER_LAYER_TRACK_ID;
}

function buildArgs(record: DiagnosticsTimelineRecord): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = {};
  if (record.runId) {
    args.runId = record.runId;
  }
  if (record.spanId) {
    args.spanId = record.spanId;
  }
  if (record.phase) {
    args.phase = record.phase;
  }
  if (record.provider) {
    args.provider = record.provider;
  }
  if (record.operation) {
    args.operation = record.operation;
  }
  if (typeof record.ok === "boolean") {
    args.ok = record.ok;
  }
  if (record.errorName) {
    args.errorName = record.errorName;
  }
  if (record.errorMessage) {
    args.errorMessage = record.errorMessage;
  }
  if (record.command) {
    args.command = record.command;
  }
  if (record.exitCode !== undefined && record.exitCode !== null) {
    args.exitCode = record.exitCode;
  }
  if (record.attributes) {
    for (const [key, value] of Object.entries(record.attributes)) {
      if (key === "layer") {
        continue;
      }
      args[key] = value;
    }
  }
  return Object.keys(args).length > 0 ? args : undefined;
}

type SpanAccumulator = {
  start: DiagnosticsTimelineRecord;
  startMs: number;
};

/**
 * Convert timeline records into a Chrome trace. Spans are matched start->end by
 * spanId; the end carries the precise `durationMs`. Each (pid, layer) pair gets
 * a named track via metadata events.
 */
export function timelineRecordsToChromeTrace(
  records: DiagnosticsTimelineRecord[],
  options: TimelineExportOptions = {},
): ChromeTrace {
  const filtered = options.runId
    ? records.filter((record) => record.runId === options.runId)
    : records;

  const baseMs = filtered.reduce<number | undefined>((min, record) => {
    const ms = epochMs(record.timestamp);
    if (ms === undefined) {
      return min;
    }
    return min === undefined || ms < min ? ms : min;
  }, undefined);
  const origin = baseMs ?? 0;
  const toUs = (ms: number) => Math.max(0, Math.round((ms - origin) * 1000));

  const events: ChromeTraceEvent[] = [];
  const openSpans = new Map<string, SpanAccumulator>();
  const tracks = new Map<string, { pid: number; tid: number; layer: string }>();

  const ensureTrack = (record: DiagnosticsTimelineRecord): { pid: number; tid: number } => {
    const pid = typeof record.pid === "number" ? record.pid : 0;
    const layer = layerOf(record);
    const tid = trackIdForLayer(layer);
    tracks.set(`${pid}:${tid}`, { pid, tid, layer });
    return { pid, tid };
  };

  const emitComplete = (
    record: DiagnosticsTimelineRecord,
    startMs: number,
    durationMs: number,
  ): void => {
    const { pid, tid } = ensureTrack(record);
    const event: ChromeTraceEvent = {
      name: record.name ?? "(anonymous)",
      ph: "X",
      ts: toUs(startMs),
      dur: Math.max(0, Math.round(durationMs * 1000)),
      pid,
      tid,
      cat: layerOf(record),
    };
    const args = buildArgs(record);
    if (args) {
      event.args = args;
    }
    events.push(event);
  };

  const emitInstant = (record: DiagnosticsTimelineRecord): void => {
    const ms = epochMs(record.timestamp);
    if (ms === undefined) {
      return;
    }
    const { pid, tid } = ensureTrack(record);
    const event: ChromeTraceEvent = {
      name: record.name ?? record.type ?? "(mark)",
      ph: "i",
      ts: toUs(ms),
      pid,
      tid,
      s: "t",
      cat: layerOf(record),
    };
    const args = buildArgs(record);
    if (args) {
      event.args = args;
    }
    events.push(event);
  };

  for (const record of filtered) {
    switch (record.type) {
      case "span.start": {
        const ms = epochMs(record.timestamp);
        if (record.spanId && ms !== undefined) {
          openSpans.set(record.spanId, { start: record, startMs: ms });
        }
        break;
      }
      case "span.end":
      case "span.error": {
        const open = record.spanId ? openSpans.get(record.spanId) : undefined;
        const endMs = epochMs(record.timestamp);
        if (open) {
          openSpans.delete(record.spanId as string);
          const durationMs =
            typeof record.durationMs === "number"
              ? record.durationMs
              : endMs !== undefined
                ? Math.max(0, endMs - open.startMs)
                : 0;
          // The end record carries the richer attributes/error; merge names from start.
          const merged: DiagnosticsTimelineRecord = {
            ...open.start,
            ...record,
            name: record.name ?? open.start.name,
          };
          emitComplete(merged, open.startMs, durationMs);
        } else if (endMs !== undefined && typeof record.durationMs === "number") {
          // Span end without a matching start (e.g. truncated head): place it
          // ending at its own timestamp.
          emitComplete(record, endMs - record.durationMs, record.durationMs);
        }
        break;
      }
      case "provider.request": {
        const ms = epochMs(record.timestamp);
        if (ms !== undefined && typeof record.durationMs === "number") {
          emitComplete(record, ms - record.durationMs, record.durationMs);
        } else {
          emitInstant(record);
        }
        break;
      }
      case "mark":
      case "childProcess.exit":
      case "eventLoop.sample": {
        emitInstant(record);
        break;
      }
      default: {
        if (record.timestamp) {
          emitInstant(record);
        }
        break;
      }
    }
  }

  // Metadata: name each process and track so Perfetto shows readable lanes.
  const seenProcesses = new Set<number>();
  for (const { pid, tid, layer } of tracks.values()) {
    if (!seenProcesses.has(pid)) {
      seenProcesses.add(pid);
      events.push({
        name: "process_name",
        ph: "M",
        ts: 0,
        pid,
        tid: 0,
        args: { name: `pid ${pid}` },
      });
    }
    events.push({
      name: "thread_name",
      ph: "M",
      ts: 0,
      pid,
      tid,
      args: { name: layer },
    });
  }

  return { traceEvents: events, displayTimeUnit: CHROME_TRACE_DISPLAY_TIME_UNIT };
}

/** Convenience: parse a JSONL body and convert in one call. */
export function chromeTraceFromJsonl(
  text: string,
  options: TimelineExportOptions = {},
): ChromeTrace {
  return timelineRecordsToChromeTrace(parseTimelineJsonl(text), options);
}
