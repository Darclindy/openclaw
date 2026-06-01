import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { isTruthyEnvValue } from "./env.js";

/**
 * Programmatic V8 CPU profiling for the per-function drilldown half of the
 * perf-trace tooling (see `docs/reference/perf-trace.md`). The span timeline
 * tells you *which phase* is slow; a CPU profile of that window tells you
 * *which function*. Both `.cpuprofile` and the timeline export open in
 * https://ui.perfetto.dev.
 *
 * Enabled only when `OPENCLAW_CPU_PROFILE_DIR` points at a writable directory,
 * so production stays untouched. Unlike `node --cpu-prof` (whole-process, see
 * `scripts/run-node.mjs`), this captures a bounded window around a slow request
 * on demand. A single profile session is supported at a time (V8 limitation).
 */

const CPU_PROFILE_DIR_ENV = "OPENCLAW_CPU_PROFILE_DIR";

let activeSession: Session | null = null;
let activeStartedAt = 0;
let warnedAboutCpuProfile = false;

export function resolveCpuProfileDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env[CPU_PROFILE_DIR_ENV]?.trim();
  return dir && dir.length > 0 ? dir : undefined;
}

export function isCpuProfileEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveCpuProfileDir(env) !== undefined && !isTruthyEnvValue(env.OPENCLAW_CPU_PROFILE_OFF);
}

function postAsync<T = unknown>(session: Session, method: string, params?: object): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // node:inspector's typings don't cover every method string; the runtime
    // accepts (method, params?, callback).
    const post = session.post.bind(session) as (
      m: string,
      p: object | ((err: Error | null, result: T) => void),
      cb?: (err: Error | null, result: T) => void,
    ) => void;
    const callback = (err: Error | null, result: T) => (err ? reject(err) : resolve(result));
    if (params) {
      post(method, params, callback);
    } else {
      post(method, callback);
    }
  });
}

/** Begin a CPU profile if enabled and none is already running. Returns whether one started. */
export async function startCpuProfile(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!isCpuProfileEnabled(env) || activeSession) {
    return false;
  }
  try {
    const session = new Session();
    session.connect();
    await postAsync(session, "Profiler.enable");
    await postAsync(session, "Profiler.start");
    activeSession = session;
    activeStartedAt = performance.now();
    return true;
  } catch (error) {
    warnOnce(`failed to start CPU profile: ${String(error)}`);
    return false;
  }
}

/**
 * Stop the active CPU profile and write `<dir>/<label>-<pid>-<ms>.cpuprofile`.
 * Returns the written path, or null if no profile was running / write failed.
 */
export async function stopCpuProfile(
  label = "openclaw",
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const session = activeSession;
  const dir = resolveCpuProfileDir(env);
  if (!session || !dir) {
    activeSession = null;
    return null;
  }
  try {
    const { profile } = await postAsync<{ profile: unknown }>(session, "Profiler.stop");
    const durationMs = Math.round(performance.now() - activeStartedAt);
    const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const fileName = `${safeLabel}-${process.pid}-${durationMs}ms.cpuprofile`;
    const filePath = join(dir, fileName);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(profile));
    return filePath;
  } catch (error) {
    warnOnce(`failed to stop/write CPU profile: ${String(error)}`);
    return null;
  } finally {
    try {
      session.disconnect();
    } catch {
      // session already gone; ignore.
    }
    activeSession = null;
  }
}

/** Run `fn` with a CPU profile captured around it (no-op when disabled). */
export async function withCpuProfile<T>(
  label: string,
  fn: () => Promise<T> | T,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const started = await startCpuProfile(env);
  try {
    return await fn();
  } finally {
    if (started) {
      await stopCpuProfile(label, env);
    }
  }
}

function warnOnce(message: string): void {
  if (warnedAboutCpuProfile) {
    return;
  }
  warnedAboutCpuProfile = true;
  process.stderr.write(`[cpu-profile] ${message}\n`);
}
