import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "openclaw:perf-trace";

type FlushCall = { method: string; params: { events: Array<Record<string, unknown>> } };

function stubLocalStorage(enabled: boolean) {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => (key === STORAGE_KEY && enabled ? "1" : null),
  };
}

async function freshCollector() {
  vi.resetModules();
  const mod = await import("./trace-client.ts");
  return mod.clientTrace;
}

function makeClient(sink: FlushCall[]) {
  return {
    request: async (method: string, params: unknown) => {
      sink.push({ method, params: params as FlushCall["params"] });
      return {};
    },
  };
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("clientTrace", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("is a no-op when the flag is not set", async () => {
    stubLocalStorage(false);
    const trace = await freshCollector();
    const sink: FlushCall[] = [];
    expect(trace.isEnabled()).toBe(false);
    trace.startChatSend("run-1");
    trace.markFirstEvent("run-1");
    trace.endChatSend("run-1", makeClient(sink));
    await Promise.resolve();
    expect(sink).toHaveLength(0);
  });

  it("captures start, first-event, and end then flushes once", async () => {
    stubLocalStorage(true);
    const trace = await freshCollector();
    const sink: FlushCall[] = [];
    const client = makeClient(sink);

    trace.startChatSend("run-2");
    trace.markFirstEvent("run-2");
    trace.markFirstEvent("run-2"); // de-duped
    trace.endChatSend("run-2", client);
    await Promise.resolve();
    await Promise.resolve();

    expect(sink).toHaveLength(1);
    expect(sink[0].method).toBe("diagnostics.clientTrace");
    const events = sink[0].params.events;
    expect(events.map((e) => `${e.type}:${e.name}`)).toEqual([
      "span.start:frontend.chat_send",
      "mark:frontend.first_event",
      "span.end:frontend.chat_send",
    ]);
    expect(events[0].spanId).toBe("fe-run-2");
    expect(events[0].runId).toBe("run-2");
    expect((events[0].attributes as Record<string, unknown>).layer).toBe("frontend");
    expect(typeof events[2].durationMs).toBe("number");
  });

  it("ignores end without a matching start", async () => {
    stubLocalStorage(true);
    const trace = await freshCollector();
    const sink: FlushCall[] = [];
    trace.endChatSend("missing", makeClient(sink));
    await Promise.resolve();
    expect(sink).toHaveLength(0);
  });
});
