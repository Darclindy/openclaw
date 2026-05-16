import { getMSTeamsRuntime } from "./runtime.js";

export type MSTeamsSqliteStateOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
};

function resolveStateDirOverride(
  options: MSTeamsSqliteStateOptions | undefined,
): string | undefined {
  if (!options) {
    return undefined;
  }
  if (options.stateDir) {
    return options.stateDir;
  }
  if (options.homedir) {
    return getMSTeamsRuntime().state.resolveStateDir(options.env ?? process.env, options.homedir);
  }
  return options.env?.OPENCLAW_STATE_DIR?.trim() || undefined;
}

export function resolveMSTeamsSqliteStateEnv(
  options: MSTeamsSqliteStateOptions | undefined,
): NodeJS.ProcessEnv | undefined {
  const stateDir = resolveStateDirOverride(options);
  if (!stateDir) {
    return options?.env;
  }
  return {
    ...(options?.env ?? process.env),
    OPENCLAW_STATE_DIR: stateDir,
  };
}

export function toPluginJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
