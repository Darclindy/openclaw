import { describe, expect, it } from "vitest";
import {
  chromeTraceFromJsonl,
  parseTimelineJsonl,
  timelineRecordsToChromeTrace,
  type DiagnosticsTimelineRecord,
} from "./diagnostics-timeline-export.js";

const BASE_MS = Date.parse("2026-05-31T00:00:00.000Z");
const iso = (offsetMs: number) => new Date(BASE_MS + offsetMs).toISOString();

function sampleRecords(): DiagnosticsTimelineRecord[] {
  return [
    {
      type: "span.start",
      name: "chat.request",
      spanId: "s1",
      pid: 100,
      runId: "r1",
      timestamp: iso(0),
      attributes: { layer: "gateway", method: "chat.send" },
    },
    {
      type: "span.start",
      name: "agent.run",
      spanId: "s2",
      parentSpanId: "s1",
      pid: 100,
      runId: "r1",
      timestamp: iso(1),
      attributes: { layer: "agent" },
    },
    {
      type: "mark",
      name: "ttft",
      pid: 100,
      runId: "r1",
      timestamp: iso(10),
      attributes: { layer: "agent" },
    },
    {
      type: "provider.request",
      name: "provider.request",
      provider: "openai",
      pid: 100,
      runId: "r1",
      durationMs: 50,
      timestamp: iso(60),
      attributes: { layer: "provider", model: "gpt-5.5" },
    },
    {
      type: "span.end",
      name: "agent.run",
      spanId: "s2",
      pid: 100,
      runId: "r1",
      durationMs: 58,
      timestamp: iso(59),
    },
    {
      type: "span.end",
      name: "chat.request",
      spanId: "s1",
      pid: 100,
      runId: "r1",
      durationMs: 60,
      timestamp: iso(60),
    },
    // A different run that should be filtered out.
    {
      type: "span.start",
      name: "chat.request",
      spanId: "x1",
      pid: 100,
      runId: "r2",
      timestamp: iso(5),
      attributes: { layer: "gateway" },
    },
    {
      type: "span.end",
      name: "chat.request",
      spanId: "x1",
      pid: 100,
      runId: "r2",
      durationMs: 5,
      timestamp: iso(10),
    },
  ];
}

describe("parseTimelineJsonl", () => {
  it("skips blank and malformed lines", () => {
    const body = [
      '{"type":"mark","name":"a"}',
      "",
      "  ",
      "not json",
      '{"type":"mark","name":"b"}',
    ].join("\n");
    const records = parseTimelineJsonl(body);
    expect(records.map((r) => r.name)).toEqual(["a", "b"]);
  });
});

describe("timelineRecordsToChromeTrace", () => {
  it("pairs span start/end into complete events with precise duration and layer tracks", () => {
    const trace = timelineRecordsToChromeTrace(sampleRecords(), { runId: "r1" });
    const complete = trace.traceEvents.filter((e) => e.ph === "X");

    const root = complete.find((e) => e.name === "chat.request");
    const agent = complete.find((e) => e.name === "agent.run");
    const provider = complete.find((e) => e.name === "provider.request");

    expect(root).toBeDefined();
    expect(agent).toBeDefined();
    expect(provider).toBeDefined();

    // Layer -> tid swimlanes.
    expect(root?.tid).toBe(2); // gateway
    expect(agent?.tid).toBe(3); // agent
    expect(provider?.tid).toBe(4); // provider

    // Durations are taken from the precise durationMs (ms -> us).
    expect(root?.dur).toBe(60_000);
    expect(agent?.dur).toBe(58_000);
    expect(provider?.dur).toBe(50_000);

    // Trace is shifted so the earliest event starts at t=0.
    expect(root?.ts).toBe(0);
    expect(agent?.ts).toBe(1_000);

    // Args carry correlation + attributes.
    expect(root?.args?.runId).toBe("r1");
    expect(root?.args?.method).toBe("chat.send");
    expect(root?.cat).toBe("gateway");
  });

  it("emits marks as instant events", () => {
    const trace = timelineRecordsToChromeTrace(sampleRecords(), { runId: "r1" });
    const instant = trace.traceEvents.find((e) => e.ph === "i" && e.name === "ttft");
    expect(instant).toBeDefined();
    expect(instant?.tid).toBe(3); // agent
    expect(instant?.ts).toBe(10_000);
  });

  it("filters by runId", () => {
    const trace = timelineRecordsToChromeTrace(sampleRecords(), { runId: "r1" });
    const names = trace.traceEvents.filter((e) => e.ph === "X").map((e) => e.name);
    // r2's chat.request must not appear; r1's does (once).
    expect(names.filter((n) => n === "chat.request")).toHaveLength(1);
  });

  it("names processes and tracks via metadata events", () => {
    const trace = timelineRecordsToChromeTrace(sampleRecords(), { runId: "r1" });
    const meta = trace.traceEvents.filter((e) => e.ph === "M");
    expect(meta.some((e) => e.name === "process_name")).toBe(true);
    const threadNames = meta.filter((e) => e.name === "thread_name").map((e) => e.args?.name);
    expect(threadNames).toEqual(expect.arrayContaining(["gateway", "agent", "provider"]));
  });

  it("places provider.request without a span pair as a duration on the provider track", () => {
    const trace = timelineRecordsToChromeTrace(
      [
        {
          type: "provider.request",
          name: "provider.request",
          provider: "anthropic",
          pid: 7,
          durationMs: 12,
          timestamp: iso(100),
        },
      ],
      {},
    );
    const provider = trace.traceEvents.find((e) => e.ph === "X");
    expect(provider?.tid).toBe(4);
    expect(provider?.dur).toBe(12_000);
  });

  it("sets displayTimeUnit to ms", () => {
    const trace = timelineRecordsToChromeTrace(sampleRecords());
    expect(trace.displayTimeUnit).toBe("ms");
  });
});

describe("chromeTraceFromJsonl", () => {
  it("parses and converts in one call", () => {
    const body = sampleRecords()
      .map((r) => JSON.stringify(r))
      .join("\n");
    const trace = chromeTraceFromJsonl(body, { runId: "r1" });
    expect(trace.traceEvents.some((e) => e.name === "chat.request" && e.ph === "X")).toBe(true);
  });
});
