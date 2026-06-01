import { readFile, writeFile } from "node:fs/promises";
import { chromeTraceFromJsonl } from "../infra/diagnostics-timeline-export.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveUserPath } from "../utils.js";

export type DiagnosticsTraceExportOptions = {
  input: string;
  out?: string;
  runId?: string;
  json?: boolean;
};

export type DiagnosticsTraceExportResult = {
  ok: true;
  input: string;
  output: string;
  traceEventCount: number;
  spanCount: number;
};

function defaultOutputPath(inputPath: string): string {
  return `${inputPath.replace(/\.jsonl$/i, "")}.perfetto.json`;
}

/**
 * Convert a diagnostics-timeline JSONL file into a Chrome Trace Event JSON for
 * https://ui.perfetto.dev / chrome://tracing. Backs `openclaw diagnostics
 * trace-export`. See docs/reference/perf-trace (Performance tracing).
 */
export async function diagnosticsTraceExportCommand(
  runtime: RuntimeEnv,
  opts: DiagnosticsTraceExportOptions,
): Promise<DiagnosticsTraceExportResult> {
  const inputPath = resolveUserPath(opts.input);
  const outputPath = opts.out ? resolveUserPath(opts.out) : defaultOutputPath(inputPath);
  const body = await readFile(inputPath, "utf8");
  const trace = chromeTraceFromJsonl(body, opts.runId ? { runId: opts.runId } : {});
  await writeFile(outputPath, JSON.stringify(trace));

  const spanCount = trace.traceEvents.filter((event) => event.ph === "X").length;
  const result: DiagnosticsTraceExportResult = {
    ok: true,
    input: inputPath,
    output: outputPath,
    traceEventCount: trace.traceEvents.length,
    spanCount,
  };

  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(
      `Wrote ${outputPath} (${trace.traceEvents.length} trace events, ${spanCount} spans).\n` +
        "Open it at https://ui.perfetto.dev or chrome://tracing.",
    );
  }
  return result;
}
