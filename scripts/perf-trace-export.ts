#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { chromeTraceFromJsonl } from "../src/infra/diagnostics-timeline-export.js";

/**
 * Convert a diagnostics-timeline JSONL file (written when the gateway runs with
 * OPENCLAW_DIAGNOSTICS=timeline + OPENCLAW_DIAGNOSTICS_TIMELINE_PATH) into a
 * Chrome Trace Event JSON for https://ui.perfetto.dev / chrome://tracing.
 *
 * Usage:
 *   node --experimental-strip-types scripts/perf-trace-export.ts <input.jsonl> [options]
 * Options:
 *   --out <file>   Output path (default: <input>.perfetto.json)
 *   --run <runId>  Keep only spans for this runId (one chat request)
 *
 * See docs/reference/perf-trace.md.
 */

type Args = { input?: string; out?: string; runId?: string };

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--out") {
      args.out = argv[++i];
    } else if (token === "--run") {
      args.runId = argv[++i];
    } else if (token === "--help" || token === "-h") {
      printUsageAndExit(0);
    } else if (!token.startsWith("-") && !args.input) {
      args.input = token;
    } else {
      process.stderr.write(`Unknown argument: ${token}\n`);
      printUsageAndExit(1);
    }
  }
  return args;
}

function printUsageAndExit(code: number): never {
  const usage =
    "Usage: node --experimental-strip-types scripts/perf-trace-export.ts <input.jsonl> " +
    "[--out <file>] [--run <runId>]\n";
  (code === 0 ? process.stdout : process.stderr).write(usage);
  process.exit(code);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    printUsageAndExit(1);
  }
  const out = args.out ?? `${args.input.replace(/\.jsonl$/i, "")}.perfetto.json`;
  const body = readFileSync(args.input, "utf8");
  const trace = chromeTraceFromJsonl(body, args.runId ? { runId: args.runId } : {});
  writeFileSync(out, JSON.stringify(trace));
  const spanCount = trace.traceEvents.filter((e) => e.ph === "X").length;
  process.stdout.write(
    `Wrote ${out} (${trace.traceEvents.length} trace events, ${spanCount} spans).\n` +
      "Open it at https://ui.perfetto.dev or chrome://tracing.\n",
  );
}

main();
