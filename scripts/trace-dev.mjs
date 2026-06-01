#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One-command dev perf-trace workflow (see docs/reference/perf-trace.md).
 *
 * Sets the diagnostics-timeline + CPU-profile env, runs the gateway (or any
 * command you pass), and on exit converts the captured timeline JSONL into a
 * Perfetto trace you can drag into https://ui.perfetto.dev.
 *
 *   node scripts/trace-dev.mjs                 # wraps `pnpm gateway:watch`
 *   node scripts/trace-dev.mjs --cpu           # also capture V8 CPU profiles
 *   node scripts/trace-dev.mjs -- pnpm dev     # wrap a custom command
 */

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");

function parseArgs(argv) {
  const opts = { cpu: false, command: ["pnpm", "gateway:watch"] };
  const passthroughAt = argv.indexOf("--");
  const flags = passthroughAt === -1 ? argv : argv.slice(0, passthroughAt);
  const rest = passthroughAt === -1 ? [] : argv.slice(passthroughAt + 1);
  for (const flag of flags) {
    if (flag === "--cpu") {
      opts.cpu = true;
    } else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "Usage: node scripts/trace-dev.mjs [--cpu] [-- <command...>]\n" +
          "Default command: pnpm gateway:watch\n",
      );
      process.exit(0);
    }
  }
  if (rest.length > 0) {
    opts.command = rest;
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const traceDir = join(homedir(), ".openclaw", "logs", "perf-trace");
  const timelinePath = join(traceDir, `timeline-${stamp}.jsonl`);
  mkdirSync(traceDir, { recursive: true });

  const env = {
    ...process.env,
    OPENCLAW_DIAGNOSTICS: "timeline",
    OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath,
    ...(opts.cpu ? { OPENCLAW_CPU_PROFILE_DIR: traceDir } : {}),
  };

  process.stdout.write(`[trace-dev] timeline -> ${timelinePath}\n`);
  if (opts.cpu) {
    process.stdout.write(`[trace-dev] cpu profiles -> ${traceDir}\n`);
  }
  process.stdout.write(`[trace-dev] running: ${opts.command.join(" ")}\n`);
  process.stdout.write("[trace-dev] reproduce the slow request, then stop with Ctrl-C.\n\n");

  const [cmd, ...cmdArgs] = opts.command;
  const child = spawn(cmd, cmdArgs, { cwd: repoRoot, env, stdio: "inherit" });

  let exported = false;
  const exportTrace = () => {
    if (exported) {
      return;
    }
    exported = true;
    process.stdout.write(`\n[trace-dev] exporting ${timelinePath}\n`);
    const result = spawn(
      "node",
      ["--import", "tsx", join(scriptDir, "perf-trace-export.ts"), timelinePath],
      { cwd: repoRoot, stdio: "inherit" },
    );
    result.on("exit", (code) => process.exit(code ?? 0));
    result.on("error", () => process.exit(1));
  };

  child.on("exit", exportTrace);
  child.on("error", (err) => {
    process.stderr.write(`[trace-dev] failed to launch command: ${String(err)}\n`);
    process.exit(1);
  });
  // Let the child own the TTY for Ctrl-C; export runs from the child's exit handler.
  process.on("SIGINT", () => {});
}

main();
