export const CODEX_MAX_CONCURRENT_THREADS_ENV =
  "CODEX_MAX_CONCURRENT_THREADS_PER_SESSION";
export const DEFAULT_CODEX_MAX_CONCURRENT_THREADS = 5;

export function resolveCodexMaxConcurrentThreads(
  value: string | undefined,
): number {
  if (!value?.trim()) return DEFAULT_CODEX_MAX_CONCURRENT_THREADS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_CODEX_MAX_CONCURRENT_THREADS;
}

export function codexAppServerConfigOverrides(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    "features.goals": "true",
    "agents.max_concurrent_threads_per_session": String(
      resolveCodexMaxConcurrentThreads(env[CODEX_MAX_CONCURRENT_THREADS_ENV]),
    ),
  };
}
