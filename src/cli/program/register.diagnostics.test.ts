import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerDiagnosticsCommand } from "./register.diagnostics.js";

const mocks = vi.hoisted(() => ({
  diagnosticsTraceExportCommand: vi.fn(),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

const diagnosticsTraceExportCommand = mocks.diagnosticsTraceExportCommand;
const runtime = mocks.runtime;

vi.mock("../../commands/diagnostics-trace-export.js", () => ({
  diagnosticsTraceExportCommand: mocks.diagnosticsTraceExportCommand,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("registerDiagnosticsCommand", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerDiagnosticsCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  function expectForwardedOptions(): Record<string, unknown> {
    expect(diagnosticsTraceExportCommand).toHaveBeenCalledTimes(1);
    const call = diagnosticsTraceExportCommand.mock.calls[0];
    if (!call) {
      throw new Error("expected diagnostics trace-export call");
    }
    const [runtimeArg, options] = call as unknown as [typeof runtime, Record<string, unknown>];
    expect(runtimeArg).toBe(runtime);
    return options;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    diagnosticsTraceExportCommand.mockResolvedValue(undefined);
  });

  it("runs trace-export with the input path and defaults", async () => {
    await runCli(["diagnostics", "trace-export", "/tmp/timeline.jsonl"]);

    const options = expectForwardedOptions();
    expect(options.input).toBe("/tmp/timeline.jsonl");
    expect(options.out).toBeUndefined();
    expect(options.runId).toBeUndefined();
    expect(options.json).toBe(false);
  });

  it("forwards --out, --run, and --json", async () => {
    await runCli([
      "diagnostics",
      "trace-export",
      "/tmp/timeline.jsonl",
      "--out",
      "/tmp/trace.json",
      "--run",
      "run-123",
      "--json",
    ]);

    const options = expectForwardedOptions();
    expect(options.out).toBe("/tmp/trace.json");
    expect(options.runId).toBe("run-123");
    expect(options.json).toBe(true);
  });
});
