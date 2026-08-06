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
   * Optional extra throttle consulted on each tick so a provider-specific
   * refresh controller can suppress duplicate work.
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
  /**
   * Floor on the gap between two *successful* reconciles within one turn.
   *
   * `staleAfterMs` cannot bound the poll rate on its own for a tab whose
   * `activitySignal` is the session object: an applied reconcile writes the
   * session back to the store, which replaces that object and so resets the
   * staleness clock. Without this floor the watchdog settles into a sustained
   * `staleAfterMs + intervalMs` loop for the whole quiet stretch of a turn.
   */
  minReconcileIntervalMs?: number;
  /** Poll period. Defaults to one second. */
  intervalMs?: number;
}

/** Default quiet period before a provider turn is considered stalled. */
export const DEFAULT_TURN_STALE_AFTER_MS = 1500;

/**
 * Default floor between two successful reconciles.
 *
 * `DEFAULT_TURN_STALE_AFTER_MS` is tuned for detection latency, not for poll
 * cost: at 1.5s a tab that reconciles once re-arms itself and issues
 * roughly four bridge GETs — including the full transcript — every couple of
 * seconds until the turn ends. Ten seconds still recovers a genuinely dropped
 * frame quickly while making the steady-state cost negligible.
 */
export const DEFAULT_MIN_RECONCILE_INTERVAL_MS = 10_000;

/**
 * Poll for a turn that has stopped reporting.
 *
 * SSE is the primary channel. OpenCode does not expose the revisioned replay
 * protocol used by the bundled Claude and Codex bridges, so its mounted view
 * retains this bounded recovery poll against authoritative session APIs.
 *
 * Two independent throttles apply. `staleAfterMs` decides when a quiet turn
 * counts as stalled at all, and `minReconcileIntervalMs` caps how often a stall
 * that persists — or that the reconcile itself keeps re-arming — may be
 * re-checked. A *failed* reconcile is not throttled: it changed nothing, so the
 * next tick retries.
 *
 * Deliberately not gated on `isActive`: switching panes inside a mounted
 * environment must not suspend its recovery path. Environment-level background
 * ownership remains in the backend; remounting rehydrates authoritative state.
 */
export function useStalledTurnWatchdog({
  agentLabel,
  isLoading,
  isReady,
  reconcile,
  shouldReconcile,
  activitySignal,
  staleAfterMs = DEFAULT_TURN_STALE_AFTER_MS,
  minReconcileIntervalMs = DEFAULT_MIN_RECONCILE_INTERVAL_MS,
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

  // Timestamp of the last reconcile that completed successfully, or 0 while the
  // current arming has not reconciled yet. Reset below on every re-arm so a new
  // turn is never made to wait out the previous turn's throttle.
  const lastReconciledAtRef = useRef(0);

  useEffect(() => {
    if (!isLoading || !isReady) return;

    let cancelled = false;
    lastReconciledAtRef.current = 0;

    const poll = async () => {
      // One reconcile at a time: these hit the network, and a slow response
      // would otherwise stack up a new request every tick.
      if (cancelled || isRefreshInFlightRef.current) return;
      // A turn that is still reporting is not stalled; reconciling under it only
      // costs bridge round trips and races the user's own refresh.
      if (Date.now() - lastActivityAtRef.current < staleAfterMs) return;
      // A reconcile that applied is itself "activity" for callers that pass the
      // session as their activity signal, so the staleness gate above cannot see
      // it. This one can.
      if (
        lastReconciledAtRef.current > 0 &&
        Date.now() - lastReconciledAtRef.current < minReconcileIntervalMs
      ) {
        return;
      }
      if (shouldReconcileRef.current && !shouldReconcileRef.current()) return;

      isRefreshInFlightRef.current = true;
      try {
        await reconcileRef.current();
        lastReconciledAtRef.current = Date.now();
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
  }, [
    agentLabel,
    isLoading,
    isReady,
    intervalMs,
    minReconcileIntervalMs,
    staleAfterMs,
  ]);
}
