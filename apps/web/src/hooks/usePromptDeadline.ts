import { useCallback, useSyncExternalStore } from "react";

const NO_SUBSCRIPTION = () => {};

/** Formats a live prompt deadline as `m:ss`, or null once it has expired. */
export function formatPromptDeadline(msRemaining: number): string | null {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return null;
  const totalSeconds = Math.ceil(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Shared countdown for blocking questions, permissions, and approvals.
 *
 * An absent deadline means the upstream protocol did not publish one and is
 * therefore not treated as expired. A present but invalid deadline fails
 * closed: the card becomes inert instead of leaving a dangerous action live.
 */
export function usePromptDeadline(expiresAt?: number): {
  remaining: string | null;
  expired: boolean;
} {
  const invalid = expiresAt !== undefined && !Number.isFinite(expiresAt);

  // The wall clock is the external store. The snapshot is the formatted
  // countdown, which only changes once a second, so ticks between changes do
  // not re-render.
  const subscribe = useCallback(
    (onTick: () => void) => {
      if (expiresAt === undefined || invalid) return NO_SUBSCRIPTION;
      if (expiresAt - Date.now() <= 0) return NO_SUBSCRIPTION;
      const timer = setInterval(() => {
        onTick();
        if (Date.now() >= expiresAt) clearInterval(timer);
      }, 1000);
      return () => clearInterval(timer);
    },
    [expiresAt, invalid],
  );
  const readRemaining = () =>
    expiresAt === undefined || invalid ? null : formatPromptDeadline(expiresAt - Date.now());
  const remaining = useSyncExternalStore(subscribe, readRemaining, readRemaining);

  return {
    remaining,
    // Absolute deadlines come from a different process (often inside a Docker
    // VM) and are only a display hint in the browser. Clock drift must not
    // suppress controls; the authoritative response endpoint returns `stale`
    // once the server-side window has actually closed. Invalid wire data still
    // fails closed.
    expired: invalid,
  };
}
