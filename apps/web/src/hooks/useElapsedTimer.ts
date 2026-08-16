import { useEffect, useState } from "react";

interface UseElapsedTimerReturn {
  /** Seconds elapsed since loading started, or null when not loading */
  elapsedSeconds: number | null;
  /** Seconds the last loading period took, or null before the first completion */
  finalElapsedSeconds: number | null;
}

/**
 * Tracks how long an agent has been working (loading).
 *
 * Elapsed time is derived from the backend-owned `loadingStartedAt` clock so a
 * remount, environment switch, or session identity change cannot restart the
 * counter. Callers that have not yet received that clock show no elapsed time
 * rather than inventing a renderer start.
 */
export function useElapsedTimer(
  isLoading: boolean | undefined,
  _sessionId: string | undefined,
  loadingStartedAt?: number,
  storedFinalElapsedSeconds?: number | null,
): UseElapsedTimerReturn {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!isLoading || loadingStartedAt === undefined) return;
    const interval = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(interval);
  }, [isLoading, loadingStartedAt]);

  const elapsedSeconds = isLoading && loadingStartedAt !== undefined
    ? Math.max(0, Math.floor((Date.now() - loadingStartedAt) / 1000))
    : null;

  return {
    elapsedSeconds,
    finalElapsedSeconds: isLoading
      ? null
      : (storedFinalElapsedSeconds ?? null),
  };
}
