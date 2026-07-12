import { useEffect, useRef, useState } from "react";

interface UseElapsedTimerReturn {
  /** Seconds elapsed since loading started, or null when not loading */
  elapsedSeconds: number | null;
  /** Seconds the last loading period took, or null before the first completion */
  finalElapsedSeconds: number | null;
}

/**
 * Tracks how long an agent has been working (loading).
 *
 * Prefers store-backed timing metadata when available so elapsed state survives
 * refreshes, but falls back to hook-local timing for callers that only toggle
 * `isLoading`.
 */
export function useElapsedTimer(
  isLoading: boolean | undefined,
  sessionId: string | undefined,
  loadingStartedAt?: number,
  storedFinalElapsedSeconds?: number | null,
): UseElapsedTimerReturn {
  const localLoadingStartRef = useRef<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);
  const [localFinalElapsedSeconds, setLocalFinalElapsedSeconds] = useState<number | null>(null);

  // Reset timer state when session changes (e.g. resume session)
  useEffect(() => {
    localLoadingStartRef.current = null;
    setElapsedSeconds(null);
    setLocalFinalElapsedSeconds(null);
  }, [sessionId]);

  useEffect(() => {
    if (!isLoading) {
      if (localLoadingStartRef.current !== null && storedFinalElapsedSeconds == null) {
        setLocalFinalElapsedSeconds(
          Math.max(0, Math.floor((Date.now() - localLoadingStartRef.current) / 1000)),
        );
      }
      localLoadingStartRef.current = null;
      setElapsedSeconds(null);
      return;
    }

    setLocalFinalElapsedSeconds(null);
    const effectiveStartTime = loadingStartedAt ?? localLoadingStartRef.current ?? Date.now();
    if (loadingStartedAt === undefined) {
      localLoadingStartRef.current = effectiveStartTime;
    } else {
      localLoadingStartRef.current = null;
    }

    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - effectiveStartTime) / 1000)));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);

    return () => clearInterval(interval);
  }, [isLoading, loadingStartedAt, storedFinalElapsedSeconds]);

  return {
    elapsedSeconds,
    finalElapsedSeconds: isLoading
      ? null
      : (storedFinalElapsedSeconds ?? localFinalElapsedSeconds ?? null),
  };
}
