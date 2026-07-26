import { useEffect, useRef } from "react";

interface UseStalledTurnWatchdogOptions {
  agentLabel: string;
  /** Only poll while a turn is actually in flight. */
  isLoading: boolean;
  /** False while disconnected — there is nothing to reconcile against. */
  isReady: boolean;
  /** Authoritative refetch of session state and messages. */
  reconcile: () => Promise<unknown>;
  /**
   * Optional extra throttle consulted on each tick. Codex uses this to defer to
   * its refresh controller so the watchdog does not fight a refresh that is
   * already scheduled.
   */
  shouldReconcile?: () => boolean;
  /**
   * A value that changes whenever live activity arrives for this session —
   * typically the session object, which every SSE frame replaces.
   *
   * Without this the watchdog reconciles once per tick for the whole turn,
   * which is pure cost during a *healthy* stream: it hammers the bridge and its
   * store writes race the user's own refresh. A stalled turn is by definition
   * one where this value has stopped changing.
   */
  activitySignal?: unknown;
  /** How long activity must be quiet before a turn counts as stalled. */
  staleAfterMs?: number;
  /** Poll period. Defaults to one second, matching Codex's watchdog. */
  intervalMs?: number;
}

/** Matches Codex's `CODEX_SESSION_STALE_AFTER_MS`. */
export const DEFAULT_TURN_STALE_AFTER_MS = 1500;

/**
 * Poll for a turn that has stopped reporting.
 *
 * SSE is the primary channel, but a dropped frame — a reconnect, a tab that was
 * unmounted mid-turn — leaves the composer disabled forever with no way back
 * except a manual refresh. `AGENTS.md` requires that the UI be able to catch up
 * from status/transcript APIs when events are missed; only Codex did.
 *
 * Deliberately not gated on `isActive`: a background environment is exactly the
 * case where frames get missed, so the watchdog must run for hidden mounts too.
 */
export function useStalledTurnWatchdog({
  agentLabel,
  isLoading,
  isReady,
  reconcile,
  shouldReconcile,
  activitySignal,
  staleAfterMs = DEFAULT_TURN_STALE_AFTER_MS,
  intervalMs = 1000,
}: UseStalledTurnWatchdogOptions): void {
  const isRefreshInFlightRef = useRef(false);
  const reconcileRef = useRef(reconcile);
  const shouldReconcileRef = useRef(shouldReconcile);
  reconcileRef.current = reconcile;
  shouldReconcileRef.current = shouldReconcile;

  // Reset the staleness clock whenever live activity arrives. Kept in an effect
  // rather than compared inside `poll` so it also covers the render in which the
  // turn starts, before the first tick fires.
  const lastActivityAtRef = useRef(Date.now());
  useEffect(() => {
    lastActivityAtRef.current = Date.now();
  }, [activitySignal, isLoading]);

  useEffect(() => {
    if (!isLoading || !isReady) return;

    let cancelled = false;

    const poll = async () => {
      // One reconcile at a time: these hit the network, and a slow response
      // would otherwise stack up a new request every tick.
      if (cancelled || isRefreshInFlightRef.current) return;
      // A turn that is still reporting is not stalled; reconciling under it only
      // costs bridge round trips and races the user's own refresh.
      if (Date.now() - lastActivityAtRef.current < staleAfterMs) return;
      if (shouldReconcileRef.current && !shouldReconcileRef.current()) return;

      isRefreshInFlightRef.current = true;
      try {
        await reconcileRef.current();
      } catch (error) {
        // A failed poll is not actionable — the next tick retries. Logged at
        // debug so a flapping connection does not spam the console.
        console.debug(`[${agentLabel}ChatTab] Stalled-turn poll failed:`, error);
      } finally {
        isRefreshInFlightRef.current = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void poll();
    }, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [agentLabel, isLoading, isReady, intervalMs, staleAfterMs]);
}
