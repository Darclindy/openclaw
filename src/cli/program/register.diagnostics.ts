import type { Command } from "commander";
import { diagnosticsTraceExportCommand } from "../../commands/diagnostics-trace-export.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

export function registerDiagnosticsCommand(program: Command) {
  const diagnostics = program
    .command("diagnostics")
    .description("Inspect and export diagnostics traces and performance data")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/diagnostics/perf-trace", "docs.openclaw.ai/diagnostics/perf-trace")}\n`,
    );

  diagnostics
    .command("trace-export <input>")
    .description("Convert a diagnostics-timeline JSONL into a Perfetto/Chrome trace flame graph")
    .option("--out <path>", "Output path (default: <input>.perfetto.json)")
    .option("--run <runId>", "Keep only spans for this runId (one chat request)")
    .option("--json", "Output JSON metadata", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          [
            "openclaw diagnostics trace-export ~/.openclaw/logs/perf-trace/timeline.jsonl",
            "Export a captured timeline to <input>.perfetto.json for ui.perfetto.dev.",
          ],
          [
            "openclaw diagnostics trace-export timeline.jsonl --run <runId>",
            "Export only the spans for one chat request.",
          ],
        ])}`,
    )
    .action(async (input, opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await diagnosticsTraceExportCommand(defaultRuntime, {
          input: input as string,
          out: opts.out as string | undefined,
          runId: opts.run as string | undefined,
          json: Boolean(opts.json),
        });
      });
    });
}
