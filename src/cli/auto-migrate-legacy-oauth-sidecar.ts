import fs from "node:fs";
import path from "node:path";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { hasFlag } from "./argv.js";
import { hasJsonOutputFlag } from "./json-output-mode.js";

const DECLINE_MARKER_FILENAME = "legacy-oauth-sidecar-migration-declined";

const SKIPPED_PRIMARIES = new Set(["doctor", "update", "help", "completion", "version"]);

// Argv flags that some command documents as suppressing confirmation
// prompts. Treat any of them as a signal that this invocation is
// scripted/automation and must not see the migration prompt either.
// `hasFlag` honors the `--` argv terminator for all of these.
const NO_PROMPT_FLAGS = ["--non-interactive", "--yes", "--no-input", "--force"] as const;

type AutoMigrateInteractivePrompter = {
  confirm: (params: { message: string; initialValue?: boolean }) => Promise<boolean | symbol>;
};

function hasSidecarFiles(env: NodeJS.ProcessEnv): boolean {
  const sidecarDir = path.join(resolveOAuthDir(env), "auth-profiles");
  try {
    return fs
      .readdirSync(sidecarDir, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith(".json"));
  } catch {
    return false;
  }
}

function resolveDeclineMarkerPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), DECLINE_MARKER_FILENAME);
}

function shouldSkip(params: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  isInteractiveTty: () => boolean;
}): boolean {
  if (process.platform !== "darwin") {
    return true;
  }
  if (!params.isInteractiveTty()) {
    return true;
  }
  const env = params.env;
  if (
    env.OPENCLAW_AUTO_MIGRATE_LEGACY_OAUTH_SIDECAR === "0" ||
    env.OPENCLAW_NON_INTERACTIVE === "1" ||
    env.CI === "true" ||
    env.CI === "1" ||
    env.OPENCLAW_AUTH_STORE_READONLY === "1"
  ) {
    return true;
  }
  const invocation = resolveCliArgvInvocation(params.argv);
  if (invocation.hasHelpOrVersion) {
    return true;
  }
  if (invocation.primary && SKIPPED_PRIMARIES.has(invocation.primary)) {
    return true;
  }
  if (hasJsonOutputFlag(params.argv)) {
    return true;
  }
  for (const flag of NO_PROMPT_FLAGS) {
    if (hasFlag(params.argv, flag)) {
      return true;
    }
  }
  if (!hasSidecarFiles(env)) {
    return true;
  }
  if (fs.existsSync(resolveDeclineMarkerPath(env))) {
    return true;
  }
  return false;
}

export async function maybeAutoMigrateLegacyOAuthSidecarOnInteractiveCli(params: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  prompter?: AutoMigrateInteractivePrompter;
  isInteractiveTty?: () => boolean;
}): Promise<void> {
  const env = params.env ?? process.env;
  const isInteractiveTty = params.isInteractiveTty ?? defaultIsInteractiveTty;

  if (shouldSkip({ argv: params.argv, env, isInteractiveTty })) {
    return;
  }

  const [
    { readBestEffortConfig },
    { hasMigratableLegacyOAuthSidecarStores, maybeRepairLegacyOAuthSidecarProfiles },
    clack,
  ] = await Promise.all([
    import("../config/io.js"),
    import("../commands/doctor-auth-oauth-sidecar.js"),
    import("@clack/prompts"),
  ]);
  const prompter = params.prompter ?? { confirm: (p) => clack.confirm(p) };

  try {
    const cfg = await readBestEffortConfig();
    if (!hasMigratableLegacyOAuthSidecarStores({ cfg, env })) {
      return;
    }
    const result = await maybeRepairLegacyOAuthSidecarProfiles({
      cfg,
      env,
      prompter: {
        confirmAutoFix: async (p) => {
          const answer = await prompter.confirm({
            message: typeof p.message === "string" ? p.message : String(p.message),
            initialValue: p.initialValue ?? true,
          });
          if (clack.isCancel(answer) || !answer) {
            return false;
          }
          return answer;
        },
      },
    });

    // Write the marker for any outcome that left credentials un-migrated:
    // explicit decline, Ctrl+C cancel, or accepted-but-decryption-failed
    // (Keychain "Deny", wrong seed, partial migration error). Doctor remains
    // the explicit retry path so this is not a one-way door.
    if (result.changes.length === 0) {
      const markerPath = resolveDeclineMarkerPath(env);
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, `${new Date().toISOString()}\n`, "utf8");
    }
  } catch {}
}

function defaultIsInteractiveTty(): boolean {
  const stdinTty = process.stdin.isTTY ?? false;
  const stdoutTty = process.stdout.isTTY ?? false;
  return stdinTty && stdoutTty;
}
