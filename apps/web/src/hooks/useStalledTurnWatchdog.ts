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
  /** Poll period. Defaults to one second, matching Codex's watchdog. */
  intervalMs?: number;
}

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
  intervalMs = 1000,
}: UseStalledTurnWatchdogOptions): void {
  const isRefreshInFlightRef = useRef(false);
  const reconcileRef = useRef(reconcile);
  const shouldReconcileRef = useRef(shouldReconcile);
  reconcileRef.current = reconcile;
  shouldReconcileRef.current = shouldReconcile;

  useEffect(() => {
    if (!isLoading || !isReady) return;

    let cancelled = false;

    const poll = async () => {
      // One reconcile at a time: these hit the network, and a slow response
      // would otherwise stack up a new request every tick.
      if (cancelled || isRefreshInFlightRef.current) return;
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
  }, [agentLabel, isLoading, isReady, intervalMs]);
}
