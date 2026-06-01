/**
 * Frontend perf-trace collector (desktop UI lane). Captures per-chat-send client
 * spans with wall-clock timestamps and the same `runId` the gateway sees, then
 * flushes them to the gateway via the `diagnostics.clientTrace` RPC. The gateway
 * writes them into the diagnostics timeline tagged `layer: "frontend"`, so the
 * perf-trace export renders desktop -> gateway -> agent -> provider as one flame
 * graph. See docs/diagnostics/perf-trace.
 *
 * Opt-in and zero-overhead by default: enable with
 * `localStorage.setItem("openclaw:perf-trace", "1")` (mirrors the main-thread
 * monitor flag). When disabled, every method is an early-return no-op.
 */

const STORAGE_KEY = "openclaw:perf-trace";
const MAX_EVENTS_PER_RUN = 200;

type TimelineAttributeValue = string | number | boolean | null;

type ClientTraceEvent = {
  type: "span.start" | "span.end" | "mark";
  name: string;
  timestamp: string;
  runId?: string;
  spanId?: string;
  durationMs?: number;
  attributes?: Record<string, TimelineAttributeValue>;
};

/** Minimal gateway client surface needed to flush, to avoid import cycles. */
type TraceFlushClient =
  | {
      request: (method: string, params: unknown) => Promise<unknown>;
    }
  | null
  | undefined;

type ActiveSpan = { spanId: string; startedAt: number; markedFirstEvent: boolean };

class ClientTraceCollector {
  private enabledCache: boolean | undefined;
  private readonly buffers = new Map<string, ClientTraceEvent[]>();
  private readonly active = new Map<string, ActiveSpan>();

  isEnabled(): boolean {
    if (this.enabledCache === undefined) {
      try {
        this.enabledCache = globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
      } catch {
        this.enabledCache = false;
      }
    }
    return this.enabledCache;
  }

  startChatSend(runId: string | null | undefined): void {
    if (!this.isEnabled() || !runId) {
      return;
    }
    const spanId = `fe-${runId}`;
    this.active.set(runId, { spanId, startedAt: Date.now(), markedFirstEvent: false });
    this.push(runId, {
      type: "span.start",
      name: "frontend.chat_send",
      spanId,
      runId,
      timestamp: new Date().toISOString(),
      attributes: { layer: "frontend" },
    });
  }

  markFirstEvent(runId: string | null | undefined): void {
    if (!this.isEnabled() || !runId) {
      return;
    }
    const span = this.active.get(runId);
    if (!span || span.markedFirstEvent) {
      return;
    }
    span.markedFirstEvent = true;
    this.push(runId, {
      type: "mark",
      name: "frontend.first_event",
      runId,
      timestamp: new Date().toISOString(),
      attributes: { layer: "frontend", sinceSendMs: Date.now() - span.startedAt },
    });
  }

  endChatSend(runId: string | null | undefined, client: TraceFlushClient): void {
    if (!this.isEnabled() || !runId) {
      return;
    }
    const span = this.active.get(runId);
    if (!span) {
      return;
    }
    this.active.delete(runId);
    this.push(runId, {
      type: "span.end",
      name: "frontend.chat_send",
      spanId: span.spanId,
      runId,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - span.startedAt,
      attributes: { layer: "frontend" },
    });
    this.flush(runId, client);
  }

  private push(runId: string, event: ClientTraceEvent): void {
    const buffer = this.buffers.get(runId) ?? [];
    if (buffer.length < MAX_EVENTS_PER_RUN) {
      buffer.push(event);
    }
    this.buffers.set(runId, buffer);
  }

  private flush(runId: string, client: TraceFlushClient): void {
    const events = this.buffers.get(runId);
    this.buffers.delete(runId);
    if (!events || events.length === 0 || !client) {
      return;
    }
    // Fire-and-forget; never let trace reporting affect the chat flow.
    void Promise.resolve(client.request("diagnostics.clientTrace", { events })).catch(() => {});
  }
}

export const clientTrace = new ClientTraceCollector();
