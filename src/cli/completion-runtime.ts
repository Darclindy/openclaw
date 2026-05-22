import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { pathExists } from "../utils.js";

export const COMPLETION_SHELLS = ["zsh", "bash", "powershell", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];
export const COMPLETION_SKIP_PLUGIN_COMMANDS_ENV = "OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS";

export function isCompletionShell(value: string): value is CompletionShell {
  return COMPLETION_SHELLS.includes(value as CompletionShell);
}

export function resolveShellFromEnv(env: NodeJS.ProcessEnv = process.env): CompletionShell {
  const shellPath = normalizeOptionalString(env.SHELL) ?? "";
  const shellName = shellPath ? normalizeLowercaseStringOrEmpty(path.basename(shellPath)) : "";
  if (shellName === "zsh") {
    return "zsh";
  }
  if (shellName === "bash") {
    return "bash";
  }
  if (shellName === "fish") {
    return "fish";
  }
  if (shellName === "pwsh" || shellName === "powershell") {
    return "powershell";
  }
  return "zsh";
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''");
}

function formatCompletionSourceLine(shell: CompletionShell, binName: string): string {
  if (shell === "powershell") {
    return `${binName} completion --shell powershell | Out-String | Invoke-Expression`;
  }
  if (shell === "fish") {
    return `${binName} completion --shell fish | source`;
  }
  return `source <(${binName} completion --shell ${shell})`;
}

export function formatCompletionReloadCommand(shell: CompletionShell, profilePath: string): string {
  if (shell === "powershell") {
    return `. '${escapePowerShellSingleQuotedString(profilePath)}'`;
  }
  return `source ${profilePath}`;
}

function isCompletionProfileHeader(line: string): boolean {
  return line.trim() === "# OpenClaw Completion";
}

function isCompletionProfileLine(line: string, binName: string, cachePath: string | null): boolean {
  if (line.includes(`${binName} completion`)) {
    return true;
  }
  if (cachePath && line.includes(cachePath)) {
    return true;
  }
  return false;
}

function updateCompletionProfile(
  content: string,
  binName: string,
  cachePath: string | null,
  sourceLine: string,
): { next: string; changed: boolean; hadExisting: boolean } {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let hadExisting = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isCompletionProfileHeader(line)) {
      hadExisting = true;
      i += 1;
      continue;
    }
    if (isCompletionProfileLine(line, binName, cachePath)) {
      hadExisting = true;
      continue;
    }
    filtered.push(line);
  }

  const trimmed = filtered.join("\n").trimEnd();
  const block = `# OpenClaw Completion\n${sourceLine}`;
  const next = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  return { next, changed: next !== content, hadExisting };
}

export function resolveCompletionProfilePath(
  shell: CompletionShell,
  options: {
    env?: NodeJS.ProcessEnv;
    homeDir?: () => string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir;
  const platform = options.platform ?? process.platform;
  const home = env.HOME || homeDir();
  if (shell === "zsh") {
    return path.join(home, ".zshrc");
  }
  if (shell === "bash") {
    return path.join(home, ".bashrc");
  }
  if (shell === "fish") {
    return path.join(home, ".config", "fish", "config.fish");
  }
  if (platform === "win32") {
    return path.win32.join(
      env.USERPROFILE || home,
      "Documents",
      "PowerShell",
      "Microsoft.PowerShell_profile.ps1",
    );
  }
  return path.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
}

export async function isCompletionInstalled(
  shell: CompletionShell,
  binName = "openclaw",
): Promise<boolean> {
  const profilePath = resolveCompletionProfilePath(shell);

  if (!(await pathExists(profilePath))) {
    return false;
  }
  const content = await fs.readFile(profilePath, "utf-8");
  const lines = content.split("\n");
  return lines.some(
    (line) => isCompletionProfileHeader(line) || isCompletionProfileLine(line, binName, null),
  );
}

export async function installCompletion(
  shell: string,
  yes: boolean,
  binName = "openclaw",
  options: { retiredCachePath?: string | null } = {},
) {
  const home = process.env.HOME || os.homedir();
  let profilePath = "";
  let sourceLine = "";

  const isShellSupported = isCompletionShell(shell);
  if (!isShellSupported) {
    console.error(`Automated installation not supported for ${shell} yet.`);
    return;
  }

  if (shell === "zsh") {
    profilePath = resolveCompletionProfilePath("zsh");
    sourceLine = formatCompletionSourceLine("zsh", binName);
  } else if (shell === "bash") {
    profilePath = resolveCompletionProfilePath("bash");
    try {
      await fs.access(profilePath);
    } catch {
      profilePath = path.join(home, ".bash_profile");
    }
    sourceLine = formatCompletionSourceLine("bash", binName);
  } else if (shell === "fish") {
    profilePath = resolveCompletionProfilePath("fish");
    sourceLine = formatCompletionSourceLine("fish", binName);
  } else if (shell === "powershell") {
    profilePath = resolveCompletionProfilePath("powershell");
    sourceLine = formatCompletionSourceLine("powershell", binName);
  } else {
    console.error("Automated installation not supported for this shell yet.");
    return;
  }

  try {
    try {
      await fs.access(profilePath);
    } catch {
      if (!yes) {
        console.warn(`Profile not found at ${profilePath}. Created a new one.`);
      }
      await fs.mkdir(path.dirname(profilePath), { recursive: true });
      await fs.writeFile(profilePath, "", "utf-8");
    }

    const content = await fs.readFile(profilePath, "utf-8");
    const update = updateCompletionProfile(
      content,
      binName,
      options.retiredCachePath ?? null,
      sourceLine,
    );
    if (!update.changed) {
      if (!yes) {
        console.log(`Completion already installed in ${profilePath}`);
      }
      return;
    }

    if (!yes) {
      const action = update.hadExisting ? "Updating" : "Installing";
      console.log(`${action} completion in ${profilePath}...`);
    }

    await fs.writeFile(profilePath, update.next, "utf-8");
    if (!yes) {
      console.log(
        `Completion installed. Restart your shell or run: ${formatCompletionReloadCommand(shell, profilePath)}`,
      );
    }
  } catch (err) {
    console.error(`Failed to install completion: ${err as string}`);
  }
}
