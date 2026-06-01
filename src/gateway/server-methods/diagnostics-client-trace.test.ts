import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordClientTraceEvents } from "./diagnostics-client-trace.js";

const savedEnv: Record<string, string | undefined> = {};
let traceDir: string | undefined;
let tracePath: string;

function readEmitted(): Array<Record<string, unknown>> {
  try {
    return readFileSync(tracePath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function enableTimeline() {
  traceDir = mkdtempSync(join(tmpdir(), "openclaw-clienttrace-"));
  tracePath = join(traceDir, "timeline.jsonl");
  process.env.OPENCLAW_DIAGNOSTICS = "timeline";
  process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = tracePath;
}

beforeEach(() => {
  for (const key of ["OPENCLAW_DIAGNOSTICS", "OPENCLAW_DIAGNOSTICS_TIMELINE_PATH"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  if (traceDir) {
    rmSync(traceDir, { recursive: true, force: true });
    traceDir = undefined;
  }
});

describe("recordClientTraceEvents", () => {
  it("is a no-op when the timeline is disabled", () => {
    expect(recordClientTraceEvents({ events: [{ type: "mark", name: "x" }] })).toBe(0);
  });

  it("emits valid events tagged layer=frontend with runId preserved", () => {
    enableTimeline();
    const accepted = recordClientTraceEvents({
      events: [
        {
          type: "span.start",
          name: "frontend.chat_send",
          spanId: "fe-1",
          runId: "run-9",
          timestamp: "2026-05-31T00:00:00.000Z",
          attributes: { phase: "submit" },
        },
        {
          type: "span.end",
          name: "frontend.chat_send",
          spanId: "fe-1",
          runId: "run-9",
          durationMs: 42,
          timestamp: "2026-05-31T00:00:00.042Z",
        },
      ],
    });
    expect(accepted).toBe(2);
    const emitted = readEmitted();
    expect(emitted).toHaveLength(2);
    expect(
      emitted.every((e) => (e.attributes as Record<string, unknown>).layer === "frontend"),
    ).toBe(true);
    expect(emitted[0].runId).toBe("run-9");
    expect(emitted[1].durationMs).toBe(42);
  });

  it("forces layer=frontend even if the client claims another layer", () => {
    enableTimeline();
    recordClientTraceEvents({
      events: [{ type: "mark", name: "spoof", attributes: { layer: "provider" } }],
    });
    const emitted = readEmitted();
    expect((emitted[0].attributes as Record<string, unknown>).layer).toBe("frontend");
  });

  it("skips invalid events (bad type, empty name, non-object)", () => {
    enableTimeline();
    const accepted = recordClientTraceEvents({
      events: [
        { type: "span.bogus", name: "x" },
        { type: "mark", name: "" },
        null,
        42,
        { type: "mark", name: "ok" },
      ],
    });
    expect(accepted).toBe(1);
    expect(readEmitted()).toHaveLength(1);
  });

  it("returns 0 for non-array events", () => {
    enableTimeline();
    expect(recordClientTraceEvents({ events: "nope" })).toBe(0);
    expect(recordClientTraceEvents({})).toBe(0);
    expect(recordClientTraceEvents(null)).toBe(0);
  });
});
