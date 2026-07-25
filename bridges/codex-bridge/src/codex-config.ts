export const CODEX_MAX_CONCURRENT_THREADS_ENV =
  "CODEX_MAX_CONCURRENT_THREADS_PER_SESSION";
export const DEFAULT_CODEX_MAX_CONCURRENT_THREADS = 5;
/**
 * Multi-agent V2 counts the root thread in its limit, while Orkestrator's
 * setting and the legacy `agents` key count only spawned children. Leave room
 * for that root before converting between the two representations.
 */
export const MAX_CODEX_CONCURRENT_THREADS = Number.MAX_SAFE_INTEGER - 1;

export function resolveCodexMaxConcurrentThreads(
  value: string | undefined,
): number {
  if (!value?.trim()) return DEFAULT_CODEX_MAX_CONCURRENT_THREADS;
  const parsed = Number(value);
  return (
    Number.isSafeInteger(parsed)
    && parsed >= 1
    && parsed <= MAX_CODEX_CONCURRENT_THREADS
  )
    ? parsed
    : DEFAULT_CODEX_MAX_CONCURRENT_THREADS;
}

export function codexAppServerConfigOverrides(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const childLimit = resolveCodexMaxConcurrentThreads(
    env[CODEX_MAX_CONCURRENT_THREADS_ENV],
  );
  return {
    "features.goals": "true",
    // V1 reads the child-only compatibility key.
    "agents.max_concurrent_threads_per_session": String(childLimit),
    // V2 prefers this root-inclusive key whenever it is present in config.toml.
    // Supplying both CLI overrides makes the Orkestrator setting authoritative
    // regardless of which multi-agent implementation Codex selects.
    "features.multi_agent_v2.max_concurrent_threads_per_session": String(
      childLimit + 1,
    ),
  };
}
