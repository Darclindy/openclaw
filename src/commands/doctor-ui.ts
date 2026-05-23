import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveControlUiDistIndexHealth,
  resolveControlUiDistIndexPathForRoot,
} from "../infra/control-ui-assets.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

export type UiProtocolFreshnessIssue =
  | {
      readonly kind: "missing-assets";
      readonly root: string;
      readonly uiIndexPath: string;
      readonly canBuild: boolean;
    }
  | {
      readonly kind: "stale-assets";
      readonly root: string;
      readonly uiIndexPath: string;
      readonly schemaPath: string;
      readonly canBuild: boolean;
      readonly changesSinceBuild: readonly string[];
    };

export async function maybeRepairUiProtocolFreshness(
  _runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  const issues = await detectUiProtocolFreshnessIssues();
  for (const issue of issues) {
    note(formatUiProtocolFreshnessIssue(issue), uiProtocolFreshnessIssueTitle(issue));
    const result = await repairUiProtocolFreshnessIssue(issue, prompter);
    for (const message of result.notes) {
      note(message, uiProtocolFreshnessIssueTitle(issue));
    }
  }
}

export async function detectUiProtocolFreshnessIssues(): Promise<
  readonly UiProtocolFreshnessIssue[]
> {
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!root) {
    return [];
  }

  try {
    const schemaPath = path.join(root, "src/gateway/protocol/schema.ts");
    const uiHealth = await resolveControlUiDistIndexHealth({
      root,
      argv1: process.argv[1],
    });
    const uiIndexPath = uiHealth.indexPath ?? resolveControlUiDistIndexPathForRoot(root);
    const uiSourcesPath = path.join(root, "ui/package.json");
    const [schemaStats, uiStats, uiSourcesStats] = await Promise.all([
      fs.stat(schemaPath).catch(() => null),
      fs.stat(uiIndexPath).catch(() => null),
      fs.stat(uiSourcesPath).catch(() => null),
    ]);
    if (!schemaStats) {
      return [];
    }

    const canBuild = uiSourcesStats !== null;
    if (!uiStats) {
      return [{ kind: "missing-assets", root, uiIndexPath, canBuild }];
    }
    if (schemaStats.mtime <= uiStats.mtime) {
      return [];
    }

    const changesSinceBuild = await collectProtocolSchemaChangesSince(root, uiStats.mtime);
    if (changesSinceBuild.length === 0) {
      return [];
    }
    return [
      {
        kind: "stale-assets",
        root,
        uiIndexPath,
        schemaPath,
        canBuild,
        changesSinceBuild,
      },
    ];
  } catch {
    // Missing files or git failures should not make doctor fail.
    return [];
  }
}

async function collectProtocolSchemaChangesSince(
  root: string,
  uiMtime: Date,
): Promise<readonly string[]> {
  const gitLog = await runCommandWithTimeout(
    [
      "git",
      "-C",
      root,
      "log",
      `--since=${uiMtime.toISOString()}`,
      "--format=%h %s",
      "src/gateway/protocol/schema.ts",
    ],
    { timeoutMs: 5000 },
  ).catch(() => null);
  if (!gitLog || gitLog.code !== 0 || !gitLog.stdout.trim()) {
    return [];
  }
  return gitLog.stdout.trim().split("\n");
}

export function formatUiProtocolFreshnessIssue(issue: UiProtocolFreshnessIssue): string {
  if (issue.kind === "missing-assets") {
    return ["- Control UI assets are missing.", "- Run: pnpm ui:build"].join("\n");
  }
  return `UI assets are older than the protocol schema.\nFunctional changes since last build:\n${issue.changesSinceBuild
    .map((line) => `- ${line}`)
    .join("\n")}`;
}

export function uiProtocolFreshnessIssueTitle(issue: UiProtocolFreshnessIssue): string {
  return issue.kind === "missing-assets" ? "UI" : "UI Freshness";
}

export function uiProtocolFreshnessRepairLabel(issue: UiProtocolFreshnessIssue): string {
  return issue.kind === "missing-assets" ? "build Control UI assets" : "rebuild stale UI assets";
}

export async function repairUiProtocolFreshnessIssue(
  issue: UiProtocolFreshnessIssue,
  prompter: Pick<DoctorPrompter, "confirmAutoFix" | "confirmAggressiveAutoFix">,
): Promise<{
  readonly status: "repaired" | "skipped" | "failed";
  readonly notes: readonly string[];
}> {
  if (!issue.canBuild) {
    const action = issue.kind === "missing-assets" ? "build" : "rebuild";
    return { status: "skipped", notes: [`Skipping UI ${action}: ui/ sources not present.`] };
  }

  const shouldRepair =
    issue.kind === "missing-assets"
      ? await prompter.confirmAutoFix({
          message: "Build Control UI assets now?",
          initialValue: true,
        })
      : await prompter.confirmAggressiveAutoFix({
          message: "Rebuild UI now? (Detected protocol mismatch requiring update)",
          initialValue: true,
        });
  if (!shouldRepair) {
    return { status: "skipped", notes: [] };
  }

  const uiScriptPath = path.join(issue.root, "scripts/ui.js");
  const buildResult = await runCommandWithTimeout([process.execPath, uiScriptPath, "build"], {
    cwd: issue.root,
    timeoutMs: 120_000,
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  if (buildResult.code === 0) {
    return {
      status: "repaired",
      notes: [issue.kind === "missing-assets" ? "UI build complete." : "UI rebuild complete."],
    };
  }

  const operation = issue.kind === "missing-assets" ? "build" : "rebuild";
  const details = [
    `UI ${operation} failed (exit ${buildResult.code ?? "unknown"}).`,
    buildResult.stderr.trim() ? buildResult.stderr.trim() : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { status: "failed", notes: [details] };
}
