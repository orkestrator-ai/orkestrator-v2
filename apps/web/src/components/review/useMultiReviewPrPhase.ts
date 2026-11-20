import { startCoordinatedPoll } from "@/lib/coordinated-poll";
import { useEffect, useRef, useState } from "react";
import {
  NATIVE_SESSION_PUSH_TOPIC,
  PUSH_RECOVERY_POLL_MS,
  formatNativeSessionPushKey,
} from "@orkestrator/protocol/push-events";
import { usePushSubscription } from "@/lib/push/push-subscriptions";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import type { NativeAgentTurnPhase } from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { getNativeAgentSessionStateUpdate } from "@/lib/backend";
import { createSessionKey } from "@/lib/utils";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/** How often the PR step re-reads the tab's phase without a healthy push subscription. */
export const PR_PHASE_POLL_MS = 2_000;

/**
 * Read only action state, without mounting a transcript or relying on its
 * renderer cache.
 *
 * Push (docs/architecture/push-events.md): while shown, the step subscribes to
 * the PR tab's `native-session` key and reads its state on each change; the
 * poll falls to the recovery cadence while that subscription is healthy and
 * keeps its old cadence otherwise.
 */
export function useMultiReviewPrPhase({
  environmentId,
  tabId,
  agent,
  active,
  loadSessionState: loadSessionStateOverride,
}: {
  environmentId: string;
  tabId: string | undefined;
  agent: AgentPlatform | undefined;
  active: boolean;
  loadSessionState?: typeof getNativeAgentSessionStateUpdate;
}): NativeAgentTurnPhase | undefined {
  const nodeBackend = useScopeBackend();
  const loadSessionState =
    loadSessionStateOverride === undefined
      ? nodeBackend.getNativeAgentSessionStateUpdate
      : loadSessionStateOverride;
  const key = tabId && agent ? `${createSessionKey(environmentId, tabId)}:${agent}` : null;
  const { scope } = useScopesWithCommandFallback();
  const refreshRef = useRef<() => void>(() => undefined);
  const pushState = usePushSubscription(
    scope,
    NATIVE_SESSION_PUSH_TOPIC,
    tabId && agent
      ? formatNativeSessionPushKey({
          environmentId,
          agent,
          logicalSessionKey: createSessionKey(environmentId, tabId),
        })
      : "",
    active && key !== null,
    () => refreshRef.current(),
  );
  const pushHealthy = pushState === "healthy";
  const [observed, setObserved] = useState<{ key: string; phase: NativeAgentTurnPhase } | null>(
    null,
  );
  useEffect(() => {
    if (!active || !tabId || !agent || !key) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const update = await loadSessionState({
          environmentId,
          agent,
          logicalSessionKey: createSessionKey(environmentId, tabId),
          viewVersion: 1,
        });
        if (cancelled) return;
        setObserved(update.status === "snapshot" ? { key, phase: update.value.turn.phase } : null);
      } catch {
        if (!cancelled) setObserved(null);
      } finally {
        inFlight = false;
      }
    };
    refreshRef.current = () => void refresh();
    void refresh();
    const stopPolling = startCoordinatedPoll({
      resource: "multi-review-pr-phase",
      target: key,
      intervalMs: pushHealthy ? PUSH_RECOVERY_POLL_MS : PR_PHASE_POLL_MS,
      read: refresh,
    });
    return () => {
      cancelled = true;
      refreshRef.current = () => undefined;
      stopPolling();
    };
  }, [active, agent, environmentId, key, loadSessionState, pushHealthy, tabId]);
  return observed?.key === key ? observed?.phase : undefined;
}
