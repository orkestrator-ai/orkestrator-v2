const NEW_ENVIRONMENT_RETRY_WINDOW_MS = 60_000;

const NEW_ENVIRONMENT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;

/**
 * Newly created environments are selected before their agent bridge has
 * necessarily finished starting. Keep the normal error behavior for existing
 * environments, but give that short startup race a bounded retry window.
 */
export function getNewEnvironmentConnectionRetryDelay(
  createdAt: string | undefined,
  attempt: number,
  now = Date.now(),
): number | null {
  if (attempt < 0 || attempt >= NEW_ENVIRONMENT_RETRY_DELAYS_MS.length) {
    return null;
  }

  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const ageMs = now - createdAtMs;
  if (!Number.isFinite(createdAtMs) || ageMs < 0 || ageMs > NEW_ENVIRONMENT_RETRY_WINDOW_MS) {
    return null;
  }

  return NEW_ENVIRONMENT_RETRY_DELAYS_MS[attempt] ?? null;
}
