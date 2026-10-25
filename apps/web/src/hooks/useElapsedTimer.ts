import { useCallback, useSyncExternalStore } from "react";

interface UseElapsedTimerReturn {
  /** Seconds elapsed since loading started, or null when not loading */
  elapsedSeconds: number | null;
  /** Seconds the last loading period took, or null before the first completion */
  finalElapsedSeconds: number | null;
}

const NO_SUBSCRIPTION = () => {};

function elapsedSecondsSince(startedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
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
  const running = Boolean(isLoading) && loadingStartedAt !== undefined;

  // The wall clock is the external store: a one-second tick asks React to
  // re-read it, and the snapshot is the whole-second count, so it is stable
  // between ticks.
  const subscribe = useCallback(
    (onTick: () => void) => {
      if (!running) return NO_SUBSCRIPTION;
      const interval = setInterval(onTick, 1000);
      return () => clearInterval(interval);
    },
    [running],
  );
  const readElapsedSeconds = () =>
    running && loadingStartedAt !== undefined ? elapsedSecondsSince(loadingStartedAt) : null;
  const elapsedSeconds = useSyncExternalStore(subscribe, readElapsedSeconds, readElapsedSeconds);

  return {
    elapsedSeconds,
    finalElapsedSeconds: isLoading ? null : (storedFinalElapsedSeconds ?? null),
  };
}
